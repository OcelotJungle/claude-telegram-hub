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
export class PluginCore {
  private sessionId: string
  private cwd: string
  private transcriptPath: string
  private tailer: TranscriptTailer | undefined
  private relay = new Relay({ isOwnTool })
  private client: HubClient
  private titles: Titles = {}
  private log: Logger
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

  // The window is closing: relay what was written last, then stop.
  async shutdown(timeoutMs: number): Promise<void> {
    this.tailer?.pollNow()
    this.flush(this.relay.idle())
    await this.client.drain(timeoutMs)
    this.stop()
  }

  async enable(): Promise<string> {
    this.tailer?.pollNow()
    this.titles = readSessionTitles(this.transcriptPath)
    const res = (await this.client.request('enable', { title: effectiveTitle(this.titles) ?? '' })) as { topicTitle: string; created: boolean }
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
    return String(await this.client.request('download', { fileId }, 60_000))
  }

  permissionRequest(p: { tool_name: string; description: string }): void {
    if (this.enabled) this.client.send({ type: 'permission', toolName: p.tool_name, description: p.description })
  }

  // /clear or /resume inside the window changed the session (from the
  // SessionStart hook, via the hub).
  switchSession(sessionId: string, transcriptPath: string, cwd: string): void {
    if (sessionId === this.sessionId && transcriptPath === this.transcriptPath) return
    this.log.info(`session ${this.sessionId} → ${sessionId}`)
    this.flush(this.relay.idle())
    this.sessionId = sessionId
    this.cwd = cwd || this.cwd
    this.setEnabled(false)
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
      } else if (ev.kind === 'title') {
        const before = effectiveTitle(this.titles)
        this.titles[ev.source] = ev.title
        const after = effectiveTitle(this.titles)
        if (after && after !== before) this.client.send({ type: 'title', title: after })
      }
    }
  }

  private flush(out: Outgoing[]): void {
    for (const o of out) this.client.enqueue(o.text, o.notify)
  }

  private setEnabled(on: boolean): void {
    this.enabled = on
    this.relay.setEnabled(on)
  }

  private onHubMessage(m: HubToPlugin): void {
    switch (m.type) {
      case 'state':
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
