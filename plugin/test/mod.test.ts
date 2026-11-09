import type { Usage } from "../src/mod/commands.ts";
import type { VolunteerLimitsResult } from "../src/shared/protocol.ts";

import { describe, expect, test } from "bun:test";
import { autocompactArg, infoText, Runner } from "../src/mod/commands.ts";
import { field } from "../src/shared/guards.ts";
import { catalogOf } from "../src/shared/i18n/index.ts";
import { waitFor } from "./helpers.ts";
import { tokens } from "../src/shared/tokens.ts";

const NOW = Date.parse("2026-01-02T11:40:00Z");
const en = catalogOf("en");
const ru = catalogOf("ru");

const usage = (o: { tokens?: number; limits?: Usage["rateLimits"]; breakdown?: Partial<NonNullable<Usage["context"]["breakdown"]>> | null } = {}): Usage => ({
  context: {
    ...(o.tokens !== undefined ? { tokens: o.tokens } : {}),
    window: 1_000_000,
    ...(o.breakdown === null
      ? {}
      : { breakdown: { totalTokens: 36_400, rawMaxTokens: 333_000, autoCompactThreshold: 300_000, isAutoCompactEnabled: true, ...o.breakdown } }),
  },
  rateLimits: o.limits ?? [
    { kind: "seven_day", percentUsed: 36, resetsAt: "2026-01-06T18:00:00.000Z" },
    { kind: "five_hour", percentUsed: 30, resetsAt: "2026-01-02T13:00:00.000Z" },
  ],
});

const volunteerOk = (overrides: Partial<Omit<VolunteerLimitsResult, "kind">> = {}): VolunteerLimitsResult => ({
  kind: "ok",
  at: NOW - 2 * 60_000,
  dayPercent: 6,
  resetsAt: NOW + 15 * 60 * 60_000,
  providers: [
    { name: "OpenRouter", used: 39, cap: 1000 },
    { name: "Requesty", used: 7, cap: 200 },
    { name: "Groq", used: 194, cap: 3000 },
  ],
  ...overrides,
});

