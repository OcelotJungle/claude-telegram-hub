import { describe, expect, test } from "bun:test";
import { join } from "path";
import { parseAgentRecord, parseRecord } from "../src/transcript/parse.ts";

// Shapes mirror records found in Claude Code transcripts.
const assistant = (id: string, stop: string | null, block: object) => ({
  parentUuid: "p",
  isSidechain: false,
  type: "assistant",
  message: { model: "claude-opus-5-5", id, type: "message", role: "assistant", content: [block], stop_reason: stop },
  uuid: "u",
  sessionId: "s",
});
const text = (t: string) => ({ type: "text", text: t });
const toolUse = (name: string) => ({ type: "tool_use", id: "toolu_1", name, input: {} });
// Signature heads: base64 protobuf naming the block kind.
const THINKING_SIG = "CAQS2AYKEAgSGAI4AUIIdGhpbmtpbmcSDMAEHc8RVkFCljXlqhoM4s16bwLW5yY0xreFIjD1gFVyB/I6V96xQnh/Zkc5R853AaR0CaLRbcgfelAoZBntTXsv";
const NARRATION_SIG = "CAQSrgcKEQgSGAI4AUIJbmFycmF0aW9uEgxhMFJuZKXpKQCYxWIaDLo3cuvEnZjRl04uqSIwcikVdFlQ26x5rHo0oYhd4CFFTF+Qg/KbIJ4gkTpHfgPAWqq3";
const thinking = { type: "thinking", thinking: "", signature: THINKING_SIG };
const narration = (t: string) => ({ type: "thinking", thinking: t, signature: NARRATION_SIG });

const userBase = { parentUuid: "p", isSidechain: false, type: "user", uuid: "u", sessionId: "s" };

describe("assistant records", () => {
  test("text block of a tool_use message is text, no turn end", () => {
    expect(parseRecord(assistant("m1", "tool_use", text("looking")))).toEqual([
      { kind: "text", text: "looking", messageId: "m1" },
    ]);
  });

  test("tool_use block is tool_use", () => {
    expect(parseRecord(assistant("m1", "tool_use", toolUse("Bash")))).toEqual([
      { kind: "tool_use", name: "Bash", messageId: "m1" },
    ]);
  });

  test("thinking is ignored", () => {
    expect(parseRecord(assistant("m1", "tool_use", thinking))).toEqual([]);
  });

  test("shown thinking summaries are not text", () => {
    expect(parseRecord(assistant("m1", "tool_use", { ...thinking, thinking: "weighing options" }))).toEqual([]);
  });

  // Claude Code shows narration in the terminal as ordinary assistant text.
  test("narration is text", () => {
    expect(parseRecord(assistant("m1", "tool_use", narration("\u041f\u0440\u043e\u0432\u0435\u0440\u044f\u044e \u0442\u0435\u0441\u0442\u044b.\n\n")))).toEqual([
      { kind: "text", text: "\u041f\u0440\u043e\u0432\u0435\u0440\u044f\u044e \u0442\u0435\u0441\u0442\u044b.", messageId: "m1" },
    ]);
  });

  test("narration of an end_turn message is text then turn_end", () => {
    expect(parseRecord(assistant("m2", "end_turn", narration("\u0413\u043e\u0442\u043e\u0432\u043e.")))).toEqual([
      { kind: "text", text: "\u0413\u043e\u0442\u043e\u0432\u043e.", messageId: "m2" },
      { kind: "turn_end", messageId: "m2" },
    ]);
  });

  test("thinking with text and an unknown kind is reported, not relayed", () => {
    const head = [0x08, 0x04, 0x12, 0x10, 0x0a, 0x10, 0x08, 0x12, 0x18, 0x02, 0x38, 0x01, 0x42, 0x07];
    const sig = Buffer.concat([Buffer.from(head), Buffer.from("musings"), Buffer.from([0x12, 0x0c, 1, 2, 3])]).toString("base64");
    expect(parseRecord(assistant("m1", "tool_use", { type: "thinking", thinking: "hm", signature: sig }))).toEqual([
      { kind: "unknown_thinking", blockKind: "musings" },
    ]);
    expect(parseRecord(assistant("m1", "tool_use", { type: "thinking", thinking: "hm", signature: "garbage" }))).toEqual([
      { kind: "unknown_thinking", blockKind: "?" },
    ]);
  });

  test("end_turn text gives text then turn_end", () => {
    expect(parseRecord(assistant("m2", "end_turn", text("done")))).toEqual([
      { kind: "text", text: "done", messageId: "m2" },
      { kind: "turn_end", messageId: "m2" },
    ]);
  });

  test("thinking record of an end_turn message still marks the turn end", () => {
    expect(parseRecord(assistant("m2", "end_turn", thinking))).toEqual([{ kind: "turn_end", messageId: "m2" }]);
  });

  test("null stop_reason does not end the turn", () => {
    expect(parseRecord(assistant("m3", null, text("partial")))).toEqual([
      { kind: "text", text: "partial", messageId: "m3" },
    ]);
  });

  test("whitespace-only text is dropped", () => {
    expect(parseRecord(assistant("m1", "tool_use", text("  \n ")))).toEqual([]);
  });

  test("sidechain records are ignored", () => {
    expect(parseRecord({ ...assistant("m1", "end_turn", text("sub")), isSidechain: true })).toEqual([]);
    expect(parseRecord({ ...assistant("m1", "tool_use", toolUse("AskUserQuestion")), isSidechain: true })).toEqual([]);
  });
});

