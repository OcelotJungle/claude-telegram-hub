import type { Card } from "../src/transcript/subagents.ts";

import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { ModelVersions } from "../src/transcript/model-versions.ts";
import { MAX_CARD, SETTLE_MS, SubagentWatcher, WAIT_MAX_MS } from "../src/transcript/subagents.ts";
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

  function setup(opts: { canStart?: () => boolean; versions?: ModelVersions } = {}) {
    const dir = join(tempDir(), "subagents");
    const cards: Card[] = [];
    let now = START;
    const w = new SubagentWatcher({
      dir,
      onCard: c => cards.push(c),
      canStart: opts.canStart ?? (() => true),
      intervalMs: 60_000,
      now: () => now,
      ...(opts.versions ? { versions: opts.versions } : {}),
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
      { id: "a1-0", final: false, text: "🤖 **Explore** · haiku\nFind the parser\n⏳ 0 с · 1 действие\n`Read parse.ts`\n\n`[18:39]` Looking around" },
    ]);
    write(assistant("m2", "tool_use", tool("Grep", { pattern: "x" })));
    s.advance(SECOND);
    expect(s.cards.length).toBe(1);
    s.advance(SEND_EVERY_MS);
    expect(s.cards.at(-1)?.text).toContain("⏳ 4 с · 2 действия\n`Grep x`");
    write(assistant("m3", "end_turn", text("Found it")));
    s.advance(SEND_EVERY_MS);
    const done = "🤖 **Explore** · haiku\nFind the parser\n✅ готово за 7 с · 2 действия\n\n`[18:39]` Looking around\n\n`[18:39]` Found it";
    expect(s.cards.at(-1)).toEqual({ id: "a1-0", final: false, text: done });
    // The card closes once the agent has not gone on for SETTLE_MS.
    s.advance(SETTLE_MS - SECOND);
    expect(s.cards.at(-1)?.final).toBe(false);
    s.advance(SECOND);
    expect(s.cards.at(-1)).toEqual({ id: "a1-0", final: true, text: done });
  });

  test("the header shows the model and effort of the agent's latest answer, the launch alias until then", () => {
    const s = setup();
    s.w.start();
    const write = s.agent("a1", { agentType: "Explore", description: "Find the parser", model: "opus" });
    const answer = (id: string, model: string, effort?: string) =>
      line({ type: "assistant", isSidechain: true, effort, message: { id, role: "assistant", model, content: [tool("Grep", { pattern: "x" })], stop_reason: "tool_use" } });
    write(line({ type: "user", isSidechain: true, message: { role: "user", content: "Find it" } }));
    write(assistant("m0", "tool_use", tool("Grep", { pattern: "x" })));
    s.advance(SEND_EVERY_MS);
    expect(s.cards.at(-1)?.text).toStartWith("🤖 **Explore** · opus\nFind the parser\n");
    write(answer("m1", "claude-opus-5-5", "high"));
    s.advance(SEND_EVERY_MS);
    // The newest version seen of its line: the line alone.
    expect(s.cards.at(-1)?.text).toStartWith("🤖 **Explore** · opus · high\nFind the parser\n");
    // Claude Code's own message does not change it; a new effort does.
    write(answer("m2", "<synthetic>"));
    write(answer("m3", "claude-haiku-4-5-20251001", "low"));
    s.advance(SEND_EVERY_MS);
    expect(s.cards.at(-1)?.text).toStartWith("🤖 **Explore** · haiku · low\nFind the parser\n");
    write(answer("m4", "gpt-proxy"));
    s.advance(SEND_EVERY_MS);
    expect(s.cards.at(-1)?.text).toStartWith("🤖 **Explore** · gpt\\-proxy\nFind the parser\n");
  });

  test("a model older than the newest seen of its line keeps its version", () => {
    const versions = new ModelVersions();
    versions.see({ kind: "claude", line: "haiku", version: "5.5" });
    const s = setup({ versions });
    s.w.start();
    const write = s.agent("a1", { agentType: "Explore", description: "Find the parser" });
    write(line({ type: "assistant", isSidechain: true, effort: "low", message: { id: "m1", role: "assistant", model: "claude-haiku-4-5-20251001", content: [tool("Grep", { pattern: "x" })], stop_reason: "tool_use" } }));
    s.advance(SEND_EVERY_MS);
    expect(s.cards.at(-1)?.text).toStartWith("🤖 **Explore** · haiku 4\\.5 · low\n");
  });

  test("an agent that goes on after a turn end keeps its card", () => {
    const s = setup();
    s.w.start();
    const write = s.agent("a1");
    write(assistant("m1", "tool_use", tool("Bash", { command: "make" })));
    // Claude Code's record when only the auto mode classifier's response broke off.
    write(line({ type: "assistant", isApiErrorMessage: true, error: "server_error", message: { id: "e1", role: "assistant", content: [text("API Error: The response stopped arriving.")], stop_reason: "stop_sequence" } }));
    s.advance(SEND_EVERY_MS);
    expect(s.cards.at(-1)?.text).toContain("✅ готово");
    write(assistant("m2", "tool_use", text("Build done")));
    s.advance(SEND_EVERY_MS);
    const last = s.cards.at(-1)?.text ?? "";
    expect(last).toContain("⏳ 3 с · 1 действие");
    expect(last).toEndWith("Build done");
    expect(s.cards.every(c => c.id === "a1-0" && !c.final)).toBe(true);
  });

  describe("an agent with a background task", () => {
    const bgBash = (id: string) => line({ type: "user", isSidechain: true, message: { role: "user", content: [{ type: "tool_result", content: `Command running in background with ID: ${id}.` }] }, toolUseResult: { stdout: "", backgroundTaskId: id } });
    const monitor = (id: string) => line({ type: "user", isSidechain: true, message: { role: "user", content: [{ type: "tool_result", content: `Monitor started (task ${id})` }] }, toolUseResult: { taskId: id, timeoutMs: 1_800_000, persistent: false } });
    const notice = (id: string, tail: string) =>
      line({ type: "user", isSidechain: true, isMeta: true, message: { role: "user", content: `[SYSTEM NOTIFICATION]\n\n<task-notification>\n<task-id>${id}</task-id>\n${tail}\n</task-notification>` } });
    const taskStop = (id: string) =>
      line({ type: "user", isSidechain: true, message: { role: "user", content: [{ type: "tool_result", content: "{}" }] }, toolUseResult: { message: `Successfully stopped task: ${id} (sleep 9)`, task_id: id, task_type: "local_bash" } });

    function waiting() {
      const s = setup();
      s.w.start();
      const write = s.agent("a1");
      write(assistant("m1", "tool_use", tool("Bash", { command: "make", run_in_background: true })));
      write(bgBash("bk1"));
      write(assistant("m2", "end_turn", text("Waiting for the task")));
      s.advance(SEND_EVERY_MS);
      return { s, write };
    }

    test("a turn end keeps the card open with a waiting status", () => {
      const { s } = waiting();
      expect(s.cards.at(-1)?.text).toContain("⏸ ждёт фоновую задачу · 0 с");
      expect(s.cards.at(-1)?.text).not.toContain("✅");
      s.advance(SETTLE_MS + MINUTE);
      expect(s.cards.at(-1)).toMatchObject({ final: false, text: expect.stringContaining("⏸ ждёт фоновую задачу · 3 мин") });
      expect(s.cards.some(c => c.final)).toBe(false);
    });

    test("a background agent of its own is a task it waits for", () => {
      const s = setup();
      s.w.start();
      const write = s.agent("a1");
      write(assistant("m1", "tool_use", tool("Agent", { description: "Review", prompt: "Review it", run_in_background: true })));
      write(line({ type: "user", isSidechain: true, message: { role: "user", content: [{ type: "tool_result", content: [{ type: "text", text: "Async agent launched successfully." }] }] }, toolUseResult: { isAsync: true, status: "async_launched", agentId: "ag7", description: "Review" } }));
      write(assistant("m2", "end_turn", text("Waiting for the review")));
      s.advance(SETTLE_MS + MINUTE);
      expect(s.cards.at(-1)).toMatchObject({ final: false, text: expect.stringContaining("⏸ ждёт фоновую задачу") });
    });

    test("the waiting time goes on like a running card's", () => {
      const { s } = waiting();
      const sent = s.cards.length;
      s.advance(SEND_EVERY_MS);
      expect(s.cards.length).toBe(sent + 1);
      expect(s.cards.at(-1)?.text).toContain("⏸ ждёт фоновую задачу · 3 с");
    });

    test("a record wakes it: the same card goes on", () => {
      const { s, write } = waiting();
      s.advance(10 * MINUTE);
      write(notice("bk1", "<status>completed</status>\n<summary>done</summary>"));
      write(assistant("m3", "tool_use", tool("Read", { file_path: "a.ts" })));
      s.advance(SEND_EVERY_MS);
      expect(s.cards.at(-1)).toMatchObject({ id: "a1-0", final: false, text: expect.stringContaining("⏳ 10 мин · 2 действия") });
      expect(s.cards.every(c => c.id === "a1-0" && !c.final)).toBe(true);
    });

    test("after the task ends, the next turn end closes the card as usual", () => {
      const { s, write } = waiting();
      s.advance(10 * MINUTE);
      write(notice("bk1", "<status>completed</status>"));
      write(assistant("m3", "end_turn", text("All done")));
      s.advance(SEND_EVERY_MS);
      expect(s.cards.at(-1)?.text).toContain("✅ готово");
      s.advance(SETTLE_MS);
      expect(s.cards.at(-1)).toMatchObject({ id: "a1-0", final: true });
    });

    test("a Monitor's event notification without a status does not end the task", () => {
      const s = setup();
      s.w.start();
      const write = s.agent("a1");
      write(monitor("mon1"));
      write(assistant("m1", "end_turn", text("Waiting for the monitor")));
      write(notice("mon1", "<summary>Monitor event: haiku done</summary>"));
      s.advance(SEND_EVERY_MS);
      s.advance(SETTLE_MS * 2);
      expect(s.cards.at(-1)).toMatchObject({ final: false, text: expect.stringContaining("⏸ ждёт фоновую задачу") });
    });

    test("a notification with any status ends the task", () => {
      const s = setup();
      s.w.start();
      const write = s.agent("a1");
      write(monitor("mon1"));
      write(assistant("m1", "end_turn", text("Waiting")));
      write(notice("mon1", "<status>failed</status>"));
      s.advance(SEND_EVERY_MS);
      s.advance(SETTLE_MS);
      expect(s.cards.at(-1)).toMatchObject({ final: true, text: expect.stringContaining("✅ готово") });
    });

    test("a TaskStop of the task ends it", () => {
      const { s, write } = waiting();
      write(taskStop("bk1"));
      s.advance(SEND_EVERY_MS);
      s.advance(SETTLE_MS);
      expect(s.cards.at(-1)).toMatchObject({ final: true, text: expect.stringContaining("✅ готово") });
    });

    test("it waits for WAIT_MAX_MS, then the card closes and a later wake opens a new one", () => {
      const { s, write } = waiting();
      s.advance(WAIT_MAX_MS - SECOND);
      expect(s.cards.at(-1)?.final).toBe(false);
      s.advance(SECOND);
      expect(s.cards.at(-1)).toMatchObject({ id: "a1-0", final: true, text: expect.stringContaining("✅ готово") });
      write(assistant("m3", "tool_use", text("Woken")));
      s.advance(SEND_EVERY_MS);
      expect(s.cards.at(-1)).toMatchObject({ id: "a1-1", final: false });
    });

    test("the parent's notification closes the card at once", () => {
      const { s } = waiting();
      s.w.taskStatus("a1", "completed");
      s.advance(SECOND);
      expect(s.cards.at(-1)).toMatchObject({ id: "a1-0", final: true, text: expect.stringContaining("✅ готово") });
    });
  });

  test("a running card's time goes on while the agent writes nothing", () => {
    const s = setup();
    s.w.start();
    const write = s.agent("a1");
    write(assistant("m1", "tool_use", tool("Bash", {})));
    s.advance(SEND_EVERY_MS);
    expect(s.cards.map(c => c.text)).toEqual(["🤖 **Субагент**\n⏳ 0 с · 1 действие\n`Bash`"]);
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
    s.advance(SETTLE_MS);
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

  test("an agent that hands its report back is done", () => {
    const s = setup();
    s.w.start();
    const write = s.agent("a1");
    write(assistant("m1", "tool_use", tool("Read", { file_path: "a.ts" })));
    write(assistant("m2", "tool_use", tool("SubagentHandback", { message: "All fixed." })));
    s.advance(SEND_EVERY_MS);
    expect(s.cards.at(-1)?.text).toContain("✅ готово за 0 с · 2 действия");
    s.advance(SETTLE_MS);
    expect(s.cards.at(-1)).toMatchObject({ id: "a1-0", final: true });
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
    s.advance(SETTLE_MS);
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
    s.advance(SETTLE_MS);
    expect(s.cards.at(-1)).toMatchObject({ id: "a1-0", final: true });
    write(assistant("m2", "tool_use", text("second run")));
    s.advance(SEND_EVERY_MS);
    expect(s.cards.at(-1)).toEqual({ id: "a1-1", final: false, text: "🤖 **Субагент**\n⏳ 0 с · 0 действий\n\n`[18:41]` second run" });
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
    expect(s.cards[0]?.text).toStartWith("🤖 **general\\-purpose**\nFix \\*all\\* \\[bugs\\]\n");
  });
});