describe("/info text", () => {
  test("Codex follows Claude, orders windows and rounds percentages", () => {
    const text = infoText(usage(), NOW, en, undefined, { at: NOW, rateLimits: [
      { kind: "seven_day", percentUsed: 22.4 },
      { kind: "five_hour", percentUsed: 40.7, resetsAt: new Date(NOW + 2 * 60 * 60_000).toISOString() },
    ] });
    expect(text).toStartWith("**Claude limits**\n");
    expect(text).toContain("\n\n**Codex limits**\n5 hours: 41% (resets in 2 h)\nWeek: 22%\n\n**Context**");
  });

  test("Codex has its own staleness and resets expired usage to zero", () => {
    const rateLimits = [{ kind: "five_hour", percentUsed: 41, resetsAt: new Date(NOW).toISOString() }];
    expect(infoText(usage(), NOW, en, NOW, { at: NOW - 72 * 60_000, rateLimits })).toContain("**Codex limits** (data 1 h 12 min old)\n5 hours: 0%\n\n");
    expect(infoText(usage(), NOW, en, NOW, { at: NOW - 59_000, rateLimits })).toContain("**Codex limits**\n");
    expect(infoText(usage(), NOW, en)).not.toContain("Codex");
  });

  test("limits with time to reset and the current context against the autocompact threshold", () => {
    expect(infoText(usage({ tokens: 128_400 }), NOW, en)).toBe(
      [
        "**Claude limits**",
        "5 hours: 30% (resets in 1 h 20 min)",
        "Week: 36% (resets in 4 d 6 h)",
        "",
        "**Context**",
        "128/300k",
      ].join("\n"),
    );
  });

  test("before the first model response there are no limits and the context is an estimate", () => {
    const text = infoText(usage({ limits: [] }), NOW, en);
    expect(text).toContain("Claude limits: no data, they appear after the model's first reply");
    expect(text).toContain("≈36/300k");
  });

  test("autocompact off", () => {
    const text = infoText(usage({ tokens: 50_000, breakdown: { isAutoCompactEnabled: false, autoCompactThreshold: undefined } }), NOW, en);
    expect(text.endsWith("**Context**\n50k")).toBe(true);
  });

  test("without a threshold only the context size is shown", () => {
    const text = infoText(usage({ tokens: 100_000, breakdown: { autoCompactThreshold: undefined } }), NOW, en);
    expect(text.endsWith("**Context**\n100k")).toBe(true);
  });

  test("short and past resets, an unknown window kind, no reset time", () => {
    const text = infoText(
      usage({
        tokens: 1,
        limits: [
          { kind: "five_hour", percentUsed: 99.5, resetsAt: "2026-01-02T11:45:00.000Z" },
          { kind: "seven_day", percentUsed: 7, resetsAt: "2026-01-02T11:00:00.000Z" },
          { kind: "spend_limit", percentUsed: 12 },
        ],
      }),
      NOW,
      en,
    );
    expect(text).toContain("5 hours: 99.5% (resets in 5 min)");
    expect(text).toContain("Week: 7%\n");
    expect(text).toContain("spend_limit: 12%\n");
  });

  test("limits read over 5 minutes ago say how old they are", () => {
    expect(infoText(usage({ tokens: 1 }), NOW, en, NOW - 4 * 60_000)).toStartWith("**Claude limits**\n");
    expect(infoText(usage({ tokens: 1 }), NOW, en, NOW - 6 * 60_000)).toStartWith("**Claude limits** (data 6 min old)\n");
  });

  test("without a breakdown only the status line figure is shown", () => {
    const text = infoText(usage({ tokens: 20_000, breakdown: null }), NOW, en);
    expect(text.endsWith("**Context**\n20k")).toBe(true);
  });

  test("without any context size shows no data", () => {
    const text = infoText(usage({ breakdown: null }), NOW, en);
    expect(text.endsWith("**Context**\nno data")).toBe(true);
  });

  test("volunteer limits ok block after Codex", () => {
    const text = infoText(usage(), NOW, en, undefined, { at: NOW, rateLimits: [] }, volunteerOk());
    expect(text).toContain("\n\n**Volunteer limits**\nDay: 6% (resets in 15 h)\nOpenRouter: 39/1000\nRequesty: 7/200\nGroq: 194/3000\n\n**Context**");
  });

  test("volunteer limits ok block after Claude when no Codex", () => {
    const text = infoText(usage(), NOW, en, undefined, undefined, volunteerOk());
    expect(text).toContain("\n\n**Volunteer limits**\nDay: 6% (resets in 15 h)\nOpenRouter: 39/1000\nRequesty: 7/200\nGroq: 194/3000\n\n**Context**");
  });

  test("volunteer day percent rounds to an integer", () => {
    const text = infoText(usage(), NOW, en, undefined, undefined, volunteerOk({ dayPercent: 6.7 }));
    expect(text).toContain("Day: 7% (resets in 15 h)");
  });

  test("volunteer limits passed reset shows 0% without suffix", () => {
    const text = infoText(usage(), NOW, en, undefined, undefined, volunteerOk({ resetsAt: NOW - 1000 }));
    expect(text).toContain("Day: 0%\n");
    // Check that the volunteer block doesn't have "resets in"
    const volIdx = text.indexOf("**Volunteer limits**");
    const ctxIdx = text.indexOf("**Context**");
    const volBlock = text.slice(volIdx, ctxIdx);
    expect(volBlock).not.toContain("resets in");
  });

  test("volunteer limits error shows single line", () => {
    const text = infoText(usage(), NOW, en, undefined, undefined, { kind: "error", reason: "timeout" });
    expect(text).toContain("\n\nVolunteer limits: no data, timeout\n\n**Context**");
  });

  test("codex limits error shows single line", () => {
    const text = infoText(usage(), NOW, en, undefined, { kind: "error", reason: "no rollout" });
    expect(text).toContain("Codex limits: no data, no rollout");
  });

  test("volunteer limits none produces no block", () => {
    const text = infoText(usage(), NOW, en, undefined, undefined, { kind: "none" });
    expect(text).not.toContain("Volunteer limits");
  });

  test("block order: Claude → Codex → volunteers → context", () => {
    const text = infoText(usage(), NOW, en, undefined, { at: NOW, rateLimits: [] }, volunteerOk());
    const claudeIdx = text.indexOf("**Claude limits**");
    const codexIdx = text.indexOf("**Codex limits**");
    const volIdx = text.indexOf("**Volunteer limits**");
    const ctxIdx = text.indexOf("**Context**");
    expect(claudeIdx).toBeLessThan(codexIdx);
    expect(codexIdx).toBeLessThan(volIdx);
    expect(volIdx).toBeLessThan(ctxIdx);
  });

  test("volunteer limits staleness uses 5-minute threshold", () => {
    const recent = volunteerOk({ at: NOW - 4 * 60_000 });
    const stale = volunteerOk({ at: NOW - 6 * 60_000 });
    expect(infoText(usage(), NOW, en, undefined, undefined, recent)).toContain("**Volunteer limits**\n");
    expect(infoText(usage(), NOW, en, undefined, undefined, stale)).toContain("**Volunteer limits** (data 6 min old)\n");
  });
});

