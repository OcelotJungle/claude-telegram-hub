import type { Card } from "../src/transcript/subagents.ts";

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { field, isObject } from "../src/shared/guards.ts";
import { discoverExecutorJob, EXECUTORS } from "../src/transcript/codex-job.ts";
import { MAX_CARD_TEXT, SETTLE_MS, SubagentWatcher } from "../src/transcript/subagents.ts";
import { tempDir } from "./helpers.ts";

const STEP = 3000;
const MINUTE = 60_000;
const START = new Date(2026, 9, 25, 18, 39).getTime();
const JOB = "20260101-120000-abcd";
const COMMAND_LIMIT = 60;
const SUMMARY_COUNT = 10;
const FIRST_RUN_MS = 17 * MINUTE;
const ANSWER_PAUSE_MS = 40 * MINUTE;
const REPLY_RUN_MS = 2 * MINUTE;
const RETRY_CASES = [["failed", false], ["limit", false], ["failed", true], ["limit", true]] as const;
const CONTINUING_EVENTS = [
  { type: "turn.started" },
  { type: "turn.failed" },
  { type: "item.started", item: { type: "todo_list", items: [] } },
  { type: "item.completed", item: { type: "agent_message", text: "Next message" } },
  { type: "item.completed", item: { type: "reasoning", text: "Next reasoning" } },
  { type: "item.completed", item: { type: "command_execution", id: "next", command: "next command" } },
];
const PLURAL_CASES = [[0, "действий"], [1, "действие"], [2, "действия"], [5, "действий"], [11, "действий"], [12, "действий"], [21, "действие"], [22, "действия"], [25, "действий"]] as const;
const TERMINAL_CASES = [["question", "❓ Codex ждёт ответа"], ["failed", "❌ "], ["orphaned", "❌ "], ["limit", "❌ "], ["cancelled", "⏹ "]] as const;

const line = (record: object) => `${JSON.stringify(record)}\n`;
const text = (value: string) => ({ type: "text", text: value });
const assistant = (id: string, value: string, stop = "tool_use") => line({ type: "assistant", message: { id, content: [text(value)], stop_reason: stop } });
const bash = (command: string, name = "Bash") => ({ type: "assistant", message: { id: "tool", content: [{ type: "tool_use", name, input: { command } }], stop_reason: "tool_use" } });
const result = (content: unknown) => ({ type: "user", message: { content: [{ type: "tool_result", content }] } });
const event = (type: string, item?: object) => line({ type, item });
const message = (value: string) => event("item.completed", { type: "agent_message", text: value });
const reasoning = (value: string) => event("item.completed", { type: "reasoning", text: value });
const command = (id: string, value: string, type = "item.completed") => event(type, { id, type: "command_execution", command: value });

