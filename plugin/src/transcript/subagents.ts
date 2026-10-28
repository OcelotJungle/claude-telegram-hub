import type { Logger } from "../shared/log.ts";
import type { ExecutorConfig, ExecutorDiscovery, ExecutorType } from "./codex-job.ts";
import type { Model } from "./model-versions.ts";
import type { TranscriptEvent } from "./parse.ts";

import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { z } from "zod";
import { field } from "../shared/guards.ts";
import { nullLogger } from "../shared/log.ts";
import { toTelegram } from "../shared/markdown.ts";
import { plural } from "../shared/plural.ts";
import { discoverExecutorJob, isExecutorWorkerSummary, ExecutorJob, EXECUTORS } from "./codex-job.ts";
import { codexModel, ModelVersions, recordModel, volunteerModelLabel } from "./model-versions.ts";
import { parseAgentRecord } from "./parse.ts";
import { TranscriptTailer } from "./tail.ts";

const SCAN_MS = 1000;
const SEND_EVERY_MS = 3000;
// A turn end in the agent's own transcript is not always its end: Claude Code
// writes an API error record as one when only the auto mode classifier's
// response broke off, and a stop hook can send the agent on. An agent that
// goes on within this long keeps its card; its card is closed only after it.
export const SETTLE_MS = 120_000;
// An agent that ended its turn with a background task of its own running
// (Bash, Monitor, Agent) is waiting for its notification, not done: its card stays
// open this long, and is closed after it.
export const WAIT_MAX_MS = 60 * 60_000;
// One text of a subagent in its card is cut to this.
export const MAX_CARD_TEXT = 1500;
// A card stays one Telegram message (4096 characters) with room for its
// status line to grow.
export const MAX_CARD = 3800;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const AGENT_FILE = /^agent-(.+)\.jsonl$/;
// Markdown specials in names the card shows as they are.
const MD_SPECIAL = /[\\`*_[\]()#+\-.!|~>]/g;
const CONTINUED = "⬇️ продолжение ниже";
// A text that starts with a Markdown block (heading, list, quote, code)
// gets its time on a line of its own, so the block stays one.
const STARTS_WITH_BLOCK = /^(#{1,6} |[-*+] |\d+[.)] |>|```)/;
const CLOCK_PAD = 2;
const MAX_COMMAND_CHARS = 60;
// The coordinator's message in a card is cut to this.
export const MAX_COORDINATOR_TEXT = 200;

// A subagent's card as Markdown. final: its last version (the agent stopped,
// or the card is full and continues in the next one).
export type Card = { id: string; text: string; final: boolean; reopen?: boolean; replyTo?: string };

type Status = "running" | "done" | "failed" | "stopped";

// A text of the agent and when it wrote it (ms).
type Entry = { at: number; text: string };

// <status> of a task notification.
const TASK_STATUSES: Record<string, Status> = { completed: "done", failed: "failed", killed: "stopped" };
// The tool a subagent ends its run with, its report going to its caller.
const HANDBACK_TOOL = "SubagentHandback";

const metaSchema = z.object({ agentType: z.string().optional(), description: z.string().optional(), model: z.string().optional() });
type Meta = z.infer<typeof metaSchema>;

type Env = {
  send(card: Card): void;
  canStart(): boolean;
  now(): number;
  sendEveryMs: number;
  log: Logger;
  executorJobsDirs: Map<ExecutorType, string>;
  versions: ModelVersions;
  jobs: Map<string, Agent>;
};

// One subagent: its status and texts, in cards of at most one message each.
class Agent {
  private tailer: TranscriptTailer;
  private meta: Meta | undefined;
  // The model and effort of the agent's latest answer.
  private model: { model: Model; effort: string | undefined } | undefined;
  private status: Status = "running";
  // The message whose records end the agent's run.
  private endMessage: string | undefined;
  private started: number;
  private ended: number | undefined;
  private tools = 0;
  private lastTool: string | undefined;
  private part = 0;
  private cardAgentId: string;
  private baseWorkMs = 0;
  private baseCommands = 0;
  private handedOver = false;
  private displayed = false;
  // Records of the history are being replayed: nothing is sent meanwhile.
  private replaying = false;
  private reopenCard = false;
  private replyTo: string | undefined;
  private texts: Entry[] = [];
  private seen = false;
  private shown = false;
  // The final version is sent: the card is closed.
  private sealed = false;
  // The agent's end came from its task notification, not its transcript: it
  // will not go on, and its card closes without waiting.
  private certain = false;
  // The agent's own live background tasks (ids).
  private tasks = new Set<string>();
  private dirty = false;
  private idle = false;
  private lastSent = 0;
  private sentText = "";
  private executor: ExecutorConfig | undefined;
  private executorJob: ExecutorJob | undefined;
  private executorMetaChecked = false;
  private pendingDiscovery: ExecutorDiscovery | undefined;
  private executorStatus: string | undefined;
  private finalMessages = new Set<string>();
  // Until the job becomes available, summaries stay visible as a fallback.
  private workerSummaries = new Set<Entry>();

