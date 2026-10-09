import type { Usage } from "../src/mod/commands.ts"

import { describe, expect, test } from "bun:test"
import { autocompactArg, infoText, Runner, tokens } from "../src/mod/commands.ts"

const NOW = Date.parse("2026-01-01T11:40:00Z")

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
})

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
    )
  })

  test("before the first model response there are no limits and the context is an estimate", () => {
    const text = infoText(usage({ limits: [] }), NOW)
    expect(text).toContain("Лимиты: нет данных — появятся после первого ответа модели")
    expect(text).toContain("Сейчас: ≈36k токенов (оценка)")
    expect(text).toContain("Использовано 12% до автокомпакта")
  })

  test("autocompact off", () => {
    const text = infoText(usage({ tokens: 50_000, breakdown: { isAutoCompactEnabled: false, autoCompactThreshold: undefined } }), NOW)
    expect(text).toContain("Автокомпакт: выключен")
    expect(text).not.toContain("до автокомпакта")
  })

  test("without a threshold the window is the boundary", () => {
    const text = infoText(usage({ tokens: 100_000, breakdown: { autoCompactThreshold: undefined } }), NOW)
    expect(text).toContain("Автокомпакт: окно 333k\n")
    expect(text).toContain("Использовано 30% до автокомпакта")
  })

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
    )
    expect(text).toContain("5 часов: 99.5% (сброс через 5 мин)")
    expect(text).toContain("Неделя: 7%\n")
    expect(text).toContain("spend_limit: 12%\n")
  })

  test("without a breakdown only the status line figure is shown", () => {
    const text = infoText(usage({ tokens: 20_000, breakdown: null }), NOW)
    expect(text.endsWith("**Контекст**\nСейчас: 20k токенов")).toBe(true)
  })
})

describe("token counts", () => {
  test("thousands and millions", () => {
    expect([999, 128_400, 999_499, 1_000_000, 1_250_000].map(tokens)).toEqual(["1k", "128k", "999k", "1M", "1.3M"])
  })
})

describe("replies", () => {
  test("a poll while a reply is being posted does not post it again: each reply once, in order", async () => {
    const posted: string[] = []
    let commands = [{ id: "c1", name: "compact", args: "" }]
    const runner = new Runner("http://hub", {
      sessionId: async () => "s",
      usage: async () => usage(),
      run: async () => ({ text: "Not enough messages to compact." }),
      http: async (url, init) => {
        if (init?.method !== "POST") {
          const list = commands
          commands = []
          return { status: 200, text: JSON.stringify(list) }
        }
        await Bun.sleep(30)
        posted.push(JSON.parse(init.body!).id)
        return { status: 200, text: "ok" }
      },
      now: () => NOW,
    })
    await runner.poll()
    // The next tick of the module's timer, while the first reply is posted.
    await runner.poll()
    await Bun.sleep(150)
    await runner.poll()
    expect(posted).toEqual(["c1.0", "c1.1"])
  })
})

describe("/compact argument", () => {
  test("a token count or auto sets the autocompact window", () => {
    expect(["333000", "333k", "333K", "1m", "1.5m", "auto", "AUTO"].map(autocompactArg)).toEqual(["333000", "333000", "333000", "1000000", "1500000", "auto", "auto"])
  })

  test("anything else is instructions for the summary", () => {
    expect(["", "keep the plan", "333 tokens", "k"].map(autocompactArg)).toEqual([undefined, undefined, undefined, undefined])
  })
})
