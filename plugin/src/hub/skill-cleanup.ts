// Empties the skills Claude Code remembers in a transcript: every
// invoked_skills attachment gets `skills: []`, so a resumed session neither
// has them in its context nor puts them back after the next compaction.
// Transcripts run to gigabytes and hold any bytes, so the file is streamed
// as bytes: a line is decoded only when it mentions "invoked_skills", and
// every other byte is copied as it is.
import type { FileHandle } from "fs/promises";
import type { Messages } from "../shared/i18n/index.ts";

import { open, readdir, readFile, rename, stat, unlink, writeFile } from "fs/promises";
import { basename, dirname, join } from "path";
import { z } from "zod";
import { field, isObject, str } from "../shared/guards.ts";

export const KEEP_BACKUPS = 3;
const CHUNK_BYTES = 1024 * 1024;
// Windows refuses a rename over a file another process holds open for a
// moment (an antivirus, an indexer): such a rename is tried again.
const RENAME_TRIES = 10;
const RENAME_RETRY_MS = 200;
const BUSY_CODES: readonly unknown[] = ["EPERM", "EBUSY", "EACCES"];
const LF = 0x0a;
const CR = 0x0d;
const SKILLS_MARK = Buffer.from('"invoked_skills"');
const VERSION_MARK = Buffer.from('"version"');

// A failure the user is told about: `message` is English for the log, `render` is the text for Telegram in the hub's language.
export class CleanupError extends Error {
  constructor(message: string, readonly render: (m: Messages) => string) {
    super(message);
  }
}

const growing = () => new CleanupError("the transcript is still being written: is the session open?", m => m.cleanupGrowing);
const shrank = () => new CleanupError("the transcript got shorter while it was being rewritten", m => m.cleanupShrank);

export type SkillInfo = { name: string; chars: number };
// cleaned: the skills of the last invoked_skills record (the one in the
// context), the records emptied and the undo file. nothing: no record had any
// skill. format: a record Claude Code wrote in a shape this does not know;
// the file is untouched. version: Claude Code's, from the transcript.
export type CleanupResult =
  | { kind: "cleaned"; skills: SkillInfo[]; records: number; backup: string; version?: string }
  | { kind: "nothing"; version?: string }
  | { kind: "format"; version?: string };

// A line of the undo file: the original text of line `line` (from 1),
// without its "\r\n" or "\n".
const backupLine = z.object({ line: z.number(), uuid: z.string().nullable(), text: z.string() });
type BackupLine = z.infer<typeof backupLine>;

// A line of the file: its number from 1, its offset, and its bytes without
// the "\n".
export type Line = { no: number; start: number; bytes: Buffer };
// Bytes [start, end) of the file become `bytes`.
type Splice = { start: number; end: number; bytes: Buffer };

// For tests: the read size and the file operations a failure can come from.
export type CleanupIo = {
  chunkBytes?: number;
  rename?: (from: string, to: string) => Promise<void>;
  size?: (path: string) => Promise<number>;
};
type Io = Required<CleanupIo>;

const utf8 = new TextDecoder("utf-8", { fatal: true });

function ioOf(io: CleanupIo): Io {
  return { chunkBytes: io.chunkBytes ?? CHUNK_BYTES, rename: io.rename ?? rename, size: io.size ?? (async p => (await stat(p)).size) };
}

