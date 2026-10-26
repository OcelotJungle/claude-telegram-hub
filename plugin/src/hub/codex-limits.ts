import type { LimitsReading, RateLimit } from "../shared/protocol.ts";

import { open, readdir, stat } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { z } from "zod";

const MAX_FILES = 20;
const TAIL_BYTES = 64 * 1024;
const MS_PER_SECOND = 1000;
const FIVE_HOUR_MINUTES = 300;
const SEVEN_DAY_MINUTES = 10080;
const MAX_DATE_MS = 8_640_000_000_000_000;
const DATE_PARTS = [/^\d{4}$/, /^\d{2}$/, /^\d{2}$/];
const windowSchema = z.object({
  used_percent: z.number().nonnegative(),
  window_minutes: z.number().int().positive(),
  resets_at: z.number().min(-MAX_DATE_MS / MS_PER_SECOND).max(MAX_DATE_MS / MS_PER_SECOND).optional(),
});
const eventSchema = z.object({
  timestamp: z.string().refine(value => Number.isFinite(Date.parse(value))),
  type: z.literal("event_msg"),
  payload: z.object({
    type: z.literal("token_count"),
    rate_limits: z.object({
      limit_id: z.literal("codex"),
      primary: windowSchema.nullish(),
      secondary: windowSchema.nullish(),
    }),
  }),
});

type Candidate = { path: string; mtime: number; size: number };
type Cached = Candidate & { reading: LimitsReading | undefined };

export class CodexLimits {
  private cache = new Map<string, Cached>();

  constructor(private sessionsDir = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions")) {}

  async read(): Promise<LimitsReading | undefined> {
    const candidates = await this.files(this.sessionsDir);
    const paths = new Set(candidates.map(file => file.path));
    for (const path of this.cache.keys()) if (!paths.has(path)) this.cache.delete(path);
    for (const file of candidates) {
      try {
        const cached = this.cache.get(file.path);
        if (cached?.mtime === file.mtime && cached.size === file.size) {
          if (cached.reading) return cached.reading;
          continue;
        }
        const reading = await this.tail(file);
        this.cache.set(file.path, { ...file, reading });
        if (reading) return reading;
      } catch {
        // A rollout can disappear or become unreadable while /info runs.
      }
    }
    return undefined;
  }

  private async files(dir: string, depth = 0): Promise<Candidate[]> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const part = DATE_PARTS[depth];
      if (part) {
        const files: Candidate[] = [];
        for (const entry of entries.filter(entry => entry.isDirectory() && part.test(entry.name)).sort((a, b) => b.name.localeCompare(a.name))) {
          files.push(...await this.files(join(dir, entry.name), depth + 1));
          if (files.length >= MAX_FILES) break;
        }
        return files.slice(0, MAX_FILES);
      }
      const files: Candidate[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) continue;
        const path = join(dir, entry.name);
        const metadata = await stat(path).catch(() => undefined);
        if (metadata) files.push({ path, mtime: metadata.mtimeMs, size: metadata.size });
      }
      return files.sort((a, b) => b.mtime - a.mtime || b.path.localeCompare(a.path)).slice(0, MAX_FILES);
    } catch {
      return [];
    }
  }

  private async tail(file: Candidate): Promise<LimitsReading | undefined> {
    const handle = await open(file.path, "r");
    try {
      let end = file.size;
      let pending = Buffer.alloc(0);
      while (end > 0) {
        const start = Math.max(0, end - TAIL_BYTES);
        const buffer = Buffer.alloc(end - start);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
        const data = Buffer.concat([buffer.subarray(0, bytesRead), pending]);
        const newline = start > 0 ? data.indexOf("\n") : -1;
        const split = start > 0 ? (newline < 0 ? data.length : newline + 1) : 0;
        pending = data.subarray(0, split);
        const lines = data.subarray(split).toString("utf8").split("\n");
        for (const line of lines.reverse()) {
          const reading = parseLine(line);
          if (reading) return reading;
        }
        end = start;
      }
      return undefined;
    } finally {
      await handle.close();
    }
  }
}

function parseLine(line: string): LimitsReading | undefined {
  if (!line.includes('"rate_limits"')) return undefined;
  try {
    const event = eventSchema.safeParse(JSON.parse(line));
    if (!event.success) return undefined;
    const rateLimits: RateLimit[] = [];
    const { primary, secondary } = event.data.payload.rate_limits;
    for (const window of [primary, secondary]) {
      if (!window) continue;
      const minutes = window.window_minutes;
      rateLimits.push({
        kind: minutes === FIVE_HOUR_MINUTES ? "five_hour" : minutes === SEVEN_DAY_MINUTES ? "seven_day" : `${minutes} мин`,
        percentUsed: window.used_percent,
        ...(window.resets_at === undefined ? {} : { resetsAt: new Date(window.resets_at * MS_PER_SECOND).toISOString() }),
      });
    }
    return rateLimits.length ? { at: Date.parse(event.data.timestamp), rateLimits } : undefined;
  } catch {
    return undefined;
  }
}
