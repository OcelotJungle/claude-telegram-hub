import type { Logger } from "../shared/log.ts";
import type { Entity } from "../shared/markdown.ts";
import type { OutFile } from "../shared/media.ts";
import type { Block } from "./rich-out.ts";
import type { Button } from "./telegram.ts";

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "fs";
import { dirname } from "path";
import { z } from "zod";
import { entitySchema } from "../shared/markdown.ts";
import { outFileSchema } from "../shared/media.ts";
import { blockSchema } from "./rich-out.ts";

// Plugin message ids remembered after their pieces are sent, to recognise a
// plugin re-sending what the hub took before it crashed.
const MAX_SEEN = 5000;

// One Telegram send for a session's topic: a piece of text at most one
// message long, or files (one file or an album) with text as their caption.
// rich: the piece goes as a rich message, text is its Markdown source.
// notice: it replaced a piece Telegram rejected. buttons: an inline keyboard
// under a text piece. card: the piece is the first version of this subagent
// card; the hub sends the card's latest version in its place.
export type Piece = { text: string; silent: boolean; entities?: Entity[]; rich?: Block[]; files?: OutFile[]; notice?: boolean; buttons?: Button[][]; card?: string; cardReplyTo?: string; resolution?: { id: string; kind: "success" | "warning" }; keepId?: true };
export type OutItem = Piece & { id: string; sessionId: string };

type Data = { items: OutItem[]; seen: string[]; messageIds: Record<string, number> };

const dataSchema: z.ZodType<Data> = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      sessionId: z.string(),
      text: z.string(),
      silent: z.boolean(),
      entities: z.array(entitySchema).optional(),
      rich: z.array(blockSchema).optional(),
      files: z.array(outFileSchema).optional(),
      notice: z.boolean().optional(),
      buttons: z.array(z.array(z.object({ text: z.string(), data: z.string() }))).optional(),
      card: z.string().optional(),
      cardReplyTo: z.string().optional(),
      resolution: z.object({ id: z.string(), kind: z.enum(["success", "warning"]) }).optional(),
      keepId: z.literal(true).optional(),
    }),
  ),
  seen: z.array(z.string()),
  messageIds: z.record(z.string(), z.number()).catch({}),
});

// The hub's delivery queue, on disk: a piece is written here before the
// plugin gets its ack and leaves only after Telegram accepted it, so neither a
// dead network nor a dead hub loses text.
export class Outbox {
  private data: Data = { items: [], seen: [], messageIds: {} };

  constructor(
    private file: string,
    private log: Logger,
  ) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      return;
    }
    try {
      this.data = dataSchema.parse(JSON.parse(raw));
    } catch (e) {
      const aside = `${file}.corrupt-${Date.now()}`;
      try {
        renameSync(file, aside);
      } catch {}
      this.log.error(`outbox ${file} is unreadable (${e}); kept as ${aside}, starting with an empty queue`);
    }
  }

  get size(): number {
    return this.data.items.length;
  }

  // Queues the pieces of one plugin message; false if that message was
  // already queued.
  add(sourceId: string, sessionId: string, pieces: Piece[]): boolean {
    if (this.data.seen.includes(sourceId)) return false;
    pieces.forEach((p, i) => this.data.items.push({ ...p, id: `${sourceId}#${i}`, sessionId }));
    this.data.seen.push(sourceId);
    if (this.data.seen.length > MAX_SEEN) this.data.seen.splice(0, this.data.seen.length - MAX_SEEN);
    this.save();
    return true;
  }

  countOf(sessionId: string): number {
    return this.data.items.filter(i => i.sessionId === sessionId).length;
  }

  head(sessionId: string): OutItem | undefined {
    return this.data.items.find(i => i.sessionId === sessionId);
  }

  // Pieces of a plugin message are still queued.
  hasMessage(sourceId: string): boolean {
    return this.data.items.some(i => i.id.startsWith(`${sourceId}#`));
  }

  items(): readonly OutItem[] {
    return this.data.items;
  }

  sessions(): string[] {
    return [...new Set(this.data.items.map(i => i.sessionId))];
  }

  remove(id: string): void {
    this.data.items = this.data.items.filter(i => i.id !== id);
    this.save();
  }

  // Puts a loud notice in place of a piece, keeping its place in the queue.
  replaceWithNotice(id: string, text: string): void {
    const item = this.data.items.find(i => i.id === id);
    if (!item) return;
    item.text = text;
    item.silent = false;
    item.notice = true;
    delete item.entities;
    delete item.rich;
    delete item.files;
    delete item.buttons;
    this.save();
  }

  dropEntities(id: string): void {
    const item = this.data.items.find(i => i.id === id);
    if (!item) return;
    delete item.entities;
    this.save();
  }

  setText(id: string, text: string): void {
    const item = this.data.items.find(i => i.id === id);
    if (!item) return;
    item.text = text;
    delete item.entities;
    this.save();
  }

  messageId(id: string): number | undefined {
    return this.data.messageIds[id];
  }

  // Only a queued notice's id is kept: its result edits or deletes it later.
  recordMessageId(id: string, messageId: number): void {
    this.data.messageIds[id] = messageId;
    // A guard for notices whose result never comes (a window that died mid-compact).
    const ids = Object.keys(this.data.messageIds);
    if (ids.length > MAX_SEEN) for (const old of ids.slice(0, ids.length - MAX_SEEN)) delete this.data.messageIds[old];
    this.save();
  }

  // The id of a queued notice, forgotten once its result uses it.
  takeMessageId(id: string): number | undefined {
    const messageId = this.data.messageIds[id];
    if (messageId === undefined) return undefined;
    delete this.data.messageIds[id];
    this.save();
    return messageId;
  }

  setFiles(id: string, files: OutFile[]): void {
    const item = this.data.items.find(i => i.id === id);
    if (!item) return;
    item.files = files;
    this.save();
  }

  // Puts several pieces in place of one; they stay pieces of its message.
  replace(id: string, pieces: Piece[]): void {
    const at = this.data.items.findIndex(i => i.id === id);
    const old = this.data.items[at];
    if (at < 0 || !old) return;
    const { sessionId } = old;
    this.data.items.splice(at, 1, ...pieces.map((p, j) => ({ ...p, id: `${id}.${j}`, sessionId })));
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, JSON.stringify(this.data));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.file);
  }
}
