// What the plugin's function hooks module does with commands from the topic.
// The module runs inside Claude Code with no Node: everything outside comes
// in as Deps (the engine's `$` calls), so this file imports nothing but types.
import type { CommandReply, TopicCommand } from "../shared/protocol.ts";

// The part of the engine's SessionUsage that /info shows.
export type Usage = {
  context: {
    tokens?: number;
    window: number;
    breakdown?: { totalTokens: number; rawMaxTokens: number; autoCompactThreshold?: number; isAutoCompactEnabled: boolean };
  };
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[];
};

// The part of the engine's session.compact result the report needs.
export type Compaction = { tokensBefore?: number; tokensAfter?: number; skip?: string };

export type Deps = {
  sessionId(): Promise<string>;
  usage(): Promise<Usage>;
  // Runs a slash command as if typed in the terminal: queued until the
  // session is idle.
  run(command: string, args: string): Promise<{ text?: string }>;
  http(url: string, init?: { method?: string; body?: string }): Promise<{ status: number; text: string }>;
  now(): number;
};

export class Runner {
  private polling = false;
  // Replies the hub has not taken yet, oldest first; retried on every poll.
  private unsent: CommandReply[] = [];
  private flushing: Promise<void> | undefined;
  // /compact commands from the topic waiting for their compaction.
  private compacting: { sessionId: string; id: string }[] = [];
  private replies = new Map<string, number>();

  constructor(
    private base: string,
    private deps: Deps,
  ) {}

  // Called by the module's timer. Commands run without blocking the next
  // poll: a compaction waits for the turn to end.
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.flush();
      const sessionId = await this.deps.sessionId();
      const res = await this.deps.http(`${this.base}/commands?session=${encodeURIComponent(sessionId)}`);
      if (res.status !== 200) return;
      for (const cmd of topicCommands(res.text)) void this.execute(sessionId, cmd);
    } catch {
      // The hub is down or restarting: the next poll tries again.
    } finally {
      this.polling = false;
    }
  }

  // Called from the module's session.compact hook with what the compaction
  // came to; reported only when a /compact from the topic asked for it.
  async compacted(c: Compaction): Promise<void> {
    const asked = this.compacting.shift();
    if (!asked) return;
    if (c.skip !== undefined) return this.reply(asked, `⚠️ Компакт пропущен: ${c.skip}`, true);
    const sizes = c.tokensBefore !== undefined && c.tokensAfter !== undefined ? `: ${tokens(c.tokensBefore)} → ${tokens(c.tokensAfter)} токенов` : "";
    await this.reply(asked, `✅ Контекст сжат${sizes}.`, true);
  }

  private async execute(sessionId: string, cmd: TopicCommand): Promise<void> {
    const to = { sessionId, id: cmd.id };
    if (cmd.name === "info") {
      try {
        await this.reply(to, infoText(await this.deps.usage(), this.deps.now()), true);
      } catch (e) {
        await this.reply(to, `⚠️ /info не выполнена: ${message(e)}`, true);
      }
      return;
    }
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
    this.compacting.push(to);
    await this.reply(to, "🗜 Компакт запущен: начнётся, как только агент закончит текущий ход.", false);
    try {
      const res = await this.deps.run("compact", cmd.args);
      // The command printed something and no compaction reported yet: it
      // ended without one (nothing to compact). Silent: the compaction hook
      // reports.
      const text = res.text?.trim();
      if (text && this.drop(to)) await this.reply(to, `Компакт: ${text}`, true);
    } catch (e) {
      if (this.drop(to)) await this.reply(to, `⚠️ Компакт не запустился: ${message(e)}`, true);
    }
  }

  private drop(to: { id: string }): boolean {
    const i = this.compacting.findIndex(c => c.id === to.id);
    if (i < 0) return false;
    this.compacting.splice(i, 1);
    return true;
  }

  private async reply(to: { sessionId: string; id: string }, text: string, notify: boolean): Promise<void> {
    const n = this.replies.get(to.id) ?? 0;
    this.replies.set(to.id, n + 1);
    this.unsent.push({ sessionId: to.sessionId, id: `${to.id}.${n}`, text, notify });
    await this.flush();
  }

  // One at a time: the poll and a finishing command both flush, and two
  // loops over the same head would each shift it off.
  private flush(): Promise<void> {
    this.flushing ??= this.send().finally(() => (this.flushing = undefined));
    return this.flushing;
  }

  private async send(): Promise<void> {
    while (this.unsent.length) {
      try {
        const res = await this.deps.http(`${this.base}/reply`, { method: "POST", body: JSON.stringify(this.unsent[0]) });
        if (res.status !== 200) return;
      } catch {
        return;
      }
      this.unsent.shift();
    }
  }
}

const LIMIT_NAMES: Record<string, string> = { five_hour: "5 часов", seven_day: "Неделя" };

export function infoText(u: Usage, now: number): string {
  const lines: string[] = [];
  if (!u.rateLimits.length) lines.push("Лимиты: нет данных — появятся после первого ответа модели");
  else {
    lines.push("**Лимиты**");
    const order = (kind: string) => (kind === "five_hour" ? 0 : kind === "seven_day" ? 1 : 2);
    for (const l of [...u.rateLimits].sort((a, b) => order(a.kind) - order(b.kind))) {
      const left = l.resetsAt ? Date.parse(l.resetsAt) - now : NaN;
      lines.push(`${LIMIT_NAMES[l.kind] ?? l.kind}: ${l.percentUsed}%${left > 0 ? ` (сброс через ${duration(left)})` : ""}`);
    }
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
  if (used !== undefined) lines.push(`Использовано ${Math.round((used / limit) * 100)}% до автокомпакта`);
  return lines.join("\n");
}

export function tokens(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`;
  return `${Math.round(n / 1000)}k`;
}

// `/compact <N>` with a token count (333000, 333k, 1.5m) or `auto` sets the
// autocompact window; the value for /autocompact, or undefined when the
// arguments are instructions for the summary.
export function autocompactArg(args: string): string | undefined {
  const a = args.trim().toLowerCase();
  if (a === "auto") return a;
  const m = a.match(/^(\d+(?:\.\d+)?)([km]?)$/);
  if (!m) return undefined;
  return String(Math.round(Number(m[1]) * (m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : 1)));
}

function duration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} ч ${min % 60} мин` : `${h} ч`;
  return h % 24 ? `${Math.floor(h / 24)} д ${h % 24} ч` : `${Math.floor(h / 24)} д`;
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
  return "id" in v && typeof v.id === "string" && (name === "info" || name === "compact") && "args" in v && typeof v.args === "string";
}
