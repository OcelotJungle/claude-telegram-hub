import type { Config } from "../src/shared/config.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, truncateSync, writeFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { Hub } from "../src/hub/hub.ts";
import { TelegramApi } from "../src/hub/telegram.ts";
import { CONTINUE_PROMPT, CUT_LIMIT_NOTE, CUT_NOTE, interruptPrompt, MAX_AUTO_CONTINUES, PluginCore } from "../src/plugin/plugin.ts";
import { arr, field } from "../src/shared/guards.ts";
import { NOTIFY_MARKER } from "../src/transcript/relay.ts";
import { buttonPress, FakeTelegram, topicMsg } from "./fake-telegram.ts";
import { freePort, memLogger, tempDir, waitFor } from "./helpers.ts";

const GROUP = "-1001";
const ME = "123456789";
const CWD = "C:\\code\\demo-app";
const SID = "sess-1";

let fake: FakeTelegram;
let hub: Hub;
let port: number;
let configDir: string;
let transcript: string;
let config: Config;
let core: PluginCore | undefined;
let channel: { content: string; meta: Record<string, string> }[];
let answers: { requestId: string; behavior: string }[];
// Each interrupt, with the number of channel messages emitted before and after it.
let interrupts: { prompt: string; channelBefore: number; channelAfter: number }[];
let interruptMs: number;
let interruptFails: boolean;
let terminated: number;
let spoolDir: string;
let state: string;
let spawned: number;
let pluginLog: ReturnType<typeof memLogger>;

const line = (o: object) => JSON.stringify(o) + "\n";
const append = (...recs: object[]) => appendFileSync(transcript, recs.map(line).join(""));
let msgN = 0;
const assistantText = (text: string, stop: "tool_use" | "end_turn" | "stop_sequence", id = `m${++msgN}`) => ({
  type: "assistant",
  isSidechain: false,
  message: { id, role: "assistant", content: [{ type: "text", text }], stop_reason: stop },
});
const assistantTool = (name: string, id: string) => ({
  type: "assistant",
  isSidechain: false,
  message: { id, role: "assistant", content: [{ type: "tool_use", id: "t", name, input: {} }], stop_reason: "tool_use" },
});
const humanTyped = (text: string) => ({ type: "user", isSidechain: false, origin: { kind: "human" }, promptSource: "typed", message: { role: "user", content: text } });
const typedMidTurn = (text: string) => ({ type: "attachment", isSidechain: false, attachment: { type: "queued_command", prompt: text, commandMode: "prompt", origin: { kind: "human" } } });
const NARRATION_SIG = "CAQSrgcKEQgSGAI4AUIJbmFycmF0aW9uEgxhMFJuZKXpKQCYxWIaDLo3cuvEnZjRl04uqSIwcikVdFlQ26x5rHo0oYhd4CFFTF+Qg/KbIJ4gkTpHfgPAWqq3";
const assistantNarration = (text: string, id: string) => ({
  type: "assistant",
  isSidechain: false,
  message: { id, role: "assistant", content: [{ type: "thinking", thinking: text, signature: NARRATION_SIG }], stop_reason: "tool_use" },
});

function sent() {
  return fake.texts().map(p => ({ text: p.text, silent: p.disable_notification, topic: p.message_thread_id }));
}

function makeCore(sessionId = SID) {
  core = new PluginCore({
    sessionId,
    cwd: CWD,
    configDir,
    windowKey: "pipe-1",
    port,
    spoolDir,
    stateDir: state,
    filesDir: join(state, "outbox-files"),
    fileWaitMs: 3000,
    spawnHub: () => void spawned++,
    emitChannel: (content, meta) => channel.push({ content, meta }),
    interrupt: async prompt => {
      const call = { prompt, channelBefore: channel.length, channelAfter: -1 };
      interrupts.push(call);
      await Bun.sleep(interruptMs);
      call.channelAfter = channel.length;
      if (interruptFails) throw new Error("inbox is gone");
    },
    answerPermission: (requestId, behavior) => answers.push({ requestId, behavior }),
    terminate: () => void terminated++,
    log: pluginLog,
    tailIntervalMs: 30,
    cardEveryMs: 30,
  });
  core.start();
  return core;
}

