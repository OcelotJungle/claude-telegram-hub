import type { Server, ServerWebSocket } from 'bun'
import { chunk } from '../shared/chunk.ts'
import type { Config } from '../shared/config.ts'
import type { Logger } from '../shared/log.ts'
import { PROTOCOL_VERSION, type ChannelMeta, type HookBody, type HubToPlugin, type PluginToHub } from '../shared/protocol.ts'
import { routeUpdate } from './router.ts'
import { SessionStore, topicName, type SessionRecord } from './sessions.ts'
import { isThreadNotFound, TelegramError, type Message, type TelegramApi, type Update } from './telegram.ts'

type Conn = { windowKey?: string; sessionId?: string; cwd?: string }
type WS = ServerWebSocket<Conn>

export type HubOptions = {
  port: number
  sessionsFile: string
  inboxDir: string
  api: TelegramApi | undefined
  config: () => Config
  idleMs: number
  pollTimeoutSec?: number
  pollRetryBaseMs?: number
  log: Logger
  onExit(): void
}

const INACTIVE_TEXT = 'сессия сейчас не активна'
const HOOK_TTL_MS = 60_000
const MAX_POLL_DELAY_MS = 15_000

// The single Telegram poller on the machine. Plugins (one per Claude Code
// window) connect over a localhost WebSocket; whoever binds the port is the hub.
export class Hub {
  private server: Server<Conn> | undefined
  private conns = new Set<WS>()
  private store: SessionStore
  private chains = new Map<string, Promise<unknown>>()
  private pendingHooks = new Map<string, { body: HookBody; at: number }>()
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private abort = new AbortController()
  private running = false
  private log: Logger

  constructor(private opts: HubOptions) {
    this.store = new SessionStore(opts.sessionsFile)
    this.log = opts.log
  }

  start(): boolean {
    try {
      this.server = Bun.serve<Conn>({
        port: this.opts.port,
        hostname: '127.0.0.1',
        fetch: (req, server) => this.handleHttp(req, server),
        websocket: {
          open: ws => this.onOpen(ws),
          message: (ws, data) => this.onMessage(ws, String(data)),
          close: ws => this.onClose(ws),
        },
      })
    } catch (e) {
      if ((e as { code?: string }).code === 'EADDRINUSE') return false
      throw e
    }
    this.running = true
    this.log.info(`hub listening on 127.0.0.1:${this.opts.port}`)
    this.armIdle()
    if (this.opts.api) void this.pollLoop(this.opts.api)
    else this.log.error('no TELEGRAM_BOT_TOKEN — not polling Telegram')
    return true
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.abort.abort()
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.server?.stop(true)
    this.log.info('hub stopped')
  }

  isConnected(sessionId: string): boolean {
    return this.connOf(sessionId) !== undefined
  }

  // --- transport -----------------------------------------------------------

  private async handleHttp(req: Request, server: Server<Conn>): Promise<Response | undefined> {
    // Browsers always send Origin; local plugins and hooks never do.
    if (req.headers.get('origin')) return new Response('forbidden', { status: 403 })
    const url = new URL(req.url)
    if (url.pathname === '/ws') {
      if (server.upgrade(req, { data: {} })) return undefined
      return new Response('upgrade required', { status: 426 })
    }
    if (url.pathname === '/health') return Response.json({ ok: true, pid: process.pid })
    if (url.pathname === '/hook' && req.method === 'POST') {
      let body: HookBody
      try {
        body = (await req.json()) as HookBody
      } catch {
        return new Response('bad json', { status: 400 })
      }
      this.onHook(body)
      return new Response('ok')
    }
    return new Response('not found', { status: 404 })
  }