describe("Executor cards", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  });

  function setup(meta = true, executor = "codex") {
    const root = tempDir("codex-card-");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const dir = join(root, "subagents");
    const codexJobs = join(root, "codex-jobs");
    const volunteerJobs = join(root, "volunteer-jobs");
    const jobs = executor === "volunteer" ? volunteerJobs : codexJobs;
    const job = join(jobs, JOB);
    mkdirSync(dir);
    const cards: Card[] = [];
    let now = START;
    const watcher = new SubagentWatcher({ dir, codexJobsDir: codexJobs, volunteerJobsDir: volunteerJobs, onCard: card => cards.push(card), canStart: () => true, now: () => now });
    cleanups.push(() => watcher.stop());
    watcher.start();
    const agent = join(dir, "agent-a1.jsonl");
    writeFileSync(agent, "");
    const writeMeta = (agentType = executor, description = "Fix tests") => writeFileSync(join(dir, "agent-a1.meta.json"), JSON.stringify({ agentType, description, model: "haiku" }));
    if (meta) writeMeta();
    return {
      watcher, cards, writeMeta,
      worker(id: string, prompt?: string | ReturnType<typeof text>[], hasMeta = true, workerExecutor = executor) {
        const path = join(dir, `agent-${id}.jsonl`);
        writeFileSync(path, prompt === undefined ? "" : line({ type: "user", message: { content: prompt } }));
        if (hasMeta) writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify({ agentType: workerExecutor, description: "Continue the fix" }));
        return (value: string) => appendFileSync(path, value);
      },
      workerMeta(id: string, workerExecutor = executor) {
        writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify({ agentType: workerExecutor, description: "Continue the fix" }));
      },
      state(extra: object = {}) {
        mkdirSync(job, { recursive: true });
        writeFileSync(join(job, "state.json"), JSON.stringify({ status: "running", slug: "gpt-6.1-sol", effort: "high", notes: [], ...extra }));
      },
      rawState(value: string) {
        mkdirSync(job, { recursive: true });
        writeFileSync(join(job, "state.json"), value);
      },
      stateFor(workerExecutor: string, extra: object = {}) {
        const workerJobs = workerExecutor === "volunteer" ? volunteerJobs : codexJobs;
        const workerJob = join(workerJobs, JOB);
        mkdirSync(workerJob, { recursive: true });
        const defaults = workerExecutor === "volunteer"
          ? { status: "running", slug: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free", effort: "-", notes: [] }
          : { status: "running", slug: "gpt-6.1-sol", effort: "high", notes: [] };
        writeFileSync(join(workerJob, "state.json"), JSON.stringify({ ...defaults, ...extra }));
      },
      events(value: string, replace = false) {
        mkdirSync(job, { recursive: true });
        if (replace) writeFileSync(join(job, "events.jsonl"), value);
        else appendFileSync(join(job, "events.jsonl"), value);
      },
      write(value: string) { appendFileSync(agent, value); },
      start() { appendFileSync(agent, line(result(`job ${JOB} started: gpt-6.1-sol / high, cwd C:/repo`))); },
      attach(verb = "reply", workerExecutor = executor) { appendFileSync(agent, line(bash(`python -I "C:/Users/someone/.claude/tools/${workerExecutor}-run.py" ${verb} ${JOB} --prompt-file reply.md`))); },
      tick(ms = STEP) { now += ms; watcher.tick(); },
      last() { return cards.at(-1)?.text ?? ""; },
      agent() {
        const agents = field(watcher, "agents");
        const agent: unknown = agents instanceof Map ? agents.get("a1") : undefined;
        if (!isObject(agent)) throw new Error("expected the watched agent");
        return agent;
      },
    };
  }

  test("worker task is displayed on its own line", () => {
    const s = setup();
    s.writeMeta("codex", "Review the parser");
    s.state();
    s.start();
    s.events(command("check", "git status", "item.started"));
    s.tick();
    expect(s.last()).toStartWith([
      "🤖 **codex** · sol · high",
      "Review the parser",
      "⏳ 0 с · 0 действий · событие 18:39",
      "`git status`",
    ].join("\n"));
  });

  test.each([false, true])("reply adopts a sealed card with texts, work time, commands and the latest task (blocks: %s)", blocks => {
    const s = setup();
    s.state();
    s.start();
    s.events(message("Earlier Codex progress") + command("old", "old command"));
    s.tick();
    s.state({ status: "question" });
    s.write(assistant("question", "Earlier worker question", "end_turn"));
    s.tick(FIRST_RUN_MS);
    s.tick(SETTLE_MS);
    expect(s.cards.at(-1)).toMatchObject({ id: "a1-0", final: true });
    expect(s.cards.at(-1)?.replyTo).toBeUndefined();
    s.tick(ANSWER_PAUSE_MS);
    const prompt = `reply: ${JOB}\nAnswer the question`;
    const write = s.worker("a2", blocks ? [text(prompt)] : prompt);
    // The proxy prepares its reply before it invokes codex-run.py reply.
    write(line(bash("read instructions", "Read")));
    s.tick();
    expect(s.cards.at(-1)).toMatchObject({ id: "a1-0", final: false, reopen: true });
    s.state();
    s.events(message("Reply progress") + command("reply", "reply command"));
    s.tick(REPLY_RUN_MS);
    expect(s.last()).toStartWith("🤖 **codex** · sol · high\nContinue the fix\n⏳ 19 мин · 2 действия");
    expect(s.last()).toContain("Earlier Codex progress");
    expect(s.last()).toContain("Earlier worker question");
    expect(s.last()).toContain("Reply progress");
    expect(new Set(s.cards.map(card => card.id))).toEqual(new Set(["a1-0"]));
    s.state({ status: "done" });
    write(assistant("reply-final", "Reply final", "end_turn"));
    s.tick();
    s.tick(SETTLE_MS);
    expect(s.last()).toContain("✅ 19 мин · 2 действия");
    expect(s.last()).toContain("Reply final");
    expect(s.cards.at(-1)?.final).toBe(true);
  });

  test("attach adopts an unsealed card and its old owner never sends again", () => {
    const s = setup();
    s.state();
    s.start();
    s.write(assistant("old", "Earlier worker text"));
    s.events(command("old", "old command"));
    s.tick();
    s.worker("a2", `attach: ${JOB}`);
    s.tick();
    const boundary = s.cards.length;
    s.write(assistant("late", "Old owner must stay silent", "end_turn"));
    s.watcher.taskStatus("a1", "completed");
    s.events(message("Attached progress") + command("attached", "attached command"));
    s.tick(SETTLE_MS);
    expect(s.cards.length).toBeGreaterThan(boundary);
    expect(s.cards.slice(boundary).every(card => card.id === "a1-0" && card.reopen && !card.final && card.replyTo === undefined)).toBe(true);
    expect(s.last()).toContain("Earlier worker text");
    expect(s.last()).toContain("Attached progress");
    expect(s.last()).toContain("2 действия");
    expect(s.last()).not.toContain("Old owner must stay silent");
  });

  test("a prompt without an earlier owner starts a new card and skips existing events", () => {
    const s = setup();
    s.state();
    s.events(message("Unseen old progress") + command("old", "old command"));
    s.worker("a2", `reply: ${JOB}`);
    s.tick();
    expect(s.cards.at(-1)).toMatchObject({ id: "a2-0", final: false });
    expect(s.cards.at(-1)?.reopen).toBeUndefined();
    expect(s.cards.at(-1)?.replyTo).toBeUndefined();
    expect(s.last()).not.toContain("Unseen old progress");
    expect(s.last()).toContain("0 действий");
  });

  test("a plugin restart forgets the earlier owner and a continuation gets a new card", () => {
    const s = setup();
    s.state();
    s.start();
    s.write(assistant("old", "Earlier session history"));
    s.tick();
    s.watcher.stop();
    s.watcher.start();
    s.worker("a2", `reply: ${JOB}`);
    s.tick();
    expect(s.cards.at(-1)?.id).toBe("a2-0");
    expect(s.cards.at(-1)?.reopen).toBeUndefined();
    expect(s.last()).not.toContain("Earlier session history");
  });

  test.each(["reply", "attach", "wait"])("command discovery with %s still adopts before its own card appears", verb => {
    const s = setup();
    s.state();
    s.start();
    s.write(assistant("old", "Earlier history"));
    s.tick();
    const write = s.worker("a2");
    write(line(bash(`codex-run.py ${verb} ${JOB}`)));
    s.tick();
    expect(s.cards.at(-1)).toMatchObject({ id: "a1-0", reopen: true });
    expect(s.last()).toContain("Earlier history");
  });

  test("a worker whose own card was shown does not adopt on command discovery", () => {
    const s = setup();
    s.state();
    s.start();
    s.write(assistant("old", "Earlier worker text"));
    s.tick();
    const write = s.worker("a2");
    write(assistant("new", "Own card text"));
    s.tick();
    expect(s.cards.at(-1)?.id).toBe("a2-0");
    write(line(bash(`codex-run.py attach ${JOB}`)));
    s.tick();
    expect(s.cards.at(-1)).toMatchObject({ id: "a2-0", final: false });
    expect(s.cards.at(-1)?.reopen).toBeUndefined();
    expect(s.last()).not.toContain("Earlier worker text");
  });

  test("late metadata still allows prompt adoption before the worker shows a card", () => {
    const s = setup();
    s.state();
    s.start();
    s.tick();
    s.worker("a2", `attach: ${JOB}`, false);
    s.tick();
    s.workerMeta("a2");
    s.tick();
    expect(s.cards.at(-1)).toMatchObject({ id: "a1-0", reopen: true });
    expect(s.last()).toContain("Continue the fix");
  });

  test("adopted cards split normally and a later worker takes the latest part and totals", () => {
    const s = setup();
    s.state();
    s.start();
    s.events(command("old", "old command"));
    s.write(assistant("long-1", "a".repeat(MAX_CARD_TEXT)));
    s.write(assistant("long-2", "b".repeat(MAX_CARD_TEXT)));
    s.tick();
    const write = s.worker("a2", `attach: ${JOB}`);
    s.tick();
    write(assistant("long-3", "c".repeat(MAX_CARD_TEXT)));
    s.events(command("reply", "reply command"));
    s.tick(MINUTE);
    expect(s.cards.some(card => card.id === "a1-0" && card.final && card.reopen && card.text.includes("⬇️ продолжение ниже"))).toBe(true);
    expect(s.cards.at(-1)).toMatchObject({ id: "a1-1", final: false });
    expect(s.cards.at(-1)?.reopen).toBeUndefined();
    s.worker("a3", `attach: ${JOB}`);
    s.tick();
    expect(s.cards.at(-1)).toMatchObject({ id: "a1-1", reopen: true });
    expect(s.last()).toContain("c".repeat(MAX_CARD_TEXT));
    expect(s.last()).toContain("1 мин · 2 действия");
  });

  test("start result reads history and agent messages wait for a continuing event", () => {
    const s = setup();
    s.state();
    s.events(message("Inspecting the parser"));
    s.start();
    s.write(assistant("m1", "codex job running"));
    s.tick();
    expect(s.last()).toStartWith("🤖 **codex** · sol · high\nFix tests\n⏳ 0 с · 0 действий · событие 18:39");
    expect(s.last()).not.toContain("haiku");
    expect(s.last()).not.toContain("Inspecting the parser");
    expect(s.last()).not.toContain("codex job running");
    s.events(message("Checking the boundary") + command("check", "check boundary", "item.started"));
    s.tick(MINUTE);
    expect(s.last()).toContain("`[18:39]` Inspecting the parser");
    expect(s.last()).toContain("`[18:40]` Checking the boundary");
    expect(s.last()).toContain("событие 18:40");
  });

  test("reasoning stays hidden, releases a held agent_message and updates event time", () => {
    const s = setup();
    s.state();
    s.start();
    s.events(reasoning("Hidden reasoning before message"));
    s.tick();
    expect(s.last()).not.toContain("Hidden reasoning before message");
    expect(s.last()).toContain("событие 18:39");
    s.events(message("Visible progress"));
    s.tick();
    expect(s.last()).not.toContain("Visible progress");
    s.events(reasoning("Hidden reasoning after message"));
    s.tick(MINUTE);
    expect(s.last()).toContain("`[18:39]` Visible progress");
    expect(s.last()).toContain("событие 18:40");
    expect(s.cards.every(card => !card.text.includes("Hidden reasoning"))).toBe(true);
  });

  test.each(["reply", "attach"])("%s follows from the end, ignores old notes, and keeps the captured boundary until meta arrives", verb => {
    const s = setup(false);
    s.state({ notes: ["17:01 old restart"] });
    s.events(message("Old output") + command("old", "old command"));
    s.attach(verb);
    s.tick();
    s.events(message("New output") + message("More output") + command("new", "new command"));
    s.state({ notes: ["17:01 old restart", "18:40 restart 1/3: new attempt"] });
    s.writeMeta();
    s.tick(MINUTE);
    expect(s.last()).not.toContain("Old output");
    expect(s.last()).not.toContain("old restart");
    expect(s.last()).toContain("New output");
    expect(s.last()).toContain("More output");
    expect(s.last()).toContain("1 действие");
    expect(s.last()).toContain("`[18:40]` 🔁 restart 1/3: new attempt");
  });

  test("discovery via start result survives late meta", () => {
    const s = setup(false);
    s.state();
    s.events(message("Earlier event") + command("early", "early command", "item.started"));
    s.start();
    s.tick();
    s.writeMeta();
    s.tick();
    expect(s.last()).toContain("sol · high");
    expect(s.last()).toContain("Earlier event");
  });

  test("the last agent_message before turn.completed is never shown, including across polls", () => {
    const s = setup();
    s.state();
    s.start();
    s.events(message("Codex final report"));
    s.tick();
    expect(s.last()).not.toContain("Codex final report");
    s.events(event("turn.completed"));
    s.tick();
    s.events(message("Another run") + command("another", "another command", "item.started"));
    s.tick();
    expect(s.cards.every(card => !card.text.includes("Codex final report"))).toBe(true);
  });

  test("file changes, todo updates and errors keep the final agent_message held until turn.completed", () => {
    const s = setup();
    s.state();
    s.start();
    s.events(message("Held final report"));
    s.tick();
    for (const value of [
      event("item.completed", { type: "file_change", changes: [] }),
      event("item.updated", { type: "todo_list", items: [] }),
      line({ type: "error", message: "Retrying" }),
      event("turn.completed"),
      message("Another turn") + command("another", "another command", "item.started"),
    ]) {
      s.events(value);
      s.tick();
      expect(s.cards.every(card => !card.text.includes("Held final report"))).toBe(true);
    }
  });

  test.each(CONTINUING_EVENTS)("a continuing event %j releases the held agent_message", next => {
    const s = setup();
    s.state();
    s.start();
    s.events(message("The run continues"));
    s.tick();
    expect(s.last()).not.toContain("The run continues");
    s.events(line(next));
    s.tick();
    expect(s.last()).toContain("The run continues");
  });

  test.each(RETRY_CASES)("reply ignores the old %s error (delayed state: %s) but shows it after a new failure", (status, delayedState) => {
    const s = setup();
    if (delayedState) s.rawState("{");
    else s.state({ status, error: "Repeated error" });
    s.attach();
    s.tick();
    if (delayedState) {
      s.state({ status, error: "Repeated error" });
      s.tick();
    }
    expect(s.last()).toContain("❌ ");
    expect(s.last()).not.toContain("❌ Repeated error");
    s.state({ status: "starting", error: "Repeated error" });
    s.tick();
    expect(s.last()).toContain("⏳");
    expect(s.last()).not.toContain("❌");
    s.state({ status: "running", error: "Repeated error" });
    s.tick();
    expect(s.last()).not.toContain("❌");
    s.state({ status: "failed", error: "Repeated error" });
    s.tick();
    expect(s.last()).toContain("❌ ");
    expect(s.last().split("❌ Repeated error")).toHaveLength(2);
    s.tick();
    expect(s.last().split("❌ Repeated error")).toHaveLength(2);
  });

  test("after a restart, wait discovers the job from the current transcript end and repeated waits keep it", () => {
    const s = setup();
    s.state({ notes: ["17:01 old restart"] });
    s.start();
    s.events(message("Old event") + command("old", "old command", "item.started"));
    s.watcher.stop();
    s.watcher.start();
    s.attach("wait");
    s.write(assistant("summary", "codex job restored"));
    s.tick();
    expect(s.last()).toContain("sol · high");
    expect(s.last()).not.toContain("codex job restored");
    expect(s.last()).not.toContain("Old event");
    expect(s.last()).not.toContain("old restart");
    s.events(message("New event") + command("new", "new command"));
    s.attach("wait");
    s.tick();
    expect(s.last()).toContain("New event");
    expect(s.last()).toContain("1 действие");
    s.attach("wait");
    s.tick();
    expect(s.last()).toContain("1 действие");
  });

  test("many long interim summaries are discarded without filling or splitting the Codex card", () => {
    const s = setup();
    s.state();
    s.start();
    s.events(message("Live Codex text") + command("live", "live command", "item.started"));
    s.tick();
    for (let index = 0; index < SUMMARY_COUNT; index++) {
      s.write(assistant(`summary-${index}`, `codex job ${"x".repeat(MAX_CARD_TEXT)}`));
      s.tick();
    }
    expect(new Set(s.cards.map(card => card.id))).toEqual(new Set(["a1-0"]));
    expect(s.last()).toContain("Live Codex text");
    expect(s.last()).not.toContain("codex job");
    // Discarded summaries must not accumulate behind the rendered card.
    expect(field(s.agent(), "texts")).toHaveLength(1);
    s.write(assistant("final", "codex job final answer", "end_turn"));
    s.tick();
    expect(s.last()).toContain("codex job final answer");
  });

  test("an unchanged stopped Codex card is not rendered again, but new Codex details mark it dirty", () => {
    const s = setup();
    s.state();
    s.start();
    s.write(assistant("final", "Done", "end_turn"));
    s.tick();
    const render = spyOn(s.agent(), "render");
    cleanups.push(() => render.mockRestore());
    s.tick();
    expect(render).not.toHaveBeenCalled();
    s.state({ slug: "gpt-other", effort: "low" });
    s.tick();
    expect(render).toHaveBeenCalledTimes(1);
    s.tick();
    expect(render).toHaveBeenCalledTimes(1);
    s.events(command("a", "new command", "item.started"));
    s.tick();
    expect(render).toHaveBeenCalledTimes(2);
    s.tick();
    expect(render).toHaveBeenCalledTimes(2);
    s.events(command("a", "new command"));
    s.tick();
    expect(s.last()).toContain("1 действие");
    render.mockClear();
    s.tick();
    expect(render).not.toHaveBeenCalled();
  });

  test("worker summaries and launch lines are hidden, but final texts with those prefixes are kept", () => {
    const s = setup();
    s.state();
    s.start();
    s.write(assistant("summary", "codex job interim"));
    s.write(assistant("launch", `job ${JOB} started: slug`));
    s.write(assistant("resume", `job ${JOB} resumed with the reply`));
    s.write(assistant("relayed", `Job ${JOB} started: gpt-6-luna / high\n\nWaiting for the job to finish.`));
    s.write(assistant("normal", "Worker explanation"));
    s.tick();
    expect(s.last()).not.toContain("codex job interim");
    expect(s.last()).not.toContain("started:");
    expect(s.last()).not.toContain("resumed with");
    expect(s.last()).not.toContain("Waiting for the job");
    expect(s.last()).toContain("Worker explanation");
    // Multiple records of the final message share its message id and turn end.
    s.write(assistant("final", "codex job final report", "end_turn"));
    s.write(assistant("final", "More final details", "end_turn"));
    s.state({ status: "done" });
    s.tick();
    expect(s.last()).toContain("codex job final report");
    expect(s.last()).toContain("More final details");
    expect(s.last()).toMatch(/✅ \d+ с · /);
    s.tick(SETTLE_MS);
    expect(s.cards.at(-1)?.final).toBe(true);
    // The closed card still tells which Codex model did the work.
    expect(s.last()).toStartWith("🤖 **codex** · sol · high\nFix tests\n✅ ");
  });

  test.each(PLURAL_CASES)("%i actions from completed commands use %s", (count, form) => {
    const s = setup();
    s.state();
    s.start();
    for (let index = 0; index < count; index++) s.events(command(String(index), "echo ok"));
    s.tick();
    expect(s.last()).toContain(` · ${count} ${form}`);
  });

  test("the status tracks the newest unfinished command by id, first line, length and event time", () => {
    const s = setup();
    s.state();
    s.start();
    s.tick();
    expect(s.last()).not.toContain("событие");
    const long = "x".repeat(COMMAND_LIMIT + 1);
    s.events(command("a", "older command", "item.started") + command("b", `${long}\nsecret second line`, "item.started"));
    s.tick(MINUTE);
    expect(s.last()).toContain(` · событие 18:40\n\`${long.slice(0, COMMAND_LIMIT)}…\``);
    expect(s.last()).not.toContain("secret second line");
    s.events(command("b", long));
    s.tick();
    expect(s.last()).toContain("1 действие · событие 18:40\n`older command`");
    s.events(command("a", "older command"));
    s.tick();
    expect(s.last()).toContain("2 действия · событие 18:40");
    expect(s.last()).not.toContain("older command");
  });

  test.each(TERMINAL_CASES)("state %s changes status before the worker ends and retains its final answer", (status, expected) => {
    const s = setup();
    s.state();
    s.start();
    s.events(command("a", "test"));
    s.tick();
    s.state({ status, error: "Runner explanation" });
    s.tick();
    expect(s.last()).toContain(expected);
    expect(s.cards.at(-1)?.final).toBe(false);
    if (status !== "question") {
      expect(s.last()).toContain("1 действие");
      expect(s.last().split("❌ Runner explanation")).toHaveLength(2);
    } else expect(s.last()).not.toContain("❌ Runner explanation");
    s.write(assistant("final", "Final worker answer", "end_turn"));
    s.tick();
    s.tick(SETTLE_MS);
    expect(s.last()).toContain(expected);
    expect(s.last()).toContain("Final worker answer");
    expect(s.cards.at(-1)?.final).toBe(true);
    if (status !== "question") expect(s.last().split("❌ Runner explanation")).toHaveLength(2);
  });

  test("cancel without an error has no error entry; done waits for the worker", () => {
    const s = setup();
    s.state({ status: "done" });
    s.start();
    s.tick();
    expect(s.last()).toContain("⏳");
    expect(s.cards.at(-1)?.final).toBe(false);
    s.state({ status: "cancelled", error: null });
    s.tick();
    expect(s.last()).toMatch(/⏹ \d+ с · /);
    expect(s.last()).not.toContain("❌");
  });

  test("notes use their own clock and are appended once, including identical new notes", () => {
    const s = setup();
    s.state({ notes: ["17:02 restart 1/3: exited", "18:05 model changed"] });
    s.start();
    s.tick();
    expect(s.last()).toContain("`[17:02]` 🔁 restart 1/3: exited");
    expect(s.last()).toContain("`[18:05]` 🔁 model changed");
    s.tick();
    expect(s.last().split("🔁 restart")).toHaveLength(2);
    s.state({ notes: ["17:02 restart 1/3: exited", "18:05 model changed", "18:05 model changed"] });
    s.tick();
    expect(s.last().split("🔁 model changed")).toHaveLength(3);
  });

  test("a missing job retains all worker texts and the original action status", () => {
    const s = setup();
    s.attach();
    s.write(assistant("summary", "codex job fallback"));
    s.tick();
    expect(s.last()).toContain("1 действие");
    expect(s.last()).toContain("codex job fallback");
    expect(s.last()).not.toContain("sol · high");
    s.write(assistant("final", "Fallback final", "end_turn"));
    s.tick();
    expect(s.last()).toMatch(/✅ \d+ (?:с|мин) · \d+ действи(?:е|я|й)/);
    expect(s.last()).toContain("Fallback final");
  });

  test("a job appearing later enables Codex; malformed state and events are safely ignored", () => {
    const s = setup();
    s.start();
    s.rawState('{"status":"running","slug":123,"effort":"high"}');
    s.write(assistant("summary", "codex job fallback"));
    s.tick();
    expect(s.last()).toContain("codex job fallback");
    s.state();
    s.events("not json\n" + line({ type: 123 }) + event("item.completed", { type: "agent_message", text: 123 }) + message("Valid message") + command("valid", "valid command", "item.started"));
    s.tick();
    expect(s.last()).toContain("sol · high");
    expect(s.last()).toContain("Valid message");
    expect(s.last()).not.toContain("codex job fallback");
    s.rawState("{");
    s.tick();
    expect(s.last()).toContain("sol · high");
  });

  test("ordinary agents do not read Codex events or filter their own text", () => {
    const s = setup();
    s.writeMeta("Explore");
    s.state();
    s.start();
    s.events(message("Codex event") + command("codex", "codex command", "item.started"));
    s.write(assistant("summary", "codex job worker text"));
    s.tick();
    expect(s.last()).toContain("haiku");
    expect(s.last()).toContain("codex job worker text");
    expect(s.last()).not.toContain("Codex event");
  });

  test("events are re-read after shrink", () => {
    const s = setup();
    s.state();
    s.start();
    s.events(message("Long old message ".repeat(COMMAND_LIMIT)) + command("old", "old command", "item.started"));
    s.tick();
    s.events(message("After shrink") + command("new", "new command", "item.started"), true);
    s.tick();
    expect(s.last()).toContain("After shrink");
  });

  test("a worker run after a sealed card captures a new reply boundary and command count", () => {
    const s = setup();
    s.state();
    s.start();
    s.events(command("old", "old command"));
    s.write(assistant("first-final", "First final", "end_turn"));
    s.tick();
    s.tick(SETTLE_MS);
    expect(s.cards.at(-1)?.final).toBe(true);
    // A text record can reopen the agent before the reply call is recorded.
    s.write(assistant("second", "Replying"));
    s.attach();
    s.tick();
    expect(s.cards.at(-1)).toMatchObject({ id: "a1-1", final: false });
    expect(s.last()).toContain("0 действий");
    s.events(command("new", "new command"));
    s.tick();
    expect(s.last()).toContain("1 действие");
  });

  test.each([
    ["openrouter/nvidia/nemotron-3-ultra-550b-a55b:free", "openrouter · nemotron\\-3\\-ultra\\-550b\\-a55b"],
    ["groq/openai/gpt-oss-120b", "groq · gpt\\-oss\\-120b"],
    ["zhipu/glm-4.5", "zhipu · glm\\-4\\.5"],
    ["single-model", "single\\-model"],
  ])("volunteer header formats model slug %s", (slug, expected) => {
    const s = setup(true, "volunteer");
    s.state({ slug, effort: "-" });
    s.start();
    s.tick();
    expect(s.last()).toStartWith(`🤖 **volunteer** · ${expected}\nFix tests\n⏳`);
    expect(s.last()).not.toContain("medium");
    expect(s.last()).not.toContain(" · -");
  });

  test("executor reply prompt before metadata captures the existing note boundary", () => {
    for (const executor of ["codex", "volunteer"]) {
      const s = setup(false, executor);
      s.state({ notes: ["17:01 previous model switch"] });
      const write = s.worker("a2", undefined, false, executor);
      write(line({ type: "user", message: { content: `reply: ${JOB}` } }));
      s.tick();
      expect(s.last()).toStartWith(`🤖 **${executor}**`);
      expect(s.last()).not.toContain("previous model switch");
      s.state({ notes: ["17:01 previous model switch", "18:40 current model switch"] });
      s.tick();
      expect(s.last()).not.toContain("previous model switch");
      expect(s.last().split("current model switch")).toHaveLength(2);
      s.workerMeta("a2", executor);
      s.tick();
      expect(s.last().split("current model switch")).toHaveLength(2);
    }
  });

  test.each(["codex", "volunteer"])("a %s Bash script selects its executor before metadata", executor => {
    const s = setup(false, executor);
    const write = s.worker("a2", undefined, false, executor);
    write(line(bash(`python -I C:/tools/${executor}-run.py reply ${JOB}`)));
    s.tick();
    expect(s.last()).toStartWith(`🤖 **${executor}**`);
  });

  test("ambiguous reply waits for a job directory or metadata", () => {
    const s = setup(false);
    const write = s.worker("a2", undefined, false);
    write(line({ type: "user", message: { content: `reply: ${JOB}` } }));
    s.tick();
    expect(s.cards).toHaveLength(0);

    s.stateFor("codex");
    s.stateFor("volunteer");
    write(line({ type: "user", message: { content: `attach: ${JOB}` } }));
    s.tick();
    expect(s.cards).toHaveLength(0);

    s.workerMeta("a2", "volunteer");
    s.tick();
    expect(s.last()).toStartWith("🤖 **volunteer**");
  });

  test("unknown reply waits until exactly one matching job directory appears", () => {
    const s = setup(false);
    const write = s.worker("a2", undefined, false);
    write(line({ type: "user", message: { content: `reply: ${JOB}` } }));
    s.tick();
    expect(s.cards).toHaveLength(0);
    s.stateFor("volunteer");
    write(line({ type: "user", message: { content: `attach: ${JOB}` } }));
    s.tick();
    expect(s.last()).toStartWith("🤖 **volunteer**");
  });

  test("volunteer model switches update the header and append every note once", () => {
    const s = setup(true, "volunteer");
    s.state();
    s.start();
    s.tick();
    s.state({ slug: "groq/openai/gpt-oss-120b", notes: ["16:05 model old:free failed: APIError 502; switching to groq/openai/gpt-oss-120b", "16:09 model old failed; switching to groq/openai/gpt-oss-120b"] });
    s.tick();
    expect(s.last()).toStartWith("🤖 **volunteer** · groq · gpt\\-oss\\-120b");
    expect(s.last().split("🔁 model old")).toHaveLength(3);
    s.tick();
    expect(s.last().split("🔁 model old")).toHaveLength(3);
  });

  test("volunteer digest stays hidden, no-free-model failure and final report stay visible", () => {
    const s = setup(true, "volunteer");
    s.state({ status: "failed", error: "no free models available: exhausted" });
    s.start();
    s.write(assistant("digest", `volunteer job ${JOB} · running · requesty/novita/ling-3.1-flash · 61 min · last activity 16:11 · 2 commands since last check · switches 4`));
    s.write(assistant("launch", `python -I C:/Users/test/.claude/tools/volunteer-run.py wait ${JOB}`));
    s.write(assistant("prompt-file", "Prompt: C:/repo/.tmp/volunteer-prompt-abc.md"));
    s.write(assistant("waiting", `(still running; call: wait ${JOB})`));
    s.write(assistant("final", "STATUS: failed\nSummary\nNo free models were available.", "end_turn"));
    s.tick();
    s.tick(SETTLE_MS);
    expect(s.last()).not.toContain("commands since last check");
    expect(s.last()).not.toContain("volunteer-run.py");
    expect(s.last()).not.toContain("volunteer-prompt-");
    expect(s.last()).not.toContain("still running; call");
    expect(s.last()).toContain("❌ no free models available: exhausted");
    expect(s.last()).toContain("STATUS: failed");
    expect(s.last()).toContain("No free models were available.");
    expect(s.cards.at(-1)?.final).toBe(true);
  });

  test("volunteer question status uses the lowercase executor label", () => {
    const s = setup(true, "volunteer");
    s.state({ status: "question" });
    s.start();
    s.tick();
    expect(s.last()).toContain("❓ volunteer ждёт ответа");
  });

  test.each(["reply", "attach"])("volunteer %s reuses the existing card", verb => {
    const s = setup(true, "volunteer");
    s.state();
    s.start();
    s.events(message("Earlier volunteer progress") + command("old", "inspect files"));
    s.tick();
    const write = s.worker("a2", `${verb}: ${JOB}`);
    s.tick();
    expect(s.cards.at(-1)).toMatchObject({ id: "a1-0", reopen: true });
    s.state({ slug: "groq/openai/gpt-oss-120b" });
    s.events(message("Continued volunteer progress") + command("new", "update files"));
    write(assistant("final", "Volunteer report", "end_turn"));
    s.tick(REPLY_RUN_MS);
    expect(new Set(s.cards.map(card => card.id))).toEqual(new Set(["a1-0"]));
    expect(s.last()).toContain("Earlier volunteer progress");
    expect(s.last()).toContain("Continued volunteer progress");
    expect(s.last()).toContain("Volunteer report");
  });

  test("Codex and volunteer jobs with the same id keep separate cards", () => {
    const s = setup();
    s.stateFor("codex");
    s.stateFor("volunteer");
    s.start();
    s.tick();
    const write = s.worker("a2", undefined, true, "volunteer");
    write(line(result(`job ${JOB} started: openrouter/nvidia/nemotron-3-ultra-550b-a55b:free`)));
    s.tick();
    expect(new Set(s.cards.map(card => card.id))).toEqual(new Set(["a1-0", "a2-0"]));
    expect(s.cards.filter(card => card.id === "a1-0").at(-1)?.text).toContain("**codex**");
    expect(s.cards.filter(card => card.id === "a2-0").at(-1)?.text).toContain("**volunteer**");
  });
});

