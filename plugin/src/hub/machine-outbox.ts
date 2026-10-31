import type { Button, TelegramApi } from "./telegram.ts";

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { z } from "zod";
import { chunk } from "../shared/chunk.ts";
import { toTelegram } from "../shared/markdown.ts";
import { TelegramError } from "./telegram.ts";

const BAD_REQUEST = 400;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
// Ids of finished work are kept to recognise a repeated post; a repeat only comes soon after the first, so a long tail is not needed.
const REMEMBERED_IDS = 1000;
const destinationSchema = z.object({ chatId: z.string(), topicId: z.number().optional() });
const buttonSchema = z.object({ text: z.string(), data: z.string() });
const confirmationSchema = z.object({ message: z.object({ message_id: z.number() }), destination: destinationSchema, recovery: z.string().optional(), sentAt: z.number().optional() });
const itemSchema = z.object({
  id: z.string(), destination: destinationSchema, text: z.string(), silent: z.boolean(),
  card: z.boolean(), buttons: z.array(z.array(buttonSchema)).optional(),
  file: z.string().optional(),
});
const dataSchema = z.object({ items: z.array(itemSchema), messages: z.record(z.string(), z.number()), delivered: z.array(z.string()), shown: z.record(z.string(), z.string()).default({}), confirmations: z.record(z.string(), confirmationSchema).default({}), handled: z.array(z.string()).default([]), progress: z.record(z.string(), z.number()).default({}) });
export type MachineDestination = z.infer<typeof destinationSchema>;
export type RigConfirmation = z.infer<typeof confirmationSchema>;
type Item = z.infer<typeof itemSchema>;

// The outbox id of the prompt a confirmation was asked with.
export function confirmationPromptId(confirmation: Pick<RigConfirmation, "destination" | "message">): string {
  return `machine-${confirmation.destination.chatId}-${confirmation.message.message_id}`;
}

function notModified(error: unknown): boolean {
  return error instanceof TelegramError && error.code === BAD_REQUEST && /message is not modified/i.test(error.description);
}

// Telegram refused the request itself (bad request, forbidden, not found); a network failure, a flood wait or a server error may pass.
function permanent(error: unknown): boolean {
  return error instanceof TelegramError && (error.code === BAD_REQUEST || error.code === FORBIDDEN || error.code === NOT_FOUND);
}

// General has no session. Keep its sends and rig cards durable independently.
export class MachineOutbox {
  private data: z.infer<typeof dataSchema> = { items: [], messages: {}, delivered: [], shown: {}, confirmations: {}, handled: [], progress: {} };
  private flushing: Promise<void> | undefined;

