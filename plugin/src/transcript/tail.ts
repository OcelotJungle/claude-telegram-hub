import type { Logger } from "../shared/log.ts";

import { closeSync, openSync, readFileSync, readSync, statSync } from "fs";
import { nullLogger } from "../shared/log.ts";
import { parseRecord } from "./parse.ts";

const NEWLINE = 0x0a;
const POLL_INTERVAL_MS = 300;

// Follows a transcript file by polling. Starts at the current end of an
// existing file (history is never replayed) unless fromStart; a file that does
// not exist yet is read from its start once it appears.
export class TranscriptTailer {
  private offset = 0;
  private rest: Buffer = Buffer.alloc(0);
  private timer: ReturnType<typeof setInterval> | undefined;
  private log: Logger;

  constructor(
    private opts: {
      path: string;
      onRecord(rec: unknown): void;
      onIdle?(): void;
      intervalMs?: number;
      fromStart?: boolean;
      log?: Logger;
    },
  ) {
    this.log = opts.log ?? nullLogger;
  }

  get path(): string {
    return this.opts.path;
  }

  start(): void {
    this.open();
    this.timer = setInterval(() => this.pollNow(), this.opts.intervalMs ?? POLL_INTERVAL_MS);
  }

  // Picks the start offset without polling on a timer: the owner calls pollNow.
  open(): void {
    this.offset = this.opts.fromStart ? 0 : (fileSize(this.opts.path) ?? 0);
    this.rest = Buffer.alloc(0);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  pollNow(): void {
    const lines = this.readNewLines();
    for (const l of lines) {
      let rec: unknown;
      try {
        rec = JSON.parse(l);
      } catch {
        this.log.warn(`transcript: skipping unparsable line in ${this.opts.path}`);
        continue;
      }
      try {
        this.opts.onRecord(rec);
      } catch (e) {
        this.log.error(`transcript: record handler failed: ${e}`);
      }
    }
    if (lines.length === 0) this.opts.onIdle?.();
  }

  private readNewLines(): string[] {
    const size = fileSize(this.opts.path);
    if (size === undefined) return [];
    if (size < this.offset) {
      this.log.warn(`transcript: ${this.opts.path} shrank, re-reading from the start`);
      this.offset = 0;
      this.rest = Buffer.alloc(0);
    }
    if (size === this.offset) return [];
    const chunk = Buffer.alloc(size - this.offset);
    const fd = openSync(this.opts.path, "r");
    let read = 0;
    try {
      read = readSync(fd, chunk, 0, chunk.length, this.offset);
    } finally {
      closeSync(fd);
    }
    this.offset += read;
    let data = Buffer.concat([this.rest, chunk.subarray(0, read)]);
    const lines: string[] = [];
    let nl: number;
    while ((nl = data.indexOf(NEWLINE)) >= 0) {
      const l = data.subarray(0, nl).toString("utf8").trim();
      if (l) lines.push(l);
      data = data.subarray(nl + 1);
    }
    this.rest = Buffer.from(data);
    return lines;
  }
}

function fileSize(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}

export type Titles = { custom?: string; agent?: string; ai?: string };

// Session name for the topic: /rename (custom-title, then agent-name) beats the
// automatic ai-title; within each kind the last record wins.
export function effectiveTitle(t: Titles): string | undefined {
  return t.custom ?? t.agent ?? t.ai;
}

export function readSessionTitles(path: string): Titles {
  const last: Titles = {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return last;
  }
  for (const l of text.split("\n")) {
    if (!l.includes('-title"') && !l.includes('"agent-name"')) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(l);
    } catch {
      continue;
    }
    for (const ev of parseRecord(rec)) if (ev.kind === "title") last[ev.source] = ev.title;
  }
  return last;
}

export function readSessionTitle(path: string): string | undefined {
  return effectiveTitle(readSessionTitles(path));
}
