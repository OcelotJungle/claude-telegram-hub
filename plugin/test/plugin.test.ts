import type { ChimeKind } from "../src/shared/chime.ts";
import type { Config } from "../src/shared/config.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, truncateSync, writeFileSync } from "fs";
import { join } from "path";
import { Hub } from "../src/hub/hub.ts";
import { SessionStore } from "../src/hub/sessions.ts";
import { TelegramApi } from "../src/hub/telegram.ts";
import { CHIME_MIN_TURN_MS, CONTINUE_PROMPT, cutLimitNote, filesRejectedPrompt, interruptPrompt, MAX_AUTO_CONTINUES, playConfiguredChime, PluginCore } from "../src/plugin/plugin.ts";
import { defaultTurnEndChime } from "../src/shared/chime.ts";
import { catalogOf } from "../src/shared/i18n/index.ts";
import { ru } from "../src/shared/i18n/ru.ts";
import { platformFor } from "../src/shared/platform.ts";
import { arr, field } from "../src/shared/guards.ts";
import { TURN_DECISION_MS } from "../src/transcript/relay.ts";
import { buttonPress, FakeTelegram, topicMsg } from "./fake-telegram.ts";
import { memLogger, NO_PACE, tempDir, waitFor } from "./helpers.ts";

const en = catalogOf("en");
const CUT_LIMIT_NOTE = cutLimitNote(en);
const GROUP = "-1001";
const ME = "123456789";
const CWD = "C:\\code\\demo-app";
const SID = "sess-1";
// The hub's quiet window for topic messages that come together, kept short.
const BATCH_QUIET_MS = 5;

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
// The pid the fake terminate reports as the Claude Code process it ends.
let claudePid: number | undefined;
let hubLog: ReturnType<typeof memLogger>;
let spoolDir: string;
let state: string;
let spawned: number;
let pluginLog: ReturnType<typeof memLogger>;
// The chimes the plugin asked for, and how far the plugin's clock is moved ahead.
let chimes: ChimeKind[];
let clockSkew: number;

// What the Stop hook does: tells the hub how the turn ended.
async function stopHook(final: boolean, kind?: ChimeKind) {
  const res = await fetch(`http://127.0.0.1:${port}/turn-end`, {
    method: "POST",
    body: JSON.stringify({ messagingSocket: "pipe-1", session_id: SID, final, ...(kind ? { kind } : {}) }),
  });
  expect(res.status).toBe(200);
}

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
// Claude Code closing the turn after all Stop hooks.
const closed = { type: "system", subtype: "turn_duration", durationMs: 1000 };
const typedMidTurn =(text: string) => ({ type: "attachment", isSidechain: false, attachment: { type: "queued_command", prompt: text, commandMode: "prompt", origin: { kind: "human" } } });
const NARRATION_SIG = "CAQSrgcKEQgSGAI4AUIJbmFycmF0aW9uEgxhMFJuZKXpKQCYxWIaDLo3cuvEnZjRl04uqSIwcikVdFlQ26x5rHo0oYhd4CFFTF+Qg/KbIJ4gkTpHfgPAWqq3";
const assistantNarration = (text: string, id: string) => ({
  type: "assistant",
  isSidechain: false,
  message: { id, role: "assistant", content: [{ type: "thinking", thinking: text, signature: NARRATION_SIG }], stop_reason: "tool_use" },
});

// The hub sends a topic message to the plugin over the same socket as the
// Stop hook's verdict, after it: once the message arrives, the verdict has
// been handled.
async function verdictHandled() {
  const before = channel.length;
  fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "\u0434\u0430\u043b\u044c\u0448\u0435" }));
  await waitFor(() => channel.length > before, 3000, "a topic message after the verdict");
}

function sent() {
  return fake.texts().map(p => ({ text: p.text, silent: p.disable_notification, topic: p.message_thread_id }));
}

function makeCore(sessionId = SID, entrypoint?: string) {
  core = new PluginCore({
    sessionId,
    cwd: CWD,
    configDir,
    ...(entrypoint ? { entrypoint } : {}),
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
    terminate: exiting => {
      terminated++;
      if (claudePid !== undefined) exiting(claudePid);
    },
    log: pluginLog,
    chime: kind => chimes.push(kind),
    now: () => Date.now() + clockSkew,
    tailIntervalMs: 30,
    cardEveryMs: 30,
  });
  core.start();
  return core;
}

