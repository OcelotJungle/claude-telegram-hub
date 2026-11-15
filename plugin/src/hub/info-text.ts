import type { Messages } from "../shared/i18n/index.ts";
import type { InfoData } from "../shared/info-data.ts";

import { isBlockError } from "../shared/info-data.ts";
import { THOUSAND, tokens } from "../shared/tokens.ts";

// The order of the limits in /info; others go after these.
const LIMIT_ORDER = ["five_hour", "seven_day"];
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const FIVE_HOUR_MINUTES = 5 * MINUTES_PER_HOUR;
const SEVEN_DAY_MINUTES = 7 * HOURS_PER_DAY * MINUTES_PER_HOUR;
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
// Limits of other lengths are named by the minutes in the kind ("90m").
const MINUTES_KIND = /^(\d+)m$/;

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

function duration(ms: number, m: Messages): string {
  const total = Math.max(1, Math.round(ms / MS_PER_MINUTE));
  if (total < MINUTES_PER_HOUR) return `${total} ${m.unitMinute}`;
  const h = Math.floor(total / MINUTES_PER_HOUR);
  const min = total % MINUTES_PER_HOUR;
  if (h < HOURS_PER_DAY) return min ? `${h} ${m.unitHour} ${min} ${m.unitMinute}` : `${h} ${m.unitHour}`;
  const d = Math.floor(h / HOURS_PER_DAY);
  return h % HOURS_PER_DAY ? `${d} ${m.unitDay} ${h % HOURS_PER_DAY} ${m.unitHour}` : `${d} ${m.unitDay}`;
}

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
