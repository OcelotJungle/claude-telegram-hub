import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Hub } from '../src/hub/hub.ts'
import { TelegramApi } from '../src/hub/telegram.ts'
import { PluginCore } from '../src/plugin/plugin.ts'
import { NOTIFY_MARKER } from '../src/transcript/relay.ts'
import type { Config } from '../src/shared/config.ts'
import { FakeTelegram, topicMsg } from './fakeTelegram.ts'
import { freePort, memLogger, tempDir, waitFor } from './helpers.ts'

const GROUP = '-1001'
const ME = '123456789'
const CWD = 'C:\\code\\demo-app'
const SID = 'sess-1'

let fake: FakeTelegram
let hub: Hub
let port: number
let configDir: string
let transcript: string
let config: Config
let core: PluginCore | undefined
let channel: { content: string; meta: Record<string, string> }[]

const line = (o: object) => JSON.stringify(o) + '\n'
const append = (...recs: object[]) => appendFileSync(transcript, recs.map(line).join(''))
let msgN = 0
const assistantText = (text: string, stop: 'tool_use' | 'end_turn', id = `m${++msgN}`) => ({
  type: 'assistant',
  isSidechain: false,
  message: { id, role: 'assistant', content: [{ type: 'text', text }], stop_reason: stop },
})
const assistantTool = (name: string, id: string) => ({
  type: 'assistant',
  isSidechain: false,
  message: { id, role: 'assistant', content: [{ type: 'tool_use', id: 't', name, input: {} }], stop_reason: 'tool_use' },
})
const humanTyped = (text: string) => ({ type: 'user', isSidechain: false, origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: text } })

function sent() {
  return fake.callsOf('sendMessage').map(p => ({ text: p.text, silent: p.disable_notification, topic: p.message_thread_id }))
}

function makeCore(sessionId = SID) {
  core = new PluginCore({
    sessionId,
    cwd: CWD,
    configDir,
    windowKey: 'pipe-1',
    port,
    spawnHub: () => {},
    emitChannel: (content, meta) => channel.push({ content, meta }),
    log: memLogger(),
    tailIntervalMs: 30,
  })
  core.start()
  return core
}

beforeEach(async () => {
  fake = new FakeTelegram()
  port = await freePort()
  const state = tempDir()
  config = { groupId: GROUP, allowFrom: [ME] }
  hub = new Hub({
    port,
    sessionsFile: join(state, 'sessions.json'),
    inboxDir: join(state, 'inbox'),
    api: new TelegramApi({ token: fake.token, base: fake.url, baseDelayMs: 1, maxAttempts: 2 }),
    config: () => config,
    idleMs: 60_000,
    pollTimeoutSec: 1,
    log: memLogger(),
    onExit() {},
  })
  hub.start()
  configDir = tempDir()
  const projDir = join(configDir, 'projects', 'C--code-demo-app')
  mkdirSync(projDir, { recursive: true })
  transcript = join(projDir, `${SID}.jsonl`)
  writeFileSync(transcript, line({ type: 'ai-title', aiTitle: 'Старое имя' }) + line(assistantText('old history', 'end_turn')))
  channel = []
})

afterEach(async () => {
  core?.stop()
  core = undefined
  await hub.stop()
  fake.stop()
})

async function enabledCore() {
  const c = makeCore()
  await waitFor(() => hub.isConnected(SID), 3000, 'plugin connected')
  await c.enable()
  return c
}

