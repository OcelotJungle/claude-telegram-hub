// The log file of a finished run, as Telegram gets it: rig holds the whole log and hands it out in pages
// (`rig exec status <id> --from <byte>`, at most 64 KiB each), so the file is built by reading those pages one
// after another into a file, never the whole log in memory. A log larger than the file limit is cut from its start,
// and the file starts at a line start (kept when the cut is exactly there, else after the first line break past it).
// When the kept tail is a single line, the file starts at the cut instead, at a whole UTF-8 character.
import type { ExecClient } from "./rig-exec.ts";

import { closeSync, openSync, writeSync } from "fs";

// The replacement characters a decoder puts for the bytes of a character cut at the start of a read.
const LEADING_REPLACEMENTS = /^�+/;

export type LogJob = {
  rig: ExecClient;
  runId: string;
  // The log's size in bytes.
  size: number;
  // The file to write.
  path: string;
  // The largest the file may be, in bytes.
  limit: number;
  // The first line of a file that starts in the middle of the log (with its line break).
  note: string;
  // Turns one line of the log into the lines the file shows; with none given the log is written as it is.
  line?: (line: string) => string[];
  // The lines that end the file, after the log's own.
  closing: string[];
  // Whether the work must stop (the hub is shutting down).
  aborted(): boolean;
};

export type LogResult = { kind: "built"; trimmed: boolean } | { kind: "unreadable" } | { kind: "aborted" };

// A file that fits the limit with the whole log when it can, otherwise with the note and the log's last part.
export async function buildLogFile(job: LogJob): Promise<LogResult> {
  const noteBytes = Buffer.byteLength(job.note);
  let start = job.size > job.limit ? Math.max(0, job.size - (job.limit - noteBytes)) : 0;
  let byteCut = false;
  for (;;) {
    const written = await writeFrom(job, start, byteCut);
    if (written === "unreadable" || written === "aborted") return { kind: written };
    if (written === "no-line-break") {
      // The kept tail is one line: no line start to begin at, so the file begins at the cut (a whole character).
      byteCut = true;
      continue;
    }
    if (written <= job.limit || start >= job.size) return { kind: "built", trimmed: start > 0 };
    // What is written is not the bytes read (a byte that is no UTF-8 grows; a line shown in words differs): start later.
    start = Math.min(job.size, start + written - job.limit + (start === 0 ? noteBytes : 0));
  }
}

// Writes the file from the log's byte `start`; the bytes the file holds. With `byteCut` the file begins at `start`
// itself (at the first whole character) instead of at a line start; "no-line-break" says the tail has none to begin at.
async function writeFrom(job: LogJob, start: number, byteCut: boolean): Promise<number | "unreadable" | "aborted" | "no-line-break"> {
  const fd = openSync(job.path, "w");
  let bytes = 0;
  const put = (text: string): void => {
    if (text === "") return;
    const buffer = Buffer.from(text, "utf8");
    writeSync(fd, buffer);
    bytes += buffer.length;
  };
  try {
    if (start > 0) put(job.note);
    // A line the cut lands in the middle of is not shown, cut or whole: the file starts after its line break. That also
    // drops any character the cut split in two, since a character holds no line break. When the cut is exactly at a
    // line start the line is whole and stays; for that the read begins one byte early, and that byte is "\n".
    let skipping = start > 0;
    let first = true;
    let carry = "";
    const emit = (raw: string): void => {
      for (const line of job.line?.(raw) ?? []) put(`${line}\n`);
    };
    let from = start > 0 && !byteCut ? start - 1 : start;
    while (from < job.size) {
      if (job.aborted()) return "aborted";
      const got = await job.rig.status(job.runId, from);
      if (!got.ok) return "unreadable";
      const { log } = got.value;
      if (log.to <= from) break;
      let text = log.text;
      from = log.to;
      if (skipping) {
        if (byteCut) {
          // A character the cut split decodes to replacement characters at the very start: they are not the log's.
          text = text.replace(LEADING_REPLACEMENTS, "");
          skipping = false;
        } else if (first && text.startsWith("\n")) {
          text = text.slice(1);
          skipping = false;
        } else {
          const lineBreak = text.indexOf("\n");
          if (lineBreak === -1) {
            first = false;
            continue;
          }
          text = text.slice(lineBreak + 1);
          skipping = false;
        }
      }
      first = false;
      if (!job.line) {
        put(text);
        continue;
      }
      carry += text;
      const cut = carry.lastIndexOf("\n") + 1;
      for (const raw of carry.slice(0, cut).split("\n").slice(0, -1)) emit(raw);
      carry = carry.slice(cut);
    }
    if (skipping) return "no-line-break";
    if (carry !== "") emit(carry);
    for (const line of job.closing) put(`${line}\n`);
    return bytes;
  } finally {
    closeSync(fd);
  }
}
