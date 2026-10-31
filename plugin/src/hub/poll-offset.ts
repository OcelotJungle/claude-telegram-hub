// The Telegram update offset on disk. Telegram confirms an update only when a
// later getUpdates asks for a higher offset, so a restarted hub that forgot the
// offset would receive the whole unconfirmed batch again and act on it twice.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import { z } from "zod";

// botId: update ids count per bot, so an offset saved for another bot is of no use.
type SavedOffset = { botId: number; offset: number };

const fileSchema: z.ZodType<SavedOffset> = z.object({ botId: z.number(), offset: z.number().int().nonnegative() });

// The offset to poll from: 0 when the file is missing, belongs to another bot or
// is unreadable (an unreadable file is set aside).
export function loadPollOffset(file: string, botId: number): number {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return 0;
  }
  try {
    const saved = fileSchema.parse(JSON.parse(raw));
    return saved.botId === botId ? saved.offset : 0;
  } catch {
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {}
    return 0;
  }
}

export function savePollOffset(file: string, botId: number, offset: number): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const saved: SavedOffset = { botId, offset };
  writeFileSync(tmp, JSON.stringify(saved));
  renameSync(tmp, file);
}
