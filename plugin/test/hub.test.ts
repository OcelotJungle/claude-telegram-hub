import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'path'
import { Hub } from '../src/hub/hub.ts'
import { SessionStore } from '../src/hub/sessions.ts'
import { TelegramApi } from '../src/hub/telegram.ts'
import { PROTOCOL_VERSION } from '../src/shared/protocol.ts'
import type { Config } from '../src/shared/config.ts'
import { FakeTelegram, topicMsg } from './fakeTelegram.ts'
import { freePort, memLogger, tempDir, waitFor, wsClient } from './helpers.ts'

const GROUP = '-1001'
const ME = '123456789'
// A session folder that exists: the repository itself.
const CWD = join(import.meta.dir, '..', '..')

let fake: FakeTelegram
let hub: Hub
let port: number
let dir: string
let config: Config
let log: ReturnType<typeof memLogger>
let exited: boolean
const clients: { close(): void }[] = []

async function startHub(o: { idleMs?: number; token?: boolean | string } = {}) {
  port = await freePort()
  hub = new Hub({
    port,
    sessionsFile: join(dir, 'sessions.json'),
    inboxDir: join(dir, 'inbox'),
    api: o.token === false ? undefined : new TelegramApi({ token: typeof o.token === 'string' ? o.token : fake.token, base: fake.url, baseDelayMs: 1, maxAttempts: 2, attemptTimeoutMs: 300, networkRetryMs: 5 }),
    config: () => config,
    idleMs: o.idleMs ?? 60_000,
    pollTimeoutSec: 1,
    pollRetryBaseMs: 10,
    log,
    onExit: () => {
      exited = true
    },
  })
  expect(hub.start()).toBe(true)
}

const hello = (sessionId: string, windowKey = `win-${sessionId}`) => ({ type: 'hello', v: PROTOCOL_VERSION, windowKey, sessionId, cwd: CWD })

async function plugin(sessionId: string, windowKey?: string) {
  const c = await wsClient(port, hello(sessionId, windowKey))
  clients.push(c)
  await c.next(m => m.type === 'state')
  return c
}

let reqId = 0
async function req(c: Awaited<ReturnType<typeof plugin>>, body: object) {
  const id = `r${++reqId}`
  c.send({ type: 'req', id, ...body })
  return c.next(m => m.type === 'res' && m.id === id, 5000)
}

async function enabled(sessionId: string, title = 'Title') {
  const c = await plugin(sessionId)
  const res = await req(c, { op: 'enable', title })
  expect(res.ok).toBe(true)
  return c
}

beforeEach(() => {
  fake = new FakeTelegram()
  dir = tempDir()
  config = { groupId: GROUP, allowFrom: [ME] }
  log = memLogger()
  exited = false
})

afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await hub?.stop()
  fake.stop()
})