  constructor(
    readonly id: string,
    private dir: string,
    // A dormant agent existed when the watcher started: it is read only once
    // its file grows past the size it had then (see replay).
    private dormant: boolean,
    private env: Env,
  ) {
    this.started = env.now();
    this.cardAgentId = id;
    this.tailer = new TranscriptTailer({
      path: join(dir, `agent-${id}.jsonl`),
      fromStart: !dormant,
      onRecord: rec => this.handle(rec, recordTime(rec) ?? env.now()),
      onIdle: () => {
        this.idle = true;
      },
      log: env.log,
    });
    this.tailer.open();
  }

  // One record of the agent's transcript, written at `at` (ms).
  private handle(rec: unknown, at: number): void {
    this.idle = false;
    const answered = recordModel(rec);
    if (answered) {
      this.model = answered;
      this.env.versions.see(answered.model);
    }
    this.checkExecutor();
    if (!this.executorJob) {
      if (!this.executorMetaChecked && this.pendingDiscovery) {
        const resolved = this.executorForJob(this.pendingDiscovery.id);
        if (resolved) {
          this.executor = resolved;
          this.executorJob = new ExecutorJob(this.pendingDiscovery, this.executorJobsDir(resolved), this.env.now, this.env.log);
          this.pendingDiscovery = undefined;
        }
      }
    }
    if (!this.executorJob) {
      const result = this.executorMetaChecked
        ? this.executor ? this.discoverForExecutor(rec, this.executor) : undefined
        : this.executor ? this.discoverForExecutor(rec, this.executor) : this.discoverExecutor(rec);
      if (result?.executor) {
        this.executor = result.executor;
        this.executorJob = new ExecutorJob(result.discovery, this.executorJobsDir(result.executor), this.env.now, this.env.log);
      } else if (result) {
        this.pendingDiscovery = result.discovery;
      }
    }
    const events = parseAgentRecord(rec);
    // Split final messages carry their turn end alongside each text block.
    for (const ev of events) if (ev.kind === "turn_end") this.finalMessages.add(ev.messageId);
    for (const ev of events) this.feed(ev, at);
    this.adoptJob();
  }

  private checkExecutor(): void {
    if (this.executorMetaChecked) return;
    const parsed = metaSchema.safeParse(this.readMeta());
    if (!parsed.success) return;
    this.meta = parsed.data;
    if (this.meta.agentType === undefined) return;
    this.executorMetaChecked = true;
    const executor = executorForAgentType(this.meta.agentType);
    this.executor = executor;
    if (executor && this.pendingDiscovery && !this.executorJob) {
      this.executorJob = new ExecutorJob(this.pendingDiscovery, this.executorJobsDir(executor), this.env.now, this.env.log);
      this.pendingDiscovery = undefined;
    }
    this.adoptJob();
  }

  private discoverForExecutor(record: unknown, executor: ExecutorConfig): { executor: ExecutorConfig; discovery: ExecutorDiscovery } | undefined {
    const discovery = discoverExecutorJob(record, executor);
    return discovery ? { executor, discovery } : undefined;
  }

  private discoverExecutor(record: unknown): { executor?: ExecutorConfig; discovery: ExecutorDiscovery } | undefined {
    const codex = this.discoverForExecutor(record, EXECUTORS.codex);
    const volunteer = this.discoverForExecutor(record, EXECUTORS.volunteer);
    const command = [codex, volunteer].find(result => result?.discovery.source === "command");
    if (command) return command;

    const discoveries = [codex, volunteer].filter((result): result is { executor: ExecutorConfig; discovery: ExecutorDiscovery } => result !== undefined);
    if (discoveries.length === 0) return undefined;
    const executor = this.executorForJob(discoveries[0].discovery.id);
    if (executor) return { executor, discovery: discoveries[0].discovery };
    return { discovery: discoveries[0].discovery };
  }

