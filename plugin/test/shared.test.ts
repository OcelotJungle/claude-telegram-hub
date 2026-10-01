import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { chunk } from '../src/shared/chunk.ts'
import { loadConfig, loadToken, paths } from '../src/shared/config.ts'
import { tempDir } from './helpers.ts'

describe('chunk', () => {
  test('short text is one piece', () => {
    expect(chunk('hello')).toEqual(['hello'])
  })

  test('empty text gives no pieces', () => {
    expect(chunk('')).toEqual([])
  })

  test('long text is split into pieces within the limit', () => {
    const text = 'abcdefghij'.repeat(1000)
    const pieces = chunk(text, 4096)
    expect(pieces.length).toBe(3)
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(4096)
    expect(pieces.join('')).toBe(text)
  })

  test('prefers a paragraph boundary past half the limit', () => {
    const a = 'a'.repeat(70)
    const b = 'b'.repeat(50)
    expect(chunk(`${a}\n\n${b}`, 100)).toEqual([a, b])
  })

  test('falls back to a line break, then a space', () => {
    expect(chunk(`${'a'.repeat(70)}\n${'b'.repeat(50)}`, 100)).toEqual(['a'.repeat(70), 'b'.repeat(50)])
    expect(chunk(`${'a'.repeat(70)} ${'b'.repeat(50)}`, 100)).toEqual(['a'.repeat(70), 'b'.repeat(50)])
  })

  test('never yields whitespace-only pieces', () => {
    const pieces = chunk(`${'a'.repeat(60)}\n\n\n\n${'b'.repeat(60)}`, 100)
    expect(pieces).toEqual(['a'.repeat(60), 'b'.repeat(60)])
  })
})

describe('config', () => {
  let dir: string
  const saved = { ...process.env }

  beforeEach(() => {
    dir = tempDir()
    process.env.TG_HUB_STATE_DIR = dir
    delete process.env.TELEGRAM_BOT_TOKEN
  })
  afterEach(() => {
    process.env = { ...saved }
  })

  test('paths live in the state dir', () => {
    const p = paths()
    expect(p.stateDir).toBe(dir)
    expect(p.configFile).toBe(join(dir, 'config.json'))
    expect(p.sessionsFile).toBe(join(dir, 'sessions.json'))
    expect(p.inboxDir).toBe(join(dir, 'inbox'))
  })

  test('token is read from .env, CRLF tolerated', () => {
    writeFileSync(join(dir, '.env'), 'OTHER=1\r\nTELEGRAM_BOT_TOKEN=123:abc\r\n')
    expect(loadToken()).toBe('123:abc')
  })

  test('real env token wins over .env', () => {
    writeFileSync(join(dir, '.env'), 'TELEGRAM_BOT_TOKEN=123:abc\n')
    process.env.TELEGRAM_BOT_TOKEN = '999:zzz'
    expect(loadToken()).toBe('999:zzz')
  })

  test('missing token is undefined', () => {
    expect(loadToken()).toBeUndefined()
  })

  test('config coerces numeric ids to strings', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ groupId: -1001234, allowFrom: [123456789] }))
    expect(loadConfig()).toEqual({ groupId: '-1001234', allowFrom: ['123456789'] })
  })

  test('missing or corrupt config gives empty allowFrom', () => {
    expect(loadConfig()).toEqual({ allowFrom: [] })
    writeFileSync(join(dir, 'config.json'), '{not json')
    expect(loadConfig()).toEqual({ allowFrom: [] })
  })
})
