import { beforeEach, describe, expect, test } from 'bun:test'
import { readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Outbox } from '../src/hub/outbox.ts'
import { memLogger, tempDir } from './helpers.ts'

let dir: string
let file: string
let log: ReturnType<typeof memLogger>

beforeEach(() => {
  dir = tempDir()
  file = join(dir, 'outbox.json')
  log = memLogger()
})

const piece = (text: string, silent = true) => ({ text, silent })

describe('Outbox', () => {
  test('pieces of a session come out in order, sessions apart', () => {
    const o = new Outbox(file, log)
    o.add('m1', 'a', [piece('a1'), piece('a2')])
    o.add('m2', 'b', [piece('b1')])
    o.add('m3', 'a', [piece('a3', false)])
    expect(o.sessions().sort()).toEqual(['a', 'b'])
    const seen: string[] = []
    for (let h = o.head('a'); h; h = o.head('a')) {
      seen.push(h.text)
      o.remove(h.id)
    }
    expect(seen).toEqual(['a1', 'a2', 'a3'])
    expect(o.head('b')?.text).toBe('b1')
    expect(o.size).toBe(1)
  })

  test('the queue survives a restart', () => {
    const o = new Outbox(file, log)
    o.add('m1', 'a', [piece('one'), piece('two', false)])
    o.remove(o.head('a')!.id)
    const again = new Outbox(file, log)
    expect(again.head('a')).toMatchObject({ sessionId: 'a', text: 'two', silent: false })
  })

  test('a message id already queued is not queued again, even after a restart', () => {
    const o = new Outbox(file, log)
    expect(o.add('m1', 'a', [piece('x')])).toBe(true)
    expect(o.add('m1', 'a', [piece('x')])).toBe(false)
    o.remove(o.head('a')!.id)
    expect(new Outbox(file, log).add('m1', 'a', [piece('x')])).toBe(false)
    expect(o.size).toBe(0)
  })

  test('a notice takes the place of a piece and is loud', () => {
    const o = new Outbox(file, log)
    o.add('m1', 'a', [piece('bad'), piece('next')])
    o.replaceWithNotice(o.head('a')!.id, '⚠️ notice')
    expect(new Outbox(file, log).head('a')).toMatchObject({ text: '⚠️ notice', silent: false, notice: true })
    expect(o.countOf('a')).toBe(2)
  })

  test('a corrupt file is kept aside and reported, not silently dropped', () => {
    writeFileSync(file, '{oops')
    const o = new Outbox(file, log)
    expect(o.size).toBe(0)
    expect(readdirSync(dir).some(f => f.startsWith('outbox.json.corrupt-'))).toBe(true)
    expect(log.lines.some(l => l.startsWith('ERROR') && l.includes('outbox'))).toBe(true)
  })
})
