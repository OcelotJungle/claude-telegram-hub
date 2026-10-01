import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { basename } from 'path'
import { isThreadNotFound, TelegramApi, TelegramError } from '../src/hub/telegram.ts'
import { FakeTelegram, topicMsg } from './fakeTelegram.ts'
import { tempDir } from './helpers.ts'

let fake: FakeTelegram
let api: TelegramApi

beforeEach(() => {
  fake = new FakeTelegram()
  api = new TelegramApi({ token: fake.token, base: fake.url, baseDelayMs: 1, maxAttempts: 3 })
})
afterEach(() => fake.stop())

describe('TelegramApi', () => {
  test('sendMessage targets the topic and maps silent to disable_notification', async () => {
    await api.sendMessage('-100', 7, 'hi', true)
    await api.sendMessage('-100', 7, 'loud', false)
    expect(fake.callsOf('sendMessage')).toEqual([
      { chat_id: '-100', message_thread_id: 7, text: 'hi', disable_notification: true },
      { chat_id: '-100', message_thread_id: 7, text: 'loud', disable_notification: false },
    ])
  })

  test('429 is retried after retry_after', async () => {
    fake.failNext('sendMessage', { code: 429, description: 'Too Many Requests: retry after 0', retry_after: 0 })
    const res = await api.sendMessage('-100', 7, 'hi', true)
    expect(res.message_id).toBeGreaterThan(0)
    expect(fake.callsOf('sendMessage').length).toBe(2)
  })

  test('5xx is retried', async () => {
    fake.failNext('createForumTopic', { code: 502, description: 'Bad Gateway' })
    const t = await api.createForumTopic('-100', 'proj · title')
    expect(t.message_thread_id).toBe(100)
  })

  test('other 4xx errors are thrown without retry', async () => {
    fake.failNext('sendMessage', { code: 400, description: 'Bad Request: chat not found' })
    const err = await api.sendMessage('-100', 7, 'hi', true).catch(e => e)
    expect(err).toBeInstanceOf(TelegramError)
    expect(err.code).toBe(400)
    expect(fake.callsOf('sendMessage').length).toBe(1)
  })

  test('gives up after maxAttempts', async () => {
    for (let i = 0; i < 3; i++) fake.failNext('sendMessage', { code: 500, description: 'Internal' })
    const err = await api.sendMessage('-100', 7, 'hi', true).catch(e => e)
    expect(err).toBeInstanceOf(TelegramError)
    expect(fake.callsOf('sendMessage').length).toBe(3)
  })

  // The Bot API is reachable only now and then from some networks: a connect
  // attempt hangs, the next one may get through, and then the connection is reused.
  describe('flaky network', () => {
    const flaky = (o: object = {}) =>
      new TelegramApi({ token: fake.token, base: fake.url, baseDelayMs: 1, maxAttempts: 2, attemptTimeoutMs: 100, networkRetryMs: 5, ...o })

    test('a hung attempt is abandoned quickly and retried', async () => {
      fake.hangNext('sendMessage')
      const started = Date.now()
      await flaky().sendMessage('-100', 7, 'hi', true)
      expect(Date.now() - started).toBeLessThan(1000)
      expect(fake.callsOf('sendMessage').length).toBe(2)
    })

    test('network failures are retried past maxAttempts until the deadline', async () => {
      fake.hangNext('sendMessage', 4)
      await flaky({ deadlineMs: 5000 }).sendMessage('-100', 7, 'hi', true)
      expect(fake.callsOf('sendMessage').length).toBe(5)
    })

    test('network failures give up at the deadline', async () => {
      const dead = new TelegramApi({ token: 'x', base: 'http://127.0.0.1:1', attemptTimeoutMs: 100, networkRetryMs: 5, deadlineMs: 300 })
      const started = Date.now()
      await expect(dead.sendMessage('-100', 1, 'x', true)).rejects.toThrow()
      expect(Date.now() - started).toBeLessThan(1500)
    })

    test('getUpdates may wait for the long poll beyond the attempt timeout', async () => {
      expect(await flaky().getUpdates(0, 1)).toEqual([])
    })
  })

  test('deleted topic is recognised', async () => {
    fake.deleteTopic(7)
    const err = await api.sendMessage('-100', 7, 'hi', true).catch(e => e)
    expect(isThreadNotFound(err)).toBe(true)
    expect(isThreadNotFound(new Error('x'))).toBe(false)
  })

  test('editForumTopic sends the new name', async () => {
    await api.editForumTopic('-100', 7, 'new')
    expect(fake.callsOf('editForumTopic')).toEqual([{ chat_id: '-100', message_thread_id: 7, name: 'new' }])
  })

  test('getUpdates long-polls until an update arrives', async () => {
    const p = api.getUpdates(0, 2)
    await Bun.sleep(50)
    fake.pushUpdate(topicMsg({ chatId: -100, threadId: 7, fromId: 1, text: 'yo' }))
    const updates = await p
    expect(updates.length).toBe(1)
    expect(updates[0]!.message?.text).toBe('yo')
  })

  test('downloadFile saves into the destination dir with a safe name', async () => {
    fake.files.set('F1', { path: 'photos/file_1.jpg', body: new Uint8Array([1, 2, 3]) })
    const dir = tempDir()
    const path = await api.downloadFile('F1', dir)
    expect(path.startsWith(dir)).toBe(true)
    expect(basename(path)).toMatch(/^\d+-uF1\.jpg$/)
    expect(existsSync(path)).toBe(true)
    expect([...readFileSync(path)]).toEqual([1, 2, 3])
  })
})