describe("API errors", () => {
  // Claude Code writes a synthetic message.
  const apiError = (o: object = {}) => ({
    ...assistant("e1", "stop_sequence", text("API Error: Connection lost mid-response. The response above may be incomplete.")),
    error: "server_error",
    truncatedAfterOutput: true,
    isApiErrorMessage: true,
    ...o,
  });

  test("a failed connection is an API error, without its text: the turn may yet go on", () => {
    expect(parseRecord(apiError())).toEqual([{ kind: "api_error", messageId: "e1" }]);
    const unreachable = {
      ...assistant("e1", "stop_sequence", text("API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)")),
      error: "server_error",
      isApiErrorMessage: true,
    };
    expect(parseRecord(unreachable)).toEqual([{ kind: "api_error", messageId: "e1" }]);
  });

  test("Claude Code closing the turn is turn_closed", () => {
    expect(parseRecord({ type: "system", subtype: "turn_duration", durationMs: 1000 })).toEqual([{ kind: "turn_closed", pendingAgents: 0 }]);
    const waiting = { type: "system", subtype: "turn_duration", durationMs: 1000, pendingBackgroundAgentCount: 7 };
    expect(parseRecord(waiting)).toEqual([{ kind: "turn_closed", pendingAgents: 7 }]);
    expect(parseRecord({ type: "system", subtype: "stop_hook_summary" })).toEqual([]);
  });

  test("API errors that are not the network's just end the turn", () => {
    expect(parseRecord(apiError({ truncatedAfterOutput: undefined, error: "rate_limit" }))[1]).toEqual({ kind: "turn_end", messageId: "e1" });
    expect(parseRecord(apiError({ truncatedAfterOutput: undefined, error: "invalid_request" }))[1]).toEqual({ kind: "turn_end", messageId: "e1" });
  });

  test("a subagent's cut response is ignored", () => {
    expect(parseRecord(apiError({ isSidechain: true }))).toEqual([]);
  });

  // A turn started by a channel
  // message or a reminder sometimes ends on this stub, never on the agent's text.
  test("Claude Code's own stub reply just ends the turn, without its text", () => {
    const base = assistant("s1", "stop_sequence", text("No response requested."));
    const stub = { ...base, isApiErrorMessage: false, message: { ...base.message, model: "<synthetic>" } };
    expect(parseRecord(stub)).toEqual([{ kind: "turn_end", messageId: "s1" }]);
  });
});

