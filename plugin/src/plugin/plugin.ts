import { mkdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Logger } from '../shared/log.ts'
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
  spawnHub(): void
  emitChannel(content: string, meta: ChannelMeta): void
  log: Logger
  tailIntervalMs?: number
}

// Our own tools never make the text before them "intermediate".
export function isOwnTool(name: string): boolean {
  return /(^|__)tg_(enable|disable|notify)$/.test(name)
}

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
        this.log.error(`could not spool ${left.length} message(s): ${e}\n${left.map(o => o.text).join('\n---\n')}`)
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
    this.flush(this.relay.setEnabled(on))
  }

  private onHubMessage(m: HubToPlugin): void {
    switch (m.type) {
      case 'state':
        // Turned off elsewhere (the prompt hook, tg_disable): first relay what
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