beforeEach(async () => {
  fake = new FakeTelegram();
  state = tempDir();
  config = { groupId: GROUP, allowFrom: [ME], turnEndChime: "" };
  hub = new Hub({
    port: 0,
    sessionsFile: join(state, "sessions.json"),
    outboxFile: join(state, "outbox.json"),
    filesDir: join(state, "outbox-files"),
    inboxDir: join(state, "inbox"),
    api: new TelegramApi({ token: fake.token, base: fake.url, baseDelayMs: 1, maxAttempts: 2, groupPace: NO_PACE }),
    config: () => config,
    idleMs: 60_000,
    pollTimeoutSec: 1,
    cardEditMs: 50,
    cardGapMs: 0,
    typingEveryMs: 50,
    reactionDelayMs: 50,
    batchQuietMs: BATCH_QUIET_MS,
    // No module polls here: /stop ends the window once nobody takes it.
    commandPickupMs: 100,
    log: (hubLog = memLogger()),
    onExit() {},
  });
  hub.start();
  port = hub.port;
  configDir = tempDir();
  const projDir = join(configDir, "projects", "C--code-demo-app");
  mkdirSync(projDir, { recursive: true });
  transcript = join(projDir, `${SID}.jsonl`);
  writeFileSync(transcript, line({ type: "ai-title", aiTitle: "\u0421\u0442\u0430\u0440\u043e\u0435 \u0438\u043c\u044f" }) + line(assistantText("old history", "end_turn")));
  channel = [];
  answers = [];
  interrupts = [];
  interruptMs = 0;
  interruptFails = false;
  terminated = 0;
  claudePid = undefined;
  spoolDir = join(state, "spool");
  spawned = 0;
  pluginLog = memLogger();
  chimes = [];
  clockSkew = 0;
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
  test("an interactive session is on from the start and gets its topic at its first text", async () => {
    const c = makeCore(SID, "cli");
    await waitFor(() => hub.isConnected(SID), 3000, "plugin connected");
    await waitFor(() => c.enabled, 3000, "mode on");
    await Bun.sleep(100);
    expect(fake.callsOf("createForumTopic")).toEqual([]);
    append(assistantText("\u0413\u043e\u0442\u043e\u0432\u043e", "end_turn", "a1"), closed);
    await stopHook(true, "done");
    await waitFor(() => sent().length === 1, 5000, "the text");
    expect(fake.callsOf("createForumTopic")).toEqual([{ chat_id: GROUP, name: "demo-app · \u0421\u0442\u0430\u0440\u043e\u0435 \u0438\u043c\u044f" }]);
    expect(sent()).toEqual([{ text: "\u0413\u043e\u0442\u043e\u0432\u043e", silent: false, topic: 100 }]);
  });

  test("a session started by an SDK entrypoint stays off and gets no topic", async () => {
    const c = makeCore(SID, "sdk-cli");
    await waitFor(() => hub.isConnected(SID), 3000, "plugin connected");
    await Bun.sleep(150);
    expect(c.enabled).toBe(false);
    expect(fake.callsOf("createForumTopic")).toEqual([]);
  });

  test("enable creates a topic named from the session title, history is not sent", async () => {
    const c = makeCore();
    const answer = await c.enable();
    expect(answer).toContain("demo-app · \u0421\u0442\u0430\u0440\u043e\u0435 \u0438\u043c\u044f");
    expect(fake.callsOf("createForumTopic")).toEqual([{ chat_id: GROUP, name: "demo-app · \u0421\u0442\u0430\u0440\u043e\u0435 \u0438\u043c\u044f" }]);
    await Bun.sleep(150);
    expect(sent()).toEqual([]);
  });

  test("a final turn: the text before a tool is silent, the last text is loud", async () => {
    await enabledCore();
    append(assistantText("\u0421\u043c\u043e\u0442\u0440\u044e \u043a\u043e\u0434", "tool_use", "a1"), assistantTool("Read", "a1"), assistantText("\u0413\u043e\u0442\u043e\u0432\u043e", "end_turn", "a2"), closed);
    await stopHook(true, "done");
    await waitFor(() => sent().length === 2, 5000, "two messages");
    expect(sent()).toEqual([
      { text: "\u0421\u043c\u043e\u0442\u0440\u044e \u043a\u043e\u0434", silent: true, topic: 100 },
      { text: "\u0413\u043e\u0442\u043e\u0432\u043e", silent: false, topic: 100 },
    ]);
  });

  test("an ask turn is loud too", async () => {
    await enabledCore();
    append(assistantText("\u041a\u0430\u043a\u043e\u0439 \u0432\u0430\u0440\u0438\u0430\u043d\u0442?", "end_turn", "q1"), closed);
    await stopHook(true, "ask");
    await waitFor(() => sent().length === 1, 5000, "question");
    expect(sent()).toEqual([{ text: "\u041a\u0430\u043a\u043e\u0439 \u0432\u0430\u0440\u0438\u0430\u043d\u0442?", silent: false, topic: 100 }]);
  });

  test("an intermediate turn end sends its text silently", async () => {
    await enabledCore();
    append(assistantText("\u0416\u0434\u0443 \u043c\u043e\u043d\u0438\u0442\u043e\u0440", "end_turn", "p1"), closed);
    await stopHook(false);
    await waitFor(() => sent().length === 1, 5000, "text");
    expect(sent()).toEqual([{ text: "\u0416\u0434\u0443 \u043c\u043e\u043d\u0438\u0442\u043e\u0440", silent: true, topic: 100 }]);
  });

  test("without a decision a closed turn is closed as final after the limit", async () => {
    await enabledCore();
    append(assistantText("\u0418\u0442\u043e\u0433", "end_turn", "n1"), closed);
    // Each check moves the clock past the limit: the tailer reads both records
    // in one poll, and its next idle check closes the turn.
    await waitFor(
      () => {
        clockSkew += TURN_DECISION_MS;
        return sent().length === 1;
      },
      3000,
      "text",
    );
    expect(sent()).toEqual([{ text: "\u0418\u0442\u043e\u0433", silent: false, topic: 100 }]);
  });

  test("a final turn without text sends nothing", async () => {
    await enabledCore();
    append({ type: "assistant", isSidechain: false, message: { id: "c1", role: "assistant", content: [{ type: "thinking", thinking: "" }], stop_reason: "end_turn" } }, closed);
    await stopHook(true, "done");
    await verdictHandled();
    expect(sent()).toEqual([]);
  });

  describe("the terminal chime", () => {
    // The mode is off (it was never on here), the user types in the terminal,
    // and the turn that follows ends and is closed.
    async function terminalTurn() {
      makeCore();
      await waitFor(() => hub.isConnected(SID), 3000, "plugin connected");
      append(humanTyped("\u0441\u0430\u043c \u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0443"));
      // The tailer reads the transcript every 30 ms: the typing is read before the turn closes.
      await Bun.sleep(200);
      append(assistantText("\u0421\u0434\u0435\u043b\u0430\u043b", "end_turn", "e1"), closed);
    }

    test("ask always chimes", async () => {
      await terminalTurn();
      await stopHook(true, "ask");
      await waitFor(() => chimes.length === 1, 3000, "chime");
      expect(chimes).toEqual(["ask"]);
    });

    test("done soon after the user typed is silent", async () => {
      await terminalTurn();
      await stopHook(true, "done");
      await Bun.sleep(200);
      expect(chimes).toEqual([]);
    });

    test(`done ${CHIME_MIN_TURN_MS / 1000} s after the user typed chimes`, async () => {
      await terminalTurn();
      clockSkew = CHIME_MIN_TURN_MS;
      await stopHook(true, "done");
      await waitFor(() => chimes.length === 1, 3000, "chime");
      expect(chimes).toEqual(["done"]);
    });

    test("done chimes when the user has not typed in this window", async () => {
      makeCore();
      await waitFor(() => hub.isConnected(SID), 3000, "plugin connected");
      append(assistantText("\u0421\u0434\u0435\u043b\u0430\u043b", "end_turn", "e1"), closed);
      await stopHook(true, "done");
      await waitFor(() => chimes.length === 1, 3000, "chime");
      expect(chimes).toEqual(["done"]);
    });

    test("an intermediate turn end never chimes", async () => {
      await terminalTurn();
      clockSkew = CHIME_MIN_TURN_MS;
      await stopHook(false);
      await Bun.sleep(200);
      expect(chimes).toEqual([]);
    });

    test("with the mode on the terminal stays silent", async () => {
      await enabledCore();
      clockSkew = CHIME_MIN_TURN_MS;
      append(assistantText("\u041a\u0430\u043a\u043e\u0439 \u0432\u0430\u0440\u0438\u0430\u043d\u0442?", "end_turn", "q1"), closed);
      await stopHook(true, "ask");
      await waitFor(() => sent().length === 1, 3000, "loud question");
      expect(sent()[0].silent).toBe(false);
      expect(chimes).toEqual([]);
    });
  });

  // Typing in the terminal never changes the mode: the text written after it still goes.
  test("typing in the terminal leaves the mode on", async () => {
    const c = await enabledCore();
    append(humanTyped("\u0441\u0430\u043c \u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0443"));
    append(assistantText("\u043e\u0442\u0432\u0435\u0442 \u0432 \u0442\u0435\u043b\u0435\u0433\u0443", "tool_use", "t1"), assistantTool("Bash", "t1"));
    await waitFor(() => sent().length === 1, 3000, "relayed text");
    expect(c.enabled).toBe(true);
    expect(sent()).toEqual([{ text: "\u043e\u0442\u0432\u0435\u0442 \u0432 \u0442\u0435\u043b\u0435\u0433\u0443", silent: true, topic: 100 }]);
  });

  test("narration is relayed like text", async () => {
    await enabledCore();
    append(assistantNarration("\u041d\u0430\u0448\u0451\u043b \u043c\u043e\u043c\u0435\u043d\u0442 \u0441\u0431\u043e\u044f.\n\n", "n1"), assistantTool("Bash", "n1"));
    await waitFor(() => sent().length === 1, 3000, "narration");
    expect(sent()).toEqual([{ text: "\u041d\u0430\u0448\u0451\u043b \u043c\u043e\u043c\u0435\u043d\u0442 \u0441\u0431\u043e\u044f.", silent: true, topic: 100 }]);
  });

  test("thinking text of an unknown kind is reported in the log", async () => {
    await enabledCore();
    append({ type: "assistant", isSidechain: false, message: { id: "u1", role: "assistant", content: [{ type: "thinking", thinking: "hm", signature: "zz" }], stop_reason: "tool_use" } });
    await waitFor(() => pluginLog.lines.some(l => l.startsWith("WARN") && l.includes("thinking")), 3000, "warning");
  });

  // A message typed mid-turn does not change the mode either.
  test("a message typed mid-turn leaves the mode on", async () => {
    const c = await enabledCore();
    append(assistantText("\u041f\u0440\u043e\u0432\u0435\u0440\u044f\u044e", "tool_use", "q1"), typedMidTurn("\u041a\u0430\u043a \u0443\u0441\u043f\u0435\u0445\u0438?"), assistantTool("Bash", "q1"));
    append(assistantText("\u0412\u043e\u0442 \u043e\u0442\u0432\u0435\u0442", "tool_use", "q2"), assistantTool("Bash", "q2"));
    await waitFor(() => sent().length === 2, 3000, "both texts");
    expect(c.enabled).toBe(true);
    expect(sent()).toEqual([
      { text: "\u041f\u0440\u043e\u0432\u0435\u0440\u044f\u044e", silent: true, topic: 100 },
      { text: "\u0412\u043e\u0442 \u043e\u0442\u0432\u0435\u0442", silent: true, topic: 100 },
    ]);
  });

  // Background tasks, Monitor events and subagent reports start turns too.
  test("prompts Claude Code itself sends leave the mode on", async () => {
    const c = await enabledCore();
    append(
      { type: "user", isSidechain: false, origin: { kind: "task-notification", producer: "session-task" }, message: { role: "user", content: "<task-notification>\n<status>completed</status>\n</task-notification>" } },
      { type: "attachment", isSidechain: false, attachment: { type: "queued_command", prompt: "<task-notification/>", commandMode: "task-notification", origin: { kind: "task-notification" } } },
      { type: "user", isSidechain: false, origin: { kind: "peer", handback: true }, isMeta: true, message: { role: "user", content: "Another Claude…" } },
      assistantText("\u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0430\u044e", "end_turn", "tn1"),
      closed,
    );
    await stopHook(false);
    await waitFor(() => sent().length === 1, 3000, "turn text");
    expect(c.enabled).toBe(true);
  });

  test("the final text of a turn ended right before terminal input is still sent", async () => {
    const c = await enabledCore();
    append(assistantText("\u0438\u0442\u043e\u0433", "end_turn", "d1"), humanTyped("next"));
    await waitFor(() => sent().length === 1, 3000, "final text");
    expect(sent()[0].text).toBe("\u0438\u0442\u043e\u0433");
    expect(c.enabled).toBe(true);
  });

  test("a topic message reaches the session and turns the mode back on", async () => {
    const c = await enabledCore();
    await c.disable();
    await waitFor(() => !c.enabled);
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "\u043a\u0430\u043a \u0434\u0435\u043b\u0430?" }));
    await waitFor(() => channel.length === 1, 3000, "channel message");
    expect(channel[0].content).toBe("\u043a\u0430\u043a \u0434\u0435\u043b\u0430?");
    expect(channel[0].meta.chat_id).toBe(GROUP);
    await waitFor(() => c.enabled, 3000, "re-enabled");
  });

  test("a topic message wears ✍ from when the hub takes it until it is in the agent's context", async () => {
    await enabledCore();
    const u = topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "\u043a\u0430\u043a \u0434\u0435\u043b\u0430?" });
    fake.pushUpdate(u);
    await waitFor(() => channel.length === 1, 3000, "channel message");
    const id = u.message?.message_id;
    await waitFor(() => fake.callsOf("setMessageReaction").length === 1, 3000, "reaction set");
    append({
      type: "user",
      isSidechain: false,
      isMeta: true,
      origin: { kind: "channel", server: "plugin:telegram-hub:telegram-hub" },
      message: { role: "user", content: `<channel source="plugin:telegram-hub:telegram-hub" chat_id="${GROUP}" message_id="${id}">\n\u043a\u0430\u043a \u0434\u0435\u043b\u0430?\n</channel>` },
    });
    await waitFor(() => fake.callsOf("setMessageReaction").length === 2, 3000, "reaction cleared");
    expect(fake.callsOf("setMessageReaction")).toEqual([
      { chat_id: GROUP, message_id: id, reaction: [{ type: "emoji", emoji: "✍" }] },
      { chat_id: GROUP, message_id: id, reaction: [] },
    ]);
  });

  test("a \"!\" message stops the working agent and comes in its place without the \"!\", before the next one", async () => {
    await enabledCore();
    append(assistantText("\u0421\u043c\u043e\u0442\u0440\u044e", "tool_use", "i1"), assistantTool("Bash", "i1"));
    await waitFor(() => fake.callsOf("sendChatAction").length >= 1, 3000, "busy");
    interruptMs = 100;
    const u = topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "!\u0441\u0442\u043e\u043f, \u043d\u0435 \u0442\u0443\u0434\u0430" });
    fake.pushUpdate(u);
    // Sent together, the next message would join the "!" one.
    await waitFor(() => interrupts.length === 1, 3000, "interrupt");
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "\u0441\u043c\u043e\u0442\u0440\u0438 \u0432 src" }));
    await waitFor(() => channel.length === 1, 3000, "the next message");
    expect(interrupts.map(i => [i.channelBefore, i.channelAfter])).toEqual([[0, 0]]);
    expect(channel.map(m => m.content)).toEqual(["\u0441\u043c\u043e\u0442\u0440\u0438 \u0432 src"]);
    const prompt = interrupts[0].prompt;
    expect(prompt).toContain(`message_id="${u.message?.message_id}"`);
    expect(prompt).toContain(">\n\u0441\u0442\u043e\u043f, \u043d\u0435 \u0442\u0443\u0434\u0430\n</channel>");
  });

  test("an interrupting message wears ✍ until it is in the agent's context", async () => {
    await enabledCore();
    append(assistantText("\u0421\u043c\u043e\u0442\u0440\u044e", "tool_use", "i3"), assistantTool("Bash", "i3"));
    await waitFor(() => fake.callsOf("sendChatAction").length >= 1, 3000, "busy");
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "!\u0441\u0442\u043e\u043f" }));
    await waitFor(() => fake.callsOf("setMessageReaction").length === 1, 3000, "reaction set");
    append({
      type: "user",
      isSidechain: false,
      isMeta: true,
      origin: { kind: "peer", from: "unknown", plugin: "telegram-hub" },
      message: { role: "user", content: `Another Claude session sent a message:\n${interrupts[0].prompt}\n\nThis came from another Claude session.` },
    });
    await waitFor(() => fake.callsOf("setMessageReaction").length === 2, 3000, "reaction cleared");
    expect(arr(fake.callsOf("setMessageReaction")[1].reaction)).toEqual([]);
  });

  test("the interrupting message keeps its meta in the tag, quotes escaped", () => {
    expect(interruptPrompt("\u0441\u0442\u043e\u043f", { chat_id: "-1001", user: 'a "b" <c>' })).toEndWith(
      '<channel source="telegram-hub" chat_id="-1001" user="a &quot;b&quot; &lt;c>">\n\u0441\u0442\u043e\u043f\n</channel>',
    );
  });

  test("a \"!\" message to an idle agent is just a message", async () => {
    await enabledCore();
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "!\u043f\u0440\u0438\u0432\u0435\u0442" }));
    await waitFor(() => channel.length === 1, 3000, "channel message");
    expect(interrupts).toEqual([]);
    expect(channel.map(m => m.content)).toEqual(["\u043f\u0440\u0438\u0432\u0435\u0442"]);
  });

  test("content starting with \"!\" without the hub's flag does not interrupt", async () => {
    await enabledCore();
    append(assistantText("\u0421\u043c\u043e\u0442\u0440\u044e", "tool_use", "i4"), assistantTool("Bash", "i4"));
    await waitFor(() => fake.callsOf("sendChatAction").length >= 1, 3000, "busy");
    // A pasted document has no text or caption, so the hub sees no "!".
    const rich_message = { blocks: [{ type: "paragraph", text: "!\u0432\u0430\u0436\u043d\u043e" }] };
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, extra: { rich_message } }));
    await waitFor(() => channel.length === 1, 3000, "channel message");
    expect(interrupts).toEqual([]);
    expect(channel.map(m => m.content)).toEqual(["!\u0432\u0430\u0436\u043d\u043e"]);
  });

  test("a message still arrives when the interrupt fails", async () => {
    await enabledCore();
    append(assistantText("\u0421\u043c\u043e\u0442\u0440\u044e", "tool_use", "i2"), assistantTool("Bash", "i2"));
    await waitFor(() => fake.callsOf("sendChatAction").length >= 1, 3000, "busy");
    interruptFails = true;
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "!\u0441\u0442\u043e\u043f" }));
    await waitFor(() => channel.length === 1, 3000, "channel message");
    expect(interrupts.length).toBe(1);
    expect(pluginLog.lines.some(l => l.includes("could not interrupt"))).toBe(true);
  });

  test("the topic shows typing while the agent works, not while it waits for an answer", async () => {
    await enabledCore();
    const typing = () => fake.callsOf("sendChatAction").length;
    append(assistantText("\u0421\u043c\u043e\u0442\u0440\u044e", "tool_use", "w1"), assistantTool("Bash", "w1"));
    await waitFor(() => typing() >= 2, 3000, "typing");
    append(assistantTool("AskUserQuestion", "w2"));
    await Bun.sleep(150);
    const asked = typing();
    await Bun.sleep(200);
    expect(typing()).toBe(asked);
    append(assistantText("\u041f\u043e\u043d\u044f\u043b", "tool_use", "w3"));
    await waitFor(() => typing() > asked, 3000, "typing again");
    append(assistantText("\u0413\u043e\u0442\u043e\u0432\u043e", "end_turn", "w4"));
    await Bun.sleep(150);
    const ended = typing();
    await Bun.sleep(200);
    expect(typing()).toBe(ended);
  });

  test("a tool result resumes busy state and a lone ! interrupts with empty content", async () => {
    await enabledCore();
    const typing = () => fake.callsOf("sendChatAction").length;
    append(assistantTool("Bash", "q1"));
    await waitFor(() => typing() >= 1, 3000, "initial busy state");
    append(assistantTool("AskUserQuestion", "q2"));
    await Bun.sleep(150);
    const waiting = typing();
    await Bun.sleep(200);
    expect(typing()).toBe(waiting);

    append({
      type: "user",
      isSidechain: false,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "The answer" }] },
    });
    await waitFor(() => typing() > waiting, 3000, "busy state after the answer");

    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "!" }));
    await waitFor(() => interrupts.length === 1, 3000, "interrupt after the answer");
    expect(channel).toEqual([]);
    expect(interrupts[0].prompt).toEndWith(">\n\n</channel>");

    append(assistantText("Finished", "end_turn", "q3"), closed);
    await stopHook(true, "done");
    await waitFor(() => sent().some(message => message.text.includes("Finished")), 3000, "turn end after the answer");
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
    const timestamp = new Date(2026, 0, 1, 12, 0).toISOString();
    appendFileSync(agent, line({ ...assistantText("Looking", "tool_use", "s1"), isSidechain: true, timestamp }));
    await waitFor(() => sent().length === 1, 3000, "card");
    expect(sent()[0]).toEqual({ text: "🤖 Explore\nFind it\n⏳ 0 s · 0 actions\n\n[12:00] Looking", silent: true, topic: 100 });
    appendFileSync(agent, line({ ...assistantText("Found", "end_turn", "s2"), isSidechain: true, timestamp }));
    await waitFor(() => fake.callsOf("editMessageText").some(c => /✅ \d+ s · \d+ actions?/.test(String(c.text))), 3000, "final edit");
    expect(String(fake.callsOf("editMessageText").at(-1)?.text)).toEndWith("[12:00] Looking\n\n[12:00] Found");
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

  test("terminate tells the hub the pid it is about to end", async () => {
    claudePid = 4242;
    await enabledCore();
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "/stop" }));
    await waitFor(() => hubLog.lines.includes(`INFO session ${SID}: the plugin ends Claude Code 4242`), 3000, "exiting");
  });

  test("text written before a question reaches the topic before the poll", async () => {
    await enabledCore();
    // The tool_use record is not in the file yet: only the text before it.
    append(assistantText("\u0421\u043f\u0440\u043e\u0448\u0443 \u043f\u0440\u043e \u0446\u0432\u0435\u0442", "tool_use", "q1"));
    const question = { question: "\u041a\u0430\u043a\u043e\u0439 \u0446\u0432\u0435\u0442?", header: "\u0426\u0432\u0435\u0442", options: [{ label: "\u041a\u0440\u0430\u0441\u043d\u044b\u0439", description: "" }, { label: "\u0421\u0438\u043d\u0438\u0439", description: "" }], multiSelect: false };
    const answer = fetch(`http://127.0.0.1:${port}/question`, {
      method: "POST",
      body: JSON.stringify({ messagingSocket: "pipe-1", session_id: SID, tool_input: { questions: [question] } }),
    }).then(r => r.json());
    await waitFor(() => sent().length === 2, 3000, "the text and the poll");
    expect(sent().map(m => m.text)).toEqual(["\u0421\u043f\u0440\u043e\u0448\u0443 \u043f\u0440\u043e \u0446\u0432\u0435\u0442", "\u0426\u0432\u0435\u0442\n\u041a\u0430\u043a\u043e\u0439 \u0446\u0432\u0435\u0442?\n\n1. \u041a\u0440\u0430\u0441\u043d\u044b\u0439\n2. \u0421\u0438\u043d\u0438\u0439"]);
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "\u0437\u0435\u043b\u0451\u043d\u044b\u0439" }));
    expect(await answer).toEqual({ decision: "allow", answers: { "\u041a\u0430\u043a\u043e\u0439 \u0446\u0432\u0435\u0442?": "\u0437\u0435\u043b\u0451\u043d\u044b\u0439" } });
  });

  test("the separator call before a question sends the text before it at once", async () => {
    await enabledCore();
    append(assistantText("\u041e\u0431\u044a\u044f\u0441\u043d\u044f\u044e, \u043e \u0447\u0451\u043c \u0441\u043f\u0440\u043e\u0448\u0443", "tool_use", "q1"), assistantTool("mcp__plugin_telegram-hub_telegram-hub__tg_before_question", "q1"));
    await waitFor(() => sent().length === 1, 3000, "the text before the separator");
    expect(sent()).toEqual([{ text: "\u041e\u0431\u044a\u044f\u0441\u043d\u044f\u044e, \u043e \u0447\u0451\u043c \u0441\u043f\u0440\u043e\u0448\u0443", silent: true, topic: 100 }]);
  });

  test("a permission request is sent loudly while enabled", async () => {
    const c = await enabledCore();
    c.permissionRequest({ request_id: "abcde", tool_name: "Bash", description: "git push" });
    await waitFor(() => sent().length === 1);
    expect(sent()[0]).toEqual({ text: "🔐 Confirmation needed: Bash", silent: false, topic: 100 });
  });

  test("a permission request answered in the topic reaches Claude Code", async () => {
    const c = await enabledCore();
    c.permissionRequest({ request_id: "abcde", tool_name: "Bash", description: "Executes a given bash command", input_preview: '{"command":"git push","description":"Push the branch"}' });
    await waitFor(() => sent().length === 1);
    const msg = fake.callsOf("sendMessage")[0];
    const head = "🔐 Confirmation needed: Bash\nPush the branch";
    expect(msg).toMatchObject({
      text: `${head}\n\ncommand: git push`,
      entities: [{ type: "pre", offset: head.length + 2, length: 17 }],
      disable_notification: false,
    });
    const rows = arr(field(field(msg, "reply_markup"), "inline_keyboard"));
    const allow = arr(rows[0]).find(b => field(b, "text") === en.permissionAllow);
    fake.pushUpdate(buttonPress({ chatId: GROUP, fromId: ME, messageId: fake.lastMessageId, data: String(field(allow, "callback_data")) }));
    await waitFor(() => answers.length === 1, 3000, "answer");
    expect(answers).toEqual([{ requestId: "abcde", behavior: "allow" }]);
    await waitFor(() => fake.callsOf("editMessageText").length === 1, 3000, "edit");
    expect(fake.callsOf("editMessageText")[0]).toMatchObject({ message_id: fake.lastMessageId, text: `${head}\n\ncommand: git push\n\n✅ Allowed` });
    expect(fake.callsOf("editMessageText")[0].reply_markup).toBeUndefined();
    expect(fake.callsOf("answerCallbackQuery")).toEqual([expect.objectContaining({ text: "✅ Allowed" })]);
  });

  test("a rename renames the topic", async () => {
    await enabledCore();
    append({ type: "agent-name", agentName: "\u041d\u043e\u0432\u043e\u0435 \u0438\u043c\u044f" });
    await waitFor(() => fake.callsOf("editForumTopic").length === 1, 3000, "rename");
    expect(fake.callsOf("editForumTopic")[0].name).toBe("demo-app · \u041d\u043e\u0432\u043e\u0435 \u0438\u043c\u044f");
  });

  test("switching session follows the new transcript", async () => {
    const c = await enabledCore();
    const next = join(configDir, "projects", "C--code-demo-app", "sess-2.jsonl");
    c.switchSession("sess-2", next, CWD);
    await waitFor(() => hub.isConnected("sess-2"), 3000, "switched");
    writeFileSync(next, line({ type: "ai-title", aiTitle: "\u041f\u043e\u0441\u043b\u0435 clear" }));
    await c.enable();
    expect(fake.callsOf("createForumTopic").at(-1)?.name).toBe("demo-app · \u041f\u043e\u0441\u043b\u0435 clear");
    appendFileSync(next, line(assistantText("\u0432 \u043d\u043e\u0432\u043e\u0439 \u0441\u0435\u0441\u0441\u0438\u0438", "end_turn")) + line(closed));
    append(assistantText("\u0432 \u0441\u0442\u0430\u0440\u043e\u0439 \u0441\u0435\u0441\u0441\u0438\u0438", "end_turn"));
    await stopHook(false);
    await waitFor(() => sent().length === 1, 3000, "message");
    await Bun.sleep(150);
    expect(sent()).toEqual([{ text: "\u0432 \u043d\u043e\u0432\u043e\u0439 \u0441\u0435\u0441\u0441\u0438\u0438", silent: true, topic: 101 }]);
  });

  test("switching a CLI window sends the new title and follows the hub mode", async () => {
    const c = makeCore(SID, "cli");
    await waitFor(() => hub.isConnected(SID), 3000, "plugin connected");
    const next = join(configDir, "projects", "C--code-demo-app", "sess-2.jsonl");
    writeFileSync(next, line({ type: "ai-title", aiTitle: "\u041f\u043e\u0441\u043b\u0435 clear" }));
    c.switchSession("sess-2", next, CWD);
    await waitFor(() => hub.isConnected("sess-2") && c.enabled && new SessionStore(join(state, "sessions.json")).get("sess-2")?.title === "\u041f\u043e\u0441\u043b\u0435 clear", 3000, "hub mode applied after switch");
    expect(new SessionStore(join(state, "sessions.json")).get("sess-2")).toMatchObject({ enabled: true, title: "\u041f\u043e\u0441\u043b\u0435 clear" });
  });

  test("shutdown sends text written just before the window closed", async () => {
    const c = await enabledCore();
    append(assistantText("\u043f\u043e\u0441\u043b\u0435\u0434\u043d\u0435\u0435 \u0441\u043b\u043e\u0432\u043e", "end_turn", "z1"));
    await c.shutdown(2000);
    core = undefined;
    await waitFor(() => sent().length === 1, 3000, "last words");
    expect(sent()).toEqual([{ text: "\u043f\u043e\u0441\u043b\u0435\u0434\u043d\u0435\u0435 \u0441\u043b\u043e\u0432\u043e", silent: true, topic: 100 }]);
    expect(spawned).toBe(0);
  });

  test("a window closing while the hub is down leaves its text in spool/ and starts a hub", async () => {
    const c = await enabledCore();
    await hub.stop();
    await waitFor(() => pluginLog.lines.some(l => l.includes("hub connection lost")), 3000, "connection lost");
    append(assistantText("\u0431\u0435\u0437 \u0445\u0430\u0431\u0430", "end_turn", "y1"));
    await c.shutdown(300);
    core = undefined;
    const files = readdirSync(spoolDir).filter(f => f.endsWith(".json"));
    expect(files.length).toBe(1);
    const items: unknown = JSON.parse(readFileSync(join(spoolDir, files[0]), "utf8"));
    expect(items).toMatchObject([{ sessionId: SID, text: "\u0431\u0435\u0437 \u0445\u0430\u0431\u0430", notify: false }]);
    expect(spawned).toBeGreaterThan(0);
  });

  test("a SessionStart hook for the same session keeps relaying", async () => {
    const c = await enabledCore();
    // same file, path spelled differently (drive letter case)
    c.switchSession(SID, transcript.replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase() + ":"), CWD);
    expect(c.enabled).toBe(true);
    append(assistantText("\u043f\u043e\u0441\u043b\u0435 \u043a\u043e\u043c\u043f\u0430\u043a\u0442\u0430", "end_turn"), closed);
    await stopHook(false);
    await waitFor(() => sent().length === 1, 3000, "message");
  });

  test("enable without groupId returns the explanation", async () => {
    config = { allowFrom: [ME], turnEndChime: "" };
    const c = makeCore();
    await expect(c.enable()).rejects.toThrow(/config\.json/);
  });
});

