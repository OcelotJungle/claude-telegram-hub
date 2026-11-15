// What the plugin's function hooks module does with commands from the topic.
// The module runs inside Claude Code with no Node: everything outside comes
// in as Deps (the engine's `$` calls), so this file imports only types and
// plain helpers from shared/ that need nothing at run time.
import type { CleanupReport, Language, ResolutionKind, TopicCommand } from "../shared/protocol.ts";
import type { InfoData } from "../shared/info-data.ts";
import type { MessageKind } from "../shared/notification.ts";
import type { Messages } from "../shared/i18n/index.ts";

import { catalogOf, DEFAULT_LANGUAGE, isLanguage } from "../shared/i18n/index.ts";
import { isBlockError, parseInfoData, RIG_QUERY_LIMIT_MS } from "../shared/info-data.ts";
import { field, str } from "../shared/guards.ts";
import { notifies } from "../shared/notification.ts";
import { MILLION, THOUSAND, tokens } from "../shared/tokens.ts";

// /stop of a session with more context than this compacts it first, so a
// resume does not cache all of it again.
const STOP_COMPACT_TOKENS = 120_000;
// The order of the limits in /info; others go after these.
const LIMIT_ORDER = ["five_hour", "seven_day"];
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const FIVE_HOUR_MINUTES = 5 * MINUTES_PER_HOUR;
const SEVEN_DAY_MINUTES = 7 * HOURS_PER_DAY * MINUTES_PER_HOUR;
const HTTP_OK = 200;
const MS_PER_SECOND = 1000;
// The hub waits for rig up to RIG_QUERY_LIMIT_MS; the window waits that long and a margin for the hub itself, so a
// slow rig is answered by the hub's own failure text and never cut off by the window first.
const HUB_MARGIN_MS = 5000;
const INFO_WAIT_MS = RIG_QUERY_LIMIT_MS + HUB_MARGIN_MS;
// The code of a block rig has nothing to show for yet (before the model's first reply).
const NO_DATA_CODE = "no-data";
// rig gives the providers' raw names; these are shown with their own spelling.
const PROVIDER_NAMES: Record<string, string> = {
  openrouter: "OpenRouter",
  requesty: "Requesty",
  groq: "Groq",
  // Not "Z.ai": Telegram turns a domain-like name into a link.
  zhipu: "Zhipu",
};
// Limits read longer ago than this say how old they are.
const STALE_LIMITS_MS = 300_000;
// Polls in a row on which the compaction failed with no turn running before
// the failure is reported: a turn may start just as it is tried.
const COMPACT_TRIES = 3;

// The part of the engine's SessionUsage that /stop looks at.
export type Usage = {
  context: {
    tokens?: number;
    window: number;
    breakdown?: { totalTokens: number; rawMaxTokens: number; autoCompactThreshold?: number; isAutoCompactEnabled: boolean };
  };
};

// The part of the engine's session.compact result the report needs.
export type Compaction = { tokensBefore?: number; tokensAfter?: number; skip?: string };

// How a compaction ended: the engine's result, or the error of its last try.
type Outcome = { ok: Compaction } | { error: string };
type Target = { sessionId: string; id: string };

export type Deps = {
  sessionId(): Promise<string>;
  usage(): Promise<Usage>;
  // Runs a slash command as if typed in the terminal: queued until the
  // session is idle.
  run(command: string, args: string): Promise<{ text?: string }>;
  // Compacts the conversation; rejects while a turn runs.
  compact(instructions: string | undefined): Promise<Compaction>;
  http(url: string, init?: { method?: string; body?: string }): Promise<{ status: number; text: string }>;
  // Resolves after the given time; /info gives the hub this long to answer.
  sleep(ms: number): Promise<void>;
  now(): number;
};

export class Runner {
  private polling = false;
  // Replies, terminate requests and cleanup reports the hub has not taken yet, oldest first;
  // retried on every poll.
  private unsent: { path: string; body: string }[] = [];
  private flushing: Promise<void> | undefined;
  // Compactions asked for from the topic, oldest first, each run once no
  // turn runs; `failed` counts the tries that failed with none running.
  // `report` hands the outcome on: a reply to /compact, a report to the hub
  // for /cleanup.
  private compactions: { args: string; failed: number; report: (o: Outcome) => Promise<void>; done: () => void; show?: (running: boolean) => Promise<void>; shown: boolean }[] = [];
  private compacting = false;
  // Whether a main-loop turn runs, from the module's turn hooks.
  private turnRuns = false;
  // Compact commands still running; a /stop waits for them.
  private running = new Set<Promise<void>>();
  private replies = new Map<string, number>();
  // The language of the topic as last known; a command brings it, and later texts ask the hub again.
  private language: Language = DEFAULT_LANGUAGE;
  private languageAsked = 0;
  private languageSeen = 0;

