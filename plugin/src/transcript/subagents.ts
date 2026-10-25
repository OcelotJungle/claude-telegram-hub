import type { Logger } from "../shared/log.ts";
import type { TranscriptEvent } from "./parse.ts";

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { field } from "../shared/guards.ts";
import { nullLogger } from "../shared/log.ts";
import { toTelegram } from "../shared/markdown.ts";
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

// A subagent's card as Markdown. final: its last version (the agent stopped,
// or the card is full and continues in the next one).
export type Card = { id: string; text: string; final: boolean };

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
};

// One subagent: its status and texts, in cards of at most one message each.
class Agent {
  private tailer: TranscriptTailer;
  private meta: Meta | undefined;
  private status: Status = "running";
  // The message whose records end the agent's run.
  private endMessage: string | undefined;
  private started: number;
  private ended: number | undefined;
  private tools = 0;
  private lastTool: string | undefined;
  private part = 0;
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

  constructor(
    readonly id: string,
    private dir: string,
    fromStart: boolean,
    private env: Env,
  ) {
    this.started = env.now();
    this.tailer = new TranscriptTailer({
      path: join(dir, `agent-${id}.jsonl`),
      fromStart,
      onRecord: rec => {
        this.idle = false;
        const at = recordTime(rec) ?? env.now();
        for (const ev of parseAgentRecord(rec)) this.feed(ev, at);
      },
      onIdle: () => {
        this.idle = true;
      },
      log: env.log,
    });
    this.tailer.open();
  }

  finish(status: Status, messageId?: string, certain = false): void {
    if (!this.seen) return;
    if (certain) this.certain = true;
    if (this.status === status) return;
    this.status = status;
    this.endMessage = messageId;
    this.ended = this.env.now();
    this.dirty = true;
  }

  tick(): void {
    this.tailer.pollNow();
    this.meta ??= this.readMeta();
    if (this.sealed) return;
    const waiting = this.isWaiting();
    const stopped = this.status !== "running" && !waiting;
    const final = this.status !== "running" && (this.certain || this.env.now() - (this.ended ?? 0) >= (this.tasks.size ? WAIT_MAX_MS : SETTLE_MS));
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
    this.env.send({ id: this.cardId(), text, final });
    this.shown = true;
    this.sealed = final;
    this.sentText = text;
    this.lastSent = this.env.now();
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
      this.ended = this.env.now();
    }
    if (ev.kind !== "text" && ev.kind !== "tool_use" && ev.kind !== "turn_end" && ev.kind !== "api_error") return;
    if (this.status !== "running" && ev.messageId !== this.endMessage) {
      // A closed card stays as it is: the agent got a new message
      // (SendMessage), a new run goes into a new card.
      if (this.sealed) this.reopen();
      else this.resume();
    }
    this.seen = true;
    this.dirty = true;
    if (ev.kind === "text") this.addText(ev.text, at);
    else if (ev.kind === "tool_use") {
      this.tools++;
      this.lastTool = ev.detail ? `${ev.name} ${ev.detail}` : ev.name;
      // A subagent that hands its report back stops there, with no turn end
      // in its transcript; a SendMessage later resumes it like any end.
      if (ev.name === HANDBACK_TOOL) this.finish("done", ev.messageId);
    } else this.finish("done", ev.messageId);
  }

  private addText(t: string, at: number): void {
    const trimmed = t.trim();
    const entry = { at, text: trimmed.length > MAX_CARD_TEXT ? `${trimmed.slice(0, MAX_CARD_TEXT)}…` : trimmed };
    if (this.texts.length && toTelegram(this.render([...this.texts, entry], this.statusLine())).text.length > MAX_CARD) {
      if (this.shown) this.env.send({ id: this.cardId(), text: this.render(this.texts, CONTINUED), final: true });
      this.part++;
      this.texts = [];
      this.shown = false;
    }
    this.texts.push(entry);
  }

  // The agent went on before its card closed: the same run, the same card.
  private resume(): void {
    this.status = "running";
    this.endMessage = undefined;
    this.ended = undefined;
    this.certain = false;
  }

  private reopen(): void {
    this.part++;
    this.texts = [];
    this.shown = false;
    this.sealed = false;
    this.certain = false;
    this.status = "running";
    this.endMessage = undefined;
    this.started = this.env.now();
    this.ended = undefined;
    this.tools = 0;
    this.lastTool = undefined;
  }

  private cardId(): string {
    return `${this.id}-${this.part}`;
  }

  private render(texts: Entry[], status: string): string {
    const m = this.meta;
    const head = [`🤖 **${escapeMd(m?.agentType ?? "Субагент")}**`, ...[m?.description, m?.model].filter(s => s !== undefined && s !== "").map(s => escapeMd(s ?? ""))].join(" · ");
    return [`${head}\n${status}`, ...texts.map(e => `\`[${clock(e.at)}]\`${STARTS_WITH_BLOCK.test(e.text) ? "\n" : " "}${e.text}`)].join("\n\n");
  }

  private statusLine(): string {
    if (this.isWaiting()) return `⏸ ждёт фоновую задачу · ${duration(this.env.now() - (this.ended ?? this.env.now()))}`;
    const took = duration((this.ended ?? this.env.now()) - this.started);
    const acts = `${this.tools} ${plural(this.tools, "действие", "действия", "действий")}`;
    switch (this.status) {
      case "running":
        return `⏳ ${took} · ${acts}${this.lastTool ? ` · \`${this.lastTool.replaceAll("`", "'")}\`` : ""}`;
      case "done":
        return `✅ готово за ${took} · ${acts}`;
      case "failed":
        return `❌ ошибка через ${took} · ${acts}`;
      case "stopped":
        return `⏹ остановлен через ${took} · ${acts}`;
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
// already there at start are followed from their current end.
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
    },
  ) {
    this.env = {
      send: card => opts.onCard(card),
      canStart: () => opts.canStart(),
      now: opts.now ?? Date.now,
      sendEveryMs: opts.sendEveryMs ?? SEND_EVERY_MS,
      log: opts.log ?? nullLogger,
    };
  }

  start(): void {
    for (const id of this.ids()) this.agents.set(id, new Agent(id, this.opts.dir, false, this.env));
    this.timer = setInterval(() => this.tick(), this.opts.intervalMs ?? SCAN_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.agents.clear();
  }

  // From a task notification in the main transcript.
  taskStatus(taskId: string, status: string): void {
    const s = TASK_STATUSES[status];
    if (s) this.agents.get(taskId)?.finish(s, undefined, true);
  }

  tick(): void {
    for (const id of this.ids()) if (!this.agents.has(id)) this.agents.set(id, new Agent(id, this.opts.dir, true, this.env));
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

// Russian plural forms: 1 действие, 2 действия, 5 действий.
function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return one;
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return few;
  return many;
}