beforeEach(async () => {
  fake = new FakeTelegram();
  port = await freePort();
  state = tempDir();
  config = { groupId: GROUP, allowFrom: [ME] };
  hub = new Hub({
    port,
    sessionsFile: join(state, "sessions.json"),
    outboxFile: join(state, "outbox.json"),
    filesDir: join(state, "outbox-files"),
    inboxDir: join(state, "inbox"),
    api: new TelegramApi({ token: fake.token, base: fake.url, baseDelayMs: 1, maxAttempts: 2 }),
    config: () => config,
    idleMs: 60_000,
    pollTimeoutSec: 1,
    cardEditMs: 50,
    typingEveryMs: 50,
    reactionDelayMs: 50,
    // No module polls here: /stop ends the window once nobody takes it.
    commandPickupMs: 100,
    log: memLogger(),
    onExit() {},
  });
  hub.start();
  configDir = tempDir();
  const projDir = join(configDir, "projects", "C--code-demo-app");
  mkdirSync(projDir, { recursive: true });
  transcript = join(projDir, `${SID}.jsonl`);
  writeFileSync(transcript, line({ type: "ai-title", aiTitle: "Старое имя" }) + line(assistantText("old history", "end_turn")));
  channel = [];
  answers = [];
  interrupts = [];
  interruptMs = 0;
  interruptFails = false;
  terminated = 0;
  spoolDir = join(state, "spool");
  spawned = 0;
  pluginLog = memLogger();
});

afterEach(async () => {
  core?.stop();
  core = undefined;
  await hub.stop();
  fake.stop();
});

async function enabledCore() {
  const c = makeCore();
  await waitFor(() => hub.isConnected(SID), 3000, "plugin connected");
  await c.enable();
  return c;
}