  private executorForJob(id: string): ExecutorConfig | undefined {
    const existing = [EXECUTORS.codex, EXECUTORS.volunteer].filter(executor =>
      existsSync(join(this.executorJobsDir(executor), id)),
    );
    return existing.length === 1 ? existing[0] : undefined;
  }

  private executorJobsDir(executor: ExecutorConfig): string {
    return this.env.executorJobsDirs.get(executor.agentType) ?? join(homedir(), executor.jobsDir);
  }

  finish(status: Status, messageId?: string, certain = false, at = this.env.now()): void {
    if (this.handedOver || !this.seen) return;
    if (certain) this.certain = true;
    if (this.status === status) return;
    this.status = status;
    this.endMessage = messageId;
    this.ended = at;
    this.dirty = true;
  }

  tick(): void {
    if (this.handedOver) return;
    if (this.dormant) {
      if (!this.tailer.grew()) return;
      this.dormant = false;
      this.meta ??= this.readMeta();
      this.replay();
    }
    this.meta ??= this.readMeta();
    this.checkExecutor();
    this.tailer.pollNow();
    this.adoptJob();
    if (this.sealed) return;
    this.pollExecutor();
    const waiting = this.isWaiting();
    const stopped = this.status !== "running" && !waiting;
    const final = this.settled(this.env.now());
    // A running card's time goes on even while the agent writes nothing, as
    // when it thinks for long, so the card shows it is alive; a waiting
    // card's too.
    if (!this.dirty && !final && (stopped || !this.shown)) return;
    if (!this.shown && !this.env.canStart()) return;
    // The final message comes in several records: wait until all are read.
    if (final ? !this.idle : this.env.now() - this.lastSent < this.env.sendEveryMs) return;
    const text = this.render(this.texts, this.statusLine());
    this.dirty = false;
    if (!final && text === this.sentText) return;
    this.send(text, final);
    this.shown = true;
    this.sealed = final;
    this.sentText = text;
    this.lastSent = this.env.now();
  }

  private pollExecutor(): void {
    if (!this.executor || !this.executorJob) return;
    const entries = this.executorJob.poll();
    if (this.executorJob.state) {
      this.seen = true;
      if (this.workerSummaries.size) {
        this.texts = this.texts.filter(entry => !this.workerSummaries.has(entry));
        this.workerSummaries.clear();
      }
    }
    const state = this.executorJob.state;
    const status = state ? JSON.stringify([state.status, state.slug, state.effort, this.executorJob.commands, this.executorJob.currentCommand, this.executorJob.eventAt]) : undefined;
    if (entries.length || status !== this.executorStatus) this.dirty = true;
    this.executorStatus = status;
    for (const entry of entries) {
      this.addText(entry.text, entry.at);
    }
  }

  // Rebuilds the card the agent had before the watcher started, from its
  // history up to the size it had then. Nothing is sent: the card the hub
  // already shows is the one this state describes. Afterwards the card goes on
  // in place (reopen), and a run that ended is sealed as a live one would be.
  private replay(): void {
    const records = this.tailer.readHistory();
    this.replaying = true;
    try {
      let at = recordTime(records[0]) ?? this.env.now();
      this.started = at;
      for (const rec of records) {
        at = recordTime(rec) ?? at;
        // A run that settled before this record is sealed, so the record wakes
        // it into a new card state, as the live path does.
        if (this.settled(at)) this.sealed = true;
        try {
          this.handle(rec, at);
        } catch (e) {
          this.env.log.error(`subagent ${this.id}: replay record failed: ${e}`);
        }
      }
      this.pollExecutor();
    } finally {
      this.replaying = false;
    }
    this.sealed = this.settled(this.env.now());
    this.shown = true;
    this.displayed = true;
    this.reopenCard = true;
    this.dirty = false;
    this.sentText = this.render(this.texts, this.statusLine());
    this.registerJob();
  }

