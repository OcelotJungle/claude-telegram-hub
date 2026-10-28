// In-process fake of the Telegram Bot API, enough for the hub: long-poll
// getUpdates (with the real "terminated by other getUpdates request" conflict),
// sendMessage, sendRichMessage, media uploads (multipart), forum topics, getFile and file download.
import type { Server } from "bun";
import type { Update } from "../src/hub/telegram.ts";

import { z } from "zod";
import { updateSchema } from "../src/hub/telegram.ts";
import { arr, field, isObject } from "../src/shared/guards.ts";

// Request params as the bot sent them.
type Params = Record<string, unknown>;
type Call = { method: string; params: Params };
type Failure = { code: number; description: string; retry_after?: number };

// One message_id sequence for the bot's messages and the user's, as in a
// real chat: a message sent after another has a larger id.
let messageCounter = 1;

const sentText = z.looseObject({ text: z.string() });

export class FakeTelegram {
  readonly token = "123456:TEST";
  calls: Call[] = [];
  conflicts = 0;
  private server: Server<undefined>;
  private updates: Update[] = [];
  private nextUpdateId = 1;
  private nextThreadId = 100;
  private lastSent = 0;
  private waiting: { resolve: () => void } | undefined;
  private activePoll: { abort: (r: Response) => void } | undefined;
  private failures = new Map<string, Failure[]>();
  private hangs = new Map<string, number>();
  private delays = new Map<string, number>();
  private holds = new Map<string, Promise<void>>();
  private deletedTopics = new Set<number>();
  files = new Map<string, { path: string; body: Uint8Array }>();