describe('enable', () => {
  test('creates a topic named "<project> · <title>"', async () => {
    await startHub()
    const c = await plugin('s1')
    const res = await req(c, { op: 'enable', title: 'Реализация хаба' })
    expect(res).toMatchObject({ ok: true, result: { topicTitle: 'claude-telegram-hub · Реализация хаба', created: true } })
    expect(fake.callsOf('createForumTopic')).toEqual([{ chat_id: GROUP, name: 'claude-telegram-hub · Реализация хаба' }])
    await c.next(m => m.type === 'state' && m.enabled === true)
    expect(new SessionStore(join(dir, 'sessions.json')).get('s1')).toEqual({ topicId: 100, title: 'Реализация хаба', project: 'claude-telegram-hub', enabled: true })
  })

  test('a second enable reuses the topic', async () => {
    await startHub()
    const c = await plugin('s1')
    await req(c, { op: 'enable', title: 'T' })
    await req(c, { op: 'disable' })
    const res = await req(c, { op: 'enable', title: 'T' })
    expect(res.result.created).toBe(false)
    expect(fake.callsOf('createForumTopic').length).toBe(1)
  })

  test('enable with a changed title renames the topic', async () => {
    await startHub()
    const c = await plugin('s1')
    await req(c, { op: 'enable', title: 'Old' })
    await req(c, { op: 'enable', title: 'New' })
    expect(fake.callsOf('editForumTopic')).toEqual([{ chat_id: GROUP, message_thread_id: 100, name: 'claude-telegram-hub · New' }])
  })

  test('without groupId the error explains what to configure', async () => {
    config = { allowFrom: [ME] }
    await startHub()
    const c = await plugin('s1')
    const res = await req(c, { op: 'enable', title: 'T' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('config.json')
    expect(res.error).toContain('hub.log')
  })

  test('without a bot token the error says so', async () => {
    await startHub({ token: false })
    const c = await plugin('s1')
    const res = await req(c, { op: 'enable', title: 'T' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('TELEGRAM_BOT_TOKEN')
  })

  test('a failing createForumTopic is reported', async () => {
    await startHub()
    fake.failNext('createForumTopic', { code: 400, description: 'Bad Request: not enough rights to create a topic' })
    const c = await plugin('s1')
    const res = await req(c, { op: 'enable', title: 'T' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('not enough rights')
  })
})

describe('inbound', () => {
  test('a topic message reaches the right one of two sessions and enables it', async () => {
    await startHub()
    const a = await enabled('a', 'A')
    const b = await enabled('b', 'B')
    await req(b, { op: 'disable' })
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 101, fromId: ME, text: 'привет B' }))
    const msg = await b.next(m => m.type === 'inbound')
    expect(msg.content).toBe('привет B')
    expect(msg.meta).toMatchObject({ chat_id: GROUP, user_id: ME, user: 'user' })
    await waitFor(() => b.messages.filter(m => m.type === 'state').at(-1)?.enabled === true, 3000, 'enabled state')
    expect(new SessionStore(join(dir, 'sessions.json')).get('b')?.enabled).toBe(true)
    expect(a.messages.some(m => m.type === 'inbound')).toBe(false)
  })

  test('a topic of a session without a window gets "сессия сейчас не активна"', async () => {
    await startHub()
    const a = await enabled('a')
    a.close()
    await waitFor(() => !hub.isConnected('a'), 3000, 'disconnect')
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: 'hello?' }))
    const sent = await waitFor(() => fake.callsOf('sendMessage').find(p => p.text === 'сессия сейчас не активна'))
    expect(sent).toMatchObject({ chat_id: GROUP, message_thread_id: 100, disable_notification: false })
  })

  test('General, other chats and other users are ignored and the chat id is logged', async () => {
    await startHub()
    const a = await enabled('a')
    fake.pushUpdate(topicMsg({ chatId: GROUP, fromId: ME, text: 'general' }))
    fake.pushUpdate(topicMsg({ chatId: '-555', threadId: 100, fromId: ME, text: 'other chat' }))
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: '42', text: 'stranger' }))
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: 'mine' }))
    const msg = await a.next(m => m.type === 'inbound')
    expect(msg.content).toBe('mine')
    expect(a.messages.filter(m => m.type === 'inbound').length).toBe(1)
    expect(log.lines.some(l => l.includes('-555'))).toBe(true)
    expect(fake.callsOf('sendMessage').length).toBe(0)
  })

  test('a photo is downloaded into the inbox and passed as image_path', async () => {
    await startHub()
    const a = await enabled('a')
    fake.files.set('P2', { path: 'photos/p.jpg', body: new Uint8Array([9]) })
    fake.pushUpdate(
      topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, extra: { caption: 'look', photo: [{ file_id: 'P1', file_unique_id: 'u1' }, { file_id: 'P2', file_unique_id: 'u2' }] } }),
    )
    const msg = await a.next(m => m.type === 'inbound')
    expect(msg.content).toBe('look')
    expect(msg.meta.image_path.startsWith(join(dir, 'inbox'))).toBe(true)
  })

  test('a document is passed as attachment meta with a sanitized name', async () => {
    await startHub()
    const a = await enabled('a')
    fake.pushUpdate(
      topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, extra: { document: { file_id: 'D1', file_unique_id: 'd', file_name: 'a<b>.txt', file_size: 5, mime_type: 'text/plain' } } }),
    )
    const msg = await a.next(m => m.type === 'inbound')
    expect(msg.content).toBe('(document: a_b_.txt)')
    expect(msg.meta).toMatchObject({ attachment_kind: 'document', attachment_file_id: 'D1', attachment_name: 'a_b_.txt', attachment_size: '5' })
  })
})