describe("PluginCore", () => {
  test("enable creates a topic named from the session title, history is not sent", async () => {
    const c = makeCore();
    const answer = await c.enable();
    expect(answer).toContain("demo-app · Старое имя");
    expect(fake.callsOf("createForumTopic")).toEqual([{ chat_id: GROUP, name: "demo-app · Старое имя" }]);
    await Bun.sleep(150);
    expect(sent()).toEqual([]);
  });

  test("intermediate text is silent and the final text is silent without tg_notify", async () => {
    await enabledCore();
    append(assistantText("Смотрю код", "tool_use", "a1"), assistantTool("Read", "a1"), assistantText("Готово", "end_turn", "a2"));
    await waitFor(() => sent().length === 2, 3000, "two messages");
    expect(sent()).toEqual([
      { text: "Смотрю код", silent: true, topic: 100 },
      { text: "Готово", silent: true, topic: 100 },
    ]);
  });

  test("tg_notify makes the final text loud", async () => {
    const c = await enabledCore();
    append(assistantText("Сводка", "tool_use", "b1"), assistantTool("mcp__plugin_tg-hub_tg-hub__tg_notify", "b1"));
    await Bun.sleep(100);
    expect(c.notify("done")).toContain("notification");
    append(assistantText("Всё сделано", "end_turn", "b2"));
    await waitFor(() => sent().length === 2, 3000, "two messages");
    expect(sent()).toEqual([
      { text: "Сводка", silent: true, topic: 100 },
      { text: "Всё сделано", silent: false, topic: 100 },
    ]);
  });

  test("tg_notify with no text after it sends the marker loudly", async () => {
    const c = await enabledCore();
    c.notify("ask");
    append({ type: "assistant", isSidechain: false, message: { id: "c1", role: "assistant", content: [{ type: "thinking", thinking: "" }], stop_reason: "end_turn" } });
    await waitFor(() => sent().length === 1, 3000, "marker");
    expect(sent()[0]).toEqual({ text: NOTIFY_MARKER, silent: false, topic: 100 });
  });

  test("typing in the terminal turns the mode off", async () => {
    const c = await enabledCore();
    append(humanTyped("сам продолжу"));
    await waitFor(() => !c.enabled, 3000, "disabled");
    append(assistantText("ответ в терминал", "end_turn"));
    await Bun.sleep(200);
    expect(sent()).toEqual([]);
  });

  test("narration is relayed like text", async () => {
    await enabledCore();
    append(assistantNarration("Нашёл момент сбоя.\n\n", "n1"), assistantTool("Bash", "n1"));
    await waitFor(() => sent().length === 1, 3000, "narration");
    expect(sent()).toEqual([{ text: "Нашёл момент сбоя.", silent: true, topic: 100 }]);
  });

  test("thinking text of an unknown kind is reported in the log", async () => {
    await enabledCore();
    append({ type: "assistant", isSidechain: false, message: { id: "u1", role: "assistant", content: [{ type: "thinking", thinking: "hm", signature: "zz" }], stop_reason: "tool_use" } });
    await waitFor(() => pluginLog.lines.some(l => l.startsWith("WARN") && l.includes("thinking")), 3000, "warning");
  });

  // The text written before the message was typed was written in Telegram mode.
  test("a message typed mid-turn turns the mode off; text written before it still goes", async () => {
    const c = await enabledCore();
    append(assistantText("Проверяю", "tool_use", "q1"), typedMidTurn("Как успехи?"));
    await waitFor(() => !c.enabled, 3000, "disabled");
    append(assistantTool("Bash", "q1"), assistantText("ответ в терминал", "end_turn", "q2"));
    await waitFor(() => sent().length === 1, 3000, "pending text");
    await Bun.sleep(200);
    expect(sent()).toEqual([{ text: "Проверяю", silent: true, topic: 100 }]);
  });

  // Background tasks, Monitor events and subagent reports start turns too.
  test("prompts Claude Code itself sends leave the mode on", async () => {
    const c = await enabledCore();
    append(
      { type: "user", isSidechain: false, origin: { kind: "task-notification", producer: "session-task" }, message: { role: "user", content: "<task-notification>\n<status>completed</status>\n</task-notification>" } },
      { type: "attachment", isSidechain: false, attachment: { type: "queued_command", prompt: "<task-notification/>", commandMode: "task-notification", origin: { kind: "task-notification" } } },
      { type: "user", isSidechain: false, origin: { kind: "peer", handback: true }, isMeta: true, message: { role: "user", content: "Another Claude…" } },
      assistantText("продолжаю", "end_turn", "tn1"),
    );
    await waitFor(() => sent().length === 1, 3000, "turn text");
    expect(c.enabled).toBe(true);
    expect(c.hookNote("")).toBe("");
  });

  test("the final text of a turn ended right before terminal input is still sent", async () => {
    const c = await enabledCore();
    append(assistantText("итог", "end_turn", "d1"), humanTyped("next"));
    await waitFor(() => !c.enabled, 3000, "disabled");
    await waitFor(() => sent().length === 1, 3000, "final text");
    expect(sent()[0].text).toBe("итог");
  });

  test("a topic message reaches the session and turns the mode back on", async () => {
    const c = await enabledCore();
    await c.disable();
    await waitFor(() => !c.enabled);
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "как дела?" }));
    await waitFor(() => channel.length === 1, 3000, "channel message");
    expect(channel[0].content).toBe("как дела?");
    expect(channel[0].meta.chat_id).toBe(GROUP);
    await waitFor(() => c.enabled, 3000, "re-enabled");
  });

  test("a topic message wears ✍ from when the hub takes it until it is in the agent's context", async () => {
    await enabledCore();
    const u = topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "как дела?" });
    fake.pushUpdate(u);
    await waitFor(() => channel.length === 1, 3000, "channel message");
    const id = u.message?.message_id;
    await waitFor(() => fake.callsOf("setMessageReaction").length === 1, 3000, "reaction set");
    append({
      type: "user",
      isSidechain: false,
      isMeta: true,
      origin: { kind: "channel", server: "plugin:tg-hub:tg-hub" },
      message: { role: "user", content: `<channel source="plugin:tg-hub:tg-hub" chat_id="${GROUP}" message_id="${id}">\nкак дела?\n</channel>` },
    });
    await waitFor(() => fake.callsOf("setMessageReaction").length === 2, 3000, "reaction cleared");
    expect(fake.callsOf("setMessageReaction")).toEqual([
      { chat_id: GROUP, message_id: id, reaction: [{ type: "emoji", emoji: "✍" }] },
      { chat_id: GROUP, message_id: id, reaction: [] },
    ]);
  });

  test("a message starting with ! stops the working agent and comes in its place, before the next one", async () => {
    await enabledCore();
    append(assistantText("Смотрю", "tool_use", "i1"), assistantTool("Bash", "i1"));
    await waitFor(() => fake.callsOf("sendChatAction").length >= 1, 3000, "busy");
    interruptMs = 100;
    const u = topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "!стоп, не туда" });
    fake.pushUpdate(u);
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "смотри в src" }));
    await waitFor(() => channel.length === 1, 3000, "the next message");
    expect(interrupts.map(i => [i.channelBefore, i.channelAfter])).toEqual([[0, 0]]);
    expect(channel.map(m => m.content)).toEqual(["смотри в src"]);
    const prompt = interrupts[0].prompt;
    expect(prompt).toContain(`message_id="${u.message?.message_id}"`);
    expect(prompt).toContain("\n!стоп, не туда\n</channel>");
  });

  test("an interrupting message wears ✍ until it is in the agent's context", async () => {
    await enabledCore();
    append(assistantText("Смотрю", "tool_use", "i3"), assistantTool("Bash", "i3"));
    await waitFor(() => fake.callsOf("sendChatAction").length >= 1, 3000, "busy");
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "!стоп" }));
    await waitFor(() => fake.callsOf("setMessageReaction").length === 1, 3000, "reaction set");
    append({
      type: "user",
      isSidechain: false,
      isMeta: true,
      origin: { kind: "peer", from: "unknown", plugin: "tg-hub" },
      message: { role: "user", content: `Another Claude session sent a message:\n${interrupts[0].prompt}\n\nThis came from another Claude session.` },
    });
    await waitFor(() => fake.callsOf("setMessageReaction").length === 2, 3000, "reaction cleared");
    expect(arr(fake.callsOf("setMessageReaction")[1].reaction)).toEqual([]);
  });

  test("the interrupting message keeps its meta in the tag, quotes escaped", () => {
    expect(interruptPrompt("стоп", { chat_id: "-1001", user: 'a "b" <c>' })).toEndWith(
      '<channel source="tg-hub" chat_id="-1001" user="a &quot;b&quot; &lt;c>">\nстоп\n</channel>',
    );
  });

  test("a message starting with ! to an idle agent is just a message", async () => {
    await enabledCore();
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "!привет" }));
    await waitFor(() => channel.length === 1, 3000, "channel message");
    expect(interrupts).toEqual([]);
  });

  test("a message still arrives when the interrupt fails", async () => {
    await enabledCore();
    append(assistantText("Смотрю", "tool_use", "i2"), assistantTool("Bash", "i2"));
    await waitFor(() => fake.callsOf("sendChatAction").length >= 1, 3000, "busy");
    interruptFails = true;
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "!стоп" }));
    await waitFor(() => channel.length === 1, 3000, "channel message");
    expect(interrupts.length).toBe(1);
    expect(pluginLog.lines.some(l => l.includes("could not interrupt"))).toBe(true);
  });

  test("the topic shows typing while the agent works, not while it waits for an answer", async () => {
    await enabledCore();
    const typing = () => fake.callsOf("sendChatAction").length;
    append(assistantText("Смотрю", "tool_use", "w1"), assistantTool("Bash", "w1"));
    await waitFor(() => typing() >= 2, 3000, "typing");
    append(assistantTool("AskUserQuestion", "w2"));
    await Bun.sleep(150);
    const asked = typing();
    await Bun.sleep(200);
    expect(typing()).toBe(asked);
    append(assistantText("Понял", "tool_use", "w3"));
    await waitFor(() => typing() > asked, 3000, "typing again");
    append(assistantText("Готово", "end_turn", "w4"));
    await Bun.sleep(150);
    const ended = typing();
    await Bun.sleep(200);
    expect(typing()).toBe(ended);
  });

  test("a subagent shows as one card that is edited until it is done", async () => {
    await enabledCore();
    const dir = join(transcript.replace(/\.jsonl$/, ""), "subagents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent-a1.meta.json"), JSON.stringify({ agentType: "Explore", description: "Find it" }));
    const agent = join(dir, "agent-a1.jsonl");
    appendFileSync(agent, line({ ...assistantText("Looking", "tool_use", "s1"), isSidechain: true }));
    await waitFor(() => sent().length === 1, 3000, "card");
    expect(sent()[0]).toEqual({ text: "🤖 Explore · Find it\n⏳ 0 с · 0 действий\n\nLooking", silent: true, topic: 100 });
    appendFileSync(agent, line({ ...assistantText("Found", "end_turn", "s2"), isSidechain: true }));
    await waitFor(() => fake.callsOf("editMessageText").some(c => String(c.text).includes("✅ готово")), 3000, "final edit");
    expect(String(fake.callsOf("editMessageText").at(-1)?.text)).toEndWith("Looking\n\nFound");
    expect(sent().length).toBe(1);
  });

  test("a subagent is first shown only while the mode is on", async () => {
    makeCore();
    await waitFor(() => hub.isConnected(SID), 3000, "plugin connected");
    const dir = join(transcript.replace(/\.jsonl$/, ""), "subagents");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "agent-a1.jsonl"), line({ ...assistantText("Looking", "end_turn", "s1"), isSidechain: true }));
    await Bun.sleep(200);
    expect(sent()).toEqual([]);
  });

  test("/stop in the topic ends Claude Code", async () => {
    await enabledCore();
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "/stop" }));
    await waitFor(() => terminated === 1, 3000, "terminate");
  });

  test("a permission request is sent loudly while enabled", async () => {
    const c = await enabledCore();
    c.permissionRequest({ request_id: "abcde", tool_name: "Bash", description: "git push" });
    await waitFor(() => sent().length === 1);
    expect(sent()[0]).toEqual({ text: "🔐 Нужно подтверждение: Bash — git push", silent: false, topic: 100 });
  });

  test("a permission request answered in the topic reaches Claude Code", async () => {
    const c = await enabledCore();
    c.permissionRequest({ request_id: "abcde", tool_name: "Bash", description: "Push the branch", input_preview: '{"command":"git push"}' });
    await waitFor(() => sent().length === 1);
    const msg = fake.callsOf("sendMessage")[0];
    const head = "🔐 Нужно подтверждение: Bash — Push the branch";
    expect(msg).toMatchObject({
      text: `${head}\n\n{"command":"git push"}`,
      entities: [{ type: "pre", offset: head.length + 2, length: 22 }],
      disable_notification: false,
    });
    const rows = arr(field(field(msg, "reply_markup"), "inline_keyboard"));
    const allow = arr(rows[0]).find(b => field(b, "text") === "✅ Разрешить");
    fake.pushUpdate(buttonPress({ chatId: GROUP, fromId: ME, messageId: fake.lastMessageId, data: String(field(allow, "callback_data")) }));
    await waitFor(() => answers.length === 1, 3000, "answer");
    expect(answers).toEqual([{ requestId: "abcde", behavior: "allow" }]);
    await waitFor(() => fake.callsOf("editMessageText").length === 1, 3000, "edit");
    expect(fake.callsOf("editMessageText")[0]).toMatchObject({ message_id: fake.lastMessageId, text: `${head}\n\n{"command":"git push"}\n\n✅ Разрешено` });
    expect(fake.callsOf("editMessageText")[0].reply_markup).toBeUndefined();
    expect(fake.callsOf("answerCallbackQuery")).toEqual([expect.objectContaining({ text: "✅ Разрешено" })]);
  });

  test("a rename renames the topic", async () => {
    await enabledCore();
    append({ type: "agent-name", agentName: "Новое имя" });
    await waitFor(() => fake.callsOf("editForumTopic").length === 1, 3000, "rename");
    expect(fake.callsOf("editForumTopic")[0].name).toBe("demo-app · Новое имя");
  });

  test("switching session follows the new transcript", async () => {
    const c = await enabledCore();
    const next = join(configDir, "projects", "C--code-demo-app", "sess-2.jsonl");
    c.switchSession("sess-2", next, CWD);
    await waitFor(() => hub.isConnected("sess-2"), 3000, "switched");
    writeFileSync(next, line({ type: "ai-title", aiTitle: "После clear" }));
    await c.enable();
    expect(fake.callsOf("createForumTopic").at(-1)?.name).toBe("demo-app · После clear");
    appendFileSync(next, line(assistantText("в новой сессии", "end_turn")));
    append(assistantText("в старой сессии", "end_turn"));
    await waitFor(() => sent().length === 1, 3000, "message");
    await Bun.sleep(150);
    expect(sent()).toEqual([{ text: "в новой сессии", silent: true, topic: 101 }]);
  });

  test("shutdown sends text written just before the window closed", async () => {
    const c = await enabledCore();
    append(assistantText("последнее слово", "end_turn", "z1"));
    await c.shutdown(2000);
    core = undefined;
    await waitFor(() => sent().length === 1, 3000, "last words");
    expect(sent()).toEqual([{ text: "последнее слово", silent: true, topic: 100 }]);
    expect(spawned).toBe(0);
  });

  test("a window closing while the hub is down leaves its text in spool/ and starts a hub", async () => {
    const c = await enabledCore();
    await hub.stop();
    await waitFor(() => pluginLog.lines.some(l => l.includes("hub connection lost")), 3000, "connection lost");
    append(assistantText("без хаба", "end_turn", "y1"));
    await c.shutdown(300);
    core = undefined;
    const files = readdirSync(spoolDir).filter(f => f.endsWith(".json"));
    expect(files.length).toBe(1);
    const items: unknown = JSON.parse(readFileSync(join(spoolDir, files[0]), "utf8"));
    expect(items).toMatchObject([{ sessionId: SID, text: "без хаба", notify: false }]);
    expect(spawned).toBeGreaterThan(0);
  });

  test("a SessionStart hook for the same session keeps relaying", async () => {
    const c = await enabledCore();
    // same file, path spelled differently (drive letter case)
    c.switchSession(SID, transcript.replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase() + ":"), CWD);
    expect(c.enabled).toBe(true);
    append(assistantText("после компакта", "end_turn"));
    await waitFor(() => sent().length === 1, 3000, "message");
  });

  test("tg_notify while the mode is off says so", () => {
    const c = makeCore();
    expect(c.notify("done")).toContain("off");
  });

  test("enable without groupId returns the explanation", async () => {
    config = { allowFrom: [ME] };
    const c = makeCore();
    await expect(c.enable()).rejects.toThrow(/config\.json/);
  });
});