describe("user records", () => {
  test("typed message from the terminal is terminal input", () => {
    const rec = { ...userBase, message: { role: "user", content: "hi" }, origin: { kind: "human" }, promptSource: "typed", turnOrigin: "human" };
    expect(parseRecord(rec)).toEqual([{ kind: "terminal_input" }]);
  });

  test("queued message from the terminal is terminal input", () => {
    const rec = { ...userBase, message: { role: "user", content: "also" }, origin: { kind: "human" }, promptSource: "queued" };
    expect(parseRecord(rec)).toEqual([{ kind: "terminal_input" }]);
  });

  test("channel message is not terminal input", () => {
    const rec = { ...userBase, isMeta: true, message: { role: "user", content: '<channel source="telegram-hub">hi</channel>' }, origin: { kind: "channel", server: "plugin:telegram-hub:telegram-hub" } };
    expect(parseRecord(rec)).toEqual([]);
  });

  test("tool result is not terminal input", () => {
    const rec = { ...userBase, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } };
    expect(parseRecord(rec)).toEqual([]);
  });

  test("compact summary is not terminal input", () => {
    const rec = { ...userBase, isCompactSummary: true, isVisibleInTranscriptOnly: true, turnOrigin: "human", message: { role: "user", content: "This session is being continued..." } };
    expect(parseRecord(rec)).toEqual([]);
  });

  test("local command is not terminal input", () => {
    const rec = { ...userBase, message: { role: "user", content: "<command-name>/autocompact</command-name>" } };
    expect(parseRecord(rec)).toEqual([]);
  });

  test("meta caveat is not terminal input even with human origin", () => {
    const rec = { ...userBase, isMeta: true, origin: { kind: "human" }, message: { role: "user", content: "<local-command-caveat>" } };
    expect(parseRecord(rec)).toEqual([]);
  });

  // A message typed while the agent works is absorbed into the running turn.
  test("message typed mid-turn is terminal input", () => {
    const rec = {
      parentUuid: "p",
      isSidechain: false,
      type: "attachment",
      attachment: { type: "queued_command", prompt: "\u041a\u0430\u043a \u0443\u0441\u043f\u0435\u0445\u0438?", commandMode: "prompt", origin: { kind: "human" }, humanTurn: true },
    };
    expect(parseRecord(rec)).toEqual([{ kind: "terminal_input" }]);
  });

  test("task notification absorbed mid-turn is not terminal input", () => {
    const rec = { type: "attachment", attachment: { type: "queued_command", prompt: "<task-notification>", commandMode: "task-notification", origin: { kind: "task-notification" } } };
    expect(parseRecord(rec)).toEqual([]);
  });

  test("a task notification absorbed mid-turn tells which task stopped", () => {
    const prompt = "<task-notification>\n<task-id>a1b2c3</task-id>\n<status>completed</status>\n<summary>Agent done</summary>\n</task-notification>";
    const rec = { type: "attachment", attachment: { type: "queued_command", prompt, commandMode: "task-notification", origin: { kind: "task-notification", producer: "session-task" } } };
    expect(parseRecord(rec)).toEqual([{ kind: "task_status", taskId: "a1b2c3", status: "completed" }]);
  });

  test("other attachments are not terminal input", () => {
    expect(parseRecord({ type: "attachment", attachment: { type: "edited_text_file", origin: { kind: "human" } } })).toEqual([]);
    expect(parseRecord({ type: "attachment" })).toEqual([]);
  });

  test("an interrupt by the user ends the turn", () => {
    const plain = { ...userBase, message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } };
    expect(parseRecord(plain)).toEqual([{ kind: "interrupted" }]);
    const tool = { ...userBase, message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } };
    expect(parseRecord(tool)).toEqual([{ kind: "interrupted" }]);
  });

  test("task notification is not terminal input", () => {
    const rec = { ...userBase, origin: { kind: "task-notification" }, promptSource: "system", turnOrigin: "task_notification", message: { role: "user", content: "<task-notification>" } };
    expect(parseRecord(rec)).toEqual([]);
  });

  test("a task notification tells which task stopped and how", () => {
    const content = "<task-notification>\n<task-id>a1b2c3</task-id>\n<status>completed</status>\n<summary>Agent done</summary>\n</task-notification>";
    const rec = { ...userBase, origin: { kind: "task-notification" }, message: { role: "user", content } };
    expect(parseRecord(rec)).toEqual([{ kind: "task_status", taskId: "a1b2c3", status: "completed" }]);
    const blocks = { ...rec, message: { role: "user", content: [{ type: "text", text: content.replace("completed", "killed") }] } };
    expect(parseRecord(blocks)).toEqual([{ kind: "task_status", taskId: "a1b2c3", status: "killed" }]);
  });

  test("an agent that stopped to wait for its own background work has not stopped", () => {
    // Claude Code 2.1.x writes this each time a background agent ends a turn with a task of its own still running.
    const content = [
      "<task-notification>",
      "<task-id>a1b2c3</task-id>",
      "<status>completed</status>",
      '<summary>Agent "Dev run" is waiting on its own background work</summary>',
      "<note>This agent stopped with background work of its own still running. It may resume on its own when that work completes or reports, and the same task-id notifies again if it does; the result below may be interim.</note>",
      "<result>This agent has not reported yet.</result>",
      "</task-notification>",
    ].join("\n");
    const rec = { ...userBase, origin: { kind: "task-notification" }, message: { role: "user", content } };
    expect(parseRecord(rec)).toEqual([]);
    const queued = { type: "attachment", attachment: { type: "queued_command", prompt: content, commandMode: "task-notification", origin: { kind: "task-notification" } } };
    expect(parseRecord(queued)).toEqual([]);
  });
});

