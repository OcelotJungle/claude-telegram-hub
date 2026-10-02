import { randomUUID } from 'crypto'
import { copyFileSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, join, resolve } from 'path'
import { isInside } from '../shared/config.ts'
import type { Logger } from '../shared/log.ts'
import { toTelegram } from '../shared/markdown.ts'
import { MAX_CAPTION, MAX_UPLOAD } from '../shared/media.ts'
import { PROTOCOL_VERSION, type ChannelMeta, type HubToPlugin } from '../shared/protocol.ts'
import { transcriptPathFor } from '../transcript/locate.ts'
import { parseRecord } from '../transcript/parse.ts'
import { Relay, type Outgoing } from '../transcript/relay.ts'
import { effectiveTitle, readSessionTitles, TranscriptTailer, type Titles } from '../transcript/tail.ts'
import { HubClient } from './hubClient.ts'

export type PluginOptions = {
  sessionId: string
  cwd: string
  configDir: string
  windowKey: string
  port: number
  // Where text the hub never acked goes when the window closes.
  spoolDir: string
  // tg-hub state: never sent, except inbox/ (what came from Telegram).
  stateDir: string
  // Where files to send are copied for the hub.
  filesDir: string
  // How long tg_send_file waits for the hub to send the files.
  fileWaitMs?: number
  spawnHub(): void
  emitChannel(content: string, meta: ChannelMeta): void
  log: Logger
  tailIntervalMs?: number
}

// Our own tools never make the text before them "intermediate".
export function isOwnTool(name: string): boolean {
  return /(^|__)tg_(enable|disable|notify)$/.test(name)
}

// Called by our PostToolBatch hook (hooks/hooks.json), not by the agent.
export const HOOK_NOTE_TOOL = 'tg_hook_note'

const MODE_OFF_NOTE =
  'tg-hub: Telegram mode is now OFF for this session, because the user typed a message in the terminal. ' +
  'Your text is no longer relayed to Telegram, and tg_notify is not needed. ' +
  'If that message asks to continue in Telegram, call tg_enable.'

// One per Claude Code window: follows the session transcript, relays the
// agent's text to the hub, delivers inbound topic messages to the session.
// Requests that make the hub call Telegram. The hub retries a flaky network
// for up to 2 minutes (TelegramApi deadlineMs), so wait a bit longer than that.
const HUB_TELEGRAM_TIMEOUT_MS = 150_000

export class PluginCore {
  private sessionId: string
  private cwd: string
  private transcriptPath: string
  private tailer: TranscriptTailer | undefined
  private relay = new Relay({ isOwnTool })
  private client: HubClient
  private titles: Titles = {}
  private log: Logger
  private reportedKinds = new Set<string>()
  // Terminal input turned the mode off and the agent has not been told yet.
  private noteOwed = false
  enabled = false