// The PostToolBatch hook asks hookNote after every batch of tool calls.
describe("note to the agent that the mode went off", () => {
  const hookOutput = z.object({ hookSpecificOutput: z.object({ hookEventName: z.string(), additionalContext: z.string() }) });
  const noteOf = (out: string) => hookOutput.parse(JSON.parse(out)).hookSpecificOutput;
  const toolBatch = (id: string) => [assistantTool("Bash", id), { type: "user", isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } }];

  test("the first tool batch after terminal input tells the agent, once", async () => {
    const c = await enabledCore();
    // No wait for the tailer: the hook may come before its next poll.
    append(humanTyped("Как успехи?"), ...toolBatch("k1"));
    const note = noteOf(c.hookNote(""));
    expect(note.hookEventName).toBe("PostToolBatch");
    expect(note.additionalContext).toContain("OFF");
    expect(note.additionalContext).toContain("tg_notify");
    expect(c.enabled).toBe(false);
    expect(c.hookNote("")).toBe("");
  });

  test("a message typed mid-turn is noted too", async () => {
    const c = await enabledCore();
    append(typedMidTurn("стоп"), ...toolBatch("k2"));
    expect(noteOf(c.hookNote("")).additionalContext).toContain("OFF");
  });

  test("a subagent batch leaves the note for the main agent", async () => {
    const c = await enabledCore();
    append(humanTyped("сам"));
    expect(c.hookNote("a3f559a955ec4c710")).toBe("");
    expect(c.hookNote("")).not.toBe("");
  });

  test("nothing to say when the agent turned the mode off itself", async () => {
    const c = await enabledCore();
    await c.disable();
    await waitFor(() => !c.enabled);
    append(humanTyped("ок"));
    expect(c.hookNote("")).toBe("");
  });

  test("turning the mode back on drops an undelivered note", async () => {
    const c = await enabledCore();
    append(humanTyped("сам"));
    await waitFor(() => !c.enabled, 3000, "disabled");
    await c.enable();
    await waitFor(() => c.enabled);
    expect(c.hookNote("")).toBe("");
  });
});