  constructor(private file: string, private warn: (text: string) => void, private remembered = REMEMBERED_IDS) {
    try {
      this.data = dataSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch (error) {
      try { renameSync(file, `${file}.corrupt-${Date.now()}`); this.warn(`machine outbox unreadable: ${String(error)}`); } catch {}
    }
  }

  get size(): number { return this.data.items.length; }
  get busy(): boolean { return this.flushing !== undefined; }
  delivered(id: string): boolean { return this.data.delivered.includes(id); }
  // Delivered or still waiting: a post under this id would be ignored.
  known(id: string): boolean { return this.delivered(id) || this.data.items.some(item => item.id === id); }
  handled(id: string): boolean { return this.data.handled.includes(id); }
  markHandled(id: string): void { if (!this.handled(id)) { this.data.handled.push(id); this.save(); } }
  confirmations(): [string, RigConfirmation][] { return Object.entries(this.data.confirmations); }
  saveConfirmation(key: string, value: RigConfirmation): void { this.data.confirmations[key] = value; this.save(); }
  deleteConfirmation(key: string): void { delete this.data.confirmations[key]; this.save(); }

  post(id: string, destination: MachineDestination, text: string, silent = true, buttons?: Button[][], card = false, file?: string): void {
    if (!card && (this.delivered(id) || this.data.items.some(item => item.id === id))) return;
    const previous = this.data.items.find(item => item.id === id);
    if (!previous && card && this.data.shown[id] === text + JSON.stringify(buttons)) return;
    if (previous?.text === text && JSON.stringify(previous.buttons) === JSON.stringify(buttons)) return;
    const item: Item = { id, destination, text, silent, card, buttons, file };
    const index = this.data.items.findIndex(item => item.id === id);
    if (index < 0) this.data.items.push(item);
    else this.data.items[index] = item;
    this.data.delivered = this.data.delivered.filter(key => key !== id);
    delete this.data.progress[id];
    this.save();
  }

  flush(api: TelegramApi): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.send(api).finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  private async send(api: TelegramApi): Promise<void> {
    while (this.data.items.length) {
      const item = this.data.items[0];
      if (!item) return;
      if (item.file && !existsSync(item.file)) {
        this.drop(item, `log file is gone: ${item.file}`);
        continue;
      }
      try {
        if (await this.deliver(api, item)) this.accept(item);
      } catch (error) {
        // Telegram refusing this very request will refuse it again: the item goes, the queue does not stop.
        if (permanent(error)) {
          this.drop(item, String(error));
          continue;
        }
        this.warn(`machine delivery: ${String(error)}`);
        return;
      }
    }
  }

  // Pieces Telegram already took (`progress`) are not sent again after a failure of a later one.
  private async deliver(api: TelegramApi, item: Item): Promise<boolean> {
    const { chatId, topicId } = item.destination;
    if (item.file) {
      await api.sendFiles(chatId, topicId, [{ path: item.file, name: item.file.split(/[\\/]/).at(-1) ?? "rig.log", size: statSync(item.file).size, kind: "document" }], "", undefined, item.silent);
      return true;
    }
    const pieces = chunk(toTelegram(item.text));
    for (const [index, piece] of pieces.entries()) {
      if (index < (this.data.progress[item.id] ?? 0)) continue;
      const last = index === pieces.length - 1 ? item.buttons : undefined;
      const shown = this.data.messages[item.id];
      if (shown !== undefined && item.card && index === 0) {
        try { await api.editMessageText(chatId, shown, piece.text, piece.entities, item.buttons); } catch (error) {
          if (!notModified(error)) {
            if (!permanent(error)) throw error;
            // The card is gone or no longer editable: it appears again as a new message.
            this.warn(`machine card ${item.id} cannot be edited, sent again: ${String(error)}`);
            delete this.data.messages[item.id];
            const result = await api.sendMessage(chatId, topicId, piece.text, item.silent, piece.entities, last);
            this.data.messages[item.id] = result.message_id;
          }
        }
      } else {
        const result = await api.sendMessage(chatId, topicId, piece.text, item.silent, piece.entities, last);
        if (item.card && index === 0) this.data.messages[item.id] = result.message_id;
      }
      // An item replaced while it was being sent is left; its replacement starts from the beginning.
      if (this.data.items[0] !== item) return false;
      this.data.progress[item.id] = index + 1;
      this.save();
    }
    return true;
  }

  private accept(item: Item): void {
    this.data.shown[item.id] = item.text + JSON.stringify(item.buttons);
    this.finish(item);
  }

  private drop(item: Item, reason: string): void {
    this.warn(`machine delivery dropped ${item.id}: ${reason}`);
    this.finish(item);
  }

  private finish(item: Item): void {
    if (this.data.items[0] === item) {
      this.data.items.shift();
      delete this.data.progress[item.id];
      if (!this.delivered(item.id)) this.data.delivered.push(item.id);
    }
    this.save();
    if (item.file) rmSync(item.file, { force: true });
  }

  // Oldest first: arrays and objects both keep insertion order for these ids.
  // The ids of a confirmation that still waits for a press are kept: the hub posts them on every tick, so a forgotten one would reach the chat again.
  private trim(): void {
    const data = this.data;
    if (data.delivered.length > this.remembered) {
      const pinned = new Set(Object.values(data.confirmations).flatMap(confirmation => [confirmationPromptId(confirmation), confirmation.recovery ?? ""]));
      const kept = data.delivered.filter(id => !pinned.has(id)).slice(-this.remembered);
      data.delivered = data.delivered.filter(id => pinned.has(id) || kept.includes(id));
    }
    if (data.handled.length > this.remembered) data.handled = data.handled.slice(-this.remembered);
    for (const record of [data.shown, data.messages]) {
      for (const key of Object.keys(record).slice(0, Math.max(0, Object.keys(record).length - this.remembered))) delete record[key];
    }
  }

  private save(): void {
    this.trim();
    const parent = dirname(this.file);
    mkdirSync(parent, { recursive: true });
    const temporary = mkdtempSync(join(parent, ".machine-"));
    try {
      const path = join(temporary, "queue.json");
      writeFileSync(path, JSON.stringify(this.data));
      renameSync(path, this.file);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
}