  constructor(
    private base: string,
    private deps: Deps,
  ) {}

  // Called by the module's timer. Commands run without blocking the next
  // poll: a compaction waits for the turn to end.
  async poll(): Promise<void> {
    void this.compactNext();
    if (this.polling) return;
    this.polling = true;
    try {
      await this.flush();
      const sessionId = await this.deps.sessionId();
      const res = await this.deps.http(`${this.base}/commands?session=${encodeURIComponent(sessionId)}&stop=1&cleanup=1`);
      if (res.status !== 200) return;
      for (const cmd of topicCommands(res.text)) void this.execute(sessionId, cmd);
    } catch {
      // The hub is down or restarting: the next poll tries again.
    } finally {
      this.polling = false;
    }
  }

  // Called from the module's turn hooks when a main-loop turn starts and ends.
  turn(runs: boolean): void {
    this.turnRuns = runs;
  }

  // The catalog for the language the topic has now. The language can change while a command is still running
  // (a compaction waits for the turn), so each text made later asks the hub; if it cannot be asked, the last known stands.
  private async messages(): Promise<Messages> {
    const ticket = ++this.languageAsked;
    try {
      const res = await this.deps.http(`${this.base}/language`);
      if (res.status === 200) {
        const value: unknown = JSON.parse(res.text);
        const language = typeof value === "object" && value !== null && "language" in value ? value.language : undefined;
        // An answer older than one already used is dropped.
        if (isLanguage(language) && ticket > this.languageSeen) {
          this.languageSeen = ticket;
          this.language = language;
        }
      }
    } catch {
      // The hub is down or restarting: the last known language stands.
    }
    return catalogOf(this.language);
  }

  private async execute(sessionId: string, cmd: TopicCommand): Promise<void> {
    const to = { sessionId, id: cmd.id };
    // The hub sends the language with each command; English until it does.
    this.language = cmd.language ?? DEFAULT_LANGUAGE;
    this.languageSeen = this.languageAsked;
    const m = catalogOf(this.language);
    if (cmd.name === "info") {
      try {
        await this.info(to, m);
      } catch (e) {
        await this.reply(to, m.commandFailed({ command: "/info", error: message(e) }), "error");
      }
      return;
    }
    if (cmd.name === "stop") return this.stop(to, m);
    if (cmd.name === "cleanup") return this.cleanup(to, cmd.args, m);
    if (cmd.name === "rename") return this.rename(to, cmd.args, m);
    const window = autocompactArg(cmd.args);
    if (window !== undefined) {
      const command = `/autocompact ${window}`;
      try {
        const res = await this.deps.run("autocompact", window);
        await this.reply(to, res.text?.trim() || m.commandDone({ command }), "info");
      } catch (e) {
        await this.reply(to, m.commandFailed({ command, error: message(e) }), "error");
      }
      return;
    }
    await this.compact(to, cmd.args, m, messages => messages.compactQueued, messages => messages.compactRunning);
  }

  // The hub asks rig for the data; a failure comes back as the text to show.
  private async info(to: Target, m: Messages): Promise<void> {
    const answer = await this.askHubForInfo(to.sessionId, m);
    if ("data" in answer) await this.reply(to, infoText(answer.data, this.deps.now(), m), "info");
    else await this.reply(to, answer.failure, "error");
  }

  // The hub's answer, or the text of the failure: the hub's own (rig failed) or the window's catalog text for a
  // hub that is unreachable, too slow or answers something unreadable.
  private async askHubForInfo(sessionId: string, m: Messages): Promise<{ data: InfoData } | { failure: string }> {
    const timedOut = this.deps.sleep(INFO_WAIT_MS).then(() => "timeout" as const);
    let res: Awaited<ReturnType<Deps["http"]>> | "timeout";
    try {
      res = await Promise.race([this.deps.http(`${this.base}/info?session=${encodeURIComponent(sessionId)}`), timedOut]);
    } catch (e) {
      return { failure: m.infoHubUnreachable({ error: message(e) }) };
    }
    if (res === "timeout") return { failure: m.infoHubTimeout({ seconds: INFO_WAIT_MS / MS_PER_SECOND }) };
    const badReply = { failure: m.infoHubBadReply({ status: res.status }) };
    let body: unknown;
    try {
      body = JSON.parse(res.text);
    } catch {
      return badReply;
    }
    if (res.status === HTTP_OK) {
      const data = parseInfoData(body);
      return data ? { data } : badReply;
    }
    const failure = str(field(body, "failure"));
    return failure === undefined ? badReply : { failure };
  }

