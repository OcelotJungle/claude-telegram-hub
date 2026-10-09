import type { TelegramMessage, TelegramUpdate } from "@gramio/types";
import type { Logger } from "../shared/log.ts";
import type { Entity } from "../shared/markdown.ts";
import type { OutFile } from "../shared/media.ts";
import type { Block } from "./rich-out.ts";

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { nullLogger } from "../shared/log.ts";

// Bot API types, generated from its documentation.
export type Message = TelegramMessage;
export type Update = TelegramUpdate;

export class TelegramError extends Error {
  constructor(
    readonly code: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(`Telegram ${code}: ${description}`);
  }
}

export function isThreadNotFound(e: unknown): boolean {
  return e instanceof TelegramError && e.code === 400 && /thread not found|TOPIC_DELETED|TOPIC_ID_INVALID/i.test(e.description);
}

const MAX_DELAY_MS = 15_000;
// An upload attempt may take as long as sending its bytes at this rate
// (64 KB/s), on top of the usual attempt timeout.
const UPLOAD_BYTES_PER_MS = 64;

// A request body: JSON params, or a multipart form built anew for each attempt.
type Body = object | (() => FormData);

type ApiOptions = {
  token: string;
  base?: string;
  log?: Logger;
  // Telegram API errors (5xx, 429): attempts with exponential backoff.
  maxAttempts?: number;
  baseDelayMs?: number;
  // Network errors. Some networks let only a fraction of connects to the Bot
  // API through, while an established connection works fine and is reused. So
  // an attempt that gets no answer is abandoned quickly instead of waiting for
  // the OS connect timeout (~21 s on Windows), and retried until the deadline.
  attemptTimeoutMs?: number;
  networkRetryMs?: number;
  deadlineMs?: number;
};

export class TelegramApi {
  private base: string;
  private log: Logger;
  private maxAttempts: number;
  private baseDelayMs: number;
  private attemptTimeoutMs: number;
  private networkRetryMs: number;
  private deadlineMs: number;

  constructor(private opts: ApiOptions) {
    this.base = opts.base ?? "https://api.telegram.org";
    this.log = opts.log ?? nullLogger;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.baseDelayMs = opts.baseDelayMs ?? 1000;
    this.attemptTimeoutMs = opts.attemptTimeoutMs ?? 5000;
    this.networkRetryMs = opts.networkRetryMs ?? 300;
    this.deadlineMs = opts.deadlineMs ?? 120_000;
  }

  // Retries network errors until the deadline, and 5xx and 429 (honouring
  // retry_after) up to maxAttempts; other API errors are thrown at once.
  // `waitMs` is how long Telegram may legitimately hold the request (long poll).
  async call<T>(method: string, params: Body, o: { signal?: AbortSignal; retry?: boolean; waitMs?: number } = {}): Promise<T> {
    const deadline = Date.now() + this.deadlineMs;
    let apiFailures = 0;
    let netFailures = 0;
    for (;;) {
      let wait: number;
      try {
        const result = await this.callOnce<T>(method, params, this.attemptTimeoutMs + (o.waitMs ?? 0), o.signal);
        if (netFailures) this.log.info(`telegram ${method} got through after ${netFailures} failed attempt(s)`);
        return result;
      } catch (e) {
        if (o.retry === false || o.signal?.aborted) throw e;
        if (e instanceof TelegramError) {
          if (!(e.code === 429 || e.code >= 500) || ++apiFailures >= this.maxAttempts) throw e;
          wait = e.retryAfter != null ? e.retryAfter * 1000 : Math.min(this.baseDelayMs * 2 ** (apiFailures - 1), MAX_DELAY_MS);
          this.log.warn(`telegram ${method} failed (${e.message}), retry ${apiFailures}/${this.maxAttempts - 1} in ${wait}ms`);
        } else {
          if (Date.now() + this.networkRetryMs >= deadline) throw e;
          wait = this.networkRetryMs;
          // One line per streak, not one per attempt.
          if (++netFailures === 1) this.log.warn(`telegram ${method}: no connection (${e instanceof Error ? e.message : e}), retrying`);
        }
      }
      await Bun.sleep(wait);
    }
  }

