#!/usr/bin/env bun
// UserPromptSubmit hook: a prompt typed in the terminal turns Telegram mode
// off at once, and when it was on, the agent is told so with the prompt.
// Never fails; prints only that context.
import { hubPort } from '../shared/config.ts'
import type { PromptAnswer, PromptBody } from '../shared/protocol.ts'

const CONTEXT =
  'tg-hub: Telegram mode is now OFF for this session, because the user typed this message in the terminal. ' +
  'Your text is no longer relayed to Telegram, and tg_notify is not needed. ' +
  'If this message asks to continue in Telegram, call tg_enable as usual.'

try {
  const input = JSON.parse(await Bun.stdin.text())
  const text = String(input?.user_input ?? input?.prompt ?? '')
  const source = typeof input?.input_source === 'string' ? input.input_source : undefined
  // A topic message, should it ever reach this hook, must not turn the mode off.
  const fromChannel = text.trimStart().startsWith('<channel') || /channel/i.test(source ?? '')
  if (typeof input?.session_id === 'string' && !fromChannel) {
    const body: PromptBody = { session_id: input.session_id, ...(source ? { input_source: source } : {}) }
    const res = await fetch(`http://127.0.0.1:${hubPort()}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1500),
    })
    const answer = (await res.json()) as PromptAnswer
    if (answer.wasEnabled) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: CONTEXT } }))
    }
  }
} catch {}
process.exit(0)
