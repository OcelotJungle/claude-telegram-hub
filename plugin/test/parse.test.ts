import { describe, expect, test } from 'bun:test'
import { parseRecord } from '../src/transcript/parse.ts'

// Shapes mirror records observed in Claude Code transcripts.
const assistant = (id: string, stop: string | null, block: object) => ({
  parentUuid: 'p',
  isSidechain: false,
  type: 'assistant',
  message: { model: 'claude-opus-5-5', id, type: 'message', role: 'assistant', content: [block], stop_reason: stop },
  uuid: 'u',
  sessionId: 's',
})
const text = (t: string) => ({ type: 'text', text: t })
const toolUse = (name: string) => ({ type: 'tool_use', id: 'toolu_1', name, input: {} })
const thinking = { type: 'thinking', thinking: 'hmm', signature: 'x' }

const userBase = { parentUuid: 'p', isSidechain: false, type: 'user', uuid: 'u', sessionId: 's' }

describe('assistant records', () => {
  test('text block of a tool_use message is text, no turn end', () => {
    expect(parseRecord(assistant('m1', 'tool_use', text('looking')))).toEqual([
      { kind: 'text', text: 'looking', messageId: 'm1' },
    ])
  })

  test('tool_use block is tool_use', () => {
    expect(parseRecord(assistant('m1', 'tool_use', toolUse('Bash')))).toEqual([
      { kind: 'tool_use', name: 'Bash', messageId: 'm1' },
    ])
  })

  test('thinking is ignored', () => {
    expect(parseRecord(assistant('m1', 'tool_use', thinking))).toEqual([])
  })

  test('end_turn text gives text then turn_end', () => {
    expect(parseRecord(assistant('m2', 'end_turn', text('done')))).toEqual([
      { kind: 'text', text: 'done', messageId: 'm2' },
      { kind: 'turn_end', messageId: 'm2' },
    ])
  })

  test('thinking record of an end_turn message still marks the turn end', () => {
    expect(parseRecord(assistant('m2', 'end_turn', thinking))).toEqual([{ kind: 'turn_end', messageId: 'm2' }])
  })

  test('null stop_reason does not end the turn', () => {
    expect(parseRecord(assistant('m3', null, text('partial')))).toEqual([
      { kind: 'text', text: 'partial', messageId: 'm3' },
    ])
  })

  test('whitespace-only text is dropped', () => {
    expect(parseRecord(assistant('m1', 'tool_use', text('  \n ')))).toEqual([])
  })

  test('sidechain records are ignored', () => {
    expect(parseRecord({ ...assistant('m1', 'end_turn', text('sub')), isSidechain: true })).toEqual([])
  })
})

describe('user records', () => {
  test('typed message from the terminal is terminal input', () => {
    const rec = { ...userBase, message: { role: 'user', content: 'hi' }, origin: { kind: 'human' }, promptSource: 'typed', turnOrigin: 'human' }
    expect(parseRecord(rec)).toEqual([{ kind: 'terminal_input' }])
  })

  test('queued message from the terminal is terminal input', () => {
    const rec = { ...userBase, message: { role: 'user', content: 'also' }, origin: { kind: 'human' }, promptSource: 'queued' }
    expect(parseRecord(rec)).toEqual([{ kind: 'terminal_input' }])
  })

  test('channel message is not terminal input', () => {
    const rec = { ...userBase, isMeta: true, message: { role: 'user', content: '<channel source="tg-hub">hi</channel>' }, origin: { kind: 'channel', server: 'plugin:tg-hub:tg-hub' } }
    expect(parseRecord(rec)).toEqual([])
  })

  test('tool result is not terminal input', () => {
    const rec = { ...userBase, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } }
    expect(parseRecord(rec)).toEqual([])
  })

  test('compact summary is not terminal input', () => {
    const rec = { ...userBase, isCompactSummary: true, isVisibleInTranscriptOnly: true, turnOrigin: 'human', message: { role: 'user', content: 'This session is being continued...' } }
    expect(parseRecord(rec)).toEqual([])
  })

  test('local command is not terminal input', () => {
    const rec = { ...userBase, message: { role: 'user', content: '<command-name>/autocompact</command-name>' } }
    expect(parseRecord(rec)).toEqual([])
  })

  test('meta caveat is not terminal input even with human origin', () => {
    const rec = { ...userBase, isMeta: true, origin: { kind: 'human' }, message: { role: 'user', content: '<local-command-caveat>' } }
    expect(parseRecord(rec)).toEqual([])
  })

  test('task notification is not terminal input', () => {
    const rec = { ...userBase, origin: { kind: 'task-notification' }, promptSource: 'system', turnOrigin: 'task_notification', message: { role: 'user', content: '<task-notification>' } }
    expect(parseRecord(rec)).toEqual([])
  })
})

describe('title records', () => {
  test('custom-title, agent-name and ai-title', () => {
    expect(parseRecord({ type: 'custom-title', customTitle: 'Mine', sessionId: 's' })).toEqual([{ kind: 'title', source: 'custom', title: 'Mine' }])
    expect(parseRecord({ type: 'agent-name', agentName: 'Renamed', sessionId: 's' })).toEqual([{ kind: 'title', source: 'agent', title: 'Renamed' }])
    expect(parseRecord({ type: 'ai-title', aiTitle: 'Auto', sessionId: 's' })).toEqual([{ kind: 'title', source: 'ai', title: 'Auto' }])
  })

  test('empty titles are ignored', () => {
    expect(parseRecord({ type: 'ai-title', aiTitle: '' })).toEqual([])
  })
})

test('garbage is ignored', () => {
  expect(parseRecord(null)).toEqual([])
  expect(parseRecord('str')).toEqual([])
  expect(parseRecord({ type: 'assistant' })).toEqual([])
  expect(parseRecord({ type: 'system', subtype: 'turn_duration' })).toEqual([])
})
