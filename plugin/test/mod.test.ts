import type { Usage } from "../src/mod/commands.ts";
import { describe, expect, test } from "bun:test";
import { autocompactArg, infoText, Runner } from "../src/mod/commands.ts";
import { field } from "../src/shared/guards.ts";
import { catalogOf } from "../src/shared/i18n/index.ts";
import { waitFor } from "./helpers.ts";
import { turn } from "./manual-clock.ts";
import { tokens } from "../src/shared/tokens.ts";
import { bareInfo, blockError, fullInfo, INFO_NOW, iso, neverSleep } from "./info-fixtures.ts";
import { RIG_QUERY_LIMIT_MS } from "../src/shared/info-data.ts";

const NOW = INFO_NOW;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const MS_PER_SECOND = 1000;
const en = catalogOf("en");
const ru = catalogOf("ru");

const usage = (o: { tokens?: number } = {}): Usage => ({
  context: {
    ...(o.tokens !== undefined ? { tokens: o.tokens } : {}),
    window: 1_000_000,
    breakdown: { totalTokens: 36_400, rawMaxTokens: 333_000, autoCompactThreshold: 300_000, isAutoCompactEnabled: true },
  },
});

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

describe("replies", () => {
  test("a poll while a reply is being posted does not post it again: each reply once, in order", async () => {
    const posted: string[] = [];
    let commands = [{ id: "c1", name: "compact", args: "" }];
    // Every post waits here, so the next poll comes while the first reply is still being posted.
    let postStarted = 0;
    let openGate = () => {};
    const gate = new Promise<void>(resolve => {
      openGate = resolve;
    });
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
        postStarted++;
        await gate;
        posted.push(String(field(JSON.parse(init.body ?? "{}"), "id")));
        return { status: 200, text: "ok" };
      },
      now: () => NOW,
      sleep: neverSleep,
    });
    await runner.poll();
    await waitFor(() => postStarted === 1, 1000, "the first reply being posted");
    // The next tick of the module's timer, while the first reply is posted: it waits for that post, so it ends only once the gate opens.
    const second = runner.poll();
    await turn();
    expect(posted).toEqual([]);
    openGate();
    await second;
    await turn();
    await runner.poll();
    await turn();
    await runner.poll();
    // Started, running (the compaction's own status), then its result.
    expect(posted).toEqual(["c1.0", "c1.1", "c1.2"]);
  });
});