  // Whether the agent's run is over by `at` (ms): its end is certain, or it did
  // not go on for the wait after its end.
  private settled(at: number): boolean {
    return this.status !== "running" && (this.certain || at - (this.ended ?? 0) >= (this.tasks.size ? WAIT_MAX_MS : SETTLE_MS));
  }

  private registerJob(): void {
    if (this.executor && this.executorJob) this.env.jobs.set(`${this.executor.agentType}:${this.executorJob.discovery.id}`, this);
  }

  private adoptJob(): void {
    if (!this.executor || !this.executorJob || this.displayed) return;
    const jobKey = `${this.executor.agentType}:${this.executorJob.discovery.id}`;
    const owner = this.env.jobs.get(jobKey);
    if (!owner || owner === this || owner.handedOver) return;
    this.cardAgentId = owner.cardAgentId;
    this.part = owner.part;
    this.texts = [...owner.texts, ...this.texts];
    this.workerSummaries = new Set([...owner.workerSummaries, ...this.workerSummaries]);
    this.baseWorkMs = owner.workMs();
    this.baseCommands = owner.baseCommands + (owner.executorJob?.commands ?? 0);
    this.shown = true;
    this.displayed = true;
    this.reopenCard = true;
    this.dirty = true;
    owner.handedOver = true;
    this.env.jobs.set(jobKey, this);
  }

  private workMs(): number {
    return this.baseWorkMs + Math.max(0, (this.ended ?? this.env.now()) - this.started);
  }

  private send(text: string, final: boolean): void {
    if (this.replaying) return;
    this.env.send({ id: this.cardId(), text, final, ...(this.reopenCard ? { reopen: true } : {}), ...(this.replyTo ? { replyTo: this.replyTo } : {}) });
    this.replyTo = undefined;
    this.displayed = true;
    this.registerJob();
  }

  // The turn ended, but a background task of the agent's own will wake it.
  private isWaiting(): boolean {
    return this.status === "done" && !this.certain && this.tasks.size > 0 && this.env.now() - (this.ended ?? 0) < WAIT_MAX_MS;
  }

  private feed(ev: TranscriptEvent, at: number): void {
    if (ev.kind === "task_started") this.tasks.add(ev.taskId);
    else if (ev.kind === "task_status" && this.tasks.delete(ev.taskId) && !this.tasks.size && this.status !== "running") {
      // The last task ended: the agent is about to be woken, and the card
      // must not close before its record is read.
      this.ended = at;
    }
    if (ev.kind === "coordinator") {
      // The agent got a message (SendMessage): it goes on, in the same card.
      this.wake(at);
      this.seen = true;
      this.dirty = true;
      const first = ev.text.split("\n").map(l => l.trim()).find(l => l !== "");
      if (first !== undefined) this.addText(`↪ ${escapeMd(first.length > MAX_COORDINATOR_TEXT ? `${first.slice(0, MAX_COORDINATOR_TEXT)}…` : first)}`, at);
      return;
    }
    if (ev.kind !== "text" && ev.kind !== "tool_use" && ev.kind !== "turn_end" && ev.kind !== "api_error") return;
    if (this.status !== "running" && ev.messageId !== this.endMessage) this.wake(at);
    this.seen = true;
    this.dirty = true;
    if (ev.kind === "text") {
      const summary = this.executor && isExecutorWorkerSummary(ev.text, this.executor) && !this.finalMessages.has(ev.messageId);
      if (this.getExecutorJob() && summary) return;
      const entry = this.addText(ev.text, at);
      if (summary) this.workerSummaries.add(entry);
    } else if (ev.kind === "tool_use") {
      this.tools++;
      this.lastTool = ev.detail ? `${ev.name} ${ev.detail}` : ev.name;
      // A subagent that hands its report back stops there, with no turn end
      // in its transcript; a SendMessage later resumes it like any end.
      if (ev.name === HANDBACK_TOOL) this.finish("done", ev.messageId, false, at);
    } else this.finish("done", ev.messageId, false, at);
  }