describe("a response cut by a lost connection", () => {
  const ERROR = "API Error: Connection lost mid-response. The response above may be incomplete.";
  const cut = () => ({ ...assistantText(ERROR, "stop_sequence"), error: "server_error", truncatedAfterOutput: true, isApiErrorMessage: true });

  test("the agent is told to continue, and the topic is told it does", async () => {
    await enabledCore();
    append(assistantText("Правлю тест", "tool_use", "r1"), assistantTool("Edit", "r1"), cut());
    await waitFor(() => channel.length === 1, 3000, "continue prompt");
    expect(channel[0]).toEqual({ content: CONTINUE_PROMPT, meta: { user: "tg-hub", reason: "response_cut" } });
    await waitFor(() => sent().length === 3, 3000, "three messages");
    expect(sent()).toEqual([
      { text: "Правлю тест", silent: true, topic: 100 },
      { text: ERROR, silent: true, topic: 100 },
      { text: CUT_NOTE, silent: true, topic: 100 },
    ]);
  });

  test("with the mode off the person at the terminal decides", async () => {
    const c = makeCore();
    await waitFor(() => hub.isConnected(SID), 3000, "plugin connected");
    append(cut());
    await Bun.sleep(300);
    expect(c.enabled).toBe(false);
    expect(channel).toEqual([]);
  });

  test(`after ${MAX_AUTO_CONTINUES} cuts in a row it stops and calls the person; a normal turn end starts the count over`, async () => {
    await enabledCore();
    for (let i = 0; i < MAX_AUTO_CONTINUES; i++) append(cut());
    await waitFor(() => channel.length === MAX_AUTO_CONTINUES, 3000, "continue prompts");
    append(cut());
    await waitFor(() => sent().some(s => s.text === CUT_LIMIT_NOTE), 3000, "limit note");
    expect(sent().find(s => s.text === CUT_LIMIT_NOTE)?.silent).toBe(false);
    expect(channel.length).toBe(MAX_AUTO_CONTINUES);
    append(assistantText("дальше сам", "end_turn"), cut());
    await waitFor(() => channel.length === MAX_AUTO_CONTINUES + 1, 3000, "continue after a normal turn");
  });

  test("a cut written before the window started is history", async () => {
    appendFileSync(transcript, line(cut()));
    await enabledCore();
    append(assistantText("новый ход", "end_turn"));
    await waitFor(() => sent().length === 1, 3000, "new turn");
    expect(channel).toEqual([]);
  });
});

