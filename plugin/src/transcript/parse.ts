// Turns one transcript (.jsonl) record into the events the relay cares about.
// Record shapes: see "Результаты проверки" in the design spec.

export type TranscriptEvent =
  | { kind: 'text'; text: string; messageId: string }
  | { kind: 'tool_use'; name: string; messageId: string }
  | { kind: 'turn_end'; messageId: string }
  | { kind: 'terminal_input' }
  | { kind: 'title'; source: 'custom' | 'agent' | 'ai'; title: string }

type Rec = Record<string, any>

export function parseRecord(rec: unknown): TranscriptEvent[] {
  if (!rec || typeof rec !== 'object') return []
  const r = rec as Rec
  if (r.isSidechain === true) return []
  switch (r.type) {
    case 'assistant':
      return parseAssistant(r)
    case 'user':
      return isTerminalInput(r) ? [{ kind: 'terminal_input' }] : []
    case 'custom-title':
      return title('custom', r.customTitle)
    case 'agent-name':
      return title('agent', r.agentName)
    case 'ai-title':
      return title('ai', r.aiTitle)
    default:
      return []
  }
}

function parseAssistant(r: Rec): TranscriptEvent[] {
  const msg = r.message
  if (!msg || typeof msg.id !== 'string' || !Array.isArray(msg.content)) return []
  const messageId: string = msg.id
  const out: TranscriptEvent[] = []
  for (const block of msg.content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      out.push({ kind: 'text', text: block.text, messageId })
    } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
      out.push({ kind: 'tool_use', name: block.name, messageId })
    }
  }
  // Every record of a split message carries the final stop_reason; the relay
  // de-duplicates turn_end by messageId.
  if (typeof msg.stop_reason === 'string' && msg.stop_reason !== 'tool_use') {
    out.push({ kind: 'turn_end', messageId })
  }
  return out
}

function isTerminalInput(r: Rec): boolean {
  return r.origin?.kind === 'human' && r.isMeta !== true && r.isCompactSummary !== true
}

function title(source: 'custom' | 'agent' | 'ai', value: unknown): TranscriptEvent[] {
  return typeof value === 'string' && value.trim() ? [{ kind: 'title', source, title: value.trim() }] : []
}