  private onOpen(ws: WS): void {
    this.conns.add(ws)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  private onClose(ws: WS): void {
    this.conns.delete(ws)
    if (ws.data.sessionId) this.log.info(`window for session ${ws.data.sessionId} disconnected`)
    this.armIdle()
  }

  private armIdle(): void {
    if (this.conns.size > 0 || !this.running) return
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.conns.size > 0) return
      this.log.info('no plugins connected — exiting')
      void this.stop().then(() => this.opts.onExit())
    }, this.opts.idleMs)
  }

  private send(ws: WS, msg: HubToPlugin): void {
    try {
      ws.send(JSON.stringify(msg))
    } catch {}
  }

  private connOf(sessionId: string): WS | undefined {
    let found: WS | undefined
    for (const ws of this.conns) if (ws.data.sessionId === sessionId) found = ws
    return found
  }

  private onHook(body: HookBody): void {
    if (!body.messagingSocket || !body.session_id || !body.transcript_path) return
    for (const ws of this.conns) {
      if (ws.data.windowKey === body.messagingSocket) {
        this.forwardHook(ws, body)
        return
      }
    }
    this.pendingHooks.set(body.messagingSocket, { body, at: Date.now() })
  }

  private forwardHook(ws: WS, body: HookBody): void {
    this.send(ws, { type: 'switchSession', sessionId: body.session_id, transcriptPath: body.transcript_path, cwd: body.cwd })
  }

  // --- plugin messages -----------------------------------------------------

  private onMessage(ws: WS, raw: string): void {
    let msg: PluginToHub
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    try {
      this.dispatch(ws, msg)
    } catch (e) {
      this.log.error(`handling ${msg.type} failed: ${e}`)
    }
  }

  private dispatch(ws: WS, msg: PluginToHub): void {
    const sid = ws.data.sessionId
    switch (msg.type) {
      case 'hello': {
        if (msg.v !== PROTOCOL_VERSION) this.log.warn(`plugin protocol v${msg.v}, hub v${PROTOCOL_VERSION}`)
        ws.data = { windowKey: msg.windowKey, sessionId: msg.sessionId, cwd: msg.cwd }
        this.log.info(`window ${msg.windowKey} connected, session ${msg.sessionId}`)
        this.pushState(msg.sessionId)
        const pending = this.pendingHooks.get(msg.windowKey)
        this.pendingHooks.delete(msg.windowKey)
        if (pending && Date.now() - pending.at < HOOK_TTL_MS) this.forwardHook(ws, pending.body)
        return
      }
      case 'session':
        ws.data.sessionId = msg.sessionId
        ws.data.cwd = msg.cwd
        this.log.info(`window ${ws.data.windowKey} switched to session ${msg.sessionId}`)
        this.pushState(msg.sessionId)
        return
      case 'req':
        void this.handleRequest(ws, msg)
        return
      // The mode is checked when the text arrives, not when its turn in the
      // queue comes: text produced while enabled is delivered even if the user
      // types in the terminal meanwhile.
      case 'send':
        if (!sid || !this.store.get(sid)?.enabled) return this.send(ws, { type: 'ack', id: msg.id })
        void this.chain(sid, () => this.deliver(sid, msg.text, msg.notify)).finally(() => this.send(ws, { type: 'ack', id: msg.id }))
        return
      case 'permission':
        if (sid && this.store.get(sid)?.enabled) void this.chain(sid, () => this.deliver(sid, `🔐 Нужно подтверждение: ${msg.toolName} — ${msg.description}`, true))
        return
      case 'title':
        if (sid) void this.chain(sid, () => this.retitle(sid, msg.title))
        return
      case 'terminalInput':
        if (sid) this.setEnabled(sid, false)
        return
    }
  }

  private async handleRequest(ws: WS, msg: Extract<PluginToHub, { type: 'req' }>): Promise<void> {
    const sid = ws.data.sessionId
    try {
      let result: unknown
      if (!sid) throw new Error('window has not said hello')
      if (msg.op === 'enable') result = await this.chain(sid, () => this.enable(sid, ws.data.cwd ?? '', msg.title))
      else if (msg.op === 'disable') result = this.setEnabled(sid, false)
      else result = await this.requireApi().downloadFile(msg.fileId, this.opts.inboxDir)
      this.send(ws, { type: 'res', id: msg.id, ok: true, result })
    } catch (e) {
      this.send(ws, { type: 'res', id: msg.id, ok: false, error: e instanceof TelegramError ? e.message : e instanceof Error ? e.message : String(e) })
    }
  }

  // Serializes everything that touches one session's topic.
  private chain<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(sessionId) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.chains.set(sessionId, next.catch(() => {}))
    return next
  }

  private requireApi(): TelegramApi {
    if (!this.opts.api) throw new Error('TELEGRAM_BOT_TOKEN is not set — put it into .env in the tg-hub state dir and restart the hub')
    return this.opts.api
  }

  private requireGroup(): string {
    const groupId = this.opts.config().groupId
    if (!groupId) {
      throw new Error('groupId is not configured — set "groupId" in config.json in the tg-hub state dir; hub.log lists the ids of chats the bot receives messages from')
    }
    return groupId
  }

  private async enable(sessionId: string, cwd: string, title: string) {
    const api = this.requireApi()
    const groupId = this.requireGroup()
    const existing = this.store.get(sessionId)
    if (existing) {
      if (title && existing.title !== title) await this.renameTopic(api, groupId, sessionId, existing, title)
      this.setEnabled(sessionId, true)
      return { topicTitle: topicName(existing.project, existing.title), created: false }
    }
    const project = projectName(cwd)
    const topic = await api.createForumTopic(groupId, topicName(project, title))
    this.store.set(sessionId, { topicId: topic.message_thread_id, title, project, enabled: true })
    this.log.info(`created topic ${topic.message_thread_id} "${topic.name}" for session ${sessionId}`)
    this.pushState(sessionId)
    return { topicTitle: topicName(project, title), created: true }
  }

  private async retitle(sessionId: string, title: string): Promise<void> {
    const rec = this.store.get(sessionId)
    if (!rec || !title || rec.title === title || !this.opts.api) return
    const groupId = this.opts.config().groupId
    if (!groupId) return
    try {
      await this.renameTopic(this.opts.api, groupId, sessionId, rec, title)
    } catch (e) {
      this.log.warn(`renaming topic of ${sessionId} failed: ${e}`)
    }
  }

  private async renameTopic(api: TelegramApi, groupId: string, sessionId: string, rec: SessionRecord, title: string): Promise<void> {
    await api.editForumTopic(groupId, rec.topicId, topicName(rec.project, title))
    this.store.set(sessionId, { ...rec, title })
  }

  private setEnabled(sessionId: string, on: boolean): boolean {
    this.store.setEnabled(sessionId, on)
    this.pushState(sessionId)
    return on
  }

  private pushState(sessionId: string): void {
    const ws = this.connOf(sessionId)
    if (!ws) return
    const rec = this.store.get(sessionId)
    this.send(ws, { type: 'state', enabled: rec?.enabled ?? false, ...(rec ? { topicTitle: topicName(rec.project, rec.title) } : {}) })
  }

  // Sends text to the session's topic. Never throws: a final failure is logged
  // together with the text so nothing is lost silently.
  private async deliver(sessionId: string, text: string, notify: boolean): Promise<void> {
    if (!this.store.get(sessionId)) return
    const pieces = chunk(text)
    try {
      const api = this.requireApi()
      const groupId = this.requireGroup()
      for (let i = 0; i < pieces.length; i++) {
        await this.sendToTopic(api, groupId, sessionId, pieces[i]!, !(notify && i === 0))
      }
    } catch (e) {
      this.log.error(`failed to deliver to session ${sessionId}: ${e}\n--- undelivered text ---\n${text}\n--- end ---`)
    }
  }

  private async sendToTopic(api: TelegramApi, groupId: string, sessionId: string, text: string, silent: boolean): Promise<void> {
    const rec = this.store.get(sessionId)!
    try {
      await api.sendMessage(groupId, rec.topicId, text, silent)
    } catch (e) {
      if (!isThreadNotFound(e)) throw e
      // The topic was deleted by hand: give the session a new one.
      const topic = await api.createForumTopic(groupId, topicName(rec.project, rec.title))
      this.store.set(sessionId, { ...rec, topicId: topic.message_thread_id })
      this.log.warn(`topic ${rec.topicId} of session ${sessionId} is gone, created ${topic.message_thread_id}`)
      await api.sendMessage(groupId, topic.message_thread_id, text, silent)
    }
  }

  // --- Telegram polling ----------------------------------------------------

  private async pollLoop(api: TelegramApi): Promise<void> {
    try {
      const me = await api.getMe(this.abort.signal)
      this.log.info(`polling Telegram as @${me.username ?? me.id}`)
    } catch (e) {
      if (!this.running) return
      if (e instanceof TelegramError && e.code === 401) {
        this.log.error('bot token rejected by Telegram (401 Unauthorized) — fix TELEGRAM_BOT_TOKEN in .env and restart the hub; not polling')
        return
      }
      this.log.warn(`getMe failed: ${e}; polling anyway`)
    }
    let offset = 0
    let failures = 0
    while (this.running) {
      let updates: Update[]
      try {
        updates = await api.getUpdates(offset, this.opts.pollTimeoutSec ?? 25, this.abort.signal)
        if (failures) this.log.info('Telegram polling works again')
        failures = 0
      } catch (e) {
        if (!this.running) return
        failures++
        const delay = Math.min((this.opts.pollRetryBaseMs ?? 1000) * failures, MAX_POLL_DELAY_MS)
        const conflict = e instanceof TelegramError && e.code === 409
        this.log.warn(`${conflict ? 'getUpdates 409 Conflict — another poller uses this bot token' : `getUpdates failed: ${e}`}; retry in ${delay}ms`)
        await Bun.sleep(delay)
        continue
      }
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1)
        try {
          await this.handleUpdate(api, u)
        } catch (e) {
          this.log.error(`update ${u.update_id} failed: ${e}`)
        }
      }
    }
  }

  private async handleUpdate(api: TelegramApi, u: Update): Promise<void> {
    const cfg = this.opts.config()
    const route = routeUpdate(u, cfg, this.store, id => this.isConnected(id))
    const m = u.message
    if (route.action === 'ignore') {
      if (m) this.log.info(`ignored update from chat ${m.chat.id} (${m.chat.type}${m.chat.title ? ` "${m.chat.title}"` : ''}), sender ${m.from?.id}: ${route.reason}`)
      return
    }
    if (route.action === 'inactive') {
      await api.sendMessage(cfg.groupId!, route.topicId, INACTIVE_TEXT, false).catch(e => this.log.warn(`inactive notice failed: ${e}`))
      return
    }
    const ws = this.connOf(route.sessionId)
    if (!ws || !m) return
    this.setEnabled(route.sessionId, true)
    const { content, meta } = await this.inboundOf(api, m)
    this.send(ws, { type: 'inbound', content, meta })
  }

  // Same meta shape as the official telegram plugin.
  private async inboundOf(api: TelegramApi, m: Message): Promise<{ content: string; meta: ChannelMeta }> {
    const meta: ChannelMeta = {
      chat_id: String(m.chat.id),
      message_id: String(m.message_id),
      user: m.from?.username ?? String(m.from?.id),
      user_id: String(m.from?.id),
      ts: new Date(m.date * 1000).toISOString(),
    }
    const attach = (kind: string, f: { file_id: string; file_size?: number; mime_type?: string }, name?: string) => {
      meta.attachment_kind = kind
      meta.attachment_file_id = f.file_id
      if (f.file_size != null) meta.attachment_size = String(f.file_size)
      if (f.mime_type) meta.attachment_mime = f.mime_type
      if (name) meta.attachment_name = name
    }
    let content = m.text ?? m.caption
    if (m.photo?.length) {
      content ??= '(photo)'
      const best = m.photo[m.photo.length - 1]!
      try {
        meta.image_path = await api.downloadFile(best.file_id, this.opts.inboxDir)
      } catch (e) {
        this.log.warn(`photo download failed: ${e}`)
        attach('photo', best)
      }
    } else if (m.document) {
      const name = safeName(m.document.file_name)
      content ??= `(document: ${name ?? 'file'})`
      attach('document', m.document, name)
    } else if (m.voice) {
      content ??= '(voice message)'
      attach('voice', m.voice)
    } else if (m.audio) {
      const name = safeName(m.audio.file_name)
      content ??= `(audio: ${safeName(m.audio.title) ?? name ?? 'audio'})`
      attach('audio', m.audio, name)
    } else if (m.video) {
      content ??= '(video)'
      attach('video', m.video, safeName(m.video.file_name))
    } else if (m.video_note) {
      content ??= '(video note)'
      attach('video_note', m.video_note)
    } else if (m.sticker) {
      content ??= `(sticker${m.sticker.emoji ? ` ${m.sticker.emoji}` : ''})`
      attach('sticker', m.sticker)
    }
    return { content: content ?? '', meta }
  }
}

// Uploader-controlled names land inside the <channel> tag; strip delimiters.
function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;"]/g, '_')
}

export function projectName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd
}