describe("token counts", () => {
  test("thousands and millions", () => {
    expect([999, 128_400, 999_499, 1_000_000, 1_250_000].map(tokens)).toEqual(["1k", "128k", "999k", "1M", "1.3M"]);
  });
});

describe("replies", () => {
  test("a poll while a reply is being posted does not post it again: each reply once, in order", async () => {
    const posted: string[] = [];
    let commands = [{ id: "c1", name: "compact", args: "" }];
    const runner = new Runner("http://hub", {
      sessionId: async () => "s",
      usage: async () => usage(),
      run: async () => ({}),
      compact: async () => ({ skip: "nothing to compact" }),
      http: async (url, init) => {
        if (init?.method !== "POST") {
          const list = commands;
          commands = [];
          return { status: 200, text: JSON.stringify(list) };
        }
        await Bun.sleep(30);
        posted.push(String(field(JSON.parse(init.body ?? "{}"), "id")));
        return { status: 200, text: "ok" };
      },
      now: () => NOW,
    });
    await runner.poll();
    // The next tick of the module's timer, while the first reply is posted.
    await runner.poll();
    await Bun.sleep(150);
    await runner.poll();
    await Bun.sleep(150);
    await runner.poll();
    // Started, running (the compaction's own status), then its result.
    expect(posted).toEqual(["c1.0", "c1.1", "c1.2"]);
  });
});

