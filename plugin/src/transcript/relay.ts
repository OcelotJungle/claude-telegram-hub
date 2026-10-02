import type { TranscriptEvent } from './parse.ts'

export type Outgoing = { text: string; notify: boolean }

// Sent with sound when the agent called tg_notify but wrote no text after it,
// so the phone still rings.
export const NOTIFY_MARKER = '🔔 Ход завершён — ответ выше.'

const REMEMBERED_ENDS = 50

// Decides which assistant text goes to the topic and whether it notifies.
// A text followed by a tool call is intermediate (silent, sent at once); the
// last text of a turn is sent when the turn ends, with sound only if
// tg_notify was called in that turn.
//
// Every record of an end_turn message carries the stop reason, including the
// thinking record written before the final text, so a turn end is only
// finished on idle() (a poll that brought no new records) or when an event of
// another message arrives.
export class Relay {
  private enabled = false
  private pending: string | undefined
  private notify = false
  private ending: string | undefined
  private ended: string[] = []

  constructor(private opts: { isOwnTool(name: string): boolean }) {}

  // Turning off returns the text written while the mode was on and not sent
  // yet: the final text of a turn that ended, or the latest text mid-turn.
  setEnabled(on: boolean): Outgoing[] {
    let out: Outgoing[] = []
    if (!on && this.enabled) {
      if (this.ending !== undefined) out = this.finishTurn()
      else if (this.pending !== undefined) out = [{ text: this.pending, notify: false }]
    }
    this.enabled = on
    if (!on) this.pending = undefined
    return out
  }

  markNotify(): void {
    this.notify = true
  }

  feed(ev: TranscriptEvent): Outgoing[] {
    const out: Outgoing[] = []
    if (this.ending !== undefined && ('messageId' in ev ? ev.messageId !== this.ending : ev.kind === 'terminal_input')) {
      out.push(...this.finishTurn())
    }
    switch (ev.kind) {
      case 'text':
        if (!this.enabled) break
        if (this.pending !== undefined) out.push({ text: this.pending, notify: false })
        this.pending = ev.text
        break
      case 'tool_use':
        if (this.opts.isOwnTool(ev.name) || this.pending === undefined) break
        out.push({ text: this.pending, notify: false })
        this.pending = undefined
        break
      case 'turn_end':
        if (!this.ended.includes(ev.messageId)) this.ending = ev.messageId
        break
    }
    return out
  }

  idle(): Outgoing[] {
    return this.ending === undefined ? [] : this.finishTurn()
  }

  private finishTurn(): Outgoing[] {
    this.ended.push(this.ending!)
    if (this.ended.length > REMEMBERED_ENDS) this.ended.shift()
    this.ending = undefined
    const out: Outgoing[] = []
    if (this.enabled) {
      if (this.pending !== undefined) out.push({ text: this.pending, notify: this.notify })
      else if (this.notify) out.push({ text: NOTIFY_MARKER, notify: true })
    }
    this.pending = undefined
    this.notify = false
    return out
  }
}