describe('send', () => {
  test('silent and notify map to disable_notification and every send is acked', async () => {
    await startHub()
    const a = await enabled('a')
    a.send({ type: 'send', id: 'x1', text: 'working', notify: false })
    a.send({ type: 'send', id: 'x2', text: 'done', notify: true })
    await a.next(m => m.type === 'ack' && m.id === 'x2')
    expect(a.messages.some(m => m.type === 'ack' && m.id === 'x1')).toBe(true)
    expect(fake.callsOf('sendMessage')).toEqual([
      { chat_id: GROUP, message_thread_id: 100, text: 'working', disable_notification: true },
      { chat_id: GROUP, message_thread_id: 100, text: 'done', disable_notification: false },
    ])
  })

  test('long text is chunked and only the first chunk notifies', async () => {
    await startHub()
    const a = await enabled('a')
    a.send({ type: 'send', id: 'x1', text: 'z'.repeat(5000), notify: true })
    await a.next(m => m.type === 'ack' && m.id === 'x1')
    const sent = fake.callsOf('sendMessage')
    expect(sent.map(s => s.text.length)).toEqual([4096, 904])
    expect(sent.map(s => s.disable_notification)).toEqual([false, true])
  })

  test('send while disabled is acked without calling Telegram', async () => {
    await startHub()
    const a = await enabled('a')
    await req(a, { op: 'disable' })
    a.send({ type: 'send', id: 'x1', text: 'quiet', notify: false })
    await a.next(m => m.type === 'ack' && m.id === 'x1')
    expect(fake.callsOf('sendMessage').length).toBe(0)
  })

  test('text queued while enabled is delivered even if terminal input follows while an earlier send is retrying', async () => {
    await startHub()
    const a = await enabled('a')
    fake.failNext('sendMessage', { code: 429, description: 'Too Many Requests', retry_after: 1 })
    a.send({ type: 'send', id: 'x1', text: 'first', notify: false })
    a.send({ type: 'send', id: 'x2', text: 'final', notify: false })
    a.send({ type: 'terminalInput' })
    await a.next(m => m.type === 'ack' && m.id === 'x2', 5000)
    expect(fake.callsOf('sendMessage').map(p => p.text)).toEqual(['first', 'first', 'final'])
  })

  test('terminal input disables the session', async () => {
    await startHub()
    const a = await enabled('a')
    a.send({ type: 'terminalInput' })
    await waitFor(() => a.messages.filter(m => m.type === 'state').at(-1)?.enabled === false, 3000, 'disabled state')
    expect(new SessionStore(join(dir, 'sessions.json')).get('a')?.enabled).toBe(false)
  })

  test('a deleted topic is recreated and the message still delivered', async () => {
    await startHub()
    const a = await enabled('a', 'T')
    fake.deleteTopic(100)
    a.send({ type: 'send', id: 'x1', text: 'still here', notify: false })
    await a.next(m => m.type === 'ack' && m.id === 'x1')
    expect(fake.callsOf('createForumTopic').length).toBe(2)
    expect(fake.callsOf('sendMessage').at(-1)).toMatchObject({ message_thread_id: 101, text: 'still here' })
    expect(new SessionStore(join(dir, 'sessions.json')).get('a')?.topicId).toBe(101)
  })

  test('a final failure is logged with the message text', async () => {
    await startHub()
    const a = await enabled('a')
    fake.failNext('sendMessage', { code: 400, description: 'Bad Request: chat not found' })
    a.send({ type: 'send', id: 'x1', text: 'lost words', notify: false })
    await a.next(m => m.type === 'ack' && m.id === 'x1')
    expect(log.lines.some(l => l.startsWith('ERROR') && l.includes('lost words'))).toBe(true)
  })

  test('a title change renames the topic', async () => {
    await startHub()
    const a = await enabled('a', 'Old')
    a.send({ type: 'title', title: 'New' })
    await waitFor(() => fake.callsOf('editForumTopic').length === 1)
    expect(fake.callsOf('editForumTopic')[0]).toMatchObject({ name: 'claude-telegram-hub · New' })
    a.send({ type: 'title', title: 'New' })
    await Bun.sleep(100)
    expect(fake.callsOf('editForumTopic').length).toBe(1)
  })

  test('a permission request is sent with sound only while enabled', async () => {
    await startHub()
    const a = await enabled('a')
    a.send({ type: 'permission', toolName: 'Bash', description: 'rm -rf build' })
    await waitFor(() => fake.callsOf('sendMessage').length === 1)
    expect(fake.callsOf('sendMessage')[0]).toMatchObject({ text: '🔐 Нужно подтверждение: Bash — rm -rf build', disable_notification: false })
    await req(a, { op: 'disable' })
    a.send({ type: 'permission', toolName: 'Bash', description: 'again' })
    await Bun.sleep(100)
    expect(fake.callsOf('sendMessage').length).toBe(1)
  })

  test('download saves the file into the inbox', async () => {
    await startHub()
    const a = await enabled('a')
    fake.files.set('F', { path: 'docs/x.pdf', body: new Uint8Array([1]) })
    const res = await req(a, { op: 'download', fileId: 'F' })
    expect(res.ok).toBe(true)
    expect(String(res.result).startsWith(join(dir, 'inbox'))).toBe(true)
  })
})

