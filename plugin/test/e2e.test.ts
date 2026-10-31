import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { z } from "zod";
import { arr, field } from "../src/shared/guards.ts";
import { buttonPress, FakeTelegram, topicMsg } from "./fake-telegram.ts";
import { freePort, hubHealth, must, tempDir, waitFor } from "./helpers.ts";

const MAIN = resolve(import.meta.dir, "../src/plugin/main.ts");
const GROUP = "-1001";
const ME = "123456789";
const SID = "11111111-2222-3333-4444-555555555555";
const CWD = "C:\\code\\e2e-proj";

let fake: FakeTelegram;
let port: number;
let transcript: string;
let client: Client;
let transport: StdioClientTransport;
const channel: { content: string; meta: Record<string, string> }[] = [];
const permissionAnswers: { request_id: string; behavior: string }[] = [];
const dirs: string[] = [];

const health = () => hubHealth(port);

// The environment without unset variables, as the transport takes it.
function definedEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
}

beforeEach(async () => {
  fake = new FakeTelegram();
  port = await freePort();
  const state = tempDir();
  dirs.push(state);
  writeFileSync(join(state, "config.json"), JSON.stringify({ groupId: GROUP, allowFrom: [ME] }));
  const configDir = tempDir();
  dirs.push(configDir);
  const proj = join(configDir, "projects", "C--code-e2e-proj");
  mkdirSync(proj, { recursive: true });
  transcript = join(proj, `${SID}.jsonl`);
  writeFileSync(transcript, JSON.stringify({ type: "ai-title", aiTitle: "E2E" }) + "\n");
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [MAIN],
    cwd: state,
    env: {
      ...definedEnv(),
      HOME: state,
      USERPROFILE: state,
      CLAUDE_CODE_SESSION_ID: SID,
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_PROJECT_DIR: CWD,
      CLAUDE_CODE_MESSAGING_SOCKET: "\\\\.\\pipe\\LOCAL\\cc-msg-e2e",
      TELEGRAM_HUB_STATE_DIR: state,
      TELEGRAM_HUB_PORT: String(port),
      TELEGRAM_HUB_API_BASE: fake.url,
      TELEGRAM_BOT_TOKEN: fake.token,
      TELEGRAM_HUB_IDLE_MS: "1000",
      TELEGRAM_HUB_POLL_TIMEOUT: "1",
    },
  });
  client = new Client({ name: "test", version: "0" });
  client.setNotificationHandler(
    z.object({ method: z.literal("notifications/claude/channel"), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }) }),
    n => void channel.push(n.params),
  );
  client.setNotificationHandler(
    z.object({ method: z.literal("notifications/claude/channel/permission"), params: z.object({ request_id: z.string(), behavior: z.string() }) }),
    n => void permissionAnswers.push(n.params),
  );
  await client.connect(transport);
});

afterEach(async () => {
  try {
    await client?.close().catch(() => {});
    const h = await health();
    if (h) {
      try { process.kill(h.pid, "SIGKILL"); } catch {}
    }
  } finally {
    fake?.stop();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  }
});

test("a window talks to Telegram through a hub it started itself", async () => {
  const caps = client.getServerCapabilities();
  expect(caps?.experimental).toMatchObject({ "claude/channel": {}, "claude/channel/permission": {} });
  const instructions = client.getInstructions() ?? "";
  expect(instructions).toContain("tg_enable");
  expect(instructions).toContain("call tg_before_question, and call AskUserQuestion in the next step");
  expect(instructions).toContain("typing in the terminal does not turn it off");

  const { tools } = await client.listTools();
  expect(tools.map(t => t.name).sort()).toEqual(["download_attachment", "tg_before_question", "tg_disable", "tg_enable", "tg_send_file"]);
  // The separator before a question only answers.
  const separator = CallToolResultSchema.parse(await client.callTool({ name: "tg_before_question", arguments: {} }));
  expect(separator.isError).toBeFalsy();
  expect(separator.content).toEqual([{ type: "text", text: "Now call AskUserQuestion." }]);

  const res = CallToolResultSchema.parse(await client.callTool({ name: "tg_enable", arguments: {} }));
  expect(res.isError).toBeFalsy();
  expect(res.content[0]).toMatchObject({ text: expect.stringContaining("e2e-proj · E2E") });
  expect(fake.callsOf("createForumTopic")).toEqual([{ chat_id: GROUP, name: "e2e-proj · E2E" }]);

  appendFileSync(
    transcript,
    JSON.stringify({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Готово!" }], stop_reason: "end_turn" } }) + "\n",
  );
  // What the Stop hook reports when the turn ends; then Claude Code closes the turn.
  const turnEnd = await fetch(`http://127.0.0.1:${port}/turn-end`, {
    method: "POST",
    body: JSON.stringify({ messagingSocket: "\\\\.\\pipe\\LOCAL\\cc-msg-e2e", session_id: SID, final: true, kind: "done" }),
  });
  expect(turnEnd.status).toBe(200);
  appendFileSync(transcript, JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 1000 }) + "\n");
  await waitFor(() => fake.texts().length === 1, 5000, "final message");
  expect(fake.texts()[0]).toMatchObject({ message_thread_id: 100, text: "Готово!", disable_notification: false });

  await client.notification({
    method: "notifications/claude/channel/permission_request",
    params: { request_id: "abcde", tool_name: "Bash", description: "rm build", input_preview: "{}" },
  });
  await waitFor(() => fake.texts().length === 2, 5000, "permission message");
  expect(fake.texts()[1]).toMatchObject({ text: "🔐 Нужно подтверждение: Bash", disable_notification: false });
  const allow = arr(arr(field(field(fake.callsOf("sendMessage")[1], "reply_markup"), "inline_keyboard"))[0])[0];
  fake.pushUpdate(buttonPress({ chatId: GROUP, fromId: ME, messageId: fake.lastMessageId, data: String(field(allow, "callback_data")) }));
  await waitFor(() => permissionAnswers.length === 1, 5000, "permission answer");
  expect(permissionAnswers).toEqual([{ request_id: "abcde", behavior: "allow" }]);

  fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "ответ с телефона" }));
  await waitFor(() => channel.length === 1, 5000, "channel notification");
  expect(channel[0]).toMatchObject({ content: "ответ с телефона", meta: { chat_id: GROUP, user_id: ME } });

  const hubPid = must(await health()).pid;
  expect(hubPid).not.toBe(process.pid);
  await client.close();
  await waitFor(async () => !(await health()), 8000, "hub idle exit");
}, 30_000);