describe("limits shared through the hub", () => {
  const OWN = [{ kind: "five_hour", percentUsed: 30, resetsAt: "2026-01-02T13:00:00.000Z" }];
  const FRESH = [{ kind: "five_hour", percentUsed: 64, resetsAt: "2026-01-02T13:00:00.000Z" }];

  function runner(
    answer: () => { status: number; text: string },
    codex: () => { status: number; text: string } = () => ({ status: 200, text: "null" }),
    volunteer: () => { status: number; text: string } = () => ({ status: 200, text: "null" })
  ) {
    const posted: { path: string; body: unknown }[] = [];
    const asked: string[] = [];
    let commands = [{ id: "c1", name: "info", args: "" }];
    const r = new Runner("http://hub", {
      sessionId: async () => "s",
      usage: async () => usage({ tokens: 1, limits: OWN }),
      run: async () => ({}),
      compact: async () => ({}),
      http: async (url, init) => {
        if (init?.method === "POST") {
          posted.push({ path: new URL(url).pathname, body: JSON.parse(init.body ?? "null") });
          return { status: 200, text: "ok" };
        }
        if (new URL(url).pathname === "/limits") return answer();
        if (new URL(url).pathname === "/codex-limits") { asked.push(url); return codex(); }
        if (new URL(url).pathname === "/volunteer-limits") { asked.push(url); return volunteer(); }
        const list = commands;
        commands = [];
        return { status: 200, text: JSON.stringify(list) };
      },
      now: () => NOW,
    });
    const info = () => String(field(posted.find(p => p.path === "/reply")?.body, "text"));
    return { r, posted, info, asked };
  }

  test("/info shows the freshest reading of the account, with its age", async () => {
    const s = runner(() => ({ status: 200, text: JSON.stringify({ at: NOW - 5 * 60_000, rateLimits: FRESH }) }));
    await s.r.poll();
    await Bun.sleep(50);
    expect(s.info()).toStartWith("**Claude limits** (data 5 min old)\n5 hours: 64%");
  });

  test("/info fetches Codex limits and tolerates failures", async () => {
    const answers = [
      () => ({ status: 200, text: JSON.stringify({ at: NOW, rateLimits: FRESH }) }),
      () => ({ status: 500, text: "" }),
      () => ({ status: 200, text: "{broken" }),
      () => { throw new Error("offline"); },
    ];
    for (const [index, answer] of answers.entries()) {
      const s = runner(() => ({ status: 200, text: "null" }), answer);
      await s.r.poll();
      await Bun.sleep(50);
      expect(s.info()).toStartWith("**Claude limits**");
      expect(s.info().includes("**Codex limits**")).toBe(index === 0);
    }
  });

  test("/info asks both worker endpoints as its own session, with no path in the request", async () => {
    const s = runner(() => ({ status: 200, text: "null" }));
    await s.r.poll();
    await Bun.sleep(50);
    expect(s.asked.sort()).toEqual(["http://hub/codex-limits?session=s", "http://hub/volunteer-limits?session=s"]);
  });

  test("/info shows the error line the hub gives for an available Codex without data", async () => {
    const s = runner(() => ({ status: 200, text: "null" }), () => ({ status: 200, text: JSON.stringify({ kind: "error", reason: "no rollout" }) }));
    await s.r.poll();
    await Bun.sleep(50);
    expect(s.info()).toContain("Codex limits: no data, no rollout");
  });

  test("/info fetches volunteer limits and tolerates failures", async () => {
    const answers = [
      () => ({ status: 200, text: JSON.stringify({ kind: "ok", at: NOW, dayPercent: 6, resetsAt: NOW + 15 * 60 * 60_000, providers: [] }) }),
      () => ({ status: 500, text: "" }),
      () => ({ status: 200, text: "{broken" }),
      () => { throw new Error("offline"); },
    ];
    for (const [index, answer] of answers.entries()) {
      const s = runner(() => ({ status: 200, text: "null" }), () => ({ status: 200, text: "null" }), answer);
      await s.r.poll();
      await Bun.sleep(50);
      expect(s.info()).toStartWith("**Claude limits**");
      expect(s.info().includes("**Volunteer limits**")).toBe(index === 0);
    }
  });

  test("without a reading in the hub /info shows the session's own", async () => {
    for (const answer of [() => ({ status: 200, text: "null" }), () => ({ status: 500, text: "" }), () => ({ status: 200, text: "{\"at\":\"x\"}" })]) {
      const s = runner(answer);
      await s.r.poll();
      await Bun.sleep(50);
      expect(s.info()).toStartWith("**Claude limits**\n5 hours: 30%");
    }
  });

  test("a reading of the session is posted to the hub; an empty one is not", async () => {
    const s = runner(() => ({ status: 200, text: "null" }));
    await s.r.measured([]);
    await s.r.measured(FRESH);
    expect(s.posted).toEqual([{ path: "/limits", body: { sessionId: "s", at: NOW, rateLimits: FRESH } }]);
  });
});

