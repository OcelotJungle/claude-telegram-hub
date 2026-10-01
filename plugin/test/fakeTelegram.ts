// In-process fake of the Telegram Bot API, enough for the hub: long-poll
// getUpdates (with the real "terminated by other getUpdates request" conflict),
// sendMessage, forum topics, getFile and file download.
import type { Server } from 'bun'
import type { Update } from '../src/hub/telegram.ts'

type Call = { method: string; params: any }
type Failure = { code: number; description: string; retry_after?: number }

export class FakeTelegram {
  readonly token = '123456:TEST'
  calls: Call[] = []
  conflicts = 0
  private server: Server<undefined>
  private updates: Update[] = []
  private nextUpdateId = 1
  private nextThreadId = 100
  private nextMessageId = 1000
  private waiting: { resolve: () => void } | undefined
  private activePoll: { abort: (r: Response) => void } | undefined
  private failures = new Map<string, Failure[]>()
  private hangs = new Map<string, number>()
  private deletedTopics = new Set<number>()
  files = new Map<string, { path: string; body: Uint8Array }>()

  constructor() {
    this.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: req => this.handle(req),
    })
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`
  }

  stop(): void {
    this.waiting?.resolve()
    this.server.stop(true)
  }

  pushUpdate(u: Omit<Update, 'update_id'>): Update {
    const full = { update_id: this.nextUpdateId++, ...u } as Update
    this.updates.push(full)
    this.waiting?.resolve()
    return full
  }

  failNext(method: string, f: Failure): void {
    const list = this.failures.get(method) ?? []
    list.push(f)
    this.failures.set(method, list)
  }

  // The next `count` calls of `method` are never answered, like a connection
  // the network silently drops.
  hangNext(method: string, count = 1): void {
    this.hangs.set(method, (this.hangs.get(method) ?? 0) + count)
  }

  deleteTopic(threadId: number): void {
    this.deletedTopics.add(threadId)
  }

  callsOf(method: string): any[] {
    return this.calls.filter(c => c.method === method).map(c => c.params)
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const filePrefix = `/file/bot${this.token}/`
    if (url.pathname.startsWith(filePrefix)) {
      const path = url.pathname.slice(filePrefix.length)
      for (const f of this.files.values()) if (f.path === path) return new Response(Buffer.from(f.body))
      return new Response('not found', { status: 404 })
    }
    const m = url.pathname.match(/^\/bot([^/]+)\/(\w+)$/)
    if (!m || m[1] !== this.token) return json({ ok: false, error_code: 401, description: 'Unauthorized' }, 401)
    const method = m[2]!
    const params = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
    this.calls.push({ method, params })

    const hang = this.hangs.get(method) ?? 0
    if (hang > 0) {
      this.hangs.set(method, hang - 1)
      return new Promise<Response>(() => {})
    }

    const fail = this.failures.get(method)?.shift()
    if (fail) {
      return json(
        { ok: false, error_code: fail.code, description: fail.description, ...(fail.retry_after != null ? { parameters: { retry_after: fail.retry_after } } : {}) },
        fail.code,
      )
    }

    switch (method) {
      case 'getUpdates':
        return this.getUpdates(params)
      case 'getMe':
        return ok({ id: 1, is_bot: true, username: 'test_bot' })
      case 'sendMessage': {
        const thread = params.message_thread_id
        if (thread != null && this.deletedTopics.has(thread)) {
          return json({ ok: false, error_code: 400, description: 'Bad Request: message thread not found' }, 400)
        }
        return ok({ message_id: this.nextMessageId++, chat: { id: Number(params.chat_id) }, text: params.text })
      }
      case 'createForumTopic':
        return ok({ message_thread_id: this.nextThreadId++, name: params.name, icon_color: 0 })
      case 'editForumTopic':
        return ok(true)
      case 'getFile': {
        const f = this.files.get(params.file_id)
        if (!f) return json({ ok: false, error_code: 400, description: 'Bad Request: invalid file_id' }, 400)
        return ok({ file_id: params.file_id, file_unique_id: `u${params.file_id}`, file_path: f.path })
      }
      default:
        return ok(true)
    }
  }

  private async getUpdates(params: any): Promise<Response> {
    const offset = Number(params.offset ?? 0)
    if (offset > 0) this.updates = this.updates.filter(u => u.update_id >= offset)
    // A newer getUpdates terminates the one in progress, like Telegram does.
    if (this.activePoll) {
      this.conflicts++
      this.activePoll.abort(
        json({ ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running' }, 409),
      )
    }
    const timeoutMs = Math.min(Number(params.timeout ?? 0), 2) * 1000
    const ready = () => this.updates.filter(u => u.update_id >= offset)
    if (ready().length === 0 && timeoutMs > 0) {
      const res = await new Promise<Response | undefined>(resolve => {
        const timer = setTimeout(() => resolve(undefined), timeoutMs)
        const poll = {
          abort: (r: Response) => {
            clearTimeout(timer)
            resolve(r)
          },
        }
        this.activePoll = poll
        this.waiting = {
          resolve: () => {
            clearTimeout(timer)
            resolve(undefined)
          },
        }
      })
      this.activePoll = undefined
      this.waiting = undefined
      if (res) return res
    }
    return ok(ready())
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function ok(result: unknown): Response {
  return json({ ok: true, result })
}

let messageCounter = 1

export function topicMsg(o: {
  chatId: number | string
  threadId?: number
  fromId: number | string
  text?: string
  isTopic?: boolean
  extra?: Record<string, unknown>
}): Omit<Update, 'update_id'> {
  const isTopic = o.isTopic ?? o.threadId != null
  return {
    message: {
      message_id: messageCounter++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(o.chatId), type: 'supergroup', title: 'Hub', is_forum: true },
      from: { id: Number(o.fromId), is_bot: false, first_name: 'User', username: 'user' },
      ...(o.threadId != null ? { message_thread_id: o.threadId } : {}),
      ...(isTopic ? { is_topic_message: true } : {}),
      ...(o.text != null ? { text: o.text } : {}),
      ...o.extra,
    },
  } as Omit<Update, 'update_id'>
}
