import { afterEach, beforeEach, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { appendFileSync, mkdirSync, writeFileSync } from "fs"
import { join, resolve } from "path"
import { z } from "zod"
import { FakeTelegram, topicMsg } from "./fake-telegram.ts"
import { freePort, tempDir, waitFor } from "./helpers.ts"

const MAIN = resolve(import.meta.dir, "../src/plugin/main.ts")
const GROUP = "-1001"
const ME = "123456789"
const SID = "11111111-2222-3333-4444-555555555555"
const CWD = "C:\\code\\e2e-proj"

let fake: FakeTelegram
let port: number
let transcript: string
let client: Client
let transport: StdioClientTransport
const channel: any[] = []

async function health(): Promise<{ pid: number } | undefined> {
  try {
    return (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { pid: number }
  } catch {
    return undefined
  }
}

beforeEach(async () => {
  fake = new FakeTelegram()
  port = await freePort()
  const state = tempDir()
  writeFileSync(join(state, "config.json"), JSON.stringify({ groupId: GROUP, allowFrom: [ME] }))
  const configDir = tempDir()
  const proj = join(configDir, "projects", "C--code-e2e-proj")
  mkdirSync(proj, { recursive: true })
  transcript = join(proj, `${SID}.jsonl`)
  writeFileSync(transcript, JSON.stringify({ type: "ai-title", aiTitle: "E2E" }) + "\n")
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [MAIN],
    cwd: "C:\\",
    env: {
      ...(process.env as Record<string, string>),
      CLAUDE_CODE_SESSION_ID: SID,
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_PROJECT_DIR: CWD,
      CLAUDE_CODE_MESSAGING_SOCKET: "\\\\.\\pipe\\LOCAL\\cc-msg-e2e",
      TG_HUB_STATE_DIR: state,
      TG_HUB_PORT: String(port),
      TG_HUB_API_BASE: fake.url,
      TELEGRAM_BOT_TOKEN: fake.token,
      TG_HUB_IDLE_MS: "1000",
      TG_HUB_POLL_TIMEOUT: "1",
    },
  })
  client = new Client({ name: "test", version: "0" })
  client.setNotificationHandler(
    z.object({ method: z.literal("notifications/claude/channel"), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }) }),
    n => void channel.push(n.params),
  )
  await client.connect(transport)
})

afterEach(async () => {
  await client.close().catch(() => {})
  const h = await health()
  if (h) {
    try {
      process.kill(h.pid)
    } catch {}
  }
  fake.stop()
})

test("a window talks to Telegram through a hub it started itself", async () => {
  const caps = client.getServerCapabilities()
  expect(caps?.experimental).toMatchObject({ "claude/channel": {}, "claude/channel/permission": {} })
  const instructions = client.getInstructions() ?? ""
  expect(instructions).toContain("tg_notify")

  const { tools } = await client.listTools()
  expect(tools.map(t => t.name).sort()).toEqual(["download_attachment", "tg_disable", "tg_enable", "tg_hook_note", "tg_notify", "tg_send_file"])
  // What the PostToolBatch hook gets when there is nothing to tell: no output.
  const note: any = await client.callTool({ name: "tg_hook_note", arguments: { agent_id: "" } })
  expect(note.isError).toBeFalsy()
  expect(note.content).toEqual([{ type: "text", text: "" }])

  const res: any = await client.callTool({ name: "tg_enable", arguments: {} })
  expect(res.isError).toBeFalsy()
  expect(res.content[0].text).toContain("e2e-proj · E2E")
  expect(fake.callsOf("createForumTopic")).toEqual([{ chat_id: GROUP, name: "e2e-proj · E2E" }])

  const notify: any = await client.callTool({ name: "tg_notify", arguments: { kind: "done" } })
  expect(notify.content[0].text).toContain("notification")
  appendFileSync(
    transcript,
    JSON.stringify({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Готово!" }], stop_reason: "end_turn" } }) + "\n",
  )
  await waitFor(() => fake.texts().length === 1, 5000, "final message")
  expect(fake.texts()[0]).toMatchObject({ message_thread_id: 100, text: "Готово!", disable_notification: false })

  await client.notification({
    method: "notifications/claude/channel/permission_request",
    params: { request_id: "abcde", tool_name: "Bash", description: "rm build", input_preview: "{}" },
  })
  await waitFor(() => fake.texts().length === 2, 5000, "permission message")
  expect(fake.texts()[1]).toMatchObject({ text: "🔐 Нужно подтверждение: Bash — rm build", disable_notification: false })

  fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "ответ с телефона" }))
  await waitFor(() => channel.length === 1, 5000, "channel notification")
  expect(channel[0]).toMatchObject({ content: "ответ с телефона", meta: { chat_id: GROUP, user_id: ME } })

  const hubPid = (await health())!.pid
  expect(hubPid).not.toBe(process.pid)
  await client.close()
  await waitFor(async () => !(await health()), 8000, "hub idle exit")
}, 30_000)

test("tg_notify with a wrong kind is an error", async () => {
  const res: any = await client.callTool({ name: "tg_notify", arguments: { kind: "loud" } })
  expect(res.isError).toBe(true)
}, 15_000)
