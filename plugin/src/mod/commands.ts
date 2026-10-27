// What the plugin's function hooks module does with commands from the topic.
// The module runs inside Claude Code with no Node: everything outside comes
// in as Deps (the engine's `$` calls), so this file imports only types and
// plain helpers from shared/ that need nothing at run time.
import type { CleanupReport, LimitsReading, RateLimit, TopicCommand, VolunteerLimitsResult } from "../shared/protocol.ts";

import { MILLION, THOUSAND, tokens } from "../shared/tokens.ts";

function isVolunteerLimitsResult(v: unknown): v is VolunteerLimitsResult {
  if (typeof v !== "object" || v === null || !("kind" in v)) return false;
  if (v.kind === "none") return true;
  if (v.kind === "error") return "reason" in v && typeof v.reason === "string";
  if (v.kind !== "ok") return false;
  return (
    "at" in v && typeof v.at === "number" &&
    "dayPercent" in v && typeof v.dayPercent === "number" &&
    (!("resetsAt" in v) || typeof v.resetsAt === "number") &&
    "providers" in v && Array.isArray(v.providers) &&
    v.providers.every((p: unknown) => {
      if (typeof p !== "object" || p === null) return false;
      return (
        "name" in p && typeof p.name === "string" &&
        "used" in p && typeof p.used === "number" &&
        "cap" in p && (p.cap === null || typeof p.cap === "number")
      );
    })
  );
}

// /stop of a session with more context than this compacts it first, so a
// resume does not cache all of it again.
const STOP_COMPACT_TOKENS = 120_000;
const LIMIT_NAMES: Record<string, string> = { five_hour: "5 часов", seven_day: "Неделя" };
// The order of the limits in /info; others go after these.
const LIMIT_ORDER = ["five_hour", "seven_day"];
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const PERCENT = 100;
// Limits read longer ago than this say how old they are.
const STALE_LIMITS_MS = 300_000;
// Polls in a row on which the compaction failed with no turn running before
// the failure is reported: a turn may start just as it is tried.
const COMPACT_TRIES = 3;