describe("/rename", () => {
  const STARTED = en.renameQueued;
  const HINT = en.renameHint;

  function runner(commands: { id: string; name: string; args: string }[], run: (command: string, args: string) => Promise<{ text?: string }>) {
    const posted: { path: string; body: unknown }[] = [];
    const ran: [string, string][] = [];
    let queue = commands;
    const r = new Runner("http://hub", {
      sessionId: async () => "s",
      usage: async () => usage({ tokens: 1 }),
      run: (command, args) => {
        ran.push([command, args]);
        return run(command, args);
      },
      compact: async () => ({}),
      http: async (url, init) => {
        if (init?.method === "POST") {
          posted.push({ path: new URL(url).pathname, body: JSON.parse(init.body ?? "null") });
          return { status: 200, text: "ok" };
        }
        const list = queue;
        queue = [];
        return { status: 200, text: JSON.stringify(list) };
      },
      now: () => NOW,
    });
    const polls = async (n: number) => {
      for (let i = 0; i < n; i++) {
        await r.poll();
        await Bun.sleep(10);
      }
    };
    return { posted, ran, polls };
  }

  test("/rename runs the session's rename with the name; the queued notice becomes the result", async () => {
    const s = runner([{ id: "c1", name: "rename", args: "\u0421\u043f\u0440\u0438\u043d\u0442 3" }], async () => ({}));
    await s.polls(5);
    expect(s.ran).toEqual([["rename", "\u0421\u043f\u0440\u0438\u043d\u0442 3"]]);
    expect(s.posted).toEqual([
      { path: "/reply", body: { sessionId: "s", id: "c1.0", text: STARTED, notify: false, awaitsResult: true } },
      { path: "/reply", body: { sessionId: "s", id: "c1.1", text: "✅ /rename \u0421\u043f\u0440\u0438\u043d\u0442 3 done.", notify: false, replaces: { id: "c1.0", kind: "success" } } },
    ]);
  });

  test("a multi-line name is collapsed before running rename", async () => {
    const s = runner([{ id: "c1", name: "rename", args: "  \u0421\u043f\u0440\u0438\u043d\u0442\n 3\t\u0444\u0438\u043d\u0430\u043b  " }], async () => ({}));
    await s.polls(5);
    expect(s.ran).toEqual([["rename", "\u0421\u043f\u0440\u0438\u043d\u0442 3 \u0444\u0438\u043d\u0430\u043b"]]);
    expect(s.posted.at(-1)).toEqual({ path: "/reply", body: { sessionId: "s", id: "c1.1", text: "✅ /rename \u0421\u043f\u0440\u0438\u043d\u0442 3 \u0444\u0438\u043d\u0430\u043b done.", notify: false, replaces: { id: "c1.0", kind: "success" } } });
  });

  test("a rejected rename is a warning that replaces the queued notice", async () => {
    const s = runner([{ id: "c1", name: "rename", args: "x" }], async () => {
      throw new Error("command not available");
    });
    await s.polls(5);
    expect(s.ran).toEqual([["rename", "x"]]);
    expect(s.posted).toEqual([
      { path: "/reply", body: { sessionId: "s", id: "c1.0", text: STARTED, notify: false, awaitsResult: true } },
      { path: "/reply", body: { sessionId: "s", id: "c1.1", text: "⚠️ /rename x failed: command not available", notify: true, replaces: { id: "c1.0", kind: "warning" } } },
    ]);
  });

  test("bare /rename answers with the hint and runs nothing", async () => {
    const s = runner([{ id: "c1", name: "rename", args: "" }], async () => ({}));
    await s.polls(3);
    expect(s.ran).toEqual([]);
    expect(s.posted).toEqual([{ path: "/reply", body: { sessionId: "s", id: "c1.0", text: HINT, notify: false } }]);
  });

  test("a whitespace-only name answers with the hint and runs nothing", async () => {
    const s = runner([{ id: "c1", name: "rename", args: " \t\n  " }], async () => ({}));
    await s.polls(3);
    expect(s.ran).toEqual([]);
    expect(s.posted).toEqual([{ path: "/reply", body: { sessionId: "s", id: "c1.0", text: HINT, notify: false } }]);
  });
});