  private async callOnce<T>(method: string, params: Body, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await fetch(`${this.base}/bot${this.opts.token}/${method}`, {
      method: "POST",
      ...(typeof params === "function" ? { body: params() } : { headers: { "content-type": "application/json" }, body: JSON.stringify(params) }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    let body: any;
    try {
      body = await res.json();
    } catch (e) {
      if (timeout.aborted || signal?.aborted) throw e;
      throw new TelegramError(res.status, `non-JSON response (HTTP ${res.status})`);
    }
    if (!body.ok) throw new TelegramError(body.error_code ?? res.status, body.description ?? "unknown error", body.parameters?.retry_after);
    return body.result as T;
  }

  getMe(signal?: AbortSignal): Promise<{ id: number; username?: string }> {
    return this.call("getMe", {}, { signal });
  }

  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<Update[]> {
    return this.call<Update[]>("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message"] }, { signal, retry: false, waitMs: timeoutSec * 1000 });
  }

  sendMessage(chatId: string, threadId: number, text: string, silent: boolean, entities?: Entity[]): Promise<{ message_id: number }> {
    return this.call("sendMessage", { chat_id: chatId, message_thread_id: threadId, text, disable_notification: silent, ...(entities?.length ? { entities } : {}) });
  }

  sendRichMessage(chatId: string, threadId: number, blocks: Block[], silent: boolean): Promise<{ message_id: number }> {
    return this.call("sendRichMessage", { chat_id: chatId, message_thread_id: threadId, rich_message: { blocks }, disable_notification: silent });
  }

  // One file by the method of its kind, several as a media group with the
  // caption on the first item (Telegram shows it under the album).
  sendFiles(chatId: string, threadId: number, files: OutFile[], caption: string, captionEntities: Entity[] | undefined, silent: boolean): Promise<unknown> {
    const cap = caption ? { caption, ...(captionEntities?.length ? { caption_entities: captionEntities } : {}) } : {};
    const form = () => {
      const f = new FormData();
      f.set("chat_id", chatId);
      f.set("message_thread_id", String(threadId));
      f.set("disable_notification", String(silent));
      if (files.length === 1) {
        const file = files[0]!;
        f.set(file.kind, Bun.file(file.path), file.name);
        for (const [k, v] of Object.entries({ ...cap, ...videoFields(file) })) f.set(k, typeof v === "string" ? v : JSON.stringify(v));
        const thumb = thumbOf(file);
        if (thumb) f.set("thumbnail", Bun.file(thumb), "thumbnail.jpg");
      } else {
        const media = files.map((file, i) => ({
          type: file.kind,
          media: `attach://file${i}`,
          ...videoFields(file),
          ...(thumbOf(file) ? { thumbnail: `attach://thumb${i}` } : {}),
          ...(i === 0 ? cap : {}),
        }));
        f.set("media", JSON.stringify(media));
        files.forEach((file, i) => {
          f.set(`file${i}`, Bun.file(file.path), file.name);
          const thumb = thumbOf(file);
          if (thumb) f.set(`thumb${i}`, Bun.file(thumb), "thumbnail.jpg");
        });
      }
      return f;
    };
    const method = files.length === 1 ? `send${files[0]!.kind[0]!.toUpperCase()}${files[0]!.kind.slice(1)}` : "sendMediaGroup";
    const bytes = files.reduce((n, file) => n + file.size, 0);
    return this.call(method, form, { waitMs: bytes / UPLOAD_BYTES_PER_MS });
  }

  setMyCommands(commands: { command: string; description: string }[], signal?: AbortSignal): Promise<true> {
    return this.call("setMyCommands", { commands }, { signal });
  }

  createForumTopic(chatId: string, name: string): Promise<{ message_thread_id: number; name: string }> {
    return this.call("createForumTopic", { chat_id: chatId, name });
  }

  editForumTopic(chatId: string, threadId: number, name: string): Promise<true> {
    return this.call("editForumTopic", { chat_id: chatId, message_thread_id: threadId, name });
  }

  async downloadFile(fileId: string, destDir: string): Promise<string> {
    const file = await this.call<{ file_path?: string; file_unique_id?: string }>("getFile", { file_id: fileId });
    if (!file.file_path) throw new Error("Telegram returned no file_path — the file may have expired");
    const res = await fetch(`${this.base}/file/bot${this.opts.token}/${file.file_path}`, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const rawExt = file.file_path.includes(".") ? file.file_path.split(".").pop()! : "bin";
    const ext = rawExt.replace(/[^a-zA-Z0-9]/g, "") || "bin";
    const unique = (file.file_unique_id ?? "").replace(/[^a-zA-Z0-9_-]/g, "") || "dl";
    mkdirSync(destDir, { recursive: true });
    const path = join(destDir, `${Date.now()}-${unique}.${ext}`);
    writeFileSync(path, buf);
    return path;
  }
}

// Without these Telegram shows a big video as a black square with no duration
// that must be downloaded before it plays.
function videoFields(file: OutFile): { width?: number; height?: number; duration?: number; supports_streaming?: true } {
  const v = file.kind === "video" ? file.video : undefined;
  if (!v?.width || !v.height) return {};
  return { width: v.width, height: v.height, ...(v.duration ? { duration: v.duration } : {}), supports_streaming: true };
}

function thumbOf(file: OutFile): string | undefined {
  return file.kind === "video" ? file.video?.thumb : undefined;
}