// The part of the engine's SessionUsage that /info shows.
export type Usage = {
  context: {
    tokens?: number;
    window: number;
    breakdown?: { totalTokens: number; rawMaxTokens: number; autoCompactThreshold?: number; isAutoCompactEnabled: boolean };
  };
  rateLimits: RateLimit[];
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
  private compactions: { args: string; failed: number; report: (o: Outcome) => Promise<void>; done: () => void }[] = [];
  private compacting = false;
  // Whether a main-loop turn runs, from the module's turn hooks.
  private turnRuns = false;
  // Compact commands still running; a /stop waits for them.
  private running = new Set<Promise<void>>();
  private replies = new Map<string, number>();

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

  // Called from the module's session.measure hook: the session read the
  // account's rate limits, which the hub keeps for the other sessions' /info.
  async measured(rateLimits: RateLimit[]): Promise<void> {
    if (!rateLimits.length) return;
    try {
      const sessionId = await this.deps.sessionId();
      await this.deps.http(`${this.base}/limits`, { method: "POST", body: JSON.stringify({ sessionId, at: this.deps.now(), rateLimits }) });
    } catch {
      // The hub is down: /info shows the session's own reading.
    }
  }

  // Called from the module's turn hooks when a main-loop turn starts and ends.
  turn(runs: boolean): void {
    this.turnRuns = runs;
  }

  private async execute(sessionId: string, cmd: TopicCommand): Promise<void> {
    const to = { sessionId, id: cmd.id };
    if (cmd.name === "info") {
      try {
        const usage = await this.deps.usage();
        const [shared, codex, volunteer] = await Promise.all([
          this.sharedLimits(sessionId),
          this.codexLimits(),
          this.volunteerLimits(),
        ]);
        await this.reply(
          to,
          infoText(shared ? { ...usage, rateLimits: shared.rateLimits } : usage, this.deps.now(), shared?.at, codex, volunteer),
          true
        );
      } catch (e) {
        await this.reply(to, `⚠️ /info не выполнена: ${message(e)}`, true);
      }
      return;
    }
    if (cmd.name === "stop") return this.stop(to);
    if (cmd.name === "cleanup") return this.cleanup(to, cmd.args);
    const window = autocompactArg(cmd.args);
    if (window !== undefined) {
      try {
        const res = await this.deps.run("autocompact", window);
        await this.reply(to, res.text?.trim() || `✅ /autocompact ${window} выполнена.`, true);
      } catch (e) {
        await this.reply(to, `⚠️ /autocompact ${window} не выполнена: ${message(e)}`, true);
      }
      return;
    }
    await this.compact(to, cmd.args, "🗜 Компакт запущен: начнётся, как только агент закончит текущий ход.");
  }

  // Resolves once the compaction is over and its result is handed to the hub.
  private async compact(to: Target, args: string, started: string): Promise<void> {
    const run = (async () => {
      await this.reply(to, started, false);
      const report = (o: Outcome) => this.reply(to, "ok" in o ? compactionText(o.ok) : `⚠️ Компакт не выполнен: ${o.error}`, true);
      await new Promise<void>(done => this.compactions.push({ args, failed: 0, report, done }));
    })();
    this.running.add(run);
    await run;
    this.running.delete(run);
  }

  // /cleanup: compacts after the compactions already asked for, then tells
  // the hub the sizes or the error. The hub ends the window and empties the
  // remembered skills.
  private async cleanup(to: Target, args: string): Promise<void> {
    await this.reply(to, "🧹 Сожму контекст, когда агент закончит ход, уберу накопившиеся скиллы и завершу сессию.", false);
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
    await new Promise<void>(done => this.compactions.push({ args, failed: 0, report, done }));
  }

  // The engine's own result, not the session.compact hook: the compact
  // command this module ran never reached the module's hook. One at a time,
  // between turns.
  private async compactNext(): Promise<void> {
    const head = this.compactions[0];
    if (!head || this.compacting || this.turnRuns) return;
    this.compacting = true;
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
  private async stop(to: { sessionId: string; id: string }): Promise<void> {
    if (this.running.size) {
      await this.reply(to, "⏳ Завершу сессию, когда закончится компакт. Повторный /stop завершит сразу.", false);
      await Promise.all(this.running);
    }
    const used = await this.contextTokens();
    if (used !== undefined && used > STOP_COMPACT_TOKENS) {
      await this.compact(to, "", `🗜 В контексте ${tokens(used)} токенов: сожму его, когда агент закончит ход, и завершу сессию. Повторный /stop завершит сразу.`);
    }
    this.unsent.push({ path: "/terminate", body: JSON.stringify({ sessionId: to.sessionId, id: to.id }) });
    await this.flush();
  }

  // The freshest reading of the account's rate limits any session posted;
  // undefined when the hub has none or cannot be asked.
  private async sharedLimits(sessionId: string): Promise<LimitsReading | undefined> {
    try {
      const res = await this.deps.http(`${this.base}/limits?session=${encodeURIComponent(sessionId)}`);
      if (res.status !== 200) return undefined;
      const v: unknown = JSON.parse(res.text);
      return isLimitsReading(v) && v.rateLimits.length ? v : undefined;
    } catch {
      return undefined;
    }
  }

  private async codexLimits(): Promise<LimitsReading | undefined> {
    try {
      const res = await this.deps.http(`${this.base}/codex-limits`);
      if (res.status !== 200) return undefined;
      const value: unknown = JSON.parse(res.text);
      return isLimitsReading(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private async volunteerLimits(): Promise<VolunteerLimitsResult | undefined> {
    try {
      const res = await this.deps.http(`${this.base}/volunteer-limits`);
      if (res.status !== 200) return undefined;
      const value: unknown = JSON.parse(res.text);
      return isVolunteerLimitsResult(value) ? value : undefined;
    } catch {
      return undefined;
    }
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

  private async reply(to: { sessionId: string; id: string }, text: string, notify: boolean): Promise<void> {
    const n = this.replies.get(to.id) ?? 0;
    this.replies.set(to.id, n + 1);
    this.unsent.push({ path: "/reply", body: JSON.stringify({ sessionId: to.sessionId, id: `${to.id}.${n}`, text, notify }) });
    await this.flush();
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

// limitsAt: when the limits were read, if known.
export function infoText(
  u: Usage,
  now: number,
  limitsAt?: number,
  codex?: LimitsReading,
  volunteer?: VolunteerLimitsResult
): string {
  const lines: string[] = [];
  if (!u.rateLimits.length) lines.push("Лимиты Claude: нет данных — появятся после первого ответа модели");
  else {
    const age = limitsAt === undefined ? 0 : now - limitsAt;
    lines.push(age >= STALE_LIMITS_MS ? `**Лимиты Claude** (данные ${duration(age)} назад)` : "**Лимиты Claude**");
    const order = (kind: string) => (LIMIT_ORDER.includes(kind) ? LIMIT_ORDER.indexOf(kind) : LIMIT_ORDER.length);
    for (const l of [...u.rateLimits].sort((a, b) => order(a.kind) - order(b.kind))) {
      const left = l.resetsAt ? Date.parse(l.resetsAt) - now : NaN;
      lines.push(`${LIMIT_NAMES[l.kind] ?? l.kind}: ${l.percentUsed}%${left > 0 ? ` (сброс через ${duration(left)})` : ""}`);
    }
  }
  if (codex) {
    const age = now - codex.at;
    lines.push("", age >= STALE_LIMITS_MS ? `**Лимиты Codex** (данные ${duration(age)} назад)` : "**Лимиты Codex**");
    const order = (kind: string) => (LIMIT_ORDER.includes(kind) ? LIMIT_ORDER.indexOf(kind) : LIMIT_ORDER.length);
    for (const limit of [...codex.rateLimits].sort((a, b) => order(a.kind) - order(b.kind))) {
      const left = limit.resetsAt ? Date.parse(limit.resetsAt) - now : NaN;
      const percent = left <= 0 ? 0 : Math.round(limit.percentUsed);
      lines.push(`${LIMIT_NAMES[limit.kind] ?? limit.kind}: ${percent}%${left > 0 ? ` (сброс через ${duration(left)})` : ""}`);
    }
  }
  if (volunteer) {
    if (volunteer.kind === "ok") {
      const age = now - volunteer.at;
      lines.push("", age >= STALE_LIMITS_MS ? `**Лимиты волонтёров** (данные ${duration(age)} назад)` : "**Лимиты волонтёров**");
      const resetsLeft = volunteer.resetsAt ? volunteer.resetsAt - now : NaN;
      if (resetsLeft > 0) {
      lines.push(`День: ${Math.round(volunteer.dayPercent)}% (сброс через ${duration(resetsLeft)})`);
      } else {
        lines.push("День: 0%");
      }
      const providerLines = volunteer.providers.map((p) =>
        p.cap !== null ? `${p.name} ${p.used}/${p.cap}` : `${p.name} ${p.used} запр.`
      );
      lines.push(providerLines.join(" · "));
    } else if (volunteer.kind === "error") {
      lines.push("", `Лимиты волонтёров: нет данных — ${volunteer.reason}`);
    }
    // kind === "none" produces no block
  }
  lines.push("", "**Контекст**");
  const b = u.context.breakdown;
  // The status line's figure; after a compaction it is gone until the next
  // model response, and the local estimate stands in.
  const used = u.context.tokens ?? b?.totalTokens;
  if (used === undefined) lines.push("Сейчас: нет данных");
  else lines.push(u.context.tokens !== undefined ? `Сейчас: ${tokens(used)} токенов` : `Сейчас: ≈${tokens(used)} токенов (оценка)`);
  if (!b) return lines.join("\n");
  if (!b.isAutoCompactEnabled) {
    lines.push("Автокомпакт: выключен");
    return lines.join("\n");
  }
  const limit = b.autoCompactThreshold ?? b.rawMaxTokens;
  lines.push(`Автокомпакт: окно ${tokens(b.rawMaxTokens)}${b.autoCompactThreshold !== undefined ? `, срабатывает на ${tokens(b.autoCompactThreshold)}` : ""}`);
  if (used !== undefined) lines.push(`Использовано ${Math.round((used / limit) * PERCENT)}% до автокомпакта`);
  return lines.join("\n");
}

export function compactionText(c: Compaction): string {
  if (c.skip !== undefined) return `⚠️ Компакт пропущен: ${c.skip}`;
  const sizes = c.tokensBefore !== undefined && c.tokensAfter !== undefined ? `: ${tokens(c.tokensBefore)} → ${tokens(c.tokensAfter)} токенов` : "";
  return `✅ Контекст сжат${sizes}.`;
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

function duration(ms: number): string {
  const min = Math.max(1, Math.round(ms / MS_PER_MINUTE));
  if (min < MINUTES_PER_HOUR) return `${min} мин`;
  const h = Math.floor(min / MINUTES_PER_HOUR);
  const m = min % MINUTES_PER_HOUR;
  if (h < HOURS_PER_DAY) return m ? `${h} ч ${m} мин` : `${h} ч`;
  const d = Math.floor(h / HOURS_PER_DAY);
  return h % HOURS_PER_DAY ? `${d} д ${h % HOURS_PER_DAY} ч` : `${d} д`;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// The commands in the hub's answer; anything else in it is skipped.
function topicCommands(json: string): TopicCommand[] {
  const list: unknown = JSON.parse(json);
  return Array.isArray(list) ? list.filter(isTopicCommand) : [];
}

function isLimitsReading(v: unknown): v is LimitsReading {
  if (typeof v !== "object" || v === null || !("at" in v) || typeof v.at !== "number" || !("rateLimits" in v) || !Array.isArray(v.rateLimits)) return false;
  return v.rateLimits.every(isRateLimit);
}

function isRateLimit(v: unknown): v is RateLimit {
  if (typeof v !== "object" || v === null) return false;
  if (!("kind" in v) || typeof v.kind !== "string" || !("percentUsed" in v) || typeof v.percentUsed !== "number") return false;
  return !("resetsAt" in v) || v.resetsAt === undefined || typeof v.resetsAt === "string";
}

function isTopicCommand(v: unknown): v is TopicCommand {
  if (typeof v !== "object" || v === null) return false;
  const name = "name" in v ? v.name : undefined;
  return "id" in v && typeof v.id === "string" && (name === "info" || name === "compact" || name === "stop" || name === "cleanup") && "args" in v && typeof v.args === "string";
}
