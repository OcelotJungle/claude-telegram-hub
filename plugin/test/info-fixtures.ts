// Recorded shapes of `rig info --session <id>` (rig's InfoData), shared by the hub, rig and window tests.
// Times are ISO-8601 UTC strings; every block can be replaced by rig's own `{error:{code,message}}`.
import type { InfoData } from "../src/shared/info-data.ts";

export const INFO_NOW = Date.parse("2026-01-02T12:00:00.000Z");
const MINUTE_MS = 60_000;
const FIVE_HOURS_MS = 300 * MINUTE_MS;
const FIVE_HOUR_WINDOW_MINUTES = 300;
const SEVEN_DAY_WINDOW_MINUTES = 10_080;
const FIVE_HOUR_PERCENT = 41;
const SEVEN_DAY_PERCENT = 12;
const CODEX_FIVE_HOUR_PERCENT = 30;
const CODEX_SEVEN_DAY_PERCENT = 55;
const CONTEXT_TOKENS = 120_000;
const CONTEXT_WINDOW = 1_000_000;
const THRESHOLD = 300_000;
const VOLUNTEER_DAY_PERCENT = 20;
const VOLUNTEER_USED = 10;
const VOLUNTEER_CAP = 50;
const HOUR_MS = 60 * MINUTE_MS;

export const iso = (ms: number): string => new Date(ms).toISOString();

// The whole answer: all blocks present and healthy.
export function fullInfo(overrides: Partial<InfoData> = {}): InfoData {
  return {
    session: "s",
    account: 1,
    claude: {
      at: iso(INFO_NOW),
      sessionId: "s",
      limits: [
        { kind: "seven_day", percentUsed: SEVEN_DAY_PERCENT, resetsAt: iso(INFO_NOW + 3 * HOUR_MS) },
        { kind: "five_hour", percentUsed: FIVE_HOUR_PERCENT, resetsAt: iso(INFO_NOW + FIVE_HOURS_MS / 2) },
      ],
    },
    codex: {
      at: iso(INFO_NOW),
      limits: [
        { windowMinutes: SEVEN_DAY_WINDOW_MINUTES, usedPercent: CODEX_SEVEN_DAY_PERCENT, resetsAt: iso(INFO_NOW + 3 * HOUR_MS) },
        { windowMinutes: FIVE_HOUR_WINDOW_MINUTES, usedPercent: CODEX_FIVE_HOUR_PERCENT, resetsAt: iso(INFO_NOW + HOUR_MS) },
      ],
    },
    volunteers: {
      at: iso(INFO_NOW),
      source: "api",
      dayPercent: VOLUNTEER_DAY_PERCENT,
      used: VOLUNTEER_USED,
      cap: VOLUNTEER_CAP,
      resetsAt: iso(INFO_NOW + 2 * HOUR_MS),
      providers: { alpha: { used: VOLUNTEER_USED, cap: VOLUNTEER_CAP }, beta: { used: 3, cap: null } },
    },
    context: { at: iso(INFO_NOW), tokens: CONTEXT_TOKENS, window: CONTEXT_WINDOW, threshold: THRESHOLD, autocompact: true },
    ...overrides,
  };
}

// The same answer without the optional blocks rig leaves out when a feature is not allowed on the machine.
export function bareInfo(): InfoData {
  const { codex: _codex, volunteers: _volunteers, ...bare } = fullInfo();
  return bare;
}

export const blockError = (code: string, message: string): { error: { code: string; message: string } } => ({ error: { code, message } });

// The object rig prints on stdout, with exit code 1, when the command itself fails.
export const commandFailure = (code: string, message: string): string => JSON.stringify({ error: { code, message } });
