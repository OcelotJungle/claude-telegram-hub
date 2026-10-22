// The hub's subagent cards on disk, so a restarted hub goes on editing the
// messages it sent instead of sending each card anew.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import { z } from "zod";

// text: the card's latest Markdown, which a card still in the queue is sent
// with. done: its final version is shown.
export type SavedCard = { text: string; done: boolean; messageId?: number };

const fileSchema: z.ZodType<Record<string, SavedCard>> = z.record(
  z.string(),
  z.object({ text: z.string(), done: z.boolean(), messageId: z.number().optional() }),
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
    return Object.entries(fileSchema.parse(JSON.parse(raw)));
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
