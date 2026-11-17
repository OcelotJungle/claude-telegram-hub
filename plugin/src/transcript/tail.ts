import type { Logger } from "../shared/log.ts";
import type { Timers, TimerHandle } from "../shared/timers.ts";

import { closeSync, openSync, readSync, statSync } from "fs";
import { nullLogger } from "../shared/log.ts";
import { realTimers } from "../shared/timers.ts";
import { parseRecord } from "./parse.ts";

const NEWLINE = 0x0a;
const POLL_INTERVAL_MS = 300;
// Block size for scanning a whole transcript for titles: bounded memory whatever the file size.
export const TITLE_BLOCK_BYTES =4 * 1024 * 1024;

// Follows a transcript file by polling. Starts at the current end of an
// existing file (history is never replayed) unless fromStart; a file that does
// not exist yet is read from its start once it appears.
export class TranscriptTailer {
  private offset = 0;
  private rest: Buffer = Buffer.alloc(0);
  private timer: TimerHandle | undefined;
  private timers: Timers;
  private log: Logger;

  constructor(
    private opts: {
      path: string;
      onRecord(rec: unknown): void;
      onIdle?(): void;
      intervalMs?: number;
      fromStart?: boolean;
      log?: Logger;
      timers?: Timers;
    },
  ) {
    this.log = opts.log ?? nullLogger;
    this.timers = opts.timers ?? realTimers;
  }

  get path(): string {
    return this.opts.path;
  }

  start(): void {
    this.open();
    this.timer = this.timers.setRepeat(() => this.pollNow(), this.opts.intervalMs ?? POLL_INTERVAL_MS);
  }

  // Picks the start offset without polling on a timer: the owner calls pollNow.
  open(): void {
    this.offset = this.opts.fromStart ? 0 : (fileSize(this.opts.path) ?? 0);
    this.rest = Buffer.alloc(0);
  }

  stop(): void {
    if (this.timer) this.timers.clearTimer(this.timer);
    this.timer = undefined;
  }

  pollNow(): void {
    const lines = this.readNewLines();
    for (const rec of this.parse(lines)) {
      try {
        this.opts.onRecord(rec);
      } catch (e) {
        this.log.error(`transcript: record handler failed: ${e}`);
      }
    }
    if (lines.length === 0) this.opts.onIdle?.();
  }

  // Whether the file has more bytes than this tailer has read.
  grew(): boolean {
    return (fileSize(this.opts.path) ?? 0) > this.offset;
  }

  // Reads everything from the start of the file up to the current offset (the
  // history before open) and leaves the offset where it was, so pollNow goes on
  // from there. Does not call onRecord.
  readHistory(): unknown[] {
    const end = this.offset;
    this.offset = 0;
    this.rest = Buffer.alloc(0);
    return this.parse(this.readNewLines(end));
  }

  private parse(lines: string[]): unknown[] {
    const recs: unknown[] = [];
    for (const l of lines) {
      try {
        recs.push(JSON.parse(l));
      } catch {
        this.log.warn(`transcript: skipping unparsable line in ${this.opts.path}`);
      }
    }
    return recs;
  }

  // Reads the new complete lines, up to byte `end` of the file when given.
  private readNewLines(end = Infinity): string[] {
    const fileLen = fileSize(this.opts.path);
    if (fileLen === undefined) return [];
    if (fileLen < this.offset) {
      this.log.warn(`transcript: ${this.opts.path} shrank, re-reading from the start`);
      this.offset = 0;
      this.rest = Buffer.alloc(0);
    }
    const size = Math.min(fileLen, end);
    if (size <= this.offset) return [];
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

// Read in blocks: a transcript can hold gigabytes, and memory stays at one block.
export function readSessionTitles(path: string): Titles {
  const last: Titles = {};
  const take = (l: string) => {
    if (!l.includes('-title"') && !l.includes('"agent-name"')) return;
    let rec: unknown;
    try {
      rec = JSON.parse(l);
    } catch {
      return;
    }
    for (const ev of parseRecord(rec)) if (ev.kind === "title") last[ev.source] = ev.title;
  };
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return last;
  }
  try {
    const block = Buffer.alloc(TITLE_BLOCK_BYTES);
    let rest: Buffer = Buffer.alloc(0);
    let position = 0;
    let read: number;
    while ((read = readSync(fd, block, 0, block.length, position)) > 0) {
      position += read;
      const data = Buffer.concat([rest, block.subarray(0, read)]);
      // Cut at the last newline, so no line or multibyte character is split.
      const end = data.lastIndexOf(NEWLINE);
      if (end < 0) {
        rest = data;
        continue;
      }
      for (const l of data.subarray(0, end).toString("utf8").split("\n")) take(l);
      rest = Buffer.from(data.subarray(end + 1));
    }
    take(rest.toString("utf8"));
  } catch {
    return last;
  } finally {
    closeSync(fd);
  }
  return last;
}

export function readSessionTitle(path: string): string | undefined {
  return effectiveTitle(readSessionTitles(path));
}
