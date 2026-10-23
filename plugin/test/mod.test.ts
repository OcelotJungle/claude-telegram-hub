import type { Usage } from "../src/mod/commands.ts";

import { describe, expect, test } from "bun:test";
import { autocompactArg, infoText, Runner, tokens } from "../src/mod/commands.ts";
import { field } from "../src/shared/guards.ts";

const NOW = Date.parse("2026-01-01T11:40:00Z");

const usage = (o: { tokens?: number; limits?: Usage["rateLimits"]; breakdown?: Partial<NonNullable<Usage["context"]["breakdown"]>> | null } = {}): Usage => ({
  context: {
    ...(o.tokens !== undefined ? { tokens: o.tokens } : {}),
    window: 1_000_000,
    ...(o.breakdown === null
      ? {}
      : { breakdown: { totalTokens: 36_400, rawMaxTokens: 333_000, autoCompactThreshold: 300_000, isAutoCompactEnabled: true, ...o.breakdown } }),
  },
  rateLimits: o.limits ?? [
    { kind: "seven_day", percentUsed: 36, resetsAt: "2026-01-01T18:00:00.000Z" },
    { kind: "five_hour", percentUsed: 30, resetsAt: "2026-01-01T13:00:00.000Z" },
  ],
});

describe("/info text", () => {
  test("limits with time to reset, context, the autocompact window and how much of its threshold is used", () => {
    expect(infoText(usage({ tokens: 128_400 }), NOW)).toBe(
      [
        "**Лимиты**",
        "5 часов: 30% (сброс через 1 ч 20 мин)",
        "Неделя: 36% (сброс через 4 д 6 ч)",
        "",
        "**Контекст**",
        "Сейчас: 128k токенов",
        "Автокомпакт: окно 333k, срабатывает на 300k",
        "Использовано 43% до автокомпакта",
      ].join("\n"),
    );
  });

  test("before the first model response there are no limits and the context is an estimate", () => {
    const text = infoText(usage({ limits: [] }), NOW);
    expect(text).toContain("Лимиты: нет данных — появятся после первого ответа модели");
    expect(text).toContain("Сейчас: ≈36k токенов (оценка)");
    expect(text).toContain("Использовано 12% до автокомпакта");
  });

  test("autocompact off", () => {
    const text = infoText(usage({ tokens: 50_000, breakdown: { isAutoCompactEnabled: false, autoCompactThreshold: undefined } }), NOW);
    expect(text).toContain("Автокомпакт: выключен");
    expect(text).not.toContain("до автокомпакта");
  });

  test("without a threshold the window is the boundary", () => {
    const text = infoText(usage({ tokens: 100_000, breakdown: { autoCompactThreshold: undefined } }), NOW);
    expect(text).toContain("Автокомпакт: окно 333k\n");
    expect(text).toContain("Использовано 30% до автокомпакта");
  });

  test("short and past resets, an unknown window kind, no reset time", () => {
    const text = infoText(
      usage({
        tokens: 1,
        limits: [
          { kind: "five_hour", percentUsed: 99.5, resetsAt: "2026-01-01T11:45:00.000Z" },
          { kind: "seven_day", percentUsed: 7, resetsAt: "2026-01-01T11:00:00.000Z" },
          { kind: "spend_limit", percentUsed: 12 },
        ],
      }),
      NOW,
    );
    expect(text).toContain("5 часов: 99.5% (сброс через 5 мин)");
    expect(text).toContain("Неделя: 7%\n");
    expect(text).toContain("spend_limit: 12%\n");
  });

  test("limits read over a minute ago say how old they are", () => {
    expect(infoText(usage({ tokens: 1 }), NOW, NOW - 59_000)).toStartWith("**Лимиты**\n");
    expect(infoText(usage({ tokens: 1 }), NOW, NOW - 72 * 60_000)).toStartWith("**Лимиты** (данные 1 ч 12 мин назад)\n");
  });

  test("without a breakdown only the status line figure is shown", () => {
    const text = infoText(usage({ tokens: 20_000, breakdown: null }), NOW);
    expect(text.endsWith("**Контекст**\nСейчас: 20k токенов")).toBe(true);
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
    expect(posted).toEqual(["c1.0", "c1.1"]);
  });
});