  constructor(private opts: PluginOptions) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.log = opts.log
    this.transcriptPath = transcriptPathFor(opts.sessionId, opts.cwd, opts.configDir)
    this.client = new HubClient({
      port: opts.port,
      hello: () => ({ type: 'hello', v: PROTOCOL_VERSION, windowKey: opts.windowKey, sessionId: this.sessionId, cwd: this.cwd }),
      spawnHub: opts.spawnHub,
      onMessage: m => this.onHubMessage(m),
      log: opts.log,
    })
  }

  start(): void {
    this.follow(this.transcriptPath)
    this.client.start()
  }

  stop(): void {
    this.tailer?.stop()
    this.client.stop()
  }

  // The window is closing: relay what was written last, then stop. Text no
  // hub took goes to the spool directory, and a hub is started to send it.
  async shutdown(timeoutMs: number): Promise<void> {
    this.tailer?.pollNow()
    this.flush(this.relay.idle())
    await this.client.drain(timeoutMs)
    const left = this.client.unacked
    if (left.length) {
      try {
        mkdirSync(this.opts.spoolDir, { recursive: true })
        const file = join(this.opts.spoolDir, `${this.sessionId}-${process.pid}-${Date.now()}.json`)
        writeFileSync(`${file}.tmp`, JSON.stringify(left))
        renameSync(`${file}.tmp`, file)
        this.log.warn(`hub unreachable at shutdown: ${left.length} message(s) left in ${file}`)
        this.client.spawnHubNow()
      } catch (e) {
        this.log.error(`could not spool ${left.length} message(s): ${e}\n${left.map(o => (o.type === 'sendFiles' ? `files: ${o.files.map(f => f.path).join(', ')}` : o.text)).join('\n---\n')}`)
      }
    }
    this.stop()
  }

  async enable(): Promise<string> {
    this.tailer?.pollNow()
    this.titles = readSessionTitles(this.transcriptPath)
    const res = (await this.client.request('enable', { title: effectiveTitle(this.titles) ?? '' }, HUB_TELEGRAM_TIMEOUT_MS)) as {
      topicTitle: string
      created: boolean
    }
    return `Telegram mode is on. Topic «${res.topicTitle}»${res.created ? ' was created' : ''}. Your text output is now relayed to it.`
  }

  async disable(): Promise<string> {
    await this.client.request('disable')
    return 'Telegram mode is off.'
  }

  notify(_kind: 'done' | 'ask'): string {
    if (!this.enabled) return 'Telegram mode is off — nothing will be sent.'
    this.relay.markNotify()
    return 'The final message of this turn will be sent with a notification. Write it now as your last text.'
  }

  async download(fileId: string): Promise<string> {
    return String(await this.client.request('download', { fileId }, HUB_TELEGRAM_TIMEOUT_MS))
  }

  // Hook output after a batch of tool calls. Only the transcript knows who
  // wrote a prompt (origin.kind), and Claude Code writes the prompt record
  // after UserPromptSubmit hooks run, so the agent hears of it here. Catch up
  // on the transcript first: the hook may come before the tailer's next poll.
  // A subagent's batch (agentId set) leaves the note for the main agent.
  hookNote(agentId: string): string {
    this.tailer?.pollNow()
    if (agentId || !this.noteOwed) return ''
    this.noteOwed = false
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext: MODE_OFF_NOTE } })
  }

  // Checks everything before sending anything, then hands the hub copies:
  // the agent may change or delete the originals right after the call.
  async sendFiles(paths: string[], caption = ''): Promise<string> {
    if (!paths.length) throw new Error('give at least one file path')
    const files = paths.map(p => this.sendable(p))
    const shown = toTelegram(caption).text.length
    if (shown > MAX_CAPTION) throw new Error(`the caption is ${shown} characters, Telegram allows ${MAX_CAPTION} — shorten it or write the text as a normal message`)
    const id = randomUUID()
    const dir = join(this.opts.filesDir, id)
    let queued: { path: string; name: string; size: number }[]
    try {
      mkdirSync(dir, { recursive: true })
      queued = files.map((f, i) => {
        const path = join(dir, `${i}-${f.name}`)
        copyFileSync(f.path, path)
        return { ...f, path }
      })
    } catch (e) {
      rmSync(dir, { recursive: true, force: true })
      throw new Error(`could not queue the files: ${e instanceof Error ? e.message : e}`)
    }
    this.tailer?.pollNow()
    this.flush(this.relay.textBeforeToolCall())
    const res = await this.client.sendFiles(
      { type: 'sendFiles', id, sessionId: this.sessionId, files: queued, caption, notify: !this.enabled },
      this.opts.fileWaitMs ?? HUB_TELEGRAM_TIMEOUT_MS,
    )
    if (!res) return `Telegram is not reachable right now: the ${files.length} file(s) are queued, and the hub will send them when it is.`
    if (res.error) throw new Error(res.error)
    return `Sent ${files.length} file(s) to the Telegram topic.`
  }

  private sendable(p: string): { path: string; name: string; size: number } {
    const path = resolve(this.cwd, p)
    let st
    try {
      st = statSync(path)
    } catch {
      throw new Error(`${p}: no such file`)
    }
    if (!st.isFile()) throw new Error(`${p}: not a file`)
    if (st.size === 0) throw new Error(`${p}: the file is empty, Telegram does not take empty files`)
    if (st.size > MAX_UPLOAD) throw new Error(`${p}: ${(st.size / 1024 / 1024).toFixed(1)} MB, over the 50 MB a bot may upload`)
    let real = path
    let state = this.opts.stateDir
    try {
      real = realpathSync(path)
      state = realpathSync(state)
    } catch {}
    if (isInside(state, real) && !isInside(join(state, 'inbox'), real)) throw new Error(`${p}: refusing to send tg-hub state files`)
    return { path, name: basename(path), size: st.size }
  }

  permissionRequest(p: { tool_name: string; description: string }): void {
    if (this.enabled) this.client.send({ type: 'permission', toolName: p.tool_name, description: p.description })
  }

  // /clear or /resume inside the window changed the session (from the
  // SessionStart hook, via the hub).
  switchSession(sessionId: string, transcriptPath: string, cwd: string): void {
    this.tailer?.pollNow()
    if (sessionId === this.sessionId) {
      // startup/compact: same session, maybe a differently spelled path.
      if (transcriptPath !== this.transcriptPath) this.follow(transcriptPath)
      return
    }
    this.log.info(`session ${this.sessionId} → ${sessionId}`)
    this.flush(this.relay.idle())
    this.setEnabled(false)
    this.sessionId = sessionId
    this.cwd = cwd || this.cwd
    this.follow(transcriptPath)
    this.client.send({ type: 'session', sessionId, cwd: this.cwd })
  }

  private follow(path: string): void {
    this.tailer?.stop()
    this.transcriptPath = path
    this.titles = readSessionTitles(path)
    this.tailer = new TranscriptTailer({
      path,
      onRecord: rec => this.onRecord(rec),
      onIdle: () => this.flush(this.relay.idle()),
      intervalMs: this.opts.tailIntervalMs,
      log: this.log,
    })
    this.tailer.start()
  }

  private onRecord(rec: unknown): void {
    for (const ev of parseRecord(rec)) {
      this.flush(this.relay.feed(ev))
      if (ev.kind === 'terminal_input' && this.enabled) {
        this.client.send({ type: 'terminalInput' })
        this.setEnabled(false)
        this.noteOwed = true
      } else if (ev.kind === 'unknown_thinking' && !this.reportedKinds.has(ev.blockKind)) {
        this.reportedKinds.add(ev.blockKind)
        this.log.warn(`transcript: thinking block of unknown kind "${ev.blockKind}" with text — not relayed; the transcript format may have changed`)
      } else if (ev.kind === 'title') {
        const before = effectiveTitle(this.titles)
        this.titles[ev.source] = ev.title
        const after = effectiveTitle(this.titles)
        if (after && after !== before) this.client.send({ type: 'title', title: after })
      }
    }
  }

  private flush(out: Outgoing[]): void {
    for (const o of out) this.client.enqueue(this.sessionId, o.text, o.notify)
  }

  // Turning off still sends what was written while the mode was on.
  private setEnabled(on: boolean): void {
    this.enabled = on
    if (on) this.noteOwed = false
    this.flush(this.relay.setEnabled(on))
  }

  private onHubMessage(m: HubToPlugin): void {
    switch (m.type) {
      case 'state':
        // Turned off elsewhere (tg_disable, another window): first relay what
        // the transcript already holds, written while the mode was on.
        if (!m.enabled && this.enabled) this.tailer?.pollNow()
        this.setEnabled(m.enabled)
        return
      case 'inbound':
        this.opts.emitChannel(m.content, m.meta)
        return
      case 'switchSession':
        this.switchSession(m.sessionId, m.transcriptPath, m.cwd)
        return
    }
  }
}