describe("tg_send_file", () => {
  const file = (name: string, body = `body of ${name}`, d = tempDir()) => {
    const path = join(d, name);
    writeFileSync(path, body);
    return path;
  };
  const sends = () => fake.calls.filter(c => c.method.startsWith("send") && c.method !== "sendChatAction").map(c => c.method);
  const leftCopies = () => (existsSync(join(state, "outbox-files")) ? readdirSync(join(state, "outbox-files")) : []);

  test("a file reaches the topic, the original stays, the queued copy goes", async () => {
    const c = await enabledCore();
    const path = file("shot.png");
    expect(await c.sendFiles([path], "see **this**")).toBe("Sent 1 file(s) to the Telegram topic.");
    expect(fake.callsOf("sendPhoto")[0]).toMatchObject({ photo: { file: "shot.png", body: "body of shot.png" }, caption: "see this" });
    expect(readFileSync(path, "utf8")).toBe("body of shot.png");
    expect(leftCopies()).toEqual([]);
  });

  test("text written before the call reaches the topic first", async () => {
    const c = await enabledCore();
    // The tool_use record is not in the file yet: only the text before it.
    append(assistantText("вот скрин", "tool_use", "s1"));
    await c.sendFiles([file("a.png")]);
    expect(sends()).toEqual(["sendMessage", "sendPhoto"]);
    expect(sent()).toEqual([{ text: "вот скрин", silent: true, topic: 100 }]);
  });

  test("silent while the mode is on, with sound while it is off", async () => {
    const c = await enabledCore();
    await c.sendFiles([file("a.txt")]);
    await c.disable();
    await waitFor(() => !c.enabled);
    await c.sendFiles([file("b.txt")]);
    expect(fake.callsOf("sendDocument").map(p => p.disable_notification)).toEqual(["true", "false"]);
  });

  test("several files go as an album", async () => {
    const c = await enabledCore();
    const d = tempDir();
    expect(await c.sendFiles([file("1.png", "x", d), file("2.jpg", "y", d)])).toBe("Sent 2 file(s) to the Telegram topic.");
    expect(arr(fake.callsOf("sendMediaGroup")[0].media).map(m => field(m, "type"))).toEqual(["photo", "photo"]);
  });

  test("as_document sends images as documents, grouped into an album", async () => {
    const c = await enabledCore();
    const d = tempDir();
    expect(await c.sendFiles([file("a.png", "x", d)], "", true)).toBe("Sent 1 file(s) to the Telegram topic.");
    expect(fake.callsOf("sendPhoto")).toEqual([]);
    expect(fake.callsOf("sendDocument")[0]).toMatchObject({ document: { file: "a.png", body: "x" } });
    await c.sendFiles([file("1.png", "x", d), file("2.jpg", "y", d)], "", true);
    expect(arr(fake.callsOf("sendMediaGroup")[0].media).map(m => field(m, "type"))).toEqual(["document", "document"]);
  });

  test("nothing is sent if any file is wrong, and the reason names it", async () => {
    const c = await enabledCore();
    const ok = file("ok.txt");
    const big = file("big.bin", "");
    truncateSync(big, 50 * 1024 * 1024 + 1);
    const cases: [string[], string][] = [
      [[], "at least one"],
      [[ok, join(tempDir(), "missing.png")], "missing.png: no such file"],
      [[tempDir()], "not a file"],
      [[file("empty.txt", "")], "empty"],
      [[big], "50 MB"],
      [[file("sessions.json", "{}", state)], "tg-hub state"],
    ];
    for (const [paths, why] of cases) await expect(c.sendFiles(paths)).rejects.toThrow(why);
    await expect(c.sendFiles([ok], "я".repeat(1025))).rejects.toThrow("1024");
    // Formatting does not count: the caption is measured as Telegram shows it.
    expect(await c.sendFiles([ok], `**${"я".repeat(1024)}**`)).toContain("Sent 1");
    expect(sends()).toEqual(["sendDocument"]);
    expect(leftCopies()).toEqual([]);
  });

  test("a file Telegram sent into the inbox may be sent back", async () => {
    const c = await enabledCore();
    mkdirSync(join(state, "inbox"), { recursive: true });
    expect(await c.sendFiles([file("photo.jpg", "x", join(state, "inbox"))])).toContain("Sent 1");
  });

  test("a session without a topic gets the error from the hub", async () => {
    const c = makeCore();
    await waitFor(() => hub.isConnected(SID), 3000, "plugin connected");
    await expect(c.sendFiles([file("a.txt")])).rejects.toThrow("tg_enable");
  });

  test("a rejection by Telegram comes back as the error", async () => {
    const c = await enabledCore();
    fake.failNext("sendDocument", { code: 400, description: "Bad Request: file is too big" });
    const why = await c.sendFiles([file("a.txt")]).then(() => "resolved", (e: Error) => e.message);
    expect(why).toBe("a.txt: Bad Request: file is too big");
  });

  test("when Telegram does not answer in time the files stay queued and the agent is told so", async () => {
    const c = await enabledCore();
    fake.hangNext("sendDocument", 1000);
    expect(await c.sendFiles([file("a.txt")])).toContain("queued");
  });
});