describe('hooks and transport', () => {
  test('a SessionStart hook is forwarded to the window with the same messaging socket', async () => {
    await startHub()
    const a = await plugin('a', 'pipe-A')
    const b = await plugin('b', 'pipe-B')
    const res = await fetch(`http://127.0.0.1:${port}/hook`, {
      method: 'POST',
      body: JSON.stringify({ messagingSocket: 'pipe-B', session_id: 'b2', transcript_path: 'C:\\t\\b2.jsonl', cwd: CWD, source: 'clear' }),
    })
    expect(res.status).toBe(200)
    const sw = await b.next(m => m.type === 'switchSession')
    expect(sw).toEqual({ type: 'switchSession', sessionId: 'b2', transcriptPath: 'C:\\t\\b2.jsonl', cwd: CWD })
    expect(a.messages.some(m => m.type === 'switchSession')).toBe(false)
  })

  test('a hook that arrives before the window says hello is applied on hello', async () => {
    await startHub()
    await fetch(`http://127.0.0.1:${port}/hook`, {
      method: 'POST',
      body: JSON.stringify({ messagingSocket: 'pipe-C', session_id: 'c', transcript_path: 'C:\\t\\c.jsonl', cwd: CWD, source: 'startup' }),
    })
    const c = await plugin('c', 'pipe-C')
    await c.next(m => m.type === 'switchSession')
  })

  test('the session message re-registers a window under a new session id', async () => {
    await startHub()
    const a = await plugin('a')
    a.send({ type: 'session', sessionId: 'a2', cwd: CWD })
    await waitFor(() => hub.isConnected('a2'))
    expect(hub.isConnected('a')).toBe(false)
  })

  test('requests from a browser (Origin header) are rejected', async () => {
    await startHub()
    const res = await fetch(`http://127.0.0.1:${port}/hook`, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' })
    expect(res.status).toBe(403)
    const ws = await fetch(`http://127.0.0.1:${port}/ws`, { headers: { Origin: 'https://evil.example', Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13' } })
    expect(ws.status).toBe(403)
  })

  test('health reports the hub pid', async () => {
    await startHub()
    const res = await (await fetch(`http://127.0.0.1:${port}/health`)).json()
    expect(res).toEqual({ ok: true, pid: process.pid })
  })

  test('a second hub on the same port does not start', async () => {
    await startHub()
    const second = new Hub({ port, sessionsFile: join(dir, 's2.json'), inboxDir: dir, api: undefined, config: () => config, idleMs: 1000, log, onExit() {} })
    expect(second.start()).toBe(false)
  })
})

describe('polling', () => {
  test('the log says which bot is polled', async () => {
    await startHub()
    await waitFor(() => log.lines.some(l => l.includes('polling Telegram as @test_bot')), 3000, 'bot name in log')
  })

  test('recovery after failed polls is logged', async () => {
    fake.failNext('getUpdates', { code: 502, description: 'Bad Gateway' })
    await startHub()
    await waitFor(() => log.lines.some(l => l.includes('Telegram polling works again')), 3000, 'recovery in log')
  })

  test('the hub keeps trying until Telegram answers', async () => {
    for (let i = 0; i < 4; i++) fake.failNext('getMe', { code: 502, description: 'Bad Gateway' })
    await startHub()
    await waitFor(() => log.lines.some(l => l.includes('polling Telegram as @test_bot')), 3000, 'bot name in log')
    expect(fake.callsOf('getUpdates').length).toBeGreaterThan(0)
  })

  test('a hung getUpdates warms the connection up with getMe and polls again', async () => {
    await startHub()
    await waitFor(() => fake.callsOf('getUpdates').length > 0, 3000, 'first poll')
    fake.hangNext('getUpdates')
    await waitFor(() => log.lines.some(l => l.includes('Telegram polling works again')), 5000, 'recovery in log')
    expect(fake.callsOf('getMe').length).toBe(2)
    const polls = fake.callsOf('getUpdates').length
    await waitFor(() => fake.callsOf('getUpdates').length > polls, 5000, 'polling resumed')
  })

  test('a wrong token is reported plainly', async () => {
    await startHub({ token: '1:wrong' })
    await waitFor(() => log.lines.some(l => l.startsWith('ERROR') && l.includes('bot token rejected')), 3000, 'token error in log')
  })
})

describe('idle exit', () => {
  test('the hub exits after the last plugin disconnects', async () => {
    await startHub({ idleMs: 200 })
    const a = await plugin('a')
    await Bun.sleep(350)
    expect(exited).toBe(false)
    a.close()
    await waitFor(() => exited, 2000, 'idle exit')
  })

  test('a hub nobody connects to exits too', async () => {
    await startHub({ idleMs: 150 })
    await waitFor(() => exited, 2000, 'idle exit')
  })
})
