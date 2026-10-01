import { describe, expect, test } from 'bun:test'
import { join } from 'path'
import { routeUpdate } from '../src/hub/router.ts'
import { SessionStore } from '../src/hub/sessions.ts'
import type { Update } from '../src/hub/telegram.ts'
import { topicMsg } from './fakeTelegram.ts'
import { tempDir } from './helpers.ts'

const GROUP = '-1001'
const ME = '123456789'
const cfg = { groupId: GROUP, allowFrom: [ME] }

function setup() {
  const store = new SessionStore(join(tempDir(), 'sessions.json'))
  store.set('live', { topicId: 10, title: 't', project: 'p', enabled: false })
  store.set('closed', { topicId: 20, title: 't', project: 'p', enabled: true })
  const connected = new Set(['live'])
  const route = (u: Omit<Update, 'update_id'>, c: { groupId?: string; allowFrom: string[] } = cfg) =>
    routeUpdate({ update_id: 1, ...u } as Update, c, store, id => connected.has(id))
  return { route }
}

describe('routeUpdate', () => {
  test('message in a connected session topic is delivered', () => {
    const { route } = setup()
    expect(route(topicMsg({ chatId: GROUP, threadId: 10, fromId: ME, text: 'hi' }))).toEqual({ action: 'deliver', sessionId: 'live', topicId: 10 })
  })

  test('message in the topic of a session without a window is "inactive"', () => {
    const { route } = setup()
    expect(route(topicMsg({ chatId: GROUP, threadId: 20, fromId: ME, text: 'hi' }))).toEqual({ action: 'inactive', topicId: 20 })
  })

  test('unknown topic is ignored', () => {
    const { route } = setup()
    expect(route(topicMsg({ chatId: GROUP, threadId: 30, fromId: ME, text: 'hi' })).action).toBe('ignore')
  })

  test('General (no thread) is ignored', () => {
    const { route } = setup()
    expect(route(topicMsg({ chatId: GROUP, fromId: ME, text: 'hi' })).action).toBe('ignore')
  })

  test('a reply in General carrying a thread id but not a topic message is ignored', () => {
    const { route } = setup()
    expect(route(topicMsg({ chatId: GROUP, threadId: 10, isTopic: false, fromId: ME, text: 'hi' })).action).toBe('ignore')
  })

  test('another chat is ignored', () => {
    const { route } = setup()
    expect(route(topicMsg({ chatId: '-999', threadId: 10, fromId: ME, text: 'hi' })).action).toBe('ignore')
  })

  test('a private chat with the bot is ignored', () => {
    const { route } = setup()
    const u = topicMsg({ chatId: ME, fromId: ME, text: 'hi' })
    u.message!.chat = { id: Number(ME), type: 'private' }
    expect(route(u).action).toBe('ignore')
  })

  test('a sender outside allowFrom is ignored', () => {
    const { route } = setup()
    expect(route(topicMsg({ chatId: GROUP, threadId: 10, fromId: '42', text: 'hi' })).action).toBe('ignore')
  })

  test('bot senders are ignored', () => {
    const { route } = setup()
    const u = topicMsg({ chatId: GROUP, threadId: 10, fromId: ME, text: 'hi' })
    u.message!.from!.is_bot = true
    expect(route(u).action).toBe('ignore')
  })

  test('service messages without content are ignored', () => {
    const { route } = setup()
    const u = topicMsg({ chatId: GROUP, threadId: 10, fromId: ME, extra: { forum_topic_edited: { name: 'x' } } })
    expect(route(u).action).toBe('ignore')
  })

  test('photo without caption is delivered', () => {
    const { route } = setup()
    const u = topicMsg({ chatId: GROUP, threadId: 10, fromId: ME, extra: { photo: [{ file_id: 'p', file_unique_id: 'u' }] } })
    expect(route(u).action).toBe('deliver')
  })

  test('without groupId everything is ignored', () => {
    const { route } = setup()
    expect(route(topicMsg({ chatId: GROUP, threadId: 10, fromId: ME, text: 'hi' }), { allowFrom: [ME] }).action).toBe('ignore')
  })

  test('update without a message is ignored', () => {
    const { route } = setup()
    expect(route({}).action).toBe('ignore')
  })
})