export async function cleanTranscript(path: string, now: number, opts: CleanupIo = {}): Promise<CleanupResult> {
  const io = ioOf(opts);
  const edits: (Splice & BackupLine)[] = [];
  let last: SkillInfo[] = [];
  let lastVersion: string | undefined;
  let firstVersion: string | undefined;
  // The file as pass 1 saw it; if it grows before the rename, a session
  // writes to it and the edit is dropped.
  const size = await io.size(path);
  for await (const line of lines(path, io.chunkBytes)) {
    const marked = line.bytes.includes(SKILLS_MARK);
    if (!marked && (firstVersion !== undefined || !line.bytes.includes(VERSION_MARK))) continue;
    const body = withoutCr(line.bytes);
    const text = decode(body);
    const rec = parse(text ?? body.toString("utf8"));
    firstVersion ??= str(field(rec, "version"));
    if (!marked || !isInvokedSkills(rec)) continue;
    const version = str(field(rec, "version")) ?? firstVersion;
    const list = field(field(rec, "attachment"), "skills");
    // Undecodable bytes would not come back from the undo file.
    if (text === undefined || !Array.isArray(list)) return { kind: "format", ...versionOf(version) };
    const skills: SkillInfo[] = [];
    for (const s of list) {
      const name = str(field(s, "name"));
      const content = str(field(s, "content"));
      if (name === undefined || content === undefined) return { kind: "format", ...versionOf(version) };
      skills.push({ name, chars: content.length });
    }
    last = skills;
    lastVersion = str(field(rec, "version"));
    if (!skills.length) continue;
    const next = JSON.stringify({ ...rec, attachment: { ...rec.attachment, skills: [] } });
    edits.push({ start: line.start, end: line.start + body.length, bytes: Buffer.from(next), line: line.no, uuid: str(field(rec, "uuid")) ?? null, text });
  }
  const version = lastVersion ?? firstVersion;
  if (!edits.length) return { kind: "nothing", ...versionOf(version) };
  const backup = join(dirname(path), `${sessionIdOf(path)}.cleanup-${now}.jsonl`);
  await writeFile(backup, edits.map(e => JSON.stringify({ line: e.line, uuid: e.uuid, text: e.text }) + "\n").join(""));
  try {
    await splice(path, edits, size, io);
  } catch (e) {
    await unlink(backup).catch(() => {});
    throw e;
  }
  await prune(path);
  return { kind: "cleaned", skills: last, records: edits.length, backup, ...versionOf(version) };
}

// Puts back the lines a cleanup changed. A line is put back only where its
// number and uuid match the undo file; if any does not, nothing is written.
export async function restoreCleanup(path: string, backup: string, opts: CleanupIo = {}): Promise<void> {
  const io = ioOf(opts);
  const entries = new Map<number, BackupLine>();
  for (const l of (await readFile(backup, "utf8")).split("\n")) {
    if (!l.trim()) continue;
    const e = backupLine.parse(JSON.parse(l));
    entries.set(e.line, e);
  }
  const edits: Splice[] = [];
  const size = await io.size(path);
  for await (const line of lines(path, io.chunkBytes)) {
    const e = entries.get(line.no);
    if (!e) continue;
    const body = withoutCr(line.bytes);
    const uuid = str(field(parse(body.toString("utf8")), "uuid")) ?? null;
    if (uuid !== e.uuid) {
      throw new CleanupError(`line ${e.line}: uuid ${uuid} instead of ${e.uuid}`, m => m.cleanupLinesMismatch({ line: e.line, uuid: String(uuid), expected: String(e.uuid) }));
    }
    edits.push({ start: line.start, end: line.start + body.length, bytes: Buffer.from(e.text) });
  }
  if (edits.length !== entries.size) {
    throw new CleanupError(`the transcript has fewer lines than ${basename(backup)}`, m => m.cleanupFewerLines({ backup: basename(backup) }));
  }
  await splice(path, edits, size, io);
}

function isInvokedSkills(rec: unknown): rec is Record<string, unknown> & { attachment: Record<string, unknown> } {
  return field(rec, "type") === "attachment" && isObject(field(rec, "attachment")) && field(field(rec, "attachment"), "type") === "invoked_skills";
}

function versionOf(version: string | undefined): { version?: string } {
  return version === undefined ? {} : { version };
}

function sessionIdOf(path: string): string {
  return basename(path).replace(/\.jsonl$/, "");
}

function withoutCr(bytes: Buffer): Buffer {
  return bytes.at(-1) === CR ? bytes.subarray(0, -1) : bytes;
}