describe('PluginCore', () => {
  test('enable creates a topic named from the session title, history is not sent', async () => {
    const c = makeCore()
    const answer = await c.enable()
    expect(answer).toContain('demo-app · Старое имя')
    expect(fake.callsOf('createForumTopic')).toEqual([{ chat_id: GROUP, name: 'demo-app · Старое имя' }])
    await Bun.sleep(150)
    expect(sent()).toEqual([])
  })

  test('intermediate text is silent and the final text is silent without tg_notify', async () => {
    await enabledCore()
    append(assistantText('Смотрю код', 'tool_use', 'a1'), assistantTool('Read', 'a1'), assistantText('Готово', 'end_turn', 'a2'))
    await waitFor(() => sent().length === 2, 3000, 'two messages')
    expect(sent()).toEqual([
      { text: 'Смотрю код', silent: true, topic: 100 },
      { text: 'Готово', silent: true, topic: 100 },
    ])
  })

  test('tg_notify makes the final text loud', async () => {
    const c = await enabledCore()
    append(assistantText('Сводка', 'tool_use', 'b1'), assistantTool('mcp__plugin_tg-hub_tg-hub__tg_notify', 'b1'))
    await Bun.sleep(100)
    expect(c.notify('done')).toContain('notification')
    append(assistantText('Всё сделано', 'end_turn', 'b2'))
    await waitFor(() => sent().length === 2, 3000, 'two messages')
    expect(sent()).toEqual([
      { text: 'Сводка', silent: true, topic: 100 },
      { text: 'Всё сделано', silent: false, topic: 100 },
    ])
  })

  test('tg_notify with no text after it sends the marker loudly', async () => {
    const c = await enabledCore()
    c.notify('ask')
    append({ type: 'assistant', isSidechain: false, message: { id: 'c1', role: 'assistant', content: [{ type: 'thinking', thinking: '' }], stop_reason: 'end_turn' } })
    await waitFor(() => sent().length === 1, 3000, 'marker')
    expect(sent()[0]).toEqual({ text: NOTIFY_MARKER, silent: false, topic: 100 })
  })

  test('typing in the terminal turns the mode off', async () => {
    const c = await enabledCore()
    append(humanTyped('сам продолжу'))
    await waitFor(() => !c.enabled, 3000, 'disabled')
    append(assistantText('ответ в терминал', 'end_turn'))
    await Bun.sleep(200)
    expect(sent()).toEqual([])
  })

  test('the final text of a turn ended right before terminal input is still sent', async () => {
    const c = await enabledCore()
    append(assistantText('итог', 'end_turn', 'd1'), humanTyped('next'))
    await waitFor(() => !c.enabled, 3000, 'disabled')
    await waitFor(() => sent().length === 1, 3000, 'final text')
    expect(sent()[0]!.text).toBe('итог')
  })

  test('a topic message reaches the session and turns the mode back on', async () => {
    const c = await enabledCore()
    await c.disable()
    await waitFor(() => !c.enabled)
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: 'как дела?' }))
    await waitFor(() => channel.length === 1, 3000, 'channel message')
    expect(channel[0]!.content).toBe('как дела?')
    expect(channel[0]!.meta.chat_id).toBe(GROUP)
    await waitFor(() => c.enabled, 3000, 're-enabled')
  })

  test('a permission request is sent loudly while enabled', async () => {
    const c = await enabledCore()
    c.permissionRequest({ tool_name: 'Bash', description: 'git push' })
    await waitFor(() => sent().length === 1)
    expect(sent()[0]).toEqual({ text: '🔐 Нужно подтверждение: Bash — git push', silent: false, topic: 100 })
  })

  test('a rename renames the topic', async () => {
    await enabledCore()
    append({ type: 'agent-name', agentName: 'Новое имя' })
    await waitFor(() => fake.callsOf('editForumTopic').length === 1, 3000, 'rename')
    expect(fake.callsOf('editForumTopic')[0].name).toBe('demo-app · Новое имя')
  })

  test('switching session follows the new transcript', async () => {
    const c = await enabledCore()
    const next = join(configDir, 'projects', 'C--code-demo-app', 'sess-2.jsonl')
    c.switchSession('sess-2', next, CWD)
    await waitFor(() => hub.isConnected('sess-2'), 3000, 'switched')
    writeFileSync(next, line({ type: 'ai-title', aiTitle: 'После clear' }))
    await c.enable()
    expect(fake.callsOf('createForumTopic').at(-1).name).toBe('demo-app · После clear')
    appendFileSync(next, line(assistantText('в новой сессии', 'end_turn')))
    append(assistantText('в старой сессии', 'end_turn'))
    await waitFor(() => sent().length === 1, 3000, 'message')
    await Bun.sleep(150)
    expect(sent()).toEqual([{ text: 'в новой сессии', silent: true, topic: 101 }])
  })

  test('shutdown sends text written just before the window closed', async () => {
    const c = await enabledCore()
    append(assistantText('последнее слово', 'end_turn', 'z1'))
    await c.shutdown(2000)
    core = undefined
    expect(sent()).toEqual([{ text: 'последнее слово', silent: true, topic: 100 }])
  })

  test('tg_notify while the mode is off says so', () => {
    const c = makeCore()
    expect(c.notify('done')).toContain('off')
  })

  test('enable without groupId returns the explanation', async () => {
    config = { allowFrom: [ME] }
    const c = makeCore()
    await expect(c.enable()).rejects.toThrow(/config\.json/)
  })
})