  private addText(t: string, at: number): Entry {
    const trimmed = t.trim();
    const entry = { at, text: trimmed.length > MAX_CARD_TEXT ? `${trimmed.slice(0, MAX_CARD_TEXT)}…` : trimmed };
    if (this.texts.length && toTelegram(this.render([...this.texts, entry], this.statusLine())).text.length > MAX_CARD) {
      const previousCardId = this.cardId();
      if (this.shown) this.send(this.render(this.texts, CONTINUED), true);
      this.part++;
      // A replayed part was shown in the hub before the restart.
      this.replyTo = this.shown || this.replaying ? previousCardId : undefined;
      this.reopenCard = false;
      this.texts = [];
      this.workerSummaries.clear();
      this.shown = false;
    }
    this.texts.push(entry);
    return entry;
  }

  // The agent went on before its card closed: the same run, the same card.
  private resume(): void {
    this.status = "running";
    this.endMessage = undefined;
    this.ended = undefined;
    this.certain = false;
  }

  // A message woke the agent: its card is edited in place, whether it is
  // sealed or not (one agent, one card). The pause between runs is not counted.
  private wake(at: number): void {
    if (this.sealed) this.continueCard(at);
    else this.resume();
  }

  private continueCard(at: number): void {
    this.baseWorkMs = this.workMs();
    this.baseCommands += this.executorJob?.commands ?? 0;
    this.reopenCard = true;
    this.replyTo = undefined;
    this.sealed = false;
    this.certain = false;
    this.status = "running";
    this.endMessage = undefined;
    this.started = at;
    this.ended = undefined;
    this.executor = undefined;
    this.executorJob = undefined;
    this.executorMetaChecked = false;
    this.pendingDiscovery = undefined;
    this.executorStatus = undefined;
    this.workerSummaries.clear();
  }

  private cardId(): string {
    return `${this.cardAgentId}-${this.part}`;
  }

  private render(texts: Entry[], status: string): string {
    const m = this.meta;
    // The worker only relays: the model doing the work is the executor's.
    const state = this.getExecutorJob()?.state;
    let model: string[] = [];
    if (state) {
      if (this.executor?.agentType === "volunteer") {
        model = [volunteerModelLabel(state.slug)];
      } else {
        // Codex: use existing model formatting
        model = [this.env.versions.label(codexModel(state.slug)), state.effort];
      }
    } else if (this.executor) {
      model = [];
    } else {
      const modelLabel = this.model ? this.env.versions.label(this.model.model) : (m?.model ?? "");
      const effort = this.model?.effort ?? "";
      model = [modelLabel, effort].filter((s): s is string => s !== "");
    }
    const head = [`🤖 **${escapeMd(this.executor?.displayName ?? m?.agentType ?? "Субагент")}**`, ...model.map(escapeMd)].join(" · ");
    const task = m?.description ? `${escapeMd(m.description)}\n` : "";
    return [`${head}\n${task}${status}`, ...texts.map(e => `\`[${clock(e.at)}]\`${STARTS_WITH_BLOCK.test(e.text) ? "\n" : " "}${e.text}`)].join("\n\n");
  }

  private getExecutorJob(): ExecutorJob | undefined {
    return this.executor && this.executorJob?.state ? this.executorJob : undefined;
  }

  private statusLine(): string {
    const took = duration(this.workMs());
    const job = this.getExecutorJob();
    if (job?.state) {
      const commands = this.baseCommands + job.commands;
      const acts = `${commands} ${plural(commands, "действие", "действия", "действий")}`;
      const displayName = this.executor?.statusName ?? "Codex";
      switch (job.state.status) {
        case "question":
          return `❓ ${displayName} ждёт ответа`;
        case "failed":
        case "orphaned":
        case "limit":
          return `❌ ${took} · ${acts}`;
        case "cancelled":
          return `⏹ ${took} · ${acts}`;
      }
      if (this.status === "running" || this.isWaiting()) {
        const first = job.currentCommand?.trim().split("\n")[0];
        const command = first && first.length > MAX_COMMAND_CHARS ? `${first.slice(0, MAX_COMMAND_CHARS)}…` : first;
        return `⏳ ${took} · ${acts}${job.eventAt === undefined ? "" : ` · событие ${clock(job.eventAt)}`}${command ? `\n\`${command.replaceAll("`", "'")}\`` : ""}`;
      }
      switch (this.status) {
        case "done":
          return `✅ ${took} · ${acts}`;
        case "failed":
          return `❌ ${took} · ${acts}`;
        case "stopped":
          return `⏹ ${took} · ${acts}`;
      }
    }
    if (this.isWaiting()) return `⏸ ждёт фоновую задачу · ${duration(this.env.now() - (this.ended ?? this.env.now()))}`;
    const acts = `${this.tools} ${plural(this.tools, "действие", "действия", "действий")}`;
    switch (this.status) {
      case "running":
        return `⏳ ${took} · ${acts}${this.lastTool ? `\n\`${this.lastTool.replaceAll("`", "'")}\`` : ""}`;
      case "done":
        return `✅ ${took} · ${acts}`;
      case "failed":
        return `❌ ${took} · ${acts}`;
      case "stopped":
        return `⏹ ${took} · ${acts}`;
    }
  }

