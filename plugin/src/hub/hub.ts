import type { Server, ServerWebSocket } from 'bun'
import { randomUUID } from 'crypto'
import { existsSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, unlinkSync } from 'fs'
import { dirname, join } from 'path'
import { chunk } from '../shared/chunk.ts'
import { isInside, type Config } from '../shared/config.ts'
import type { Logger } from '../shared/log.ts'
import { toTelegram, type Formatted } from '../shared/markdown.ts'
import { albums, kindOf, type OutFile } from '../shared/media.ts'
import { PROTOCOL_VERSION, type ChannelMeta, type CommandReply, type HookBody, type HubToPlugin, type PluginToHub, type TopicCommand } from '../shared/protocol.ts'
import { Outbox, type OutItem, type Piece } from './outbox.ts'
import { commandOf, routeUpdate } from './router.ts'
import { SessionStore, topicName, type SessionRecord } from './sessions.ts'
import { isThreadNotFound, TelegramError, type Message, type TelegramApi, type Update } from './telegram.ts'
import { richPhotos, richToMarkdown, type RichMessage } from './rich.ts'
import { richPieces } from './rich-out.ts'
import { DEFAULT_VIDEO_TOOLS, probeVideo, thumbPath, type VideoTools } from './video.ts'

type Conn = { windowKey?: string; sessionId?: string; cwd?: string }
type WS = ServerWebSocket<Conn>

export type HubOptions = {
  port: number
  sessionsFile: string
  outboxFile: string
  // Where a closing window leaves the text it could not hand to a hub.
  spoolDir?: string
  spoolScanMs?: number
  // The only place file copies to send are taken from (and removed from).
  filesDir: string
  inboxDir: string
  api: TelegramApi | undefined
  // ffprobe and ffmpeg, for the metadata and thumbnail of videos to send.
  videoTools?: VideoTools
  config: () => Config
  idleMs: number
  // How long a command from the topic waits for the plugin's module to take it.
  commandPickupMs?: number
  pollTimeoutSec?: number
  pollRetryBaseMs?: number
  // Pause between attempts to deliver the head of a session's queue.
  sendRetryBaseMs?: number
  sendRetryMaxMs?: number
  log: Logger
  onExit(): void
}

const INACTIVE_TEXT = 'сессия сейчас не активна'
const HOOK_TTL_MS = 60_000
const MAX_POLL_DELAY_MS = 15_000
const COMMAND_PICKUP_MS = 10_000
const BOT_COMMANDS = [
  { command: 'info', description: 'Лимиты и контекст сессии' },
  { command: 'compact', description: 'Сжать контекст; /compact N — окно автокомпакта' },
]

// Delivery cannot work until the user fixes the setup: no token, no groupId,
// the bot is not in the group or may not write there.
class SetupError extends Error {}

// A queued file copy vanished from disk: retrying cannot help.
class LostFileError extends Error {}

type Failure = 'retry' | 'setup' | 'rejected'

function classify(e: unknown): Failure {
  if (e instanceof SetupError) return 'setup'
  if (e instanceof LostFileError) return 'rejected'
  if (!(e instanceof TelegramError)) return 'retry'
  if (e.code === 401 || e.code === 403 || e.code === 404) return 'setup'
  if (e.code === 400) {
    return /chat not found|not enough rights|have no rights|CHAT_WRITE_FORBIDDEN|CHAT_ADMIN_REQUIRED|bot was kicked|upgraded to a supergroup/i.test(e.description) ? 'setup' : 'rejected'
  }
  return 'retry'
}