describe("/info through the hub", () => {
  type Answer = { status: number; text: string };

  function runner(answer: () => Answer | Promise<Answer>, sleep: (ms: number) => Promise<void> = neverSleep) {
    const posted: { path: string; body: unknown }[] = [];
    const asked: string[] = [];
    let commands = [{ id: "c1", name: "info", args: "" }];
    const r = new Runner("http://hub", {
      sessionId: async () => "s",
      usage: async () => usage({ tokens: 1 }),
      run: async () => ({}),
      compact: async () => ({}),
      http: async (url, init) => {
        if (init?.method === "POST") {
          posted.push({ path: new URL(url).pathname, body: JSON.parse(init.body ?? "null") });
          return { status: 200, text: "ok" };
        }
        if (new URL(url).pathname === "/info") { asked.push(url); return answer(); }
        const list = commands;
        commands = [];
        return { status: 200, text: JSON.stringify(list) };
      },
      now: () => NOW,
      sleep,
    });
    const reply = () => posted.find(p => p.path === "/reply")?.body;
    return { r, posted, asked, reply, text: () => String(field(reply(), "text")) };
  }

  test("asks the hub for rig's data of its own session, with no path in the request, and draws it", async () => {
    const s = runner(() => ({ status: 200, text: JSON.stringify(fullInfo()) }));
    await s.r.poll();
    await waitFor(() => s.reply(), 1000, "the /info reply");
    expect(s.asked).toEqual(["http://hub/info?session=s"]);
    expect(s.text()).toBe(infoText(fullInfo(), NOW, en));
    expect(field(s.reply(), "notify")).toBe(false);
  });

  test("the hub's failure text is the reply, as an error", async () => {
    const s = runner(() => ({ status: 502, text: JSON.stringify({ failure: "rig could not read the session" }) }));
    await s.r.poll();
    await waitFor(() => s.reply(), 1000, "the failure reply");
    expect(s.text()).toBe("rig could not read the session");
    expect(field(s.reply(), "notify")).toBe(true);
  });

  test("an answer that is not rig's data gets the hub's bad-reply text, never drawn and never a parse error", async () => {
    const answers = [
      { status: 200, text: JSON.stringify({ session: "s" }) },
      { status: 500, text: "{}" },
      { status: 200, text: "<html>not json</html>" },
      { status: 502, text: "not json either" },
    ];
    for (const answer of answers) {
      const s = runner(() => answer);
      await s.r.poll();
      await waitFor(() => s.reply(), 1000, "the failed reply");
      expect(s.text()).toBe(en.infoHubBadReply({ status: answer.status }));
      expect(s.text()).not.toContain("Claude limits");
      expect(s.text()).not.toContain("JSON");
      expect(field(s.reply(), "notify")).toBe(true);
    }
  });

  test("a hub that cannot be reached is told in the hub's own text", async () => {
    const s = runner(() => Promise.reject(new Error("connect refused")));
    await s.r.poll();
    await waitFor(() => s.reply(), 1000, "the unreachable reply");
    expect(s.text()).toBe(en.infoHubUnreachable({ error: "connect refused" }));
  });

  test("the window waits for the hub as long as rig's query limit plus a margin, then says so", async () => {
    const waits: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      waits.push(ms);
      return Promise.resolve();
    };
    const s = runner(() => new Promise<Answer>(() => undefined), sleep);
    await s.r.poll();
    await waitFor(() => s.reply(), 1000, "the timeout reply");
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(RIG_QUERY_LIMIT_MS);
    expect(s.text()).toBe(en.infoHubTimeout({ seconds: (waits[0] ?? 0) / MS_PER_SECOND }));
  });

  test("a no-data block of rig is drawn as no data, other codes as unavailable with rig's message", async () => {
    const noData = fullInfo({ claude: blockError("no-data", "x"), context: blockError("no-data", "y") });
    const s = runner(() => ({ status: 200, text: JSON.stringify(noData) }));
    await s.r.poll();
    await waitFor(() => s.reply(), 1000, "the no-data reply");
    expect(s.text()).toContain(en.infoClaudeNoData);
    expect(s.text()).toContain(`**Context**\n${en.infoNoData}`);
    const failed = fullInfo({ claude: blockError("boom", "claude down"), context: blockError("boom", "ctx down") });
    const f = runner(() => ({ status: 200, text: JSON.stringify(failed) }));
    await f.r.poll();
    await waitFor(() => f.reply(), 1000, "the unavailable reply");
    expect(f.text()).toContain(en.infoClaudeUnavailable({ reason: "claude down" }));
    expect(f.text()).toContain(en.infoContextUnavailable({ reason: "ctx down" }));
  });

  test("an answer that breaks rig's contract in a field the window reads is not drawn", async () => {
    const broken = { ...fullInfo(), codex: { at: null, limits: [] } };
    const s = runner(() => ({ status: 200, text: JSON.stringify(broken) }));
    await s.r.poll();
    await waitFor(() => s.reply(), 1000, "the bad reply");
    expect(s.text()).toBe(en.infoHubBadReply({ status: 200 }));
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
      sleep: neverSleep,
    });
    const polls = async (n: number) => {
      for (let i = 0; i < n; i++) {
        await r.poll();
        await turn();
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
      sleep: neverSleep,
    });
    const polls = async (n: number) => {
      for (let i = 0; i < n; i++) {
        await r.poll();
        await turn();
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
      sleep: neverSleep,
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