function decode(bytes: Buffer): string | undefined {
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// The file's lines split on "\n", streamed; the last one may lack its "\n".
export async function* lines(path: string, chunkBytes = CHUNK_BYTES): AsyncGenerator<Line> {
  const fh = await open(path, "r");
  try {
    let parts: Buffer[] = [];
    let start = 0;
    let no = 0;
    for (let pos = 0; ; ) {
      // A fresh buffer each time: the lines handed out are views of it.
      const buf = Buffer.allocUnsafe(chunkBytes);
      const { bytesRead } = await fh.read(buf, 0, chunkBytes, pos);
      if (!bytesRead) break;
      const chunk = buf.subarray(0, bytesRead);
      let from = 0;
      for (let nl = chunk.indexOf(LF); nl !== -1; nl = chunk.indexOf(LF, from)) {
        parts.push(chunk.subarray(from, nl));
        yield { no: ++no, start, bytes: joined(parts) };
        parts = [];
        start = pos + nl + 1;
        from = nl + 1;
      }
      if (from < chunk.length) parts.push(chunk.subarray(from));
      pos += bytesRead;
    }
    if (parts.length) yield { no: ++no, start, bytes: joined(parts) };
  } finally {
    await fh.close();
  }
}

function joined(parts: Buffer[]): Buffer {
  const [only] = parts;
  return parts.length === 1 && only ? only : Buffer.concat(parts);
}

// Writes the first `size` bytes of the file, with the splices (in file
// order), to a file beside it, then puts that in its place. If the file is no
// longer `size` bytes by then, nothing changes: a session is writing to it.
async function splice(path: string, edits: Splice[], size: number, io: Io): Promise<void> {
  const tmp = `${path}.cleanup-tmp`;
  let placed = false;
  try {
    const src = await open(path, "r");
    try {
      const out = await open(tmp, "w");
      try {
        let pos = 0;
        for (const e of edits) {
          await copy(src, out, pos, e.start, io.chunkBytes);
          await out.write(e.bytes);
          pos = e.end;
        }
        await copy(src, out, pos, size, io.chunkBytes);
      } finally {
        await out.close();
      }
    } finally {
      await src.close();
    }
    const now = await io.size(path);
    if (now > size) throw growing();
    if (now < size) throw shrank();
    await replace(tmp, path, io);
    placed = true;
  } finally {
    if (!placed) await unlink(tmp).catch(() => {});
  }
}

async function replace(tmp: string, path: string, io: Io): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await io.rename(tmp, path);
      return;
    } catch (e) {
      if (attempt >= RENAME_TRIES || !BUSY_CODES.includes(field(e, "code"))) throw e;
      await new Promise(resolve => setTimeout(resolve, RENAME_RETRY_MS));
    }
  }
}

async function copy(src: FileHandle, out: FileHandle, from: number, to: number, chunkBytes: number): Promise<void> {
  const buf = Buffer.allocUnsafe(chunkBytes);
  for (let pos = from; pos < to; ) {
    const { bytesRead } = await src.read(buf, 0, Math.min(chunkBytes, to - pos), pos);
    if (!bytesRead) throw shrank();
    await out.write(buf.subarray(0, bytesRead));
    pos += bytesRead;
  }
}

// Only this session's undo files, the newest KEEP_BACKUPS of them stay.
async function prune(path: string): Promise<void> {
  const prefix = `${sessionIdOf(path)}.cleanup-`;
  const stamps: number[] = [];
  for (const name of await readdir(dirname(path))) {
    if (!name.startsWith(prefix) || !name.endsWith(".jsonl")) continue;
    const stamp = name.slice(prefix.length, -".jsonl".length);
    if (/^\d+$/.test(stamp)) stamps.push(Number(stamp));
  }
  stamps.sort((a, b) => b - a);
  for (const stamp of stamps.slice(KEEP_BACKUPS)) await unlink(join(dirname(path), `${prefix}${stamp}.jsonl`)).catch(() => {});
}