// The single Telegram poller on the machine. Plugins (one per Claude Code
// window) connect over a localhost WebSocket; whoever binds the port is the hub.
export class Hub {
  private server: Server<Conn> | undefined
  private conns = new Set<WS>()
  private store: SessionStore
  private chains = new Map<string, Promise<unknown>>()
  private pendingHooks = new Map<string, { body: HookBody; at: number }>()
  private outbox: Outbox
  // sendFiles messages still in the queue: what failed so far, and the window
  // that waits for the result.
  private fileMessages = new Map<string, { errors: string[]; ws?: WS }>()
  // Results for windows that were not connected when their files went out
  // (the hub restarted meanwhile), by session; given out on hello.
  private heldResults = new Map<string, HubToPlugin[]>()
  // Commands from the topic the plugin's module has not taken yet, by session.
  private commands = new Map<string, { cmd: TopicCommand; timer: ReturnType<typeof setTimeout> }[]>()
  private botUsername: string | undefined
  private pumping = new Set<string>()
  // Sessions whose delivery waits for the user to fix the setup.
  private blocked = new Set<string>()
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  // Idle time is up, but the queue is still being delivered.
  private idleExpired = false
  private spoolTimer: ReturnType<typeof setInterval> | undefined
  private abort = new AbortController()
  private running = false
  private log: Logger

  constructor(private opts: HubOptions) {
    this.store = new SessionStore(opts.sessionsFile)
    this.log = opts.log
    this.outbox = new Outbox(opts.outboxFile, opts.log)
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
    if (this.outbox.size) this.log.info(`${this.outbox.size} queued piece(s) left by the previous hub — delivering`)
    for (const item of this.outbox.items()) if (item.files) this.fileMessages.set(messageOf(item.id), { errors: [] })
    for (const sid of this.outbox.sessions()) void this.pump(sid)
    this.ingestSpool()
    this.spoolTimer = setInterval(() => this.ingestSpool(), this.opts.spoolScanMs ?? 5000)
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
    if (this.spoolTimer) clearInterval(this.spoolTimer)
    for (const queued of this.commands.values()) for (const e of queued) clearTimeout(e.timer)
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
    if (url.pathname === '/commands' && req.method === 'GET') return Response.json(this.takeCommands(url.searchParams.get('session') ?? ''))
    if (url.pathname === '/reply' && req.method === 'POST') {
      let r: CommandReply
      try {
        r = (await req.json()) as CommandReply
      } catch {
        return new Response('bad json', { status: 400 })
      }
      if (typeof r?.sessionId !== 'string' || typeof r.id !== 'string' || typeof r.text !== 'string') return new Response('bad reply', { status: 400 })
      this.enqueue(r.sessionId, `cmd-${r.id}`, r.text, r.notify === true)
      return new Response('ok')
    }
    return new Response('not found', { status: 404 })
  }

  // --- commands from the topic ---------------------------------------------

  // Waits for the session's module; a window without one (an older Claude
  // Code, a window still on the old plugin) never takes it, and the user is
  // told so.
  private queueCommand(sessionId: string, c: Omit<TopicCommand, 'id'>): void {
    const cmd = { id: randomUUID(), ...c }
    const ms = this.opts.commandPickupMs ?? COMMAND_PICKUP_MS
    const timer = setTimeout(() => {
      this.commands.set(sessionId, (this.commands.get(sessionId) ?? []).filter(e => e.cmd !== cmd))
      this.log.warn(`/${cmd.name} for session ${sessionId} was not taken in ${ms} ms`)
      this.enqueue(sessionId, `cmd-${cmd.id}-lost`, `⚠️ /${cmd.name} не выполнена: окно не забрало её за ${ms / 1000} с. Команды выполняет модуль плагина — перезапусти окно.`, true, false)
    }, ms)
    this.commands.set(sessionId, [...(this.commands.get(sessionId) ?? []), { cmd, timer }])
    this.log.info(`/${cmd.name} for session ${sessionId}`)
  }

  private takeCommands(sessionId: string): TopicCommand[] {
    const queued = this.commands.get(sessionId) ?? []
    this.commands.delete(sessionId)
    for (const e of queued) clearTimeout(e.timer)
    return queued.map(e => e.cmd)
  }

  private async registerCommands(api: TelegramApi): Promise<void> {
    try {
      await api.setMyCommands(BOT_COMMANDS, this.abort.signal)
    } catch (e) {
      if (this.running) this.log.warn(`registering bot commands failed: ${e}`)
    }
  }

