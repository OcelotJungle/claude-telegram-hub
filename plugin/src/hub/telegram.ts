import type { TelegramMessage, TelegramUpdate } from "@gramio/types";
import type { Logger } from "../shared/log.ts";
import type { Entity } from "../shared/markdown.ts";
import type { OutFile } from "../shared/media.ts";
import type { Priority } from "./pace.ts";
import type { Block } from "./rich-out.ts";

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { API_BASE } from "../shared/config.ts";
import { field } from "../shared/guards.ts";
import { nullLogger } from "../shared/log.ts";
import { Pace } from "./pace.ts";

const MS_PER_SECOND = 1000;
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 15_000;
const ATTEMPT_TIMEOUT_MS = 5000;
const SEND_ATTEMPT_TIMEOUT_MS = 60_000;
const NETWORK_RETRY_MS = 300;
const DEADLINE_MS = 120_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
// An upload attempt may take as long as sending its bytes at this rate
// (64 KB/s), on top of the usual attempt timeout.
const UPLOAD_BYTES_PER_MS = 64;
// Telegram lets a bot post about 20 messages a minute in a group, edits
// included; past that it answers 429 and makes the bot wait some 40 s. So
// posts and edits are paced here instead of running into the limit.
const GROUP_POSTS = 20;
const GROUP_POSTS_PER_MS = 60_000;

// Bot API types, generated from its documentation.
export type Message = TelegramMessage;
export type Update = TelegramUpdate;
// An inline keyboard button; data comes back in the callback query.
export type Button = { text: string; data: string };

// The envelope of every Bot API answer.
const answerSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error_code: z.number().optional(),
  description: z.string().optional(),
  parameters: z.object({ retry_after: z.number().optional() }).optional(),
});

// Results are checked for the fields the hub reads.
const meSchema = z.object({ id: z.number(), username: z.string().optional() });
const sentSchema = z.object({ message_id: z.number() });
const topicSchema = z.object({ message_thread_id: z.number(), name: z.string() });
const fileSchema = z.object({ file_path: z.string().optional(), file_unique_id: z.string().optional() });
// An update keeps every field Telegram sent, typed by the Bot API
// documentation; what routing relies on is checked.
export const updateSchema = z.custom<Update>(isUpdate);
const updatesSchema = z.array(updateSchema);

function isUpdate(v: unknown): v is Update {
  if (typeof field(v, "update_id") !== "number") return false;
  const m = field(v, "message");
  return m === undefined || (typeof field(m, "message_id") === "number" && typeof field(field(m, "chat"), "id") === "number");
}

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
  // A send that may already be in the chat is not abandoned that quickly: a
  // slow answer to it is waited for, as a retry would post the message twice.
  sendAttemptTimeoutMs?: number;
  networkRetryMs?: number;
  deadlineMs?: number;
  groupPace?: { count: number; perMs: number };
};

// Calls that go on while the bot waits out a flood limit: polling, and
// answers to button presses, which are not messages in a chat.
const FLOOD_FREE = new Set(["getUpdates", "getMe", "answerCallbackQuery"]);
// Calls that put something in the group or change it, and so count towards
// its limit; a new message goes before an edit.
const PACED: Record<string, Priority> = {
  sendMessage: "send",
  sendRichMessage: "send",
  sendPhoto: "send",
  sendVideo: "send",
  sendAudio: "send",
  sendAnimation: "send",
  sendDocument: "send",
  sendMediaGroup: "send",
  createForumTopic: "send",
  editMessageText: "edit",
  editMessageReplyMarkup: "edit",
  editForumTopic: "edit",
};

export class TelegramApi {
  private base: string;
  private log: Logger;
  private maxAttempts: number;
  private baseDelayMs: number;
  private attemptTimeoutMs: number;
  private sendAttemptTimeoutMs: number;
  private networkRetryMs: number;
  private deadlineMs: number;
  // Until when Telegram asked the bot to wait (429 retry_after).
  private floodUntil = 0;
  private pace: Pace;

  constructor(private opts: ApiOptions) {
    this.base = opts.base ?? API_BASE;
    this.log = opts.log ?? nullLogger;
    this.maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
    this.baseDelayMs = opts.baseDelayMs ?? BASE_DELAY_MS;
    this.attemptTimeoutMs = opts.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;
    this.sendAttemptTimeoutMs = opts.sendAttemptTimeoutMs ?? SEND_ATTEMPT_TIMEOUT_MS;
    this.networkRetryMs = opts.networkRetryMs ?? NETWORK_RETRY_MS;
    this.deadlineMs = opts.deadlineMs ?? DEADLINE_MS;
    this.pace = new Pace(opts.groupPace?.count ?? GROUP_POSTS, opts.groupPace?.perMs ?? GROUP_POSTS_PER_MS);
  }