describe("a turn ended by a failed connection to the API", () => {
  const ERROR = "API Error: Connection lost mid-response. The response above may be incomplete.";
  const apiError = (text = ERROR) => ({ ...assistantText(text, "stop_sequence"), error: "server_error", isApiErrorMessage: true });
  // The error record, then Claude Code closing the turn on it.
  const cut = (): object[] => [apiError(), closed];
  const UNREACHABLE = "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)";

  test("the agent is told to continue without a topic notice", async () => {
    await enabledCore();
    append(assistantText("\u041f\u0440\u0430\u0432\u043b\u044e \u0442\u0435\u0441\u0442", "tool_use", "r1"), assistantTool("Edit", "r1"), ...cut());
    await waitFor(() => channel.length === 1, 3000, "continue prompt");
    expect(channel[0]).toEqual({ content: CONTINUE_PROMPT, meta: { user: "telegram-hub", reason: "response_cut" } });
    await waitFor(() => sent().length === 1, 3000, "relayed answer");
    expect(sent()).toEqual([
      { text: "\u041f\u0440\u0430\u0432\u043b\u044e \u0442\u0435\u0441\u0442", silent: true, topic: 100 },
    ]);
  });

  test("a request that never reached the API is continued too", async () => {
    await enabledCore();
    append(apiError(UNREACHABLE), closed);
    await waitFor(() => channel.length === 1, 3000, "continue prompt");
    expect(channel[0]?.content).toBe(CONTINUE_PROMPT);
  });

  // Claude Code: the auto mode classifier's response broke
  // off, the tool call got its result and the turn went on.
  test("an API error after which the turn goes on is neither a cut nor a turn end", async () => {
    await enabledCore();
    append(assistantText("\u041f\u0438\u0448\u0443 \u0444\u0430\u0439\u043b", "tool_use", "r1"), assistantTool("Write", "r1"), apiError("API Error: The response stopped arriving."));
    append(assistantText("\u0417\u0430\u043f\u0438\u0441\u0430\u043b", "tool_use", "r2"), assistantTool("Bash", "r2"), assistantText("\u0413\u043e\u0442\u043e\u0432\u043e", "end_turn", "r3"), closed);
    await stopHook(true, "done");
    await waitFor(() => sent().length === 3, 3000, "three messages");
    expect(sent().map(s => s.text)).toEqual(["\u041f\u0438\u0448\u0443 \u0444\u0430\u0439\u043b", "\u0417\u0430\u043f\u0438\u0441\u0430\u043b", "\u0413\u043e\u0442\u043e\u0432\u043e"]);
    expect(channel).toEqual([]);
  });

  test("with the mode off the person at the terminal decides", async () => {
    const c = makeCore();
    await waitFor(() => hub.isConnected(SID), 3000, "plugin connected");
    append(...cut());
    await Bun.sleep(300);
    expect(c.enabled).toBe(false);
    expect(channel).toEqual([]);
  });

  test(`after ${MAX_AUTO_CONTINUES} cuts in a row it stops and calls the person; a normal turn end starts the count over`, async () => {
    await enabledCore();
    for (let i = 0; i < MAX_AUTO_CONTINUES; i++) append(...cut());
    await waitFor(() => channel.length === MAX_AUTO_CONTINUES, 3000, "continue prompts");
    append(...cut());
    await waitFor(() => sent().some(s => s.text === CUT_LIMIT_NOTE), 3000, "limit note");
    expect(sent().find(s => s.text === CUT_LIMIT_NOTE)?.silent).toBe(false);
    expect(channel.length).toBe(MAX_AUTO_CONTINUES);
    append(assistantText("\u0434\u0430\u043b\u044c\u0448\u0435 \u0441\u0430\u043c", "end_turn"), closed, ...cut());
    await waitFor(() => channel.length === MAX_AUTO_CONTINUES + 1, 3000, "continue after a normal turn");
  });

  test("the plugin writes English until the hub says otherwise, then in the hub's language", async () => {
    await enabledCore();
    for (let i = 0; i <= MAX_AUTO_CONTINUES; i++) append(...cut());
    await waitFor(() => sent().some(s => s.text === en.apiFailure({ count: MAX_AUTO_CONTINUES })), 3000, "English limit note");
    expect(sent().some(s => s.text === ru.apiFailure({ count: MAX_AUTO_CONTINUES }))).toBe(false);
    hub["rig"].language = async () => "ru";
    await hub["onLanguageChanged"]();
    append(assistantText("again", "end_turn"), closed);
    for (let i = 0; i <= MAX_AUTO_CONTINUES; i++) append(...cut());
    await waitFor(() => sent().some(s => s.text === ru.apiFailure({ count: MAX_AUTO_CONTINUES })), 3000, "Russian limit note");
  });

  test("the stopped notice names the attempt limit", () => {
    expect(CUT_LIMIT_NOTE).toBe(en.apiFailure({ count: MAX_AUTO_CONTINUES }));
  });

  test("a cut written before the window started is history", async () => {
    appendFileSync(transcript, cut().map(line).join(""));
    await enabledCore();
    append(assistantText("\u043d\u043e\u0432\u044b\u0439 \u0445\u043e\u0434", "end_turn"), closed);
    await stopHook(false);
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
    append(assistantText("\u0432\u043e\u0442 \u0441\u043a\u0440\u0438\u043d", "tool_use", "s1"));
    await c.sendFiles([file("a.png")]);
    expect(sends()).toEqual(["sendMessage", "sendPhoto"]);
    expect(sent()).toEqual([{ text: "\u0432\u043e\u0442 \u0441\u043a\u0440\u0438\u043d", silent: true, topic: 100 }]);
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
      [[file("sessions.json", "{}", state)], "telegram-hub state"],
    ];
    for (const [paths, why] of cases) await expect(c.sendFiles(paths)).rejects.toThrow(why);
    await expect(c.sendFiles([ok], "\u044f".repeat(1025))).rejects.toThrow("1024");
    // Formatting does not count: the caption is measured as Telegram shows it.
    expect(await c.sendFiles([ok], `**${"\u044f".repeat(1024)}**`)).toContain("Sent 1");
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

  test("a rejection after the call returned reaches the agent, not the topic", async () => {
    const c = await enabledCore();
    fake.delayNext("sendDocument", 3500);
    fake.failNext("sendDocument", { code: 413, description: "Request Entity Too Large" });
    expect(await c.sendFiles([file("a.txt")])).toContain("queued");
    await waitFor(() => channel.length === 1, 3000, "rejection prompt");
    expect(channel[0]).toEqual({ content: filesRejectedPrompt("a.txt: Request Entity Too Large"), meta: { user: "telegram-hub", reason: "files_rejected" } });
    expect(sent()).toEqual([]);
  });
});

describe("the configured chime", () => {
  const savedStateDir = process.env.TELEGRAM_HUB_STATE_DIR;
  afterEach(() => {
    if (savedStateDir === undefined) delete process.env.TELEGRAM_HUB_STATE_DIR;
    else process.env.TELEGRAM_HUB_STATE_DIR = savedStateDir;
  });

  test("a bad turnEndChime plays the default sound and is logged once", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ allowFrom: [], turnEndChime: 5 }));
    process.env.TELEGRAM_HUB_STATE_DIR = dir;
    const log = memLogger();
    const played: [string, ChimeKind][] = [];
    const play = (template: string, kind: ChimeKind) => void played.push([template, kind]);
    playConfiguredChime("done", log, play, platformFor("win32"));
    playConfiguredChime("ask", log, play, platformFor("win32"));
    expect(played).toEqual([
      [defaultTurnEndChime(), "done"],
      [defaultTurnEndChime(), "ask"],
    ]);
    expect(log.lines).toEqual(["WARN turnEndChime in config.json must be a string; playing the default sound"]);
  });
});