  private onOpen(ws: WS): void {
    this.conns.add(ws)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    this.idleExpired = false
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
      this.idleExpired = true
      if (this.deliverable() > 0) this.log.info(`no plugins connected — exiting once ${this.deliverable()} queued piece(s) reach Telegram`)
      this.maybeExit()
    }, this.opts.idleMs)
  }

  // Queued pieces that can still go out without the user fixing anything.
  private deliverable(): number {
    return this.outbox
      .sessions()
      .filter(s => !this.blocked.has(s))
      .reduce((n, s) => n + this.outbox.countOf(s), 0)
  }

  private maybeExit(): void {
    if (!this.idleExpired || !this.running || this.conns.size > 0 || this.deliverable() > 0) return
    if (this.outbox.size) this.log.info(`no plugins connected — exiting; ${this.outbox.size} queued piece(s) wait on disk until the setup is fixed`)
    else this.log.info('no plugins connected — exiting')
    void this.stop().then(() => this.opts.onExit())
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
        this.giveHeldResults(ws, msg.sessionId)
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
      // The plugin sends only text written while the mode was on, so it is
      // delivered whatever the mode is now. The ack goes once it is on disk.
      case 'send': {
        const target = msg.sessionId ?? sid
        if (target) this.enqueue(target, msg.id, msg.text, msg.notify)
        else this.log.warn(`text from a window that has not said hello, not sent:
${msg.text}`)
        this.send(ws, { type: 'ack', id: msg.id })
        return
      }
      case 'sendFiles':
        this.enqueueFiles(msg, ws)
        this.send(ws, { type: 'ack', id: msg.id })
        return
      case 'permission':
        if (sid && this.store.get(sid)?.enabled) this.enqueue(sid, `perm-${randomUUID()}`, `🔐 Нужно подтверждение: ${msg.toolName} — ${msg.description}`, true, false)
        return
      case 'title':
        if (sid) void this.chain(sid, () => this.retitle(sid, msg.title))
        return
      case 'terminalInput':
        if (!sid) return
        this.log.info(`terminal input in session ${sid}: Telegram mode off`)
        this.setEnabled(sid, false)
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
    if (!this.opts.api) throw new SetupError('TELEGRAM_BOT_TOKEN is not set — put it into .env in the tg-hub state dir and restart the hub')
    return this.opts.api
  }

  private requireGroup(): string {
    const groupId = this.opts.config().groupId
    if (!groupId) {
      throw new SetupError('groupId is not configured — set "groupId" in config.json in the tg-hub state dir; hub.log lists the ids of chats the bot receives messages from')
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

  // --- delivery -------------------------------------------------------------

  // Puts text for a session's topic into the queue on disk and starts its
  // delivery. Throws only if the queue cannot be written; then the plugin gets
  // no ack and sends the text again. Agent text is Markdown and goes as rich
  // messages; the hub's own texts go as they are.
  private enqueue(sessionId: string, sourceId: string, text: string, notify: boolean, markdown = true): void {
    if (!this.store.get(sessionId)) {
      this.log.warn(`session ${sessionId} has no topic, text not sent:\n${text}`)
      return
    }
    const pieces = (markdown ? richPieces(text).flatMap(p => (p.blocks ? [{ text: p.text, silent: true, rich: p.blocks }] : textPieces(p.text, true))) : textPieces(text, false)).map(
      (p, i) => ({ ...p, silent: !(notify && i === 0) }),
    )
    if (pieces.length && this.outbox.add(sourceId, sessionId, pieces)) void this.pump(sessionId)
  }

  // One queue item per Telegram send, so a retry never repeats an album that
  // already went out. The caption and the sound go with the first send.
  private enqueueFiles(msg: Extract<PluginToHub, { type: 'sendFiles' }>, ws?: WS): void {
    const fail = (error: string) => {
      this.dropFiles(msg.files.filter(f => this.inFilesDir(f.path)))
      this.filesSent(msg.id, msg.sessionId, [error], ws)
    }
    const outside = msg.files.filter(f => !this.inFilesDir(f.path))
    if (outside.length) {
      this.log.error(`files outside ${this.opts.filesDir} refused for session ${msg.sessionId}: ${outside.map(f => f.path).join(', ')}`)
      return fail(`the hub sends only copies from ${this.opts.filesDir}`)
    }
    if (!this.store.get(msg.sessionId)) {
      this.log.warn(`session ${msg.sessionId} has no topic, files not sent: ${msg.files.map(f => f.name).join(', ')}`)
      return fail('This session has no Telegram topic yet — call tg_enable first.')
    }
    const caption = toTelegram(msg.caption)
    const pieces = albums(msg.files.map(f => ({ ...f, kind: msg.asDocument ? 'document' : kindOf(f.name, f.size) }))).map((files, i) => filesPiece(files, i === 0 ? caption : undefined, msg.notify && i === 0))
    if (this.outbox.add(msg.id, msg.sessionId, pieces)) {
      this.fileMessages.set(msg.id, { errors: [], ws })
      void this.pump(msg.sessionId)
    } else if (!this.outbox.hasMessage(msg.id)) {
      // Sent before; the plugin re-sent it after a reconnect.
      this.filesSent(msg.id, msg.sessionId, [], ws)
    } else {
      const entry = this.fileMessages.get(msg.id)
      if (entry) entry.ws = ws
    }
  }

  private inFilesDir(path: string): boolean {
    return isInside(this.opts.filesDir, path)
  }

  // Removes queued copies, their thumbnails and the message folder once it is empty.
  private dropFiles(files: { path: string }[]): void {
    for (const f of files) {
      if (!this.inFilesDir(f.path)) continue
      try {
        rmSync(f.path, { force: true })
        rmSync(thumbPath(f.path), { force: true })
        rmdirSync(dirname(f.path))
      } catch {}
    }
  }

  private filesSent(id: string, sessionId: string, errors: string[], ws?: WS): void {
    const msg: HubToPlugin = { type: 'filesSent', id, ...(errors.length ? { error: errors.join('; ') } : {}) }
    const target = ws && this.conns.has(ws) ? ws : this.connOf(sessionId)
    if (target) return this.send(target, msg)
    this.heldResults.set(sessionId, [...(this.heldResults.get(sessionId) ?? []), msg])
  }

  private giveHeldResults(ws: WS, sessionId: string): void {
    for (const msg of this.heldResults.get(sessionId) ?? []) this.send(ws, msg)
    this.heldResults.delete(sessionId)
  }

  // A piece left the queue: its files are no longer needed, and the window
  // hears when the last send of its files is done.
  private settled(item: OutItem): void {
    if (item.files) this.dropFiles(item.files)
    const id = messageOf(item.id)
    const entry = this.fileMessages.get(id)
    if (!entry || this.outbox.hasMessage(id)) return
    this.fileMessages.delete(id)
    this.filesSent(id, item.sessionId, entry.errors, entry.ws)
  }

  // Delivers a session's queue strictly in order: a piece leaves the queue
  // only after Telegram accepted it. Network and server failures are retried
  // for as long as it takes; a piece Telegram rejects is replaced by a notice.
  private async pump(sessionId: string): Promise<void> {
    if (this.pumping.has(sessionId)) return
    this.pumping.add(sessionId)
    const base = this.opts.sendRetryBaseMs ?? 1000
    const max = this.opts.sendRetryMaxMs ?? 30_000
    let failures = 0
    try {
      while (this.running) {
        const item = this.outbox.head(sessionId)
        if (!item) break
        try {
          await this.sendItem(sessionId, item)
          this.outbox.remove(item.id)
          this.settled(item)
          if (failures) this.log.info(`delivery to session ${sessionId} works again after ${failures} failed attempt(s)`)
          failures = 0
          this.blocked.delete(sessionId)
          continue
        } catch (e) {
          if (!this.running) break
          const kind = classify(e)
          if (kind === 'rejected') {
            this.onRejected(item, e)
            continue
          }
          failures++
          if (failures === 1) {
            const waiting = `${this.outbox.countOf(sessionId)} piece(s) wait`
            this.log.warn(
              kind === 'setup'
                ? `delivery to session ${sessionId} is blocked: ${e instanceof Error ? e.message : e} — fix the bot or group setup; ${waiting}, retrying every ${max / 1000} s`
                : `delivery to session ${sessionId} failed (${e instanceof Error ? e.message : e}); ${waiting}, retrying`,
            )
          }
          if (kind === 'setup') {
            this.blocked.add(sessionId)
            this.maybeExit()
          }
          await this.sleep(kind === 'setup' ? max : Math.min(base * 2 ** (failures - 1), max))
        }
      }
    } finally {
      this.pumping.delete(sessionId)
      if (!this.outbox.head(sessionId)) this.blocked.delete(sessionId)
      this.maybeExit()
    }
  }

  private async sendItem(sessionId: string, item: OutItem): Promise<void> {
    if (!this.store.get(sessionId)) {
      this.log.error(`session ${sessionId} lost its topic record, ${item.files ? `files not sent: ${names(item.files)}` : `text not sent:\n${item.text}`}`)
      return
    }
    const api = this.requireApi()
    const groupId = this.requireGroup()
    if (item.rich) {
      await this.sendToTopic(api, groupId, sessionId, thread => api.sendRichMessage(groupId, thread, item.rich!, item.silent))
      return
    }
    if (!item.files) {
      await this.sendToTopic(api, groupId, sessionId, thread => api.sendMessage(groupId, thread, item.text, item.silent, item.entities))
      return
    }
    const lost = item.files.filter(f => !existsSync(f.path))
    if (lost.length) throw new LostFileError(`the queued copy is gone: ${lost.map(f => f.path).join(', ')}`)
    const files = await this.probeVideos(item)
    await this.sendToTopic(api, groupId, sessionId, thread => api.sendFiles(groupId, thread, files, item.text, item.entities, item.silent))
  }

  // Videos are probed once, before their first send, and the result stays
  // with the queued piece; a thumbnail gone from disk is just not sent.
  private async probeVideos(item: OutItem): Promise<OutFile[]> {
    let files = item.files!
    if (files.some(f => f.kind === 'video' && !f.video)) {
      const tools = this.opts.videoTools ?? DEFAULT_VIDEO_TOOLS
      const probed: OutFile[] = []
      for (const f of files) probed.push(f.kind === 'video' && !f.video ? { ...f, video: await probeVideo(f.path, f.name, tools, this.log) } : f)
      this.outbox.setFiles(item.id, probed)
      files = probed
    }
    return files.map(f => (f.video?.thumb && !existsSync(f.video.thumb) ? { ...f, video: { ...f.video, thumb: undefined } } : f))
  }

  // Before giving a piece up: a rich message Telegram cannot take goes as
  // plain text with entities, photos as documents, and formatting Telegram
  // cannot take is dropped.
  private onRejected(item: OutItem, e: unknown): void {
    const why = e instanceof TelegramError ? e.message : e instanceof Error ? e.message : String(e)
    if (item.rich) {
      this.log.warn(`Telegram rejected a rich message for session ${item.sessionId} (${why}); sending it as plain formatted text`)
      this.outbox.replace(item.id, textPieces(item.text, true).map((p, i) => ({ ...p, silent: item.silent || i > 0 })))
      return
    }
    if (item.files?.some(f => f.kind === 'photo') && e instanceof TelegramError && /PHOTO_|IMAGE_PROCESS_FAILED/i.test(e.description)) {
      this.log.warn(`Telegram rejected photos for session ${item.sessionId} (${why}); sending them as documents`)
      const files = item.files.map(f => (f.kind === 'photo' ? { ...f, kind: 'document' as const } : f))
      const caption = { text: item.text, entities: item.entities ?? [] }
      this.outbox.replace(item.id, albums(files).map((g, i) => filesPiece(g, i === 0 ? caption : undefined, !item.silent && i === 0)))
      return
    }
    if (item.entities?.length) {
      this.log.warn(`Telegram rejected a formatted message for session ${item.sessionId} (${why}); sending it without formatting`)
      this.outbox.dropEntities(item.id)
      return
    }
    this.reject(item, e instanceof TelegramError ? e.description : why)
  }

  // Explicit beats silent: the topic learns that a message is missing, the
  // log keeps its text.
  private reject(item: OutItem, reason: string): void {
    if (item.files) {
      this.log.error(`Telegram did not take files for session ${item.sessionId}: ${reason}\n--- files ---\n${names(item.files)}\n--- end ---`)
      this.fileMessages.get(messageOf(item.id))?.errors.push(`${names(item.files)}: ${reason}`)
      this.dropFiles(item.files)
      this.outbox.replaceWithNotice(item.id, `⚠️ Telegram не принял ${item.files.length === 1 ? 'файл' : 'файлы'} ${names(item.files)}: ${reason}`)
      return
    }
    this.log.error(`Telegram rejected a message for session ${item.sessionId}: ${reason}\n--- text ---\n${item.text}\n--- end ---`)
    if (item.notice) {
      this.outbox.remove(item.id)
      this.settled(item)
    } else this.outbox.replaceWithNotice(item.id, `⚠️ Telegram не принял сообщение: ${reason}. Текст в hub.log.`)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const onAbort = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        this.abort.signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      this.abort.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  // Text a window could not hand to a hub before it closed.
  private ingestSpool(): void {
    const dir = this.opts.spoolDir
    if (!dir) return
    let files: string[]
    try {
      files = readdirSync(dir).filter(f => f.endsWith('.json'))
    } catch {
      return
    }
    for (const f of files) {
      const path = join(dir, f)
      try {
        // Older plugins wrote text items without a type.
        const items = JSON.parse(readFileSync(path, 'utf8')) as (Extract<PluginToHub, { type: 'sendFiles' }> | { type?: 'send'; id: string; sessionId: string; text: string; notify: boolean })[]
        if (!Array.isArray(items)) throw new Error('not a list')
        for (const it of items) {
          if (it.type === 'sendFiles') this.enqueueFiles(it)
          else this.enqueue(it.sessionId, it.id, it.text, it.notify)
        }
        unlinkSync(path)
        this.log.info(`took ${items.length} message(s) from ${path}`)
      } catch (e) {
        const aside = `${path}.corrupt-${Date.now()}`
        try {
          renameSync(path, aside)
        } catch {}
        this.log.error(`spool file ${path} is unreadable (${e}); kept as ${aside}`)
      }
    }
  }

  private async sendToTopic(api: TelegramApi, groupId: string, sessionId: string, send: (threadId: number) => Promise<unknown>): Promise<void> {
    const rec = this.store.get(sessionId)!
    try {
      await send(rec.topicId)
    } catch (e) {
      if (!isThreadNotFound(e)) throw e
      // The topic was deleted by hand: give the session a new one.
      const topic = await api.createForumTopic(groupId, topicName(rec.project, rec.title))
      this.store.set(sessionId, { ...rec, topicId: topic.message_thread_id })
      this.log.warn(`topic ${rec.topicId} of session ${sessionId} is gone, created ${topic.message_thread_id}`)
      await send(topic.message_thread_id)
    }
  }

  // --- Telegram polling ----------------------------------------------------

  // getMe is a short request with a quick timeout, so it is what fights its way
  // through a flaky network; the long poll then reuses the warm connection.
  // A failed connect inside the long poll would otherwise hang for the whole
  // poll timeout.
  private async pollLoop(api: TelegramApi): Promise<void> {
    let offset = 0
    let online = false
    let wasOnline = false
    let failures = 0
    while (this.running) {
      if (!online) {
        try {
          const me = await api.getMe(this.abort.signal)
          this.log.info(wasOnline ? 'Telegram polling works again' : `polling Telegram as @${me.username ?? me.id}`)
          if (!wasOnline) {
            this.botUsername = me.username
            void this.registerCommands(api)
          }
          online = wasOnline = true
          failures = 0
        } catch (e) {
          if (!this.running) return
          if (e instanceof TelegramError && e.code === 401) {
            this.log.error('bot token rejected by Telegram (401 Unauthorized) — fix TELEGRAM_BOT_TOKEN in .env and restart the hub; not polling')
            return
          }
          this.log.warn(`Telegram unreachable (${e}); still trying`)
          await Bun.sleep(this.opts.pollRetryBaseMs ?? 1000)
          continue
        }
      }
      let updates: Update[]
      try {
        updates = await api.getUpdates(offset, this.opts.pollTimeoutSec ?? 25, this.abort.signal)
        if (failures) this.log.info('Telegram polling works again')
        failures = 0
      } catch (e) {
        if (!this.running) return
        if (!(e instanceof TelegramError)) {
          this.log.warn(`getUpdates lost the connection (${e}); reconnecting`)
          online = false
          continue
        }
        failures++
        const delay = Math.min((this.opts.pollRetryBaseMs ?? 1000) * failures, MAX_POLL_DELAY_MS)
        const conflict = e.code === 409
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
    const cmd = m.text !== undefined ? commandOf(m.text, this.botUsername) : undefined
    if (cmd) return this.queueCommand(route.sessionId, cmd)
    this.setEnabled(route.sessionId, true)
    const { content, meta } = await this.inboundOf(api, m)
    this.send(ws, { type: 'inbound', content, meta })
    this.log.info(`message ${m.message_id} in topic ${route.topicId} → session ${route.sessionId}: ${shapeOf(m, content)}`)
  }

  // Photos inside are downloaded like a photo message; a photo that fails keeps
  // its file_id in the text, as other files do.
  private async richContent(api: TelegramApi, rich: RichMessage): Promise<string> {
    const paths = new Map<string, string>()
    for (const id of richPhotos(rich)) {
      try {
        paths.set(id, await api.downloadFile(id, this.opts.inboxDir))
      } catch (e) {
        this.log.warn(`photo download failed: ${e}`)
      }
    }
    return richToMarkdown(rich, paths)
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
    let content = m.text ?? m.caption ?? (m.rich_message ? await this.richContent(api, m.rich_message) : undefined)
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

// Queue item ids are `<plugin message id>#<n>`, replacements add `.<m>`.
function messageOf(itemId: string): string {
  return itemId.slice(0, itemId.lastIndexOf('#'))
}

function names(files: OutFile[]): string {
  return files.map(f => f.name).join(', ')
}

// Text in pieces of at most one plain message, silent; markdown: formatted
// with entities.
function textPieces(text: string, markdown: boolean): Piece[] {
  return chunk(markdown ? toTelegram(text) : { text, entities: [] }).map(p => ({ text: p.text, silent: true, ...(p.entities.length ? { entities: p.entities } : {}) }))
}

function filesPiece(files: OutFile[], caption: Formatted | undefined, loud: boolean): Piece {
  return {
    text: caption?.text ?? '',
    silent: !loud,
    files,
    ...(caption?.entities.length ? { entities: caption.entities } : {}),
  }
}

// What a delivered message was, for the log: its kind, length and formatting,
// never its text.
function shapeOf(m: Message, content: string): string {
  const kind = (['rich_message', 'photo', 'document', 'voice', 'audio', 'video', 'video_note', 'sticker'] as const).find(k => m[k]) ?? 'text'
  const types = [...new Set((m.entities ?? m.caption_entities ?? []).map(e => e.type))]
  return `${kind}, ${content.length} chars${types.length ? `, entities ${types.join(', ')}` : ''}`
}

// Uploader-controlled names land inside the <channel> tag; strip delimiters.
function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;"]/g, '_')
}

export function projectName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd
}