  constructor() {
    this.server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: req => this.handle(req),
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  stop(): void {
    this.waiting?.resolve();
    this.server.stop(true);
  }

  pushUpdate(u: Update): Update {
    const full = { ...u, update_id: this.nextUpdateId++ };
    this.updates.push(full);
    this.waiting?.resolve();
    return full;
  }

  failNext(method: string, f: Failure): void {
    const list = this.failures.get(method) ?? [];
    list.push(f);
    this.failures.set(method, list);
  }

  // The next `count` calls of `method` are never answered, like a connection
  // the network silently drops.
  hangNext(method: string, count = 1): void {
    this.hangs.set(method, (this.hangs.get(method) ?? 0) + count);
  }

  // The next call of `method` is answered only after `ms`, like a slow network.
  delayNext(method: string, ms: number): void {
    this.delays.set(method, ms);
  }

  // The next call of `method` is received (and recorded) but answered only
  // once the returned function is called.
  holdNext(method: string): () => void {
    let release = () => {};
    this.holds.set(method, new Promise<void>(resolve => { release = resolve; }));
    return release;
  }

  clearHangs(): void {
    this.hangs.clear();
  }

  deleteTopic(threadId: number): void {
    this.deletedTopics.add(threadId);
  }

  // The message_id of the last message sent.
  get lastMessageId(): number {
    return this.lastSent;
  }

  // The message_id the next message, the bot's or the user's, gets.
  get nextMessageId(): number {
    return messageCounter;
  }

  callsOf(method: string): Params[] {
    return this.calls.filter(c => c.method === method).map(c => c.params);
  }

  // Text messages in order, plain and rich; a rich one gets the text of its
  // blocks as `text`.
  texts(): z.infer<typeof sentText>[] {
    return this.calls
      .filter(c => c.method === "sendMessage" || c.method === "sendRichMessage")
      .map(c => sentText.parse(c.method === "sendRichMessage" ? { ...c.params, text: blocksText(field(c.params.rich_message, "blocks")) } : c.params));
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const filePrefix = `/file/bot${this.token}/`;
    if (url.pathname.startsWith(filePrefix)) {
      const path = url.pathname.slice(filePrefix.length);
      for (const f of this.files.values()) if (f.path === path) return new Response(Buffer.from(f.body));
      return new Response("not found", { status: 404 });
    }
    const m = url.pathname.match(/^\/bot([^/]+)\/(\w+)$/);
    if (!m || m[1] !== this.token) return json({ ok: false, error_code: 401, description: "Unauthorized" }, 401);
    const method = m[2] ?? "";
    const params = req.method !== "POST" ? {} : (req.headers.get("content-type") ?? "").startsWith("multipart/") ? await formParams(req) : jsonParams(await req.json().catch(() => ({})));
    this.calls.push({ method, params });

    const hang = this.hangs.get(method) ?? 0;
    if (hang > 0) {
      this.hangs.set(method, hang - 1);
      return new Promise<Response>(() => {});
    }
    const delay = this.delays.get(method);
    if (delay !== undefined) {
      this.delays.delete(method);
      await Bun.sleep(delay);
    }

    const hold = this.holds.get(method);
    if (hold) {
      this.holds.delete(method);
      await hold;
    }

    const fail = this.failures.get(method)?.shift();
    if (fail) {
      return json(
        { ok: false, error_code: fail.code, description: fail.description, ...(fail.retry_after != null ? { parameters: { retry_after: fail.retry_after } } : {}) },
        fail.code,
      );
    }

    switch (method) {
      case "getUpdates":
        return this.getUpdates(params);
      case "getMe":
        return ok({ id: 1, is_bot: true, username: "test_bot" });
      case "sendMessage":
      case "sendRichMessage":
      case "sendPhoto":
      case "sendVideo":
      case "sendAudio":
      case "sendAnimation":
      case "sendDocument":
      case "sendMediaGroup": {
        const thread = params.message_thread_id;
        if (thread != null && this.deletedTopics.has(Number(thread))) {
          return json({ ok: false, error_code: 400, description: "Bad Request: message thread not found" }, 400);
        }
        const message = () => ({ message_id: (this.lastSent = messageCounter++), chat: { id: Number(params.chat_id) }, text: params.text });
        return ok(method === "sendMediaGroup" ? arr(params.media).map(message) : message());
      }
      case "createForumTopic":
        return ok({ message_thread_id: this.nextThreadId++, name: params.name, icon_color: 0 });
      case "editForumTopic":
        return ok(true);
      case "getFile": {
        const f = this.files.get(String(params.file_id));
        if (!f) return json({ ok: false, error_code: 400, description: "Bad Request: invalid file_id" }, 400);
        return ok({ file_id: params.file_id, file_unique_id: `u${params.file_id}`, file_path: f.path });
      }
      default:
        return ok(true);
    }
  }

  private async getUpdates(params: Params): Promise<Response> {
    const offset = Number(params.offset ?? 0);
    if (offset > 0) this.updates = this.updates.filter(u => u.update_id >= offset);
    // A newer getUpdates terminates the one in progress, like Telegram does.
    if (this.activePoll) {
      this.conflicts++;
      this.activePoll.abort(
        json({ ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running" }, 409),
      );
    }
    const timeoutMs = Math.min(Number(params.timeout ?? 0), 2) * 1000;
    const ready = () => this.updates.filter(u => u.update_id >= offset);
    if (ready().length === 0 && timeoutMs > 0) {
      const res = await new Promise<Response | undefined>(resolve => {
        const timer = setTimeout(() => resolve(undefined), timeoutMs);
        const poll = {
          abort: (r: Response) => {
            clearTimeout(timer);
            resolve(r);
          },
        };
        this.activePoll = poll;
        this.waiting = {
          resolve: () => {
            clearTimeout(timer);
            resolve(undefined);
          },
        };
      });
      this.activePoll = undefined;
      this.waiting = undefined;
      if (res) return res;
    }
    return ok(ready());
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function ok(result: unknown): Response {
  return json({ ok: true, result });
}

export function topicMsg(o: {
  chatId: number | string;
  threadId?: number;
  fromId: number | string;
  text?: string;
  isTopic?: boolean;
  extra?: Record<string, unknown>;
}): Update {
  const isTopic = o.isTopic ?? o.threadId != null;
  // Checked like an update from Telegram; pushUpdate numbers it.
  return updateSchema.parse({
    update_id: 0,
    message: {
      message_id: messageCounter++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(o.chatId), type: "supergroup", title: "Hub", is_forum: true },
      from: { id: Number(o.fromId), is_bot: false, first_name: "User", username: "user" },
      ...(o.threadId != null ? { message_thread_id: o.threadId } : {}),
      ...(isTopic ? { is_topic_message: true } : {}),
      ...(o.text != null ? { text: o.text } : {}),
      ...o.extra,
    },
  });
}

// A press of an inline button under a bot message in the group.
export function buttonPress(o: { chatId: number | string; fromId: number | string; messageId: number; data: string }): Update {
  return updateSchema.parse({
    update_id: 0,
    callback_query: {
      id: `cq${messageCounter++}`,
      from: { id: Number(o.fromId), is_bot: false, first_name: "User" },
      chat_instance: "1",
      data: o.data,
      message: { message_id: o.messageId, date: Math.floor(Date.now() / 1000), chat: { id: Number(o.chatId), type: "supergroup" } },
    },
  });
}

function jsonParams(v: unknown): Params {
  return isObject(v) ? v : {};
}

// Multipart fields as the JSON body would carry them: numbers and booleans
// stay strings as sent, JSON fields (media, entities) are parsed, an uploaded
// file becomes { file: name, size, body }.
async function formParams(req: Request): Promise<Params> {
  const out: Params = {};
  for (const [key, value] of (await req.formData()).entries()) {
    const v: unknown = value;
    if (v instanceof File) out[key] = { file: v.name, size: v.size, body: await v.text() };
    else out[key] = key === "media" || key.endsWith("entities") ? JSON.parse(String(v)) : v;
  }
  return out;
}

function blocksText(blocks: unknown): string {
  const text = (t: unknown): string => (typeof t === "string" ? t : Array.isArray(t) ? t.map(text).join("") : text(field(t, "text") ?? ""));
  const block = (b: unknown): string =>
    field(b, "type") === "list"
      ? arr(field(b, "items"))
          .map(i => blocksText(field(i, "blocks")))
          .join("\n")
      : field(b, "blocks")
        ? blocksText(field(b, "blocks"))
        : field(b, "cells")
          ? arr(field(b, "cells"))
              .map(r => arr(r).map(c => text(field(c, "text"))).join(" | "))
              .join("\n")
          : text(field(b, "text"));
  return arr(blocks).map(block).join("\n\n");
}
