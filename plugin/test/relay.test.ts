import { describe, expect, test } from 'bun:test'
import { NOTIFY_MARKER, Relay } from '../src/transcript/relay.ts'
import type { TranscriptEvent } from '../src/transcript/parse.ts'

const own = (name: string) => /(^|__)tg_(enable|disable|notify)$/.test(name)
const text = (t: string, m = 'm1'): TranscriptEvent => ({ kind: 'text', text: t, messageId: m })
const tool = (name: string, m = 'm1'): TranscriptEvent => ({ kind: 'tool_use', name, messageId: m })
const end = (m: string): TranscriptEvent => ({ kind: 'turn_end', messageId: m })

function enabledRelay() {
  const r = new Relay({ isOwnTool: own })
  r.setEnabled(true)
  return r
}

function run(r: Relay, events: TranscriptEvent[]) {
  const out = []
  for (const e of events) out.push(...r.feed(e))
  out.push(...r.idle())
  return out
}

describe('relay', () => {
  test('text before a tool call is sent silently right away', () => {
    const r = enabledRelay()
    expect(r.feed(text('looking'))).toEqual([])
    expect(r.feed(tool('Bash'))).toEqual([{ text: 'looking', notify: false }])
  })

  test('final text waits for the turn end and is silent without tg_notify', () => {
    const r = enabledRelay()
    const out = run(r, [text('A', 'm1'), tool('Bash', 'm1'), text('B', 'm2'), end('m2')])
    expect(out).toEqual([
      { text: 'A', notify: false },
      { text: 'B', notify: false },
    ])
  })

  test('final text is not sent before idle', () => {
    const r = enabledRelay()
    expect(r.feed(text('B', 'm2'))).toEqual([])
    expect(r.feed(end('m2'))).toEqual([])
    expect(r.idle()).toEqual([{ text: 'B', notify: false }])
  })

  test('turn_end from the thinking record before the text record keeps the text final', () => {
    const r = enabledRelay()
    r.markNotify()
    expect(r.feed(end('m2'))).toEqual([])
    expect(r.feed(text('final', 'm2'))).toEqual([])
    expect(r.feed(end('m2'))).toEqual([])
    expect(r.idle()).toEqual([{ text: 'final', notify: true }])
  })

  test('tg_notify makes the final text notify', () => {
    const r = enabledRelay()
    r.markNotify()
    expect(run(r, [text('done', 'm2'), end('m2')])).toEqual([{ text: 'done', notify: true }])
  })

  test('own tool call between text and turn end keeps the text final', () => {
    const r = enabledRelay()
    const out = run(r, [text('summary', 'm1'), tool('mcp__plugin_tg-hub_tg-hub__tg_notify', 'm1')])
    expect(out).toEqual([])
    r.markNotify()
    expect(run(r, [end('m2')])).toEqual([{ text: 'summary', notify: true }])
  })

  test('two texts in one message: first silent, second final', () => {
    const r = enabledRelay()
    expect(run(r, [text('one', 'm1'), text('two', 'm1'), end('m1')])).toEqual([
      { text: 'one', notify: false },
      { text: 'two', notify: false },
    ])
  })

  test('a repeated turn_end for the same message is handled once', () => {
    const r = enabledRelay()
    r.markNotify()
    expect(run(r, [end('m1')])).toEqual([{ text: NOTIFY_MARKER, notify: true }])
    expect(run(r, [end('m1')])).toEqual([])
  })

  test('tg_notify without any final text sends the marker with sound', () => {
    const r = enabledRelay()
    run(r, [text('progress', 'm1'), tool('Bash', 'm1')])
    r.markNotify()
    expect(run(r, [end('m2')])).toEqual([{ text: NOTIFY_MARKER, notify: true }])
  })

  test('a turn end without notify and without text sends nothing', () => {
    const r = enabledRelay()
    expect(run(r, [end('m1')])).toEqual([])
  })

  test('an event from another message finishes the pending turn first', () => {
    const r = enabledRelay()
    expect(r.feed(text('final', 'm1'))).toEqual([])
    expect(r.feed(end('m1'))).toEqual([])
    expect(r.feed(text('next turn', 'm2'))).toEqual([{ text: 'final', notify: false }])
  })

  test('terminal input finishes the pending turn first', () => {
    const r = enabledRelay()
    r.feed(text('final', 'm1'))
    r.feed(end('m1'))
    expect(r.feed({ kind: 'terminal_input' })).toEqual([{ text: 'final', notify: false }])
  })

  test('notify flag resets after the turn', () => {
    const r = enabledRelay()
    r.markNotify()
    run(r, [text('first', 'm1'), end('m1')])
    expect(run(r, [text('second', 'm2'), end('m2')])).toEqual([{ text: 'second', notify: false }])
  })

  test('disabled relay drops everything', () => {
    const r = new Relay({ isOwnTool: own })
    r.markNotify()
    expect(run(r, [text('A'), tool('Bash'), text('B', 'm2'), end('m2')])).toEqual([])
  })

  test('enabling mid-turn relays only later text', () => {
    const r = new Relay({ isOwnTool: own })
    r.feed(text('before'))
    r.setEnabled(true)
    expect(r.feed(tool('mcp__plugin_tg-hub_tg-hub__tg_enable'))).toEqual([])
    expect(run(r, [text('after', 'm2'), end('m2')])).toEqual([{ text: 'after', notify: false }])
  })

  test('disabling drops the pending text', () => {
    const r = enabledRelay()
    r.feed(text('pending', 'm1'))
    r.setEnabled(false)
    expect(run(r, [end('m1')])).toEqual([])
  })

  test('title and terminal input alone produce nothing', () => {
    const r = enabledRelay()
    expect(r.feed({ kind: 'title', source: 'ai', title: 'x' })).toEqual([])
    expect(r.feed({ kind: 'terminal_input' })).toEqual([])
  })
})
