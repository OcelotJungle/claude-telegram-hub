import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { chunk } from '../src/shared/chunk.ts'
import { loadConfig, loadToken, paths } from '../src/shared/config.ts'
import { tempDir } from './helpers.ts'

describe('chunk', () => {
  const plain = (text: string) => ({ text, entities: [] })
  const texts = (text: string, limit?: number) => chunk(plain(text), limit).map(p => p.text)

  test('short text is one piece', () => {
    expect(chunk(plain('hello'))).toEqual([plain('hello')])
  })

  test('empty text gives no pieces', () => {
    expect(chunk(plain(''))).toEqual([])
  })

  test('long text is split into pieces within the limit', () => {
    const text = 'abcdefghij'.repeat(1000)
    const pieces = texts(text, 4096)
    expect(pieces.length).toBe(3)
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(4096)
    expect(pieces.join('')).toBe(text)
  })

  test('prefers a paragraph boundary past half the limit', () => {
    const a = 'a'.repeat(70)
    const b = 'b'.repeat(50)
    expect(texts(`${a}\n\n${b}`, 100)).toEqual([a, b])
  })

  test('falls back to a line break, then a space', () => {
    expect(texts(`${'a'.repeat(70)}\n${'b'.repeat(50)}`, 100)).toEqual(['a'.repeat(70), 'b'.repeat(50)])
    expect(texts(`${'a'.repeat(70)} ${'b'.repeat(50)}`, 100)).toEqual(['a'.repeat(70), 'b'.repeat(50)])
  })

  test('never yields whitespace-only pieces', () => {
    expect(texts(`${'a'.repeat(60)}\n\n\n\n${'b'.repeat(60)}`, 100)).toEqual(['a'.repeat(60), 'b'.repeat(60)])
  })

  test('never cuts a surrogate pair', () => {
    const pieces = texts('a' + '😀'.repeat(60), 100)
    expect(pieces.join('')).toBe('a' + '😀'.repeat(60))
    for (const p of pieces) expect(p).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/)
  })

  test('entities move with their piece; one on the boundary is split', () => {
    const a = 'a'.repeat(70)
    const b = 'b'.repeat(50)
    const text = `${a}\n\n${b}`
    const pieces = chunk(
      {
        text,
        entities: [
          { type: 'bold', offset: 0, length: 5 },
          { type: 'pre', offset: 60, length: 20, language: 'ts' },
          { type: 'italic', offset: 75, length: 3 },
        ],
      },
      100,
    )
    expect(pieces).toEqual([
      { text: a, entities: [{ type: 'bold', offset: 0, length: 5 }, { type: 'pre', offset: 60, length: 10, language: 'ts' }] },
      // The cut drops "\n\n"; the pre entity keeps its two b's, the italic its three.
      { text: b, entities: [{ type: 'pre', offset: 0, length: 8, language: 'ts' }, { type: 'italic', offset: 3, length: 3 }] },
    ])
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

  // Windows PowerShell 5.1 `>` / Out-File writes UTF-16LE with a BOM; Notepad may add a UTF-8 BOM.
  const utf16le = (s: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')])
  const utf16be = (s: string) => Buffer.from(utf16le(s).swap16())
  const utf8bom = (s: string) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s, 'utf8')])

  test('token is read from .env saved as UTF-16 or with a BOM', () => {
    for (const enc of [utf16le, utf16be, utf8bom]) {
      writeFileSync(join(dir, '.env'), enc('TELEGRAM_BOT_TOKEN=123:abc\r\n'))
      expect(loadToken()).toBe('123:abc')
    }
  })

  test('config.json saved as UTF-16 or with a BOM is read', () => {
    for (const enc of [utf16le, utf8bom]) {
      writeFileSync(join(dir, 'config.json'), enc('{ "groupId": "-1001", "allowFrom": ["1"] }'))
      expect(loadConfig()).toEqual({ groupId: '-1001', allowFrom: ['1'] })
    }
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
