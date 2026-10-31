import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { writeRigFile } from "./rig-files.ts";

export const RIG_POLL_MS = 5000;
const NEWLINE = 0x0a;
const READ_CHUNK_BYTES = 64 * 1024;
// A rig event is a short notice; a longer line is treated as a broken one rather than held in memory.
const MAX_LINE_BYTES = 1024 * 1024;
const STATE_FILE = "rig-events.json";
const eventSchema = z.object({ id: z.string(), time: z.string(), level: z.enum(["info", "warn", "error"]), type: z.string(), text: z.string() });
const firstLineSchema = z.object({ id: z.string() });
// The hub's own memory, kept in its state dir: rig's directory is rig's.
const stateSchema = z.object({ firstId: z.string().optional(), partial: z.object({ offset: z.number(), id: z.string(), pieces: z.number() }).optional() });
export type RigEvent = z.infer<typeof eventSchema>;
type State = z.infer<typeof stateSchema>;
type Line = { text: string | undefined; start: number; next: number };
// Text events hand their Telegram pieces over one by one: `sent` pieces are already accepted, `accepted(n)` reports n in total.
export type RigEventSend = (event: RigEvent, sent: number, accepted: (pieces: number) => void) => Promise<void | boolean>;

export class RigEvents {
  private polling = false;
  private state: State | undefined;
  // Everything before this byte was already looked at for service events in this process.
  private serviceThrough = 0;
  private seenFirstId: string | undefined;
  private lastWarning = "";

  constructor(private deps: {
    dir: string; stateDir: string; running(): boolean; available(): boolean; send: RigEventSend;
    features(): Promise<void>; restart(): void; warn(text: string): void;
  }) {}

  async poll(): Promise<void> {
    if (this.polling || !this.deps.running()) return;
    this.polling = true;
    let fd: number | undefined;
    try {
      try { fd = openSync(join(this.deps.dir, "events.jsonl"), "r"); } catch { return; }
      const size = fstatSync(fd).size;
      const first = readLine(fd, 0, size);
      // Nothing complete yet: no id to compare, nothing to read.
      if (!first) return;
      const identity = firstIdentity(first.text);
      const state = this.load();
      let offset = this.savedOffset();
      const reset = offset > size || (state.firstId !== undefined && state.firstId !== identity);
      if (reset) offset = 0;
      if (identity !== this.seenFirstId || size < this.serviceThrough) this.serviceThrough = 0;
      this.seenFirstId = identity;
      let delivering = this.deps.available();
      if (delivering) {
        // Offset first, id second: a crash between them repeats this reset.
        if (reset) writeRigFile(this.deps.dir, "events.offset", "0");
        if (reset || state.firstId === undefined) this.save({ ...state, firstId: identity, ...(reset ? { partial: undefined } : {}) });
      }
      const done = { features: false, restart: false };
      let scan = offset;
      let line: Line | undefined;
      while ((line = readLine(fd, scan, size))) {
        scan = line.next;
        const fresh = line.start >= this.serviceThrough;
        const event = this.parse(line, fresh);
        const service = event !== undefined && isService(event.type);
        if (event && service && fresh) await this.handle(event.type, done);
        if (fresh) this.serviceThrough = line.next;
        if (delivering && !this.deps.available()) delivering = false;
        if (!delivering) continue;
        if (!this.deps.running()) return;
        if (event && !service && !(await this.deliver(event, line.start))) { delivering = false; continue; }
        // The service events behind a stuck one are still handled above; the offset waits for the stuck one.
        if (!this.deps.running()) return;
        writeRigFile(this.deps.dir, "events.offset", String(line.next));
      }
    } catch (error) { this.deps.warn(`rig events: ${String(error)}`); }
    finally {
      if (fd !== undefined) closeSync(fd);
      this.polling = false;
    }
  }

  get busy(): boolean { return this.polling; }

  private parse(line: Line, fresh: boolean): RigEvent | undefined {
    try {
      if (line.text === undefined) throw new Error("line too long");
      const parsed = eventSchema.safeParse(JSON.parse(line.text));
      if (parsed.success) return parsed.data;
      if (fresh) this.deps.warn(`rig event at ${line.start}: ${parsed.error.message}`);
    } catch (error) { if (fresh) this.deps.warn(`rig event at ${line.start}: ${String(error)}`); }
    return undefined;
  }

  private async handle(type: string, done: { features: boolean; restart: boolean }): Promise<void> {
    if (type === "features-changed") {
      if (done.features) return;
      done.features = true;
      try { await this.deps.features(); } catch (error) { this.deps.warn(`rig events: ${String(error)}`); }
    } else if (!done.restart) {
      done.restart = true;
      this.deps.restart();
    }
  }

  // Whether Telegram accepted the whole event. A rejection waits for the next poll.
  private async deliver(event: RigEvent, start: number): Promise<boolean> {
    const partial = this.load().partial;
    const sent = partial?.offset === start && partial.id === event.id ? partial.pieces : 0;
    try {
      const accepted = await this.deps.send(event, sent, pieces => this.save({ ...this.load(), partial: { offset: start, id: event.id, pieces } }));
      return accepted !== false;
    } catch (error) {
      const text = `rig event delivery: ${String(error)}`;
      if (text !== this.lastWarning) this.deps.warn(text);
      this.lastWarning = text;
      return false;
    }
  }

  private savedOffset(): number {
    try {
      const raw = readFileSync(join(this.deps.dir, "events.offset"), "utf8").trim();
      if (/^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))) return Number(raw);
    } catch {}
    return 0;
  }

  private load(): State {
    if (this.state) return this.state;
    try { this.state = stateSchema.parse(JSON.parse(readFileSync(join(this.deps.stateDir, STATE_FILE), "utf8"))); } catch { this.state = {}; }
    return this.state;
  }

  private save(state: State): void {
    this.state = state;
    mkdirSync(this.deps.stateDir, { recursive: true });
    const path = join(this.deps.stateDir, STATE_FILE);
    writeFileSync(`${path}.tmp`, JSON.stringify(state), "utf8");
    renameSync(`${path}.tmp`, path);
  }
}

function isService(type: string): boolean {
  return type === "features-changed" || type === "hub-restart-pending";
}

// The complete line starting at `from`; a line still being written (no newline yet) is not one.
function readLine(fd: number, from: number, size: number): Line | undefined {
  const parts: Buffer[] = [];
  let kept = 0;
  let position = from;
  while (position < size) {
    const buffer = Buffer.alloc(Math.min(READ_CHUNK_BYTES, size - position));
    const read = readSync(fd, buffer, 0, buffer.length, position);
    if (read <= 0) return undefined;
    const end = buffer.subarray(0, read).indexOf(NEWLINE);
    const used = end < 0 ? read : end;
    if (kept <= MAX_LINE_BYTES) { parts.push(buffer.subarray(0, used)); kept += used; }
    if (end >= 0) return { text: kept > MAX_LINE_BYTES ? undefined : Buffer.concat(parts).toString("utf8"), start: from, next: position + end + 1 };
    position += read;
  }
  return undefined;
}

// What tells one events file from the next: the first line's id, or the line itself when it has none.
function firstIdentity(text: string | undefined): string {
  if (text === undefined) return "oversized";
  try {
    const parsed = firstLineSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data.id;
  } catch {}
  return `raw:${text}`;
}
