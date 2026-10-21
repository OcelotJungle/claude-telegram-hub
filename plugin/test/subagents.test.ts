import type { Card } from "../src/transcript/subagents.ts";

import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { MAX_CARD, SubagentWatcher } from "../src/transcript/subagents.ts";
import { tempDir } from "./helpers.ts";

const SEND_EVERY_MS = 3000;
const SECOND = 1000;
const MINUTE = 60_000;
// The tests' clock starts at 18:39 local time.
const START = new Date(2026, 9, 21, 18, 39).getTime();

const line = (o: object) => JSON.stringify(o) + "\n";
const assistant = (id: string, stop: string, block: object) =>
  line({ type: "assistant", isSidechain: true, message: { id, role: "assistant", content: [block], stop_reason: stop } });
const text = (t: string) => ({ type: "text", text: t });
const tool = (name: string, input: object) => ({ type: "tool_use", id: "t", name, input });

describe("SubagentWatcher", () => {
  const watchers: SubagentWatcher[] = [];
  afterEach(() => {
    for (const w of watchers.splice(0)) w.stop();
  });

  function setup(opts: { canStart?: () => boolean } = {}) {
    const dir = join(tempDir(), "subagents");
    const cards: Card[] = [];
    let now = START;
    const w = new SubagentWatcher({
      dir,
      onCard: c => cards.push(c),
      canStart: opts.canStart ?? (() => true),
      intervalMs: 60_000,
      now: () => now,
    });
    watchers.push(w);
    return {
      w,
      dir,
      cards,
      advance(ms: number) {
        now += ms;
        w.tick();
      },
      agent(id: string, meta?: object) {
        mkdirSync(dir, { recursive: true });
        if (meta) writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify(meta));
        const path = join(dir, `agent-${id}.jsonl`);
        writeFileSync(path, "", { flag: "a" });
        return (s: string) => appendFileSync(path, s);
      },
    };
  }

  test("a new agent gets a card with its texts and status, updated at most every few seconds", () => {
    const s = setup();
    s.w.start();
    const write = s.agent("a1", { agentType: "Explore", description: "Find the parser", model: "haiku" });
    write(assistant("m1", "tool_use", text("Looking around")));
    write(assistant("m1", "tool_use", tool("Read", { file_path: "C:\\src\\parse.ts" })));
    s.advance(SEND_EVERY_MS);
    expect(s.cards).toEqual([
      { id: "a1-0", final: false, text: "🤖 **Explore** · Find the parser · haiku\n⏳ 0 с · 1 действие · `Read parse.ts`\n\n`[18:39]` Looking around" },
    ]);
    write(assistant("m2", "tool_use", tool("Grep", { pattern: "x" })));
    s.advance(SECOND);
    expect(s.cards.length).toBe(1);
    s.advance(SEND_EVERY_MS);
    expect(s.cards.at(-1)?.text).toContain("⏳ 4 с · 2 действия · `Grep x`");
    write(assistant("m3", "end_turn", text("Found it")));
    // The final version waits until the file has nothing more to read.
    s.advance(SECOND);
    expect(s.cards.length).toBe(2);
    s.advance(SECOND);
    expect(s.cards.at(-1)).toEqual({
      id: "a1-0",
      final: true,
      text: "🤖 **Explore** · Find the parser · haiku\n✅ готово за 5 с · 2 действия\n\n`[18:39]` Looking around\n\n`[18:39]` Found it",
    });
  });

  test("a running card's time goes on while the agent writes nothing", () => {
    const s = setup();
    s.w.start();
    const write = s.agent("a1");
    write(assistant("m1", "tool_use", tool("Bash", {})));
    s.advance(SEND_EVERY_MS);
    expect(s.cards.map(c => c.text)).toEqual(["🤖 **Субагент**\n⏳ 0 с · 1 действие · `Bash`"]);
    s.advance(SECOND);
    expect(s.cards.length).toBe(1);
    s.advance(SEND_EVERY_MS);
    expect(s.cards.at(-1)?.text).toContain("⏳ 4 с · 1 действие");
    s.advance(MINUTE);
    expect(s.cards.at(-1)?.text).toContain("⏳ 1 мин · 1 действие");
    // Past a minute the time shown changes once a minute.
    s.advance(SEND_EVERY_MS);
    s.advance(SEND_EVERY_MS);
    expect(s.cards.length).toBe(3);
  });

  test("a finished card is not sent again", () => {
    const s = setup();
    s.w.start();
    const write = s.agent("a1");
    write(assistant("m1", "end_turn", text("done")));
    s.advance(SEND_EVERY_MS);
    s.advance(SECOND);
    expect(s.cards.at(-1)).toMatchObject({ final: true });
    const sent = s.cards.length;
    s.advance(MINUTE);
    expect(s.cards.length).toBe(sent);
  });

  test("agents already there at start are followed from their end", () => {
    const s = setup();
    const write = s.agent("old");
    write(assistant("m1", "end_turn", text("old news")));
    s.w.start();
    s.advance(SEND_EVERY_MS);
    expect(s.cards).toEqual([]);
    s.w.taskStatus("old", "completed");
    s.advance(SEND_EVERY_MS);
    expect(s.cards).toEqual([]);
  });

  test("a killed background agent ends with its status", () => {
    const s = setup();
    s.w.start();
    const write = s.agent("a1");
    write(assistant("m1", "tool_use", tool("Bash", { command: "sleep 100" })));
    s.advance(SEND_EVERY_MS);
    s.advance(SECOND);
    s.w.taskStatus("a1", "killed");
    s.w.taskStatus("nobody", "failed");
    s.advance(SECOND);
    expect(s.cards.at(-1)).toMatchObject({ id: "a1-0", final: true, text: expect.stringContaining("⏹ остановлен через 1 с · 1 действие") });
  });

  test("a card is first sent only while allowed, then kept up to date", () => {
    let allowed = false;
    const s = setup({ canStart: () => allowed });
    s.w.start();
    const write = s.agent("a1");
    write(assistant("m1", "tool_use", text("one")));
    s.advance(SEND_EVERY_MS);
    expect(s.cards).toEqual([]);
    allowed = true;
    s.advance(SEND_EVERY_MS);
    expect(s.cards.length).toBe(1);
    allowed = false;
    write(assistant("m2", "end_turn", text("two")));
    s.advance(SEND_EVERY_MS);
    s.advance(SECOND);
    expect(s.cards.at(-1)).toMatchObject({ final: true, text: expect.stringContaining("two") });
  });

  test("a full card is closed and the texts go on in the next one", () => {
    const s = setup();
    s.w.start();
    const write = s.agent("a1");
    const chunk = "x".repeat(1400);
    write(assistant("m1", "tool_use", text(chunk)));
    write(assistant("m1", "tool_use", text(chunk)));
    s.advance(SEND_EVERY_MS);
    expect(s.cards.map(c => c.id)).toEqual(["a1-0"]);
    write(assistant("m2", "tool_use", text(chunk)));
    s.advance(SECOND);
    expect(s.cards[1]).toEqual({ id: "a1-0", final: true, text: `🤖 **Субагент**\n⬇️ продолжение ниже\n\n\`[18:39]\` ${chunk}\n\n\`[18:39]\` ${chunk}` });
    s.advance(SEND_EVERY_MS);
    expect(s.cards[2]).toMatchObject({ id: "a1-1", final: false });
    expect(s.cards.every(c => c.text.length <= MAX_CARD)).toBe(true);
  });

  test("a stopped agent that gets a new message starts a new card", () => {
    const s = setup();
    s.w.start();
    const write = s.agent("a1");
    write(assistant("m1", "end_turn", text("first run")));
    s.advance(SEND_EVERY_MS);
    s.advance(SECOND);
    expect(s.cards.at(-1)).toMatchObject({ id: "a1-0", final: true });
    write(assistant("m2", "tool_use", text("second run")));
    s.advance(SEND_EVERY_MS);
    expect(s.cards.at(-1)).toEqual({ id: "a1-1", final: false, text: "🤖 **Субагент**\n⏳ 0 с · 0 действий\n\n`[18:39]` second run" });
  });

  test("each text shows when the agent wrote it, by its record's time", () => {
    const s = setup();
    s.w.start();
    const write = s.agent("a1");
    const at = (h: number, m: number) => new Date(2026, 9, 21, h, m).toISOString();
    write(line({ type: "assistant", timestamp: at(17, 2), message: { id: "m1", role: "assistant", content: [text("Full run started")], stop_reason: "tool_use" } }));
    write(line({ type: "assistant", timestamp: at(18, 5), message: { id: "m2", role: "assistant", content: [text("## Results\n\n- ok")], stop_reason: "tool_use" } }));
    s.advance(SEND_EVERY_MS);
    expect(s.cards[0]?.text).toEndWith("\n\n`[17:02]` Full run started\n\n`[18:05]`\n## Results\n\n- ok");
  });

  test("Markdown in the description is shown as it is", () => {
    const s = setup();
    s.w.start();
    const write = s.agent("a1", { agentType: "general-purpose", description: "Fix *all* [bugs]" });
    write(assistant("m1", "tool_use", text("ok")));
    s.advance(SEND_EVERY_MS);
    expect(s.cards[0]?.text).toStartWith("🤖 **general\\-purpose** · Fix \\*all\\* \\[bugs\\]\n");
  });
});
