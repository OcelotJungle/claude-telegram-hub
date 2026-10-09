import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Hub } from '../src/hub/hub.ts'
import { SessionStore } from '../src/hub/sessions.ts'
import { TelegramApi } from '../src/hub/telegram.ts'
import type { VideoTools } from '../src/hub/video.ts'
import { Runner, type Usage } from '../src/mod/commands.ts'
import { PROTOCOL_VERSION } from '../src/shared/protocol.ts'
import type { Config } from '../src/shared/config.ts'
import { FakeTelegram, topicMsg } from './fakeTelegram.ts'
import { freePort, hasFfmpeg, makeVideo, memLogger, tempDir, waitFor, wsClient } from './helpers.ts'

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

async function startHub(o: { idleMs?: number; token?: boolean | string; commandPickupMs?: number; videoTools?: VideoTools } = {}) {
  port = await freePort()
  hub = new Hub({
    port,
    sessionsFile: join(dir, 'sessions.json'),
    outboxFile: join(dir, 'outbox.json'),
    spoolDir: join(dir, 'spool'),
    spoolScanMs: 50,
    filesDir: join(dir, 'outbox-files'),
    inboxDir: join(dir, 'inbox'),
    ...(o.videoTools ? { videoTools: o.videoTools } : {}),
    api: o.token === false ? undefined : new TelegramApi({ token: typeof o.token === 'string' ? o.token : fake.token, base: fake.url, baseDelayMs: 1, maxAttempts: 2, attemptTimeoutMs: 300, networkRetryMs: 5, deadlineMs: 500 }),
    config: () => config,
    idleMs: o.idleMs ?? 60_000,
    commandPickupMs: o.commandPickupMs ?? 3000,
    pollTimeoutSec: 1,
    pollRetryBaseMs: 10,
    sendRetryBaseMs: 10,
    sendRetryMaxMs: 50,
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

  // Rich text pasted into Telegram arrives as text plus entities.
  test('a formatted message is delivered as its text, and the log names it without the text', async () => {
    await startHub()
    const a = await enabled('a')
    const text = '# План\n\nСначала **v2g1**, потом `cleanup`.'
    const entities = [
      { type: 'bold', offset: 0, length: 6 },
      { type: 'bold', offset: 17, length: 4 },
      { type: 'code', offset: 29, length: 7 },
    ]
    const u = topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text, extra: { entities } })
    fake.pushUpdate(u)
    expect((await a.next(m => m.type === 'inbound')).content).toBe(text)
    const line = log.lines.find(l => l.includes(`message ${u.message!.message_id}`))
    expect(line).toBe(`INFO message ${u.message!.message_id} in topic 100 → session a: text, ${text.length} chars, entities bold, code`)
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

  // The plugin decides what goes out: only it knows the text was written while
  // the mode was on, even if the hub turned the mode off meanwhile.
  test('text sent after the mode was turned off is still delivered', async () => {
    await startHub()
    const a = await enabled('a')
    await req(a, { op: 'disable' })
    a.send({ type: 'send', id: 'x1', text: 'written while on', notify: false })
    await waitFor(() => fake.callsOf('sendMessage').length === 1)
    expect(fake.callsOf('sendMessage')[0]).toMatchObject({ text: 'written while on' })
  })

  test('text for a session without a topic is acked, logged and not sent', async () => {
    await startHub()
    const a = await plugin('a')
    a.send({ type: 'send', id: 'x1', text: 'nowhere', notify: false })
    await a.next(m => m.type === 'ack' && m.id === 'x1')
    expect(fake.callsOf('sendMessage').length).toBe(0)
    expect(log.lines.some(l => l.startsWith('WARN') && l.includes('nowhere'))).toBe(true)
  })

  test('text carrying a session id goes to that session, not to the current one of the window', async () => {
    await startHub()
    const a = await enabled('a')
    a.send({ type: 'session', sessionId: 'a2', cwd: CWD })
    await waitFor(() => hub.isConnected('a2'))
    a.send({ type: 'send', id: 'x1', sessionId: 'a', text: 'old session text', notify: false })
    await waitFor(() => fake.callsOf('sendMessage').length === 1)
    expect(fake.callsOf('sendMessage')[0]).toMatchObject({ message_thread_id: 100, text: 'old session text' })
  })

  test('text queued while enabled is delivered even if terminal input follows while an earlier send is retrying', async () => {
    await startHub()
    const a = await enabled('a')
    fake.failNext('sendMessage', { code: 429, description: 'Too Many Requests', retry_after: 1 })
    a.send({ type: 'send', id: 'x1', text: 'first', notify: false })
    a.send({ type: 'send', id: 'x2', text: 'final', notify: false })
    a.send({ type: 'terminalInput' })
    await waitFor(() => fake.callsOf('sendMessage').length === 3, 5000, 'both delivered')
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

describe('delivery', () => {
  const texts = () => fake.callsOf('sendMessage').map(p => p.text)

  test('the plugin gets its ack once the text is on disk, before Telegram answers', async () => {
    await startHub()
    const a = await enabled('a')
    fake.hangNext('sendMessage', 1000)
    a.send({ type: 'send', id: 'x1', text: 'kept safe', notify: false })
    await a.next(m => m.type === 'ack' && m.id === 'x1')
    expect(readFileSync(join(dir, 'outbox.json'), 'utf8')).toContain('kept safe')
  })

  test('an outage longer than the API retries delays the text but keeps it and its order', async () => {
    await startHub()
    const a = await enabled('a')
    for (let i = 0; i < 7; i++) fake.failNext('sendMessage', { code: 502, description: 'Bad Gateway' })
    a.send({ type: 'send', id: 'x1', text: 'first', notify: false })
    a.send({ type: 'send', id: 'x2', text: 'second', notify: true })
    await waitFor(() => texts().includes('second'), 5000, 'second delivered')
    expect(texts()).toEqual([...Array(8).fill('first'), 'second'])
    expect(fake.callsOf('sendMessage').at(-1)).toMatchObject({ disable_notification: false })
    expect(log.lines.some(l => l.startsWith('INFO') && l.includes('works again'))).toBe(true)
  })

  test('a dead network is waited out', async () => {
    await startHub()
    const a = await enabled('a')
    fake.hangNext('sendMessage', 6)
    a.send({ type: 'send', id: 'x1', text: 'patience', notify: false })
    await waitFor(() => fake.callsOf('sendMessage').length === 7, 8000, 'delivered after the hangs')
    await Bun.sleep(100)
    expect(fake.callsOf('sendMessage').length).toBe(7)
  })

  test('a restarted hub sends what the previous one had queued', async () => {
    await startHub()
    const a = await enabled('a')
    fake.hangNext('sendMessage', 1000)
    a.send({ type: 'send', id: 'x1', text: 'survivor', notify: true })
    await a.next(m => m.type === 'ack' && m.id === 'x1')
    a.close()
    await hub.stop()
    fake.stop()
    fake = new FakeTelegram()
    await startHub()
    await waitFor(() => texts().includes('survivor'), 3000, 'delivery by the new hub')
    expect(fake.callsOf('sendMessage')[0]).toMatchObject({ message_thread_id: 100, disable_notification: false })
  })

  test('a text re-sent by a plugin after reconnecting is not delivered twice', async () => {
    await startHub()
    const a = await enabled('a')
    a.send({ type: 'send', id: 'x1', text: 'once', notify: false })
    await a.next(m => m.type === 'ack' && m.id === 'x1')
    a.send({ type: 'send', id: 'x1', text: 'once', notify: false })
    await waitFor(() => a.messages.filter(m => m.type === 'ack' && m.id === 'x1').length === 2)
    await Bun.sleep(100)
    expect(texts()).toEqual(['once'])
  })

  test('a text Telegram rejects is logged and replaced in the topic by a loud notice', async () => {
    await startHub()
    const a = await enabled('a')
    fake.failNext('sendMessage', { code: 400, description: 'Bad Request: message text is empty' })
    a.send({ type: 'send', id: 'x1', text: 'odd words', notify: false })
    a.send({ type: 'send', id: 'x2', text: 'after', notify: false })
    await waitFor(() => texts().includes('after'), 3000)
    expect(log.lines.some(l => l.startsWith('ERROR') && l.includes('odd words') && l.includes('message text is empty'))).toBe(true)
    const sent = fake.callsOf('sendMessage')
    expect(sent.map(p => p.text)).toEqual(['odd words', '⚠️ Telegram не принял сообщение: Bad Request: message text is empty. Текст в hub.log.', 'after'])
    expect(sent[1].disable_notification).toBe(false)
  })

  test('a bot thrown out of the group keeps the text queued until it is back', async () => {
    await startHub()
    const a = await enabled('a')
    fake.failNext('sendMessage', { code: 403, description: 'Forbidden: bot was kicked from the supergroup chat' })
    fake.failNext('sendMessage', { code: 400, description: 'Bad Request: chat not found' })
    a.send({ type: 'send', id: 'x1', text: 'waiting', notify: false })
    await waitFor(() => fake.callsOf('sendMessage').length === 3, 3000)
    expect(texts()).toEqual(['waiting', 'waiting', 'waiting'])
    expect(log.lines.some(l => l.startsWith('WARN') && l.includes('kicked'))).toBe(true)
    expect(log.lines.some(l => l.includes('⚠️'))).toBe(false)
  })

  test('the hub does not exit while its queue is not delivered', async () => {
    await startHub({ idleMs: 100 })
    const a = await enabled('a')
    fake.hangNext('sendMessage', 4)
    a.send({ type: 'send', id: 'x1', text: 'last words', notify: true })
    await a.next(m => m.type === 'ack' && m.id === 'x1')
    a.close()
    await Bun.sleep(400)
    expect(exited).toBe(false)
    await waitFor(() => exited, 8000, 'exit after delivery')
    expect(texts().at(-1)).toBe('last words')
    expect(log.lines.some(l => l.includes('queued'))).toBe(true)
  })

  test('a queue blocked by configuration stays on disk and does not keep the hub alive', async () => {
    new SessionStore(join(dir, 'sessions.json')).set('a', { topicId: 100, title: 'T', project: 'p', enabled: true })
    await startHub({ idleMs: 100, token: false })
    const a = await plugin('a')
    a.send({ type: 'send', id: 'x1', text: 'for later', notify: false })
    await a.next(m => m.type === 'ack' && m.id === 'x1')
    a.close()
    await waitFor(() => exited, 3000, 'idle exit')
    expect(readFileSync(join(dir, 'outbox.json'), 'utf8')).toContain('for later')
  })

  test('text a closing window left in spool/ is delivered and the file removed', async () => {
    await startHub()
    await enabled('a')
    mkdirSync(join(dir, 'spool'), { recursive: true })
    const file = join(dir, 'spool', 'a-1.json')
    writeFileSync(file, JSON.stringify([{ id: 's1', sessionId: 'a', text: 'from the grave', notify: true }]))
    await waitFor(() => texts().includes('from the grave'), 3000)
    expect(fake.callsOf('sendMessage')[0]).toMatchObject({ disable_notification: false })
    expect(existsSync(file)).toBe(false)
  })

  test('an unreadable spool file is set aside and reported', async () => {
    await startHub()
    mkdirSync(join(dir, 'spool'), { recursive: true })
    writeFileSync(join(dir, 'spool', 'bad.json'), '{nope')
    await waitFor(() => log.lines.some(l => l.startsWith('ERROR') && l.includes('bad.json')), 3000)
    expect(existsSync(join(dir, 'spool', 'bad.json'))).toBe(false)
  })
})

describe('formatting', () => {
  test('agent markdown goes as plain text with entities', async () => {
    await startHub()
    const a = await enabled('a')
    a.send({ type: 'send', id: 'x1', text: '## Итог\n\n**готово**, см. `hub.ts`', notify: false })
    await waitFor(() => fake.callsOf('sendMessage').length === 1)
    expect(fake.callsOf('sendMessage')[0]).toMatchObject({
      text: 'Итог\n\nготово, см. hub.ts',
      entities: [
        { type: 'bold', offset: 0, length: 4 },
        { type: 'bold', offset: 6, length: 6 },
        { type: 'code', offset: 18, length: 6 },
      ],
    })
  })

  test('a long formatted text keeps its entities on both sides of the cut', async () => {
    await startHub()
    const a = await enabled('a')
    a.send({ type: 'send', id: 'x1', text: '```\n' + 'z'.repeat(5000) + '\n```', notify: false })
    await waitFor(() => fake.callsOf('sendMessage').length === 2)
    expect(fake.callsOf('sendMessage').map(s => s.entities)).toEqual([[{ type: 'pre', offset: 0, length: 4096 }], [{ type: 'pre', offset: 0, length: 904 }]])
  })

  test('a text Telegram rejects with entities is sent again without them', async () => {
    await startHub()
    const a = await enabled('a')
    fake.failNext('sendMessage', { code: 400, description: "Bad Request: can't parse entities" })
    a.send({ type: 'send', id: 'x1', text: '**bold**', notify: true })
    await waitFor(() => fake.callsOf('sendMessage').length === 2)
    const [first, second] = fake.callsOf('sendMessage')
    expect(first).toMatchObject({ text: 'bold', entities: [{ type: 'bold', offset: 0, length: 4 }] })
    expect(second).toEqual({ chat_id: GROUP, message_thread_id: 100, text: 'bold', disable_notification: false })
    expect(log.lines.some(l => l.startsWith('WARN') && l.includes("can't parse entities"))).toBe(true)
  })

  test("the hub's own texts are not parsed as markdown", async () => {
    await startHub()
    const a = await enabled('a')
    a.send({ type: 'permission', toolName: 'Bash', description: 'rm *.tmp and *.log' })
    await waitFor(() => fake.callsOf('sendMessage').length === 1)
    expect(fake.callsOf('sendMessage')[0].text).toBe('🔐 Нужно подтверждение: Bash — rm *.tmp and *.log')
    expect(fake.callsOf('sendMessage')[0].entities).toBeUndefined()
  })
})

describe('files', () => {
  let n = 0
  // A copy the plugin put into outbox-files/<message id>/.
  const queued = (id: string, name: string, body = `body of ${name}`) => {
    const d = join(dir, 'outbox-files', id)
    mkdirSync(d, { recursive: true })
    const path = join(d, `${n++}-${name}`)
    writeFileSync(path, body)
    return { path, name, size: body.length }
  }
  const sendFiles = (c: { send(o: object): void }, id: string, files: object[], o: { caption?: string; notify?: boolean; sessionId?: string } = {}) =>
    c.send({ type: 'sendFiles', id, sessionId: o.sessionId ?? 'a', files, caption: o.caption ?? '', notify: o.notify ?? false })
  const done = (c: Awaited<ReturnType<typeof plugin>>, id: string) => c.next(m => m.type === 'filesSent' && m.id === id, 5000)
  const sends = () => fake.calls.filter(c => c.method.startsWith('send')).map(c => c.method)

  test('a photo goes with a formatted caption, the plugin hears it is sent, the copy is removed', async () => {
    await startHub()
    const a = await enabled('a')
    const f = queued('f1', 'shot.png')
    sendFiles(a, 'f1', [f], { caption: 'see **this**' })
    await a.next(m => m.type === 'ack' && m.id === 'f1')
    expect(await done(a, 'f1')).toEqual({ type: 'filesSent', id: 'f1' })
    expect(fake.callsOf('sendPhoto')).toEqual([
      {
        chat_id: GROUP,
        message_thread_id: '100',
        disable_notification: 'true',
        photo: { file: 'shot.png', size: f.size, body: 'body of shot.png' },
        caption: 'see this',
        caption_entities: [{ type: 'bold', offset: 4, length: 4 }],
      },
    ])
    expect(existsSync(join(dir, 'outbox-files', 'f1'))).toBe(false)
  })

  test('albums follow the files, the caption and the sound go with the first send only', async () => {
    await startHub()
    const a = await enabled('a')
    const files = [queued('f1', '1.png'), queued('f1', '2.mp4'), queued('f1', 'a.pdf'), queued('f1', 'b.pdf'), queued('f1', 'clip.gif')]
    sendFiles(a, 'f1', files, { caption: 'cap', notify: true })
    await done(a, 'f1')
    expect(sends()).toEqual(['sendMediaGroup', 'sendMediaGroup', 'sendAnimation'])
    const [visual, docs] = fake.callsOf('sendMediaGroup')
    expect(visual.media).toEqual([
      { type: 'photo', media: 'attach://file0', caption: 'cap' },
      { type: 'video', media: 'attach://file1' },
    ])
    expect(visual.disable_notification).toBe('false')
    expect(docs.media).toEqual([
      { type: 'document', media: 'attach://file0' },
      { type: 'document', media: 'attach://file1' },
    ])
    expect(docs.disable_notification).toBe('true')
    expect(fake.callsOf('sendAnimation')[0]).toMatchObject({ animation: { file: 'clip.gif' }, disable_notification: 'true' })
  })

  test('files keep their place between texts', async () => {
    await startHub()
    const a = await enabled('a')
    a.send({ type: 'send', id: 'x1', text: 'before', notify: false })
    sendFiles(a, 'f1', [queued('f1', 'a.txt')])
    a.send({ type: 'send', id: 'x2', text: 'after', notify: false })
    await waitFor(() => sends().length === 3)
    expect(sends()).toEqual(['sendMessage', 'sendDocument', 'sendMessage'])
    expect(fake.callsOf('sendMessage').map(s => s.text)).toEqual(['before', 'after'])
  })

  test('files re-sent after a reconnect are not sent twice, and the plugin still hears they are sent', async () => {
    await startHub()
    const a = await enabled('a')
    const f = queued('f1', 'a.txt')
    sendFiles(a, 'f1', [f])
    await done(a, 'f1')
    a.messages.length = 0
    sendFiles(a, 'f1', [f])
    expect(await done(a, 'f1')).toEqual({ type: 'filesSent', id: 'f1' })
    expect(fake.callsOf('sendDocument').length).toBe(1)
  })

  test('a session without a topic gets an error and the copies are removed', async () => {
    await startHub()
    const a = await plugin('a')
    sendFiles(a, 'f1', [queued('f1', 'a.txt')])
    expect((await done(a, 'f1')).error).toContain('tg_enable')
    expect(existsSync(join(dir, 'outbox-files', 'f1'))).toBe(false)
    expect(sends()).toEqual([])
  })

  test('a path outside outbox-files is refused and left alone', async () => {
    await startHub()
    const a = await enabled('a')
    const outside = join(dir, 'precious.txt')
    writeFileSync(outside, 'keep me')
    sendFiles(a, 'f1', [{ path: outside, name: 'precious.txt', size: 7 }])
    expect((await done(a, 'f1')).error).toContain('outbox-files')
    expect(readFileSync(outside, 'utf8')).toBe('keep me')
    expect(sends()).toEqual([])
    expect(log.lines.some(l => l.startsWith('ERROR') && l.includes('precious.txt'))).toBe(true)
  })

  test('photos Telegram rejects go again as documents, other files of the album as they were', async () => {
    await startHub()
    const a = await enabled('a')
    fake.failNext('sendMediaGroup', { code: 400, description: 'Bad Request: PHOTO_INVALID_DIMENSIONS' })
    sendFiles(a, 'f1', [queued('f1', 'tall.png'), queued('f1', 'clip.mp4')], { caption: 'cap', notify: true })
    expect(await done(a, 'f1')).toEqual({ type: 'filesSent', id: 'f1' })
    expect(sends()).toEqual(['sendMediaGroup', 'sendDocument', 'sendVideo'])
    expect(fake.callsOf('sendDocument')[0]).toMatchObject({ document: { file: 'tall.png' }, caption: 'cap', disable_notification: 'false' })
    expect(fake.callsOf('sendVideo')[0]).toMatchObject({ video: { file: 'clip.mp4' }, disable_notification: 'true' })
    expect(fake.callsOf('sendVideo')[0].caption).toBeUndefined()
    expect(log.lines.some(l => l.startsWith('WARN') && l.includes('as documents'))).toBe(true)
  })

  // A real clip the plugin put into outbox-files/<message id>/.
  const video = (id: string, name: string) => {
    const d = join(dir, 'outbox-files', id)
    mkdirSync(d, { recursive: true })
    const path = join(d, `${n++}-${name}`)
    makeVideo(path, { width: 640, height: 360, seconds: 3 })
    return { path, name, size: Bun.file(path).size }
  }
  const thumbPart = { file: 'thumbnail.jpg', size: expect.any(Number), body: expect.any(String) }
  const videoFields = { width: 640, height: 360, duration: 3, supports_streaming: true }

  test.skipIf(!hasFfmpeg)('a video goes with its size, duration, streaming and a thumbnail, which is removed with the copy', async () => {
    await startHub()
    const a = await enabled('a')
    sendFiles(a, 'f1', [video('f1', 'clip.mp4')], { caption: 'cap' })
    expect(await done(a, 'f1')).toEqual({ type: 'filesSent', id: 'f1' })
    const [sent] = fake.callsOf('sendVideo')
    expect(sent.thumbnail.size).toBeLessThan(200 * 1024)
    expect(sent).toMatchObject({ video: { file: 'clip.mp4' }, caption: 'cap', width: '640', height: '360', duration: '3', supports_streaming: 'true', thumbnail: thumbPart })
    expect(existsSync(join(dir, 'outbox-files', 'f1'))).toBe(false)
  })

  test.skipIf(!hasFfmpeg)('a video in an album has its fields and its thumbnail attached', async () => {
    await startHub()
    const a = await enabled('a')
    sendFiles(a, 'f1', [queued('f1', '1.png'), video('f1', 'clip.mp4')], { caption: 'cap' })
    await done(a, 'f1')
    const [album] = fake.callsOf('sendMediaGroup')
    expect(album.media).toEqual([
      { type: 'photo', media: 'attach://file0', caption: 'cap' },
      { type: 'video', media: 'attach://file1', ...videoFields, thumbnail: 'attach://thumb1' },
    ])
    expect(album).toMatchObject({ file1: { file: 'clip.mp4' }, thumb1: thumbPart })
    expect(album.thumb0).toBeUndefined()
    expect(existsSync(join(dir, 'outbox-files', 'f1'))).toBe(false)
  })

  test.skipIf(!hasFfmpeg)('a video split off an album Telegram rejected keeps its metadata', async () => {
    await startHub()
    const a = await enabled('a')
    fake.failNext('sendMediaGroup', { code: 400, description: 'Bad Request: PHOTO_INVALID_DIMENSIONS' })
    sendFiles(a, 'f1', [queued('f1', 'tall.png'), video('f1', 'clip.mp4')])
    expect(await done(a, 'f1')).toEqual({ type: 'filesSent', id: 'f1' })
    expect(sends()).toEqual(['sendMediaGroup', 'sendDocument', 'sendVideo'])
    expect(fake.callsOf('sendVideo')[0]).toMatchObject({ video: { file: 'clip.mp4' }, width: '640', height: '360', duration: '3', supports_streaming: 'true', thumbnail: thumbPart })
    expect(existsSync(join(dir, 'outbox-files', 'f1'))).toBe(false)
  })

  test('without ffprobe and ffmpeg a video is sent as before, with a warning', async () => {
    await startHub({ videoTools: { ffprobe: 'no-such-ffprobe', ffmpeg: 'no-such-ffmpeg' } })
    const a = await enabled('a')
    const f = queued('f1', 'clip.mp4')
    sendFiles(a, 'f1', [f])
    expect(await done(a, 'f1')).toEqual({ type: 'filesSent', id: 'f1' })
    expect(fake.callsOf('sendVideo')).toEqual([{ chat_id: GROUP, message_thread_id: '100', disable_notification: 'true', video: { file: 'clip.mp4', size: f.size, body: 'body of clip.mp4' } }])
    expect(log.lines.some(l => l.startsWith('WARN') && l.includes('clip.mp4'))).toBe(true)
  })

  test('files Telegram rejects are reported to the plugin and in the topic, and their copies removed', async () => {
    await startHub()
    const a = await enabled('a')
    fake.failNext('sendDocument', { code: 400, description: 'Bad Request: file is too big' })
    sendFiles(a, 'f1', [queued('f1', 'huge.bin')])
    expect((await done(a, 'f1')).error).toBe('huge.bin: Bad Request: file is too big')
    expect(fake.callsOf('sendMessage').map(s => s.text)).toEqual(['⚠️ Telegram не принял файл huge.bin: Bad Request: file is too big'])
    expect(existsSync(join(dir, 'outbox-files', 'f1'))).toBe(false)
    expect(log.lines.some(l => l.startsWith('ERROR') && l.includes('huge.bin'))).toBe(true)
  })

  test('a copy gone from disk is reported like a rejection, not retried forever', async () => {
    await startHub()
    const a = await enabled('a')
    const gone = { path: join(dir, 'outbox-files', 'f1', '0-gone.png'), name: 'gone.png', size: 3 }
    sendFiles(a, 'f1', [gone])
    expect((await done(a, 'f1')).error).toContain('gone.png')
    expect(fake.callsOf('sendMessage')[0].text).toStartWith('⚠️ Telegram не принял файл gone.png')
    expect(sends()).toEqual(['sendMessage'])
  })

  test('files a closing window left in spool/ are sent', async () => {
    await startHub()
    await enabled('a')
    const f = queued('f1', 'a.txt')
    mkdirSync(join(dir, 'spool'), { recursive: true })
    writeFileSync(join(dir, 'spool', 'a-1.json'), JSON.stringify([{ type: 'sendFiles', id: 'f1', sessionId: 'a', files: [f], caption: '', notify: false }]))
    await waitFor(() => fake.callsOf('sendDocument').length === 1, 3000, 'document sent')
  })

  test('a restarted hub sends the files the previous one had queued and tells the plugin', async () => {
    await startHub()
    const a = await enabled('a')
    fake.hangNext('sendDocument', 100)
    sendFiles(a, 'f1', [queued('f1', 'a.txt')])
    await a.next(m => m.type === 'ack' && m.id === 'f1')
    await hub.stop()
    fake.clearHangs()
    await startHub()
    const b = await plugin('a')
    expect(await done(b, 'f1')).toEqual({ type: 'filesSent', id: 'f1' })
    expect(existsSync(join(dir, 'outbox-files', 'f1'))).toBe(false)
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
    const second = new Hub({ port, sessionsFile: join(dir, 's2.json'), outboxFile: join(dir, 'o2.json'), filesDir: join(dir, 'f2'), inboxDir: dir, api: undefined, config: () => config, idleMs: 1000, log, onExit() {} })
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
    // The line is logged before getUpdates reaches the fake.
    await waitFor(() => fake.callsOf('getUpdates').length > 0, 3000, 'getUpdates after getMe')
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

describe('commands', () => {
  const USAGE: Usage = {
    context: { tokens: 128_400, window: 1_000_000, breakdown: { totalTokens: 130_000, rawMaxTokens: 333_000, autoCompactThreshold: 300_000, isAutoCompactEnabled: true } },
    rateLimits: [{ kind: 'five_hour', percentUsed: 30 }],
  }

  // The mod of one window, with the engine faked: what it ran, and what
  // `run` answers.
  function mod(sessionId: string, answer: (command: string, args: string) => Promise<{ text?: string }> = async () => ({})) {
    const ran: [string, string][] = []
    const runner = new Runner(`http://127.0.0.1:${port}`, {
      sessionId: async () => sessionId,
      usage: async () => USAGE,
      run: (command, args) => {
        ran.push([command, args])
        return answer(command, args)
      },
      http: async (url, init) => {
        const r = await fetch(url, init)
        return { status: r.status, text: await r.text() }
      },
      now: () => Date.now(),
    })
    return { runner, ran }
  }

  const command = (text: string, threadId = 100) => fake.pushUpdate(topicMsg({ chatId: GROUP, threadId, fromId: ME, text }))
  const sentText = (pred: (t: string) => boolean) => fake.callsOf('sendMessage').find(p => pred(p.text))
  // Polls like the mod's timer until the topic gets the text.
  const reply = (runner: Runner, pred: (t: string) => boolean) =>
    waitFor(
      async () => {
        await runner.poll()
        return sentText(pred)
      },
      3000,
      'command reply',
    )

  test('/info is answered by the mod with sound, never reaches the agent and leaves the mode as it was', async () => {
    await startHub()
    const a = await enabled('a')
    await req(a, { op: 'disable' })
    const { runner } = mod('a')
    command('/info')
    const sent = await reply(runner, t => t.startsWith('Лимиты'))
    expect(sent).toMatchObject({ message_thread_id: 100, disable_notification: false })
    expect(sent.text).toContain('Сейчас: 128k токенов')
    expect(sent.entities[0]).toMatchObject({ type: 'bold', offset: 0, length: 6 })
    expect(a.messages.some(m => m.type === 'inbound')).toBe(false)
    expect(new SessionStore(join(dir, 'sessions.json')).get('a')?.enabled).toBe(false)
  })

  test('a command goes to the mod of its own session only', async () => {
    await startHub()
    await enabled('a')
    await enabled('b')
    const a = mod('a')
    const b = mod('b')
    command('/compact 200k', 101)
    await waitFor(async () => {
      await a.runner.poll()
      await b.runner.poll()
      return b.ran.length
    })
    expect(b.ran).toEqual([['autocompact', '200000']])
    expect(a.ran).toEqual([])
  })

  test('a command for another bot and unknown commands reach the agent as text', async () => {
    await startHub()
    const a = await enabled('a')
    command('/info@other_bot')
    command('/start')
    await waitFor(() => a.messages.filter(m => m.type === 'inbound').length === 2)
    expect(a.messages.filter(m => m.type === 'inbound').map(m => m.content)).toEqual(['/info@other_bot', '/start'])
  })

  test('a command nobody picks up is reported in the topic', async () => {
    await startHub({ commandPickupMs: 150 })
    await enabled('a')
    command('/info')
    const sent = await waitFor(() => sentText(t => t.startsWith('⚠️')))
    expect(sent.text).toBe('⚠️ /info не выполнена: окно не забрало её за 0.15 с. Команды выполняет модуль плагина — перезапусти окно.')
    expect(sent.disable_notification).toBe(false)
    // Picked up too late, it is not run.
    const { runner, ran } = mod('a')
    await runner.poll()
    expect(ran).toEqual([])
  })

  test('/compact runs the compact command, says so silently and reports the result from the compaction', async () => {
    await startHub()
    await enabled('a')
    const { runner, ran } = mod('a')
    command('/compact keep the plan')
    const started = await reply(runner, t => t.startsWith('🗜'))
    expect(started.disable_notification).toBe(true)
    expect(ran).toEqual([['compact', 'keep the plan']])
    await runner.compacted({ tokensBefore: 180_000, tokensAfter: 24_000 })
    const done = await reply(runner, t => t.startsWith('✅'))
    expect(done.text).toBe('✅ Контекст сжат: 180k → 24k токенов.')
    expect(done.disable_notification).toBe(false)
    // A later compaction nobody asked for from Telegram is not reported.
    await runner.compacted({ tokensBefore: 300_000, tokensAfter: 20_000 })
    await runner.poll()
    expect(fake.callsOf('sendMessage').filter(p => p.text.startsWith('✅')).length).toBe(1)
  })

  test('a skipped compaction gives the reason', async () => {
    await startHub()
    await enabled('a')
    const { runner } = mod('a')
    command('/compact')
    await reply(runner, t => t.startsWith('🗜'))
    await runner.compacted({ skip: 'a hook vetoed it' })
    expect((await reply(runner, t => t.startsWith('⚠️'))).text).toBe('⚠️ Компакт пропущен: a hook vetoed it')
  })

  test('a compact command that ends with its own text and no compaction reports that text', async () => {
    await startHub()
    await enabled('a')
    const { runner } = mod('a', async () => ({ text: 'Not enough messages to compact.' }))
    command('/compact')
    expect((await reply(runner, t => t.startsWith('Компакт:'))).text).toBe('Компакт: Not enough messages to compact.')
  })

  test('a compact command that fails to start gives the reason', async () => {
    await startHub()
    await enabled('a')
    const { runner } = mod('a', async () => {
      throw new Error('no session is bound')
    })
    command('/compact')
    expect((await reply(runner, t => t.startsWith('⚠️'))).text).toBe('⚠️ Компакт не запустился: no session is bound')
  })

  test('/compact N sets the autocompact window and answers with the text of the command', async () => {
    await startHub()
    await enabled('a')
    const { runner, ran } = mod('a', async () => ({ text: 'Auto-compact window set to 333k tokens' }))
    command('/compact 333k')
    const sent = await reply(runner, t => t.startsWith('Auto-compact'))
    expect(ran).toEqual([['autocompact', '333000']])
    expect(sent.disable_notification).toBe(false)
  })

  test('a reply the mod could not deliver goes with the next poll, once', async () => {
    await startHub()
    await enabled('a')
    let down = true
    const ran: string[] = []
    const runner = new Runner(`http://127.0.0.1:${port}`, {
      sessionId: async () => 'a',
      usage: async () => USAGE,
      run: async () => ({}),
      http: async (url, init) => {
        ran.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`)
        if (init?.method === 'POST' && down) throw new Error('connection refused')
        const r = await fetch(url, init)
        return { status: r.status, text: await r.text() }
      },
      now: () => Date.now(),
    })
    command('/info')
    await waitFor(async () => {
      await runner.poll()
      return ran.includes('POST /reply')
    })
    down = false
    await reply(runner, t => t.startsWith('Лимиты'))
    await runner.poll()
    await runner.poll()
    expect(fake.callsOf('sendMessage').filter(p => p.text.startsWith('Лимиты')).length).toBe(1)
  })

  test('the same reply posted twice is sent once', async () => {
    await startHub()
    await enabled('a')
    const post = () => fetch(`http://127.0.0.1:${port}/reply`, { method: 'POST', body: JSON.stringify({ sessionId: 'a', id: 'c1.0', text: 'once', notify: true }) })
    expect((await post()).status).toBe(200)
    expect((await post()).status).toBe(200)
    await waitFor(() => sentText(t => t === 'once'))
    await Bun.sleep(100)
    expect(fake.callsOf('sendMessage').filter(p => p.text === 'once').length).toBe(1)
  })

  test('the hub puts the commands into the bot menu', async () => {
    await startHub()
    const call = await waitFor(() => fake.callsOf('setMyCommands')[0])
    expect(call.commands.map((c: { command: string }) => c.command)).toEqual(['info', 'compact'])
  })
})
