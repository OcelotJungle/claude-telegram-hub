// The hub's subagent cards on disk, so a restarted hub goes on editing the
// messages it sent instead of sending each card anew.
import type { Button } from "./telegram.ts";
import type { Entity } from "../shared/markdown.ts";

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import { z } from "zod";
import { entitySchema, toTelegram } from "../shared/markdown.ts";

// text and entities: the card's latest version as plain text and Telegram
// entities, which a card still in the queue is sent with. done: its final
// version is shown. buttons: the keyboard under it.
export type SavedCard = { text: string; entities: Entity[]; done: boolean; messageId?: number; buttons?: Button[][] };

// A file of the older version holds the card's Markdown and no entities.
const fileSchema = z.record(
  z.string(),
  z.object({
    text: z.string(),
    entities: z.array(entitySchema).optional(),
    done: z.boolean(),
    messageId: z.number().optional(),
    buttons: z.array(z.array(z.object({ text: z.string(), data: z.string() }))).optional(),
  }),
);

// The cards by `${sessionId}:${cardId}`, oldest first; none when the file is
// missing, and none, the file set aside, when it is unreadable.
export function loadCards(file: string): [string, SavedCard][] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  try {
    return Object.entries(fileSchema.parse(JSON.parse(raw))).map(([key, card]): [string, SavedCard] => {
      const { entities, ...rest } = card;
      return [key, entities ? { ...rest, entities } : { ...rest, ...toTelegram(card.text) }];
    });
  } catch {
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {}
    return [];
  }
}

export function saveCards(file: string, cards: [string, SavedCard][]): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(cards)));
  renameSync(tmp, file);
}