describe("limits shared through the hub", () => {
  const OWN = [{ kind: "five_hour", percentUsed: 30, resetsAt: "2026-01-01T13:00:00.000Z" }];
  const FRESH = [{ kind: "five_hour", percentUsed: 64, resetsAt: "2026-01-01T13:00:00.000Z" }];

  function runner(answer: () => { status: number; text: string }) {
    const posted: { path: string; body: unknown }[] = [];
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
        const list = commands;
        commands = [];
        return { status: 200, text: JSON.stringify(list) };
      },
      now: () => NOW,
    });
    const info = () => String(field(posted.find(p => p.path === "/reply")?.body, "text"));
    return { r, posted, info };
  }

  test("/info shows the freshest reading of the account, with its age", async () => {
    const s = runner(() => ({ status: 200, text: JSON.stringify({ at: NOW - 5 * 60_000, rateLimits: FRESH }) }));
    await s.r.poll();
    await Bun.sleep(50);
    expect(s.info()).toStartWith("**Лимиты** (данные 5 мин назад)\n5 часов: 64%");
  });

  test("without a reading in the hub /info shows the session's own", async () => {
    for (const answer of [() => ({ status: 200, text: "null" }), () => ({ status: 500, text: "" }), () => ({ status: 200, text: "{\"at\":\"x\"}" })]) {
      const s = runner(answer);
      await s.r.poll();
      await Bun.sleep(50);
      expect(s.info()).toStartWith("**Лимиты**\n5 часов: 30%");
    }
  });

  test("a reading of the session is posted to the hub; an empty one is not", async () => {
    const s = runner(() => ({ status: 200, text: "null" }));
    await s.r.measured([]);
    await s.r.measured(FRESH);
    expect(s.posted).toEqual([{ path: "/limits", body: { sessionId: "s", at: NOW, rateLimits: FRESH } }]);
  });
});

describe("/cleanup", () => {
  const STARTED = "🧹 Сожму контекст, когда агент закончит ход, и перезапущу сессию без накопившихся скиллов.";

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
      { path: "/reply", body: { sessionId: "s", id: "c1.0", text: STARTED, notify: false } },
      { path: "/cleanup", body: { sessionId: "s", id: "c1", before: 210_000, after: 24_000 } },
    ]);
  });

  test("cleanup reports the compact error and posts no terminate", async () => {
    const failing = runner([{ id: "c1", name: "cleanup", args: "" }], async () => {
      throw new Error("boom");
    });
    await failing.polls(8);
    expect(failing.compacted).toEqual([undefined, undefined, undefined]);
    expect(failing.posted.map(p => p.path)).toEqual(["/reply", "/cleanup"]);
    expect(failing.posted[1]?.body).toEqual({ sessionId: "s", id: "c1", error: "boom" });

    const skipped = runner([{ id: "c2", name: "cleanup", args: "" }], async () => ({ skip: "nothing to compact" }));
    await skipped.polls(5);
    expect(skipped.posted.map(p => p.path)).toEqual(["/reply", "/cleanup"]);
    expect(skipped.posted[1]?.body).toEqual({ sessionId: "s", id: "c2", error: "nothing to compact" });
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
    expect(s.posted.map(p => p.path)).toEqual(["/reply", "/reply"]);
    release();
    await s.polls(5);
    expect(s.compacted).toEqual(["first", "second"]);
    expect(s.posted.map(p => [p.path, field(p.body, "id")])).toEqual([
      ["/reply", "c1.0"],
      ["/reply", "c2.0"],
      ["/reply", "c1.1"],
      ["/cleanup", "c2"],
    ]);
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