  // Resolves once the compaction is over and its result is handed to the hub.
  private async compact(to: Target, args: string, m: Messages, started: (m: Messages) => string, running: (m: Messages) => string): Promise<void> {
    const run = (async () => {
      const startedId = await this.reply(to, started(m), "info", undefined, true);
      const show = async (isRunning: boolean) => {
        const now = await this.messages();
        await this.reply(to, isRunning ? running(now) : started(now), "info", { id: startedId, kind: "progress" });
      };
      const report = async (o: Outcome): Promise<void> => {
        const success = "ok" in o && o.ok.skip === undefined;
        const now = await this.messages();
        await this.reply(
          to,
          "ok" in o ? compactionText(o.ok, now) : now.compactFailed({ error: o.error }),
          "error" in o ? "error" : o.ok.skip !== undefined ? "warning" : "info",
          { id: startedId, kind: success ? "success" : "warning" },
        );
      };
      await new Promise<void>(done => this.compactions.push({ args, failed: 0, report, done, show, shown: false }));
    })();
    this.running.add(run);
    await run;
    this.running.delete(run);
  }

  // /cleanup: compacts after the compactions already asked for, then tells
  // the hub the sizes or the error. The hub ends the window and empties the
  // remembered skills.
  private async cleanup(to: Target, args: string, m: Messages): Promise<void> {
    const startedId = await this.reply(to, m.cleanupQueued, "info", undefined, true);
    const show = async (isRunning: boolean) => {
      const now = await this.messages();
      await this.reply(to, isRunning ? now.cleanupRunning : now.cleanupQueued, "info", { id: startedId, kind: "progress" });
    };
    await Promise.all(this.running);
    const report = async (o: Outcome) => {
      const body: CleanupReport = { sessionId: to.sessionId, id: to.id };
      if ("error" in o) body.error = o.error;
      else if (o.ok.skip !== undefined) body.error = o.ok.skip;
      else {
        if (o.ok.tokensBefore !== undefined) body.before = o.ok.tokensBefore;
        if (o.ok.tokensAfter !== undefined) body.after = o.ok.tokensAfter;
      }
      this.unsent.push({ path: "/cleanup", body: JSON.stringify(body) });
      await this.flush();
    };
    await new Promise<void>(done => this.compactions.push({ args, failed: 0, report, done, show, shown: false }));
  }

  // /rename <name> runs the session's own /rename once the session is idle;
  // the topic follows the new title through the hub's retitle, not here.
  private async rename(to: Target, name: string, m: Messages): Promise<void> {
    const normalizedName = name.replace(/\s+/g, " ").trim();
    if (!normalizedName) {
      await this.reply(to, m.renameHint, "info");
      return;
    }
    const command = `/rename ${normalizedName}`;
    const startedId = await this.reply(to, m.renameQueued, "info", undefined, true);
    try {
      await this.deps.run("rename", normalizedName);
      await this.reply(to, (await this.messages()).commandDone({ command }), "info", { id: startedId, kind: "success" });
    } catch (e) {
      await this.reply(to, (await this.messages()).commandFailed({ command, error: message(e) }), "warning", { id: startedId, kind: "warning" });
    }
  }

  // The engine's own result, not the session.compact hook: the compact
  // command this module ran never reached the module's hook. One at a time,
  // between turns.
  private async compactNext(): Promise<void> {
    const head = this.compactions[0];
    if (!head || this.compacting) return;
    if (this.turnRuns) {
      // A try that lost to a starting turn waits again, and says so.
      if (head.shown) {
        head.shown = false;
        await head.show?.(false);
      }
      return;
    }
    this.compacting = true;
    if (!head.shown) {
      head.shown = true;
      await head.show?.(true);
    }
    let outcome: Outcome | undefined;
    try {
      outcome = { ok: await this.deps.compact(head.args || undefined) };
    } catch (e) {
      // Failed with a turn running, or one just starting: tried again.
      if (!this.turnRuns && ++head.failed >= COMPACT_TRIES) outcome = { error: message(e) };
    }
    if (outcome !== undefined) {
      this.compactions.shift();
      await head.report(outcome);
      head.done();
    }
    this.compacting = false;
  }