  private readMeta(): Meta | undefined {
    try {
      const parsed = metaSchema.safeParse(JSON.parse(readFileSync(join(this.dir, `agent-${this.id}.meta.json`), "utf8")));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }
}

// Follows the subagents of one session: Claude Code writes each into
// <session>/subagents/agent-<id>.jsonl, next to the main transcript. Agents
// already there at start are dormant: nothing is read until their file grows,
// then their history is replayed silently and the card goes on from it.
export class SubagentWatcher {
  private agents = new Map<string, Agent>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private env: Env;

  constructor(
    private opts: {
      dir: string;
      onCard(card: Card): void;
      // A card is first sent only while this holds; a card already sent keeps
      // being updated.
      canStart(): boolean;
      intervalMs?: number;
      sendEveryMs?: number;
      now?(): number;
      log?: Logger;
      codexJobsDir?: string;
      volunteerJobsDir?: string;
      versions?: ModelVersions;
    },
  ) {
    this.env = {
      send: card => opts.onCard(card),
      canStart: () => opts.canStart(),
      now: opts.now ?? Date.now,
      sendEveryMs: opts.sendEveryMs ?? SEND_EVERY_MS,
      log: opts.log ?? nullLogger,
      executorJobsDirs: new Map([
        [EXECUTORS.codex.agentType, opts.codexJobsDir ?? join(homedir(), EXECUTORS.codex.jobsDir)],
        [EXECUTORS.volunteer.agentType, opts.volunteerJobsDir ?? join(homedir(), EXECUTORS.volunteer.jobsDir)],
      ]),
      versions: opts.versions ?? new ModelVersions(),
      jobs: new Map(),
    };
  }

  start(): void {
    for (const id of this.ids()) this.agents.set(id, new Agent(id, this.opts.dir, true, this.env));
    this.timer = setInterval(() => this.tick(), this.opts.intervalMs ?? SCAN_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.agents.clear();
    this.env.jobs.clear();
  }

  // From a task notification in the main transcript.
  taskStatus(taskId: string, status: string): void {
    const s = TASK_STATUSES[status];
    if (s) this.agents.get(taskId)?.finish(s, undefined, true);
  }

  tick(): void {
    for (const id of this.ids()) if (!this.agents.has(id)) this.agents.set(id, new Agent(id, this.opts.dir, false, this.env));
    for (const a of this.agents.values()) a.tick();
  }

  private ids(): string[] {
    try {
      return readdirSync(this.opts.dir).flatMap(f => f.match(AGENT_FILE)?.[1] ?? []);
    } catch {
      return [];
    }
  }
}

// When a transcript record was written (ms), from its timestamp.
function recordTime(rec: unknown): number | undefined {
  const ts = field(rec, "timestamp");
  const ms = typeof ts === "string" ? Date.parse(ts) : NaN;
  return Number.isNaN(ms) ? undefined : ms;
}

function executorForAgentType(agentType: string | undefined): ExecutorConfig | undefined {
  if (agentType === "codex") return EXECUTORS.codex;
  if (agentType === "volunteer") return EXECUTORS.volunteer;
  return undefined;
}

// Local wall-clock time, as 18:39.
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(CLOCK_PAD, "0")}:${String(d.getMinutes()).padStart(CLOCK_PAD, "0")}`;
}

function escapeMd(s: string): string {
  return s.replace(MD_SPECIAL, c => `\\${c}`);
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / MS_PER_SECOND));
  return s < SECONDS_PER_MINUTE ? `${s} с` : `${Math.floor(s / SECONDS_PER_MINUTE)} мин`;
}
