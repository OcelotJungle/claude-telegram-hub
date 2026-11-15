import { describe, expect, test } from "bun:test";
import { catalogOf } from "../src/shared/i18n/index.ts";
import { infoText } from "../src/hub/info-text.ts";
import { tokens } from "../src/shared/tokens.ts";
import { bareInfo, blockError, fullInfo, INFO_NOW, iso } from "./info-fixtures.ts";

const NOW = INFO_NOW;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const en = catalogOf("en");
const ru = catalogOf("ru");

describe("/info text", () => {
  test("all four blocks from rig's data, in order, with reset times and the context against the threshold", () => {
    expect(infoText(fullInfo(), NOW, en)).toBe(
      [
        "**Claude limits**",
        "5 hours: 41% (resets in 2 h 30 min)",
        "Week: 12% (resets in 3 h)",
        "",
        "**Codex limits**",
        "5 hours: 30% (resets in 1 h)",
        "Week: 55% (resets in 3 h)",
        "",
        "**Volunteer limits**",
        "Day: 20% (resets in 2 h)",
        "alpha: 10/50",
        "",
        "**Context**",
        "120/300k",
      ].join("\n"),
    );
  });

  test("a block rig leaves out is not shown", () => {
    const text = infoText(bareInfo(), NOW, en);
    expect(text).toStartWith("**Claude limits**\n");
    expect(text).not.toContain("Codex");
    expect(text).not.toContain("Volunteer");
    expect(text).toEndWith("**Context**\n120/300k");
  });

  test("a block with rig's error shows as unavailable with rig's message, the other blocks stay", () => {
    const text = infoText(
      fullInfo({
        claude: blockError("claude-failed", "no session data"),
        codex: blockError("codex-failed", "no rollout"),
        volunteers: blockError("volunteers-failed", "timeout"),
        context: blockError("context-failed", "no status line"),
      }),
      NOW,
      en,
    );
    expect(text).toBe(
      [
        "Claude limits: unavailable, no session data",
        "",
        "Codex limits: unavailable, no rollout",
        "",
        "Volunteer limits: unavailable, timeout",
        "",
        "**Context**",
        "unavailable, no status line",
      ].join("\n"),
    );
    expect(infoText(fullInfo({ codex: blockError("codex-failed", "no rollout") }), NOW, en)).toContain("**Volunteer limits**\n");
  });

  test("the unavailable lines are in Russian in the Russian catalog, with rig's message as it is", () => {
    const text = infoText(fullInfo({ codex: blockError("codex-failed", "no rollout") }), NOW, ru);
    expect(text).toContain(ru.infoCodexUnavailable({ reason: "no rollout" }));
    expect(ru.infoCodexUnavailable({ reason: "x" })).not.toBe(en.infoCodexUnavailable({ reason: "x" }));
  });

  test("before the first model response there are no limits and the context is an estimate", () => {
    const claude = { at: null, sessionId: "s", limits: [] };
    const text = infoText(fullInfo({ claude, context: { at: iso(NOW), tokens: 36_400, window: 1_000_000, threshold: 300_000, autocompact: true, estimated: true } }), NOW, en);
    expect(text).toContain("Claude limits: no data, they appear after the model's first reply");
    expect(text).toEndWith("**Context**\n≈36/300k");
  });

  test("autocompact off or no threshold shows only the context size", () => {
    const off = fullInfo({ context: { at: iso(NOW), tokens: 50_000, window: 1_000_000, autocompact: false } });
    expect(infoText(off, NOW, en)).toEndWith("**Context**\n50k");
    const none = fullInfo({ context: { at: iso(NOW), tokens: 100_000, window: 1_000_000, autocompact: true } });
    expect(infoText(none, NOW, en)).toEndWith("**Context**\n100k");
  });

  test("short and past resets, an unknown window kind, no reset time", () => {
    const text = infoText(
      fullInfo({
        claude: {
          at: iso(NOW),
          sessionId: "s",
          limits: [
            { kind: "five_hour", percentUsed: 99.5, resetsAt: iso(NOW + 5 * MINUTE_MS) },
            { kind: "seven_day", percentUsed: 7, resetsAt: iso(NOW - HOUR_MS) },
            { kind: "spend_limit", percentUsed: 12, resetsAt: null },
          ],
        },
      }),
      NOW,
      en,
    );
    expect(text).toContain("5 hours: 99.5% (resets in 5 min)");
    expect(text).toContain("Week: 7%\n");
    expect(text).toContain("spend_limit: 12%\n");
  });

  test("a block read over 5 minutes ago says how old it is, each by its own time", () => {
    const fresh = infoText(fullInfo({ claude: { at: iso(NOW - 4 * MINUTE_MS), sessionId: "s", limits: [{ kind: "five_hour", percentUsed: 1, resetsAt: null }] } }), NOW, en);
    expect(fresh).toStartWith("**Claude limits**\n");
    const stale = infoText(fullInfo({ claude: { at: iso(NOW - 6 * MINUTE_MS), sessionId: "s", limits: [{ kind: "five_hour", percentUsed: 1, resetsAt: null }] } }), NOW, en);
    expect(stale).toStartWith("**Claude limits** (data 6 min old)\n");
    const codex = infoText(fullInfo({ codex: { at: iso(NOW - 72 * MINUTE_MS), limits: [{ windowMinutes: 300, usedPercent: 30, resetsAt: iso(NOW + HOUR_MS) }] } }), NOW, en);
    expect(codex).toContain("**Codex limits** (data 1 h 12 min old)\n");
    expect(codex).toContain("**Volunteer limits**\n");
  });

  test("the context block says how old its reading is from its own time, with the same threshold", () => {
    const at = (ms: number) => ({ at: iso(ms), tokens: 1000, window: null });
    expect(infoText(fullInfo({ context: at(NOW - 4 * MINUTE_MS) }), NOW, en)).toContain("\n**Context**\n");
    expect(infoText(fullInfo({ context: at(NOW - 6 * MINUTE_MS) }), NOW, en)).toContain("\n**Context** (data 6 min old)\n");
    expect(infoText(fullInfo({ context: { at: null, tokens: 1000, window: null } }), NOW, en)).toContain("\n**Context**\n");
  });

  test("a Codex window whose reset has passed is empty again", () => {
    const codex = { at: iso(NOW), limits: [{ windowMinutes: 300, usedPercent: 41, resetsAt: iso(NOW) }] };
    expect(infoText(fullInfo({ codex }), NOW, en)).toContain("**Codex limits**\n5 hours: 0%\n\n");
  });

  test("the Codex percentage is rounded, a window of another length is named by it", () => {
    const codex = { at: iso(NOW), limits: [{ windowMinutes: 90, usedPercent: 12.4, resetsAt: iso(NOW + HOUR_MS) }, { windowMinutes: 10_080, usedPercent: 22.6, resetsAt: null }] };
    const text = infoText(fullInfo({ codex }), NOW, en);
    expect(text).toContain("Week: 23%\n");
    expect(text).toContain(`1 ${en.unitHour} 30 ${en.unitMinute}: 12% (resets in 1 h)`);
    expect(infoText(fullInfo({ codex }), NOW, ru)).toContain(`1 ${ru.unitHour} 30 ${ru.unitMinute}: 12%`);
    expect(infoText(fullInfo({ codex }), NOW, ru)).not.toContain("90m");
  });

  test("volunteer day percent rounds to an integer", () => {
    const volunteers = { at: iso(NOW), source: "api", dayPercent: 6.7, used: 1, cap: 10, resetsAt: iso(NOW + 2 * HOUR_MS), providers: {} };
    expect(infoText(fullInfo({ volunteers }), NOW, en)).toContain("Day: 7% (resets in 2 h)");
  });

  test("volunteers: providers by their names, one without a limit is not shown, a passed reset shows 0%", () => {
    const volunteers = {
      at: iso(NOW),
      source: "api",
      dayPercent: 6,
      used: 240,
      cap: 4200,
      resetsAt: iso(NOW - 1000),
      providers: { openrouter: { used: 39, cap: 1000 }, requesty: { used: 7, cap: 200 }, groq: { used: 194, cap: 3000 }, zhipu: { used: 4, cap: null }, other: { used: 1, cap: 5 } },
    };
    const text = infoText(fullInfo({ volunteers }), NOW, en);
    expect(text).toContain("**Volunteer limits**\nDay: 0%\nOpenRouter: 39/1000\nRequesty: 7/200\nGroq: 194/3000\nother: 1/5\n\n**Context**");
    expect(text).not.toContain("Zhipu");
    expect(text).not.toContain("resets in 0");
  });

  test("an estimate of the context is marked with a tilde", () => {
    const estimated = fullInfo({ context: { at: iso(NOW), tokens: 128_400, window: 1_000_000, threshold: 300_000, autocompact: true, estimated: true } });
    expect(infoText(estimated, NOW, en)).toEndWith("≈128/300k");
  });
});

describe("token counts", () => {
  test("thousands and millions", () => {
    expect([999, 128_400, 999_499, 1_000_000, 1_250_000].map(tokens)).toEqual(["1k", "128k", "999k", "1M", "1.3M"]);
  });
});