  // The window ends once the compactions asked for are over; with much
  // context, after one more. A second /stop in the topic does not wait.
  private async stop(to: { sessionId: string; id: string }, m: Messages): Promise<void> {
    if (this.running.size) {
      await this.reply(to, m.stopAfterCompact, "info", undefined, true);
      await Promise.all(this.running);
    }
    const used = await this.contextTokens();
    if (used !== undefined && used > STOP_COMPACT_TOKENS) {
      await this.compact(to, "", m, messages => messages.stopCompactQueued, messages => messages.stopCompactRunning);
    }
    this.unsent.push({ path: "/terminate", body: JSON.stringify({ sessionId: to.sessionId, id: to.id }) });
    await this.flush();
  }

  // The status line's figure, else the local estimate (right after a
  // compaction); undefined when the engine cannot tell.
  private async contextTokens(): Promise<number | undefined> {
    try {
      const u = await this.deps.usage();
      return u.context.tokens ?? u.context.breakdown?.totalTokens;
    } catch {
      return undefined;
    }
  }

  private async reply(to: { sessionId: string; id: string }, text: string, kind: MessageKind, replaces?: { id: string; kind: ResolutionKind }, awaitsResult?: true): Promise<string> {
    const n = this.replies.get(to.id) ?? 0;
    this.replies.set(to.id, n + 1);
    const id = `${to.id}.${n}`;
    this.unsent.push({ path: "/reply", body: JSON.stringify({ sessionId: to.sessionId, id, text, notify: notifies(kind), ...(replaces ? { replaces } : {}), ...(awaitsResult ? { awaitsResult } : {}) }) });
    await this.flush();
    return id;
  }

  // One at a time: the poll and a finishing command both flush, and two
  // loops over the same head would each shift it off.
  private flush(): Promise<void> {
    this.flushing ??= this.send().finally(() => (this.flushing = undefined));
    return this.flushing;
  }

  private async send(): Promise<void> {
    for (let head = this.unsent[0]; head; head = this.unsent[0]) {
      try {
        const res = await this.deps.http(`${this.base}${head.path}`, { method: "POST", body: head.body });
        if (res.status !== 200) return;
      } catch {
        return;
      }
      this.unsent.shift();
    }
  }
}

// The /info answer from rig's data. Ages and reset times come from the data's own times.
export function infoText(d: InfoData, now: number, m: Messages): string {
  const lines: string[] = [];
  const staleAge = (at: string | null) => {
    const age = at === null ? NaN : now - Date.parse(at);
    return age >= STALE_LIMITS_MS ? duration(age, m) : undefined;
  };
  const resetLeft = (resetsAt: string | null) => (resetsAt === null ? NaN : Date.parse(resetsAt) - now);
  const resetIn = (left: number) => (left > 0 ? duration(left, m) : undefined);
  const order = (kind: string) => (LIMIT_ORDER.includes(kind) ? LIMIT_ORDER.indexOf(kind) : LIMIT_ORDER.length);
  if (isBlockError(d.claude)) lines.push(d.claude.error.code === NO_DATA_CODE ? m.infoClaudeNoData : m.infoClaudeUnavailable({ reason: d.claude.error.message }));
  else if (!d.claude.limits.length) lines.push(m.infoClaudeNoData);
  else {
    lines.push(m.infoClaudeLimits({ age: staleAge(d.claude.at) }));
    for (const l of [...d.claude.limits].sort((a, b) => order(a.kind) - order(b.kind))) {
      lines.push(m.infoLimitLine({ name: limitName(l.kind, m), percent: l.percentUsed, resetIn: resetIn(resetLeft(l.resetsAt)) }));
    }
  }
  const codex = d.codex;
  if (codex && isBlockError(codex)) lines.push("", m.infoCodexUnavailable({ reason: codex.error.message }));
  else if (codex) {
    lines.push("", m.infoCodexLimits({ age: staleAge(codex.at) }));
    const named = codex.limits.map(l => ({ ...l, kind: codexKind(l.windowMinutes) }));
    for (const l of named.sort((a, b) => order(a.kind) - order(b.kind))) {
      const left = resetLeft(l.resetsAt);
      // A window whose reset has passed is empty again.
      lines.push(m.infoLimitLine({ name: limitName(l.kind, m), percent: left <= 0 ? 0 : Math.round(l.usedPercent), resetIn: resetIn(left) }));
    }
  }
  const volunteers = d.volunteers;
  if (volunteers && isBlockError(volunteers)) lines.push("", m.infoVolunteerUnavailable({ reason: volunteers.error.message }));
  else if (volunteers) {
    lines.push("", m.infoVolunteerLimits({ age: staleAge(volunteers.at) }));
    const left = resetLeft(volunteers.resetsAt);
    if (left > 0) lines.push(m.infoVolunteerDay({ percent: Math.round(volunteers.dayPercent), resetIn: duration(left, m) }));
    else lines.push(m.infoVolunteerDay({ percent: 0, resetIn: undefined }));
    // A provider without a limit is not shown.
    for (const [name, p] of Object.entries(volunteers.providers)) {
      if (p.cap !== null) lines.push(`${PROVIDER_NAMES[name] ?? name}: ${p.used}/${p.cap}`);
    }
  }
  const c = d.context;
  // rig's context comes from its stored reading, so its age is shown like the limits'.
  lines.push("", m.infoContext({ age: isBlockError(c) ? undefined : staleAge(c.at) }));
  if (isBlockError(c)) lines.push(c.error.code === NO_DATA_CODE ? m.infoNoData : m.infoContextUnavailable({ reason: c.error.message }));
  else {
    // rig marks the figure as a local estimate when the status line's is gone (after a compaction).
    const approx = c.estimated === true ? "≈" : "";
    if (c.autocompact === true && c.threshold !== undefined) lines.push(`${approx}${Math.round(c.tokens / THOUSAND)}/${Math.round(c.threshold / THOUSAND)}k`);
    else lines.push(`${approx}${tokens(c.tokens)}`);
  }
  return lines.join("\n");
}