  // When the current flood wait ends; in the past if there is none.
  floodEndsAt(): number {
    return this.floodUntil;
  }

  // Retries network errors until the deadline, and 5xx and 429 (honouring
  // retry_after) up to maxAttempts; other API errors are thrown at once.
  // `waitMs` is how long Telegram may legitimately hold the request (long poll).
  // A 429 holds every call to chats until retry_after passes: more requests
  // meanwhile only get more 429s. A call without retries is not held but fails.
  // A paced call takes one slot of the group's pace, whatever its attempts:
  // during an outage they mostly never reach Telegram.
  async call<T>(method: string, params: Body, result: z.ZodType<T>, o: { signal?: AbortSignal; retry?: boolean; waitMs?: number; sends?: boolean } = {}): Promise<T> {
    const priority = PACED[method];
    if (priority) await this.pace.take(priority);
    const deadline = Date.now() + this.deadlineMs;
    const timeoutMs = (o.sends ? this.sendAttemptTimeoutMs : this.attemptTimeoutMs) + (o.waitMs ?? 0);
    let apiFailures = 0;
    let netFailures = 0;
    for (;;) {
      const flood = FLOOD_FREE.has(method) ? 0 : this.floodUntil - Date.now();
      if (flood > 0) {
        if (o.retry === false) throw new TelegramError(429, "Too Many Requests: waiting out the flood limit", Math.ceil(flood / MS_PER_SECOND));
        await Bun.sleep(flood);
      }
      let wait: number;
      try {
        const answer = await this.callOnce(method, params, result, timeoutMs, o.signal);
        if (netFailures) this.log.info(`telegram ${method} got through after ${netFailures} failed attempt(s)`);
        return answer;
      } catch (e) {
        if (e instanceof TelegramError && e.code === 429 && e.retryAfter != null) this.floodUntil = Math.max(this.floodUntil, Date.now() + e.retryAfter * MS_PER_SECOND);
        if (o.retry === false || o.signal?.aborted) throw e;
        if (e instanceof TelegramError) {
          if (!(e.code === 429 || e.code >= 500) || ++apiFailures >= this.maxAttempts) throw e;
          wait = e.retryAfter != null ? e.retryAfter * MS_PER_SECOND : Math.min(this.baseDelayMs * 2 ** (apiFailures - 1), MAX_DELAY_MS);
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

  private async callOnce<T>(method: string, params: Body, result: z.ZodType<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await fetch(`${this.base}/bot${this.opts.token}/${method}`, {
      method: "POST",
      ...(typeof params === "function" ? { body: params() } : { headers: { "content-type": "application/json" }, body: JSON.stringify(params) }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      if (timeout.aborted || signal?.aborted) throw e;
      throw new TelegramError(res.status, `non-JSON response (HTTP ${res.status})`);
    }
    const answer = answerSchema.safeParse(json);
    if (!answer.success) throw new TelegramError(res.status, `not a Bot API response (HTTP ${res.status})`);
    const body = answer.data;
    if (!body.ok) throw new TelegramError(body.error_code ?? res.status, body.description ?? "unknown error", body.parameters?.retry_after);
    const parsed = result.safeParse(body.result);
    if (!parsed.success) throw new TelegramError(res.status, `unexpected ${method} result: ${z.prettifyError(parsed.error)}`);
    return parsed.data;
  }

  getMe(signal?: AbortSignal): Promise<{ id: number; username?: string }> {
    return this.call("getMe", {}, meSchema, { signal });
  }

  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<Update[]> {
    return this.call("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] }, updatesSchema, { signal, retry: false, waitMs: timeoutSec * MS_PER_SECOND });
  }

  sendMessage(chatId: string, threadId: number, text: string, silent: boolean, entities?: Entity[], buttons?: Button[][], replyTo?: number): Promise<{ message_id: number }> {
    return this.call(
      "sendMessage",
      { chat_id: chatId, message_thread_id: threadId, text, disable_notification: silent, ...(entities?.length ? { entities } : {}), ...keyboard(buttons), ...(replyTo === undefined ? {} : { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }) },
      sentSchema,
      { sends: true },
    );
  }

  // Without buttons the message loses its keyboard.
  editMessageText(chatId: string, messageId: number, text: string, entities?: Entity[], buttons?: Button[][]): Promise<unknown> {
    return this.call("editMessageText", { chat_id: chatId, message_id: messageId, text, ...(entities?.length ? { entities } : {}), ...keyboard(buttons) }, z.unknown());
  }

  removeKeyboard(chatId: string, messageId: number): Promise<unknown> {
    return this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId }, z.unknown());
  }

  deleteMessage(chatId: string, messageId: number): Promise<unknown> {
    return this.call("deleteMessage", { chat_id: chatId, message_id: messageId }, z.unknown());
  }

  answerCallbackQuery(id: string, text?: string): Promise<unknown> {
    return this.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) }, z.unknown());
  }

  // "typing…" in a topic for up to 5 seconds. One attempt: the next one is
  // seconds away anyway.
  sendTyping(chatId: string, threadId: number): Promise<unknown> {
    return this.call("sendChatAction", { chat_id: chatId, message_thread_id: threadId, action: "typing" }, z.unknown(), { retry: false });
  }

  // Without an emoji the bot's reaction comes off.
  setMessageReaction(chatId: string, messageId: number, emoji?: string): Promise<unknown> {
    return this.call("setMessageReaction", { chat_id: chatId, message_id: messageId, reaction: emoji ? [{ type: "emoji", emoji }] : [] }, z.unknown());
  }

  sendRichMessage(chatId: string, threadId: number, blocks: Block[], silent: boolean): Promise<{ message_id: number }> {
    return this.call("sendRichMessage", { chat_id: chatId, message_thread_id: threadId, rich_message: { blocks }, disable_notification: silent }, sentSchema, { sends: true });
  }

  // One file by the method of its kind, several as a media group with the
  // caption on the first item (Telegram shows it under the album).
  sendFiles(chatId: string, threadId: number, files: OutFile[], caption: string, captionEntities: Entity[] | undefined, silent: boolean): Promise<unknown> {
    const cap = caption ? { caption, ...(captionEntities?.length ? { caption_entities: captionEntities } : {}) } : {};
    const single = files.length === 1 ? files[0] : undefined;
    const form = () => {
      const f = new FormData();
      f.set("chat_id", chatId);
      f.set("message_thread_id", String(threadId));
      f.set("disable_notification", String(silent));
      if (single) {
        f.set(single.kind, Bun.file(single.path), single.name);
        for (const [k, v] of Object.entries({ ...cap, ...videoFields(single) })) f.set(k, typeof v === "string" ? v : JSON.stringify(v));
        const thumb = thumbOf(single);
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
    const method = single ? `send${single.kind.charAt(0).toUpperCase()}${single.kind.slice(1)}` : "sendMediaGroup";
    const bytes = files.reduce((n, file) => n + file.size, 0);
    return this.call(method, form, z.unknown(), { waitMs: bytes / UPLOAD_BYTES_PER_MS, sends: true });
  }

  setMyCommands(commands: { command: string; description: string }[], signal?: AbortSignal): Promise<true> {
    return this.call("setMyCommands", { commands }, z.literal(true), { signal });
  }

  createForumTopic(chatId: string, name: string): Promise<{ message_thread_id: number; name: string }> {
    return this.call("createForumTopic", { chat_id: chatId, name }, topicSchema, { sends: true });
  }

  editForumTopic(chatId: string, threadId: number, name: string): Promise<true> {
    return this.call("editForumTopic", { chat_id: chatId, message_thread_id: threadId, name }, z.literal(true));
  }

  async downloadFile(fileId: string, destDir: string): Promise<string> {
    const file = await this.call("getFile", { file_id: fileId }, fileSchema);
    if (!file.file_path) throw new Error("Telegram returned no file_path — the file may have expired");
    const res = await fetch(`${this.base}/file/bot${this.opts.token}/${file.file_path}`, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const rawExt = file.file_path.includes(".") ? (file.file_path.split(".").at(-1) ?? "") : "";
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

function keyboard(buttons: Button[][] | undefined): { reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } } {
  if (!buttons?.length) return {};
  return { reply_markup: { inline_keyboard: buttons.map(row => row.map(b => ({ text: b.text, callback_data: b.data }))) } };
}

function thumbOf(file: OutFile): string | undefined {
  return file.kind === "video" ? file.video?.thumb : undefined;
}