describe("topic messages reaching the agent", () => {
  const TG = { kind: "channel", server: "plugin:telegram-hub:telegram-hub" };
  const tag = (id: number, body: string) => `<channel source="plugin:telegram-hub:telegram-hub" chat_id="-1001" message_id="${id}" user="me" user_id="1" ts="2026-01-09T12:00:00.000Z">\n${body}\n</channel>`;

  test("a channel prompt names the messages the agent got", () => {
    const rec = { ...userBase, isMeta: true, origin: TG, message: { role: "user", content: tag(4951, "\u043f\u0440\u0438\u0432\u0435\u0442") } };
    expect(parseRecord(rec)).toEqual([{ kind: "channel_seen", messageIds: [4951] }]);
    const blocks = { ...rec, message: { role: "user", content: [{ type: "text", text: `${tag(7, "a")}\n${tag(8, "b")}` }] } };
    expect(parseRecord(blocks)).toEqual([{ kind: "channel_seen", messageIds: [7, 8] }]);
  });

  test("a channel message absorbed mid-turn is seen too", () => {
    const rec = { type: "attachment", isSidechain: false, attachment: { type: "queued_command", prompt: tag(4841, "\u0438 \u0435\u0449\u0451"), commandMode: "prompt", origin: TG } };
    expect(parseRecord(rec)).toEqual([{ kind: "channel_seen", messageIds: [4841] }]);
  });

  test("a message that interrupted the agent comes from our plugin through the inbox", () => {
    const peer = { kind: "peer", from: "unknown", plugin: "telegram-hub" };
    const rec = { ...userBase, isMeta: true, origin: peer, message: { role: "user", content: `Another Claude session sent a message:\n${tag(5107, "! \u0441\u0442\u043e\u043f")}` } };
    expect(parseRecord(rec)).toEqual([{ kind: "channel_seen", messageIds: [5107] }]);
  });

  test("another channel's messages and quoted tags are not ours", () => {
    const other = { kind: "channel", server: "plugin:telegram:telegram" };
    expect(parseRecord({ ...userBase, isMeta: true, origin: other, message: { role: "user", content: tag(5, "x") } })).toEqual([]);
    const otherPeer = { kind: "peer", from: "uds:x", plugin: "other" };
    expect(parseRecord({ ...userBase, isMeta: true, origin: otherPeer, message: { role: "user", content: tag(5, "x") } })).toEqual([]);
    expect(parseRecord({ ...userBase, origin: { kind: "human" }, message: { role: "user", content: `see ${tag(6, "x")}` } })).toEqual([{ kind: "terminal_input" }]);
  });
});