test("executor discovery validates records and detects prompts, full Bash commands and start results", () => {
  const discoverCodex = (record: unknown) => discoverExecutorJob(record, EXECUTORS.codex);
  const discoverVolunteer = (record: unknown) => discoverExecutorJob(record, EXECUTORS.volunteer);
  expect(discoverCodex(bash(`python ${"long-path/".repeat(COMMAND_LIMIT)}codex-run.py reply ${JOB}`))).toEqual({ id: JOB, fromStart: false, source: "command" });
  expect(discoverVolunteer(bash(`python ${"long-path/".repeat(COMMAND_LIMIT)}volunteer-run.py attach ${JOB}`))).toEqual({ id: JOB, fromStart: false, source: "command" });
  expect(discoverCodex(result([text(`job ${JOB} started: model`)]))).toEqual({ id: JOB, fromStart: true, source: "started" });
  expect(discoverCodex(bash(`echo reply ${JOB}`))).toBeUndefined();
  expect(discoverCodex(bash(`codex-run.py reply ${JOB}`, "Read"))).toBeUndefined();
  expect(discoverCodex(bash("codex-run.py reply ../../unsafe"))).toBeUndefined();
  expect(discoverCodex(result({ text: `job ${JOB} started: model` }))).toBeUndefined();
  expect(discoverCodex(null)).toBeUndefined();
  expect(discoverCodex({ type: "user", message: { content: `reply: ${JOB}\nAnswer` } })).toEqual({ id: JOB, fromStart: false, source: "prompt" });
  expect(discoverCodex({ type: "user", message: { content: [text("Instructions"), text(`attach: ${JOB}`)] } })).toEqual({ id: JOB, fromStart: false, source: "prompt" });
  expect(discoverCodex({ type: "user", message: { content: "reply: ../../unsafe" } })).toBeUndefined();
  expect(discoverCodex({ type: "user", message: { content: `Mention reply: ${JOB}` } })).toBeUndefined();
  expect(discoverCodex({ type: "assistant", message: { content: [text(`reply: ${JOB}`)] } })).toBeUndefined();
  expect(discoverCodex(result(`reply: ${JOB}`))).toBeUndefined();
});