export function compactionText(c: Compaction, m: Messages): string {
  if (c.skip !== undefined) return m.compactSkipped({ reason: c.skip });
  return m.compactDone;
}

// `/compact <N>` with a token count (333000, 333k, 1.5m) or `auto` sets the
// autocompact window; the value for /autocompact, or undefined when the
// arguments are instructions for the summary.
export function autocompactArg(args: string): string | undefined {
  const a = args.trim().toLowerCase();
  if (a === "auto") return a;
  const m = a.match(/^(\d+(?:\.\d+)?)([km]?)$/);
  if (!m) return undefined;
  return String(Math.round(Number(m[1]) * (m[2] === "k" ? THOUSAND : m[2] === "m" ? MILLION : 1)));
}

function duration(ms: number, m: Messages): string {
  const total = Math.max(1, Math.round(ms / MS_PER_MINUTE));
  if (total < MINUTES_PER_HOUR) return `${total} ${m.unitMinute}`;
  const h = Math.floor(total / MINUTES_PER_HOUR);
  const min = total % MINUTES_PER_HOUR;
  if (h < HOURS_PER_DAY) return min ? `${h} ${m.unitHour} ${min} ${m.unitMinute}` : `${h} ${m.unitHour}`;
  const d = Math.floor(h / HOURS_PER_DAY);
  return h % HOURS_PER_DAY ? `${d} ${m.unitDay} ${h % HOURS_PER_DAY} ${m.unitHour}` : `${d} ${m.unitDay}`;
}

// Limits of other lengths are named by the minutes in the kind ("90m").
const MINUTES_KIND = /^(\d+)m$/;

// Codex names its windows by length: the 5-hour and the 7-day ones are the Claude limits' kinds.
function codexKind(windowMinutes: number): string {
  if (windowMinutes === FIVE_HOUR_MINUTES) return "five_hour";
  if (windowMinutes === SEVEN_DAY_MINUTES) return "seven_day";
  return `${windowMinutes}m`;
}

function limitName(kind: string, m: Messages): string {
  if (kind === "five_hour") return m.limitFiveHour;
  if (kind === "seven_day") return m.limitSevenDay;
  const minutes = MINUTES_KIND.exec(kind)?.[1];
  return minutes === undefined ? kind : duration(Number(minutes) * MS_PER_MINUTE, m);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// The commands in the hub's answer; anything else in it is skipped.
function topicCommands(json: string): TopicCommand[] {
  const list: unknown = JSON.parse(json);
  return Array.isArray(list) ? list.filter(isTopicCommand) : [];
}

function isTopicCommand(v: unknown): v is TopicCommand {
  if (typeof v !== "object" || v === null) return false;
  const name = "name" in v ? v.name : undefined;
  const language = "language" in v ? v.language : undefined;
  if (language !== undefined && !isLanguage(language)) return false;
  return "id" in v && typeof v.id === "string" && (name === "info" || name === "compact" || name === "stop" || name === "cleanup" || name === "rename") && "args" in v && typeof v.args === "string";
}