describe("tool call details", () => {
  const call = (input: object) => parseRecord(assistant("m1", "tool_use", { type: "tool_use", id: "t", name: "X", input }));

  test("a path shows as its file name", () => {
    expect(call({ file_path: join("src", "hub", "hub.ts"), old_string: "a" })).toEqual([{ kind: "tool_use", name: "X", messageId: "m1", detail: "hub.ts" }]);
  });

  test("a description beats a command, and only the first line is kept", () => {
    expect(call({ command: "bun test", description: "Run tests" })[0]).toMatchObject({ detail: "Run tests" });
    expect(call({ command: "cd x\nbun test" })[0]).toMatchObject({ detail: "cd x" });
  });

  test("a long detail is cut", () => {
    expect(call({ pattern: "a".repeat(100) })[0]).toMatchObject({ detail: `${"a".repeat(60)}…` });
  });
});

describe("subagent records", () => {
  test("sidechain assistant records give events, other records none", () => {
    expect(parseAgentRecord({ ...assistant("m1", "end_turn", text("found it")), isSidechain: true })).toEqual([
      { kind: "text", text: "found it", messageId: "m1" },
      { kind: "turn_end", messageId: "m1" },
    ]);
    expect(parseAgentRecord({ ...userBase, isSidechain: true, message: { role: "user", content: "go" } })).toEqual([]);
  });

  test("a coordinator's message to an idle agent gives an event without the prefix", () => {
    const rec = { ...userBase, isSidechain: true, isMeta: true, origin: { kind: "coordinator" }, message: { role: "user", content: "The coordinator sent a message while you were working:\nLook at B too" } };
    expect(parseAgentRecord(rec)).toEqual([{ kind: "coordinator", text: "Look at B too" }]);
  });

  test("a coordinator's message to a working agent gives an event", () => {
    const rec = { type: "attachment", isSidechain: true, attachment: { type: "queued_command", prompt: "Stop after A", origin: { kind: "coordinator" }, isMeta: true } };
    expect(parseAgentRecord(rec)).toEqual([{ kind: "coordinator", text: "Stop after A" }]);
  });

  test("the agent's initial prompt and other queued commands are no coordinator message", () => {
    expect(parseAgentRecord({ ...userBase, isSidechain: true, promptId: "p", message: { role: "user", content: "Do the task" } })).toEqual([]);
    expect(parseAgentRecord({ type: "attachment", attachment: { type: "queued_command", prompt: "x", origin: { kind: "human" } } })).toEqual([]);
  });

  test("the main-session parser ignores coordinator records", () => {
    const rec = { ...userBase, isMeta: true, origin: { kind: "coordinator" }, message: { role: "user", content: "The coordinator sent a message while you were working:\nhi" } };
    expect(parseRecord(rec)).toEqual([]);
  });
});

describe("title records", () => {
  test("custom-title, agent-name and ai-title", () => {
    expect(parseRecord({ type: "custom-title", customTitle: "Mine", sessionId: "s" })).toEqual([{ kind: "title", source: "custom", title: "Mine" }]);
    expect(parseRecord({ type: "agent-name", agentName: "Renamed", sessionId: "s" })).toEqual([{ kind: "title", source: "agent", title: "Renamed" }]);
    expect(parseRecord({ type: "ai-title", aiTitle: "Auto", sessionId: "s" })).toEqual([{ kind: "title", source: "ai", title: "Auto" }]);
  });

  test("empty titles are ignored", () => {
    expect(parseRecord({ type: "ai-title", aiTitle: "" })).toEqual([]);
  });
});

test("garbage is ignored", () => {
  expect(parseRecord(null)).toEqual([]);
  expect(parseRecord("str")).toEqual([]);
  expect(parseRecord({ type: "assistant" })).toEqual([]);
  expect(parseRecord({ type: "system", subtype: "local_command" })).toEqual([]);
});