describe("/cleanup", () => {
  const STARTED = en.cleanupQueued;

  function runner(commands: { id: string; name: string; args: string }[], compact: (args: string | undefined) => Promise<{ tokensBefore?: number; tokensAfter?: number; skip?: string }>) {
    const posted: { path: string; body: unknown }[] = [];
    const urls: string[] = [];
    const compacted: (string | undefined)[] = [];
    let queue = commands;
    const r = new Runner("http://hub", {
      sessionId: async () => "s",
      usage: async () => usage({ tokens: 1 }),
      run: async () => ({}),
      compact: async args => {
        compacted.push(args);
        return compact(args);
      },
      http: async (url, init) => {
        if (init?.method === "POST") {
          posted.push({ path: new URL(url).pathname, body: JSON.parse(init.body ?? "null") });
          return { status: 200, text: "ok" };
        }
        urls.push(url);
        const list = queue;
        queue = [];
        return { status: 200, text: JSON.stringify(list) };
      },
      now: () => NOW,
    });
    const polls = async (n: number) => {
      for (let i = 0; i < n; i++) {
        await r.poll();
        await Bun.sleep(10);
      }
    };
    return { r, posted, urls, compacted, polls };
  }

  test("cleanup compacts with its instructions and reports the sizes to the hub, without a ✅ reply", async () => {
    const s = runner([{ id: "c1", name: "cleanup", args: "keep the plan" }], async () => ({ tokensBefore: 210_000, tokensAfter: 24_000 }));
    await s.polls(5);
    expect(s.compacted).toEqual(["keep the plan"]);
    expect(s.posted).toEqual([
      { path: "/reply", body: { sessionId: "s", id: "c1.0", text: STARTED, notify: false, awaitsResult: true } },
      { path: "/reply", body: { sessionId: "s", id: "c1.1", text: "🧹 Cleanup is running…", notify: false, replaces: { id: "c1.0", kind: "progress" } } },
      { path: "/cleanup", body: { sessionId: "s", id: "c1", before: 210_000, after: 24_000 } },
    ]);
  });

  test("cleanup reports the compact error and posts no terminate", async () => {
    const failing = runner([{ id: "c1", name: "cleanup", args: "" }], async () => {
      throw new Error("boom");
    });
    await failing.polls(8);
    expect(failing.compacted).toEqual([undefined, undefined, undefined]);
    // Tries that fail with no turn in the way stay running; the third one's failure is reported.
    expect(failing.posted.filter(p => p.path === "/reply").map(p => field(p.body, "text"))).toEqual([
      "🧹 Cleanup is queued.",
      "🧹 Cleanup is running…",
    ]);
    expect(failing.posted.at(-1)?.path).toBe("/cleanup");
    expect(failing.posted.at(-1)?.body).toEqual({ sessionId: "s", id: "c1", error: "boom" });

    const skipped = runner([{ id: "c2", name: "cleanup", args: "" }], async () => ({ skip: "nothing to compact" }));
    await skipped.polls(5);
    expect(skipped.posted.map(p => p.path)).toEqual(["/reply", "/reply", "/cleanup"]);
    expect(skipped.posted[2]?.body).toEqual({ sessionId: "s", id: "c2", error: "nothing to compact" });
  });

  test("cleanup waits for a running compaction first", async () => {
    let release = () => {};
    const held = new Promise<void>(done => (release = done));
    const s = runner(
      [
        { id: "c1", name: "compact", args: "first" },
        { id: "c2", name: "cleanup", args: "second" },
      ],
      async args => {
        if (args === "first") await held;
        return { tokensBefore: 100_000, tokensAfter: 10_000 };
      },
    );
    await s.polls(5);
    expect(s.compacted).toEqual(["first"]);
    // The first compaction's started notice and its running status; the cleanup waits its turn.
    expect(s.posted.map(p => [p.path, field(p.body, "id")])).toEqual([
      ["/reply", "c1.0"],
      ["/reply", "c2.0"],
      ["/reply", "c1.1"],
    ]);
    release();
    await s.polls(5);
    expect(s.compacted).toEqual(["first", "second"]);
    expect(s.posted.map(p => [p.path, field(p.body, "id")])).toEqual([
      ["/reply", "c1.0"],
      ["/reply", "c2.0"],
      ["/reply", "c1.1"],
      ["/reply", "c1.2"],
      ["/reply", "c2.1"],
      ["/cleanup", "c2"],
    ]);
  });

  test("/stop during a running compaction marks its waiting notice as awaiting the result; /stop alone sends none", async () => {
    let release = () => {};
    const held = new Promise<void>(done => (release = done));
    const s = runner(
      [
        { id: "c1", name: "compact", args: "first" },
        { id: "c2", name: "stop", args: "" },
      ],
      async () => {
        await held;
        return { tokensBefore: 100_000, tokensAfter: 10_000 };
      },
    );
    await s.polls(5);
    expect(s.posted.filter(p => field(p.body, "id") === "c2.0")).toEqual([
      { path: "/reply", body: { sessionId: "s", id: "c2.0", text: en.stopAfterCompact, notify: false, awaitsResult: true } },
    ]);
    release();
    await s.polls(5);
    expect(s.posted.at(-1)).toEqual({ path: "/terminate", body: { sessionId: "s", id: "c2" } });

    const alone = runner([{ id: "c3", name: "stop", args: "" }], async () => ({}));
    await alone.polls(5);
    expect(alone.posted).toEqual([{ path: "/terminate", body: { sessionId: "s", id: "c3" } }]);
  });

  test("the poll asks for cleanup", async () => {
    const s = runner([], async () => ({}));
    await s.polls(1);
    const url = new URL(s.urls[0] ?? "http://x");
    expect(url.searchParams.get("stop")).toBe("1");
    expect(url.searchParams.get("cleanup")).toBe("1");
  });
});

describe("/compact argument", () => {
  test("a token count or auto sets the autocompact window", () => {
    expect(["333000", "333k", "333K", "1m", "1.5m", "auto", "AUTO"].map(autocompactArg)).toEqual(["333000", "333000", "333000", "1000000", "1500000", "auto", "auto"]);
  });

  test("anything else is instructions for the summary", () => {
    expect(["", "keep the plan", "333 tokens", "k"].map(autocompactArg)).toEqual([undefined, undefined, undefined, undefined]);
  });
});

