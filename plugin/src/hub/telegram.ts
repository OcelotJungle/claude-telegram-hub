import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { nullLogger, type Logger } from '../shared/log.ts'

// Only the Bot API fields the hub reads.
export type User = { id: number; is_bot: boolean; first_name?: string; username?: string }
export type Chat = { id: number; type: string; title?: string; is_forum?: boolean }
export type PhotoSize = { file_id: string; file_unique_id: string; file_size?: number }
export type FileRef = { file_id: string; file_unique_id?: string; file_size?: number; mime_type?: string; file_name?: string }
export type Message = {
  message_id: number
  date: number
  chat: Chat
  from?: User
  message_thread_id?: number
  is_topic_message?: boolean
  text?: string
  caption?: string
  photo?: PhotoSize[]
  document?: FileRef
  voice?: FileRef
  audio?: FileRef & { title?: string }
  video?: FileRef
  video_note?: FileRef
  sticker?: FileRef & { emoji?: string }
}
export type Update = { update_id: number; message?: Message }

export class TelegramError extends Error {
  constructor(
    readonly code: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(`Telegram ${code}: ${description}`)
  }
}

export function isThreadNotFound(e: unknown): boolean {
  return e instanceof TelegramError && e.code === 400 && /thread not found|TOPIC_DELETED|TOPIC_ID_INVALID/i.test(e.description)
}

const MAX_DELAY_MS = 15_000

export class TelegramApi {
  private base: string
  private log: Logger
  private maxAttempts: number
  private baseDelayMs: number

  constructor(private opts: { token: string; base?: string; log?: Logger; maxAttempts?: number; baseDelayMs?: number }) {
    this.base = opts.base ?? 'https://api.telegram.org'
    this.log = opts.log ?? nullLogger
    this.maxAttempts = opts.maxAttempts ?? 5
    this.baseDelayMs = opts.baseDelayMs ?? 1000
  }

  // Retries network errors, 5xx and 429 (honouring retry_after); other API
  // errors are thrown at once.
  async call<T>(method: string, params: object, o: { signal?: AbortSignal; retry?: boolean } = {}): Promise<T> {
    const attempts = o.retry === false ? 1 : this.maxAttempts
    for (let attempt = 1; ; attempt++) {
      let wait: number
      try {
        return await this.callOnce<T>(method, params, o.signal)
      } catch (e) {
        const retryable = !(e instanceof TelegramError) || e.code === 429 || e.code >= 500
        if (!retryable || attempt >= attempts || o.signal?.aborted) throw e
        wait =
          e instanceof TelegramError && e.retryAfter != null
            ? e.retryAfter * 1000
            : Math.min(this.baseDelayMs * 2 ** (attempt - 1), MAX_DELAY_MS)
        this.log.warn(`telegram ${method} failed (${e instanceof Error ? e.message : e}), retry ${attempt}/${attempts - 1} in ${wait}ms`)
      }
      await Bun.sleep(wait)
    }
  }

  private async callOnce<T>(method: string, params: object, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.base}/bot${this.opts.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal,
    })
    let body: any
    try {
      body = await res.json()
    } catch {
      throw new TelegramError(res.status, `non-JSON response (HTTP ${res.status})`)
    }
    if (!body.ok) throw new TelegramError(body.error_code ?? res.status, body.description ?? 'unknown error', body.parameters?.retry_after)
    return body.result as T
  }

  getMe(signal?: AbortSignal): Promise<{ id: number; username?: string }> {
    return this.call('getMe', {}, { signal })
  }

  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<Update[]> {
    return this.call<Update[]>('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message'] }, { signal, retry: false })
  }

  sendMessage(chatId: string, threadId: number, text: string, silent: boolean): Promise<{ message_id: number }> {
    return this.call('sendMessage', { chat_id: chatId, message_thread_id: threadId, text, disable_notification: silent })
  }

  createForumTopic(chatId: string, name: string): Promise<{ message_thread_id: number; name: string }> {
    return this.call('createForumTopic', { chat_id: chatId, name })
  }

  editForumTopic(chatId: string, threadId: number, name: string): Promise<true> {
    return this.call('editForumTopic', { chat_id: chatId, message_thread_id: threadId, name })
  }

  async downloadFile(fileId: string, destDir: string): Promise<string> {
    const file = await this.call<{ file_path?: string; file_unique_id?: string }>('getFile', { file_id: fileId })
    if (!file.file_path) throw new Error('Telegram returned no file_path — the file may have expired')
    const res = await fetch(`${this.base}/file/bot${this.opts.token}/${file.file_path}`)
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : 'bin'
    const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
    const unique = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'dl'
    mkdirSync(destDir, { recursive: true })
    const path = join(destDir, `${Date.now()}-${unique}.${ext}`)
    writeFileSync(path, buf)
    return path
  }
}
