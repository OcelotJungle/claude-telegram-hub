import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import type { Logger } from '../shared/log.ts'
import type { HubToPlugin, PluginToHub } from '../shared/protocol.ts'

type Hello = Extract<PluginToHub, { type: 'hello' }>
type Outbox = { id: string; text: string; notify: boolean }
type Pending = { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }

const SPAWN_COOLDOWN_MS = 2000
const MAX_OUTBOX = 500

// Starts the hub as a detached process: not tied to this window, so closing
// the window that started it leaves the hub running for the others.
export function spawnHubDetached(hubMain: string, env?: Record<string, string>): void {
  const child = spawn(process.execPath, [hubMain], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: homedir(),
    env: { ...process.env, ...env },
  })
  child.on('error', () => {})
  child.unref()
}

// The plugin's link to the hub. Reconnects forever with backoff; when nobody
// listens it starts a hub (losers of a start race exit on EADDRINUSE). Text to
// send is kept until the hub acks it and is re-sent after a reconnect, so
// nothing is lost when the hub dies.
export class HubClient {
  private ws: WebSocket | undefined
  private stopped = true
  private attempt = 0
  private lastSpawn = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private outbox: Outbox[] = []
  private pending = new Map<string, Pending>()
  private waiters: (() => void)[] = []

  constructor(
    private opts: {
      port: number
      hello: () => Hello
      spawnHub: () => void
      onMessage(m: HubToPlugin): void
      log: Logger
      minDelayMs?: number
      maxDelayMs?: number
    },
  ) {}

  get connected(): boolean {
    return this.ws !== undefined
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    const ws = this.ws
    this.ws = undefined
    ws?.close()
  }

  send(msg: PluginToHub): void {
    if (!this.ws) return
    try {
      this.ws.send(JSON.stringify(msg))
    } catch {}
  }

  enqueue(text: string, notify: boolean): void {
    const item = { id: randomUUID(), text, notify }
    this.outbox.push(item)
    if (this.outbox.length > MAX_OUTBOX) {
      const dropped = this.outbox.shift()!
      this.opts.log.error(`outbox full, dropping: ${dropped.text}`)
    }
    this.send({ type: 'send', ...item })
  }

  // Resolves once every queued text is acked by the hub, or after timeoutMs.
  async drain(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.outbox.length > 0 && Date.now() < deadline) await Bun.sleep(25)
  }

  async request(op: string, extra: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<unknown> {
    const deadline = Date.now() + timeoutMs
    if (!this.ws) await this.waitConnected(timeoutMs)
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('hub did not answer in time'))
      }, Math.max(1, deadline - Date.now()))
      this.pending.set(id, { resolve, reject, timer })
      this.send({ type: 'req', id, op, ...extra } as PluginToHub)
    })
  }

  private waitConnected(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w !== done)
        reject(new Error('tg-hub: the hub is not reachable'))
      }, timeoutMs)
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      this.waiters.push(done)
    })
  }

  private connect(): void {
    if (this.stopped) return
    let opened = false
    const ws = new WebSocket(`ws://127.0.0.1:${this.opts.port}/ws`)
    ws.onopen = () => {
      if (this.stopped) return ws.close()
      opened = true
      this.attempt = 0
      this.ws = ws
      this.opts.log.info('connected to hub')
      this.send(this.opts.hello())
      for (const item of this.outbox) this.send({ type: 'send', ...item })
      for (const w of this.waiters.splice(0)) w()
    }
    ws.onmessage = e => this.onMessage(String(e.data))
    ws.onerror = () => {}
    ws.onclose = () => {
      if (this.ws === ws) {
        this.ws = undefined
        this.opts.log.warn('hub connection lost')
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer)
          p.reject(new Error('hub connection lost'))
          this.pending.delete(id)
        }
      }
      if (this.stopped) return
      if (!opened) this.maybeSpawn()
      this.scheduleReconnect()
    }
  }

  private maybeSpawn(): void {
    if (Date.now() - this.lastSpawn < SPAWN_COOLDOWN_MS) return
    this.lastSpawn = Date.now()
    this.opts.log.info('no hub listening — starting one')
    try {
      this.opts.spawnHub()
    } catch (e) {
      this.opts.log.error(`starting hub failed: ${e}`)
    }
  }

  private scheduleReconnect(): void {
    const min = this.opts.minDelayMs ?? 100
    const max = this.opts.maxDelayMs ?? 5000
    const delay = Math.min(min * 2 ** this.attempt, max) * (0.75 + Math.random() * 0.5)
    this.attempt++
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }

  private onMessage(raw: string): void {
    let m: HubToPlugin
    try {
      m = JSON.parse(raw)
    } catch {
      return
    }
    if (m.type === 'ack') {
      this.outbox = this.outbox.filter(o => o.id !== m.id)
      return
    }
    if (m.type === 'res') {
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      clearTimeout(p.timer)
      if (m.ok) p.resolve(m.result)
      else p.reject(new Error(m.error ?? 'hub error'))
      return
    }
    this.opts.onMessage(m)
  }
}