// The language can change while a command is still running: each later text uses the one current when it is made.
describe("language changes during a command", () => {
  function runner(command: { id: string; name: string; args: string }, run: Promise<unknown>, compact: Promise<unknown>) {
    const posted: { path: string; body: unknown }[] = [];
    let language: unknown = "en";
    let queue = [{ ...command, language: "en" }];
    const r = new Runner("http://hub", {
      sessionId: async () => "s",
      usage: async () => usage({ tokens: 1 }),
      run: async () => { await run; return {}; },
      compact: async () => { await compact; return {}; },
      http: async (url, init) => {
        if (init?.method === "POST") {
          posted.push({ path: new URL(url).pathname, body: JSON.parse(init.body ?? "null") });
          return { status: 200, text: "ok" };
        }
        if (new URL(url).pathname === "/language") return { status: 200, text: JSON.stringify({ language }) };
        const list = queue;
        queue = [];
        return { status: 200, text: JSON.stringify(list) };
      },
      now: () => NOW,
    });
    const text = (id: string) => {
      const reply = posted.find(p => field(p.body, "id") === id);
      return reply ? String(field(reply.body, "text")) : undefined;
    };
    return { r, text, setLanguage: (value: unknown) => { language = value; } };
  }

  test("a compaction's running and result texts use the language current when they are posted", async () => {
    let release = () => {};
    const s = runner({ id: "c1", name: "compact", args: "" }, Promise.resolve(), new Promise<void>(resolve => { release = resolve; }));
    s.r.turn(true);
    await s.r.poll();
    await waitFor(() => s.text("c1.0"), 1000, "the queued text");
    expect(s.text("c1.0")).toBe(en.compactQueued);
    s.setLanguage("ru");
    s.r.turn(false);
    // The module's timer polls again and again; the compaction starts on the first poll that finds it queued.
    await waitFor(async () => { await s.r.poll(); return s.text("c1.1"); }, 1000, "the running text");
    expect(s.text("c1.1")).toBe(ru.compactRunning);
    // The result is posted in ru, not in the en the command started with.
    s.setLanguage("ru");
    release();
    await waitFor(() => s.text("c1.2"), 1000, "the result text");
    expect(s.text("c1.2")).toBe(ru.compactDone);
  });

  test("a rename result uses the language current when it is posted", async () => {
    let release = () => {};
    const s = runner({ id: "c1", name: "rename", args: "Sprint" }, new Promise<void>(resolve => { release = resolve; }), Promise.resolve());
    await s.r.poll();
    await waitFor(() => s.text("c1.0"), 1000, "the queued text");
    s.setLanguage("ru");
    release();
    await waitFor(() => s.text("c1.1"), 1000, "the result text");
    expect(s.text("c1.1")).toBe(ru.commandDone({ command: "/rename Sprint" }));
  });

  test("an answer that is not a language keeps the last known one", async () => {
    let release = () => {};
    const s = runner({ id: "c1", name: "rename", args: "Sprint" }, new Promise<void>(resolve => { release = resolve; }), Promise.resolve());
    await s.r.poll();
    await waitFor(() => s.text("c1.0"), 1000, "the queued text");
    s.setLanguage("klingon");
    release();
    await waitFor(() => s.text("c1.1"), 1000, "the result text");
    expect(s.text("c1.1")).toBe(en.commandDone({ command: "/rename Sprint" }));
  });
});

describe("Codex limits of an unusual length", () => {
  const limits = { at: NOW, rateLimits: [{ kind: "90m", percentUsed: 12, resetsAt: "2026-01-02T13:00:00.000Z" }, { kind: "weekly", percentUsed: 3 }] };

  test("the length is written with the catalog's unit, in both languages", () => {
    const text = (catalog: typeof en) => infoText(usage(), NOW, catalog, undefined, limits);
    expect(text(en)).toContain(`1 ${en.unitHour} 30 ${en.unitMinute}: 12%`);
    expect(text(ru)).toContain(`1 ${ru.unitHour} 30 ${ru.unitMinute}: 12%`);
    expect(text(ru)).not.toContain("90m");
  });

  test("a kind that is not a length is shown as it is", () => {
    expect(infoText(usage(), NOW, en, undefined, limits)).toContain("weekly: 3%");
  });
});
