// The log file of a finished run, as Telegram gets it: rig holds the whole log and hands it out in pages
// (`rig exec status <id> --from <byte>`, at most 64 KiB each), so the file is built by reading those pages one
// after another into a file, never the whole log in memory. A log larger than the file limit is cut from its start.
import type { ExecClient } from "./rig-exec.ts";

import { closeSync, openSync, writeSync } from "fs";

// What a page shows of a character that the cut at the start of the log split in two: one replacement character
// for each byte that is left of it.
const SPLIT_CHARACTER = /^�+/;

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
  for (;;) {
    const written = await writeFrom(job, start);
    if (written === "unreadable" || written === "aborted") return { kind: written };
    if (written <= job.limit || start >= job.size) return { kind: "built", trimmed: start > 0 };
    // What is written is not the bytes read (a byte that is no UTF-8 grows; a line shown in words differs): start later.
    start = Math.min(job.size, start + written - job.limit + (start === 0 ? noteBytes : 0));
  }
}

// Writes the file from the log's byte `start`; the bytes the file holds.
async function writeFrom(job: LogJob, start: number): Promise<number | "unreadable" | "aborted"> {
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
    // A line that starts before `start` is cut: it is not shown.
    let skipLine = start > 0;
    let carry = "";
    const emit = (raw: string): void => {
      if (skipLine) {
        skipLine = false;
        return;
      }
      for (const line of job.line?.(raw) ?? []) put(`${line}\n`);
    };
    let from = start;
    while (from < job.size) {
      if (job.aborted()) return "aborted";
      const got = await job.rig.status(job.runId, from);
      if (!got.ok) return "unreadable";
      const { log } = got.value;
      if (log.to <= from) break;
      const text = from === start && start > 0 ? log.text.replace(SPLIT_CHARACTER, "") : log.text;
      from = log.to;
      if (!job.line) {
        put(text);
        continue;
      }
      carry += text;
      const cut = carry.lastIndexOf("\n") + 1;
      for (const raw of carry.slice(0, cut).split("\n").slice(0, -1)) emit(raw);
      carry = carry.slice(cut);
    }
    if (carry !== "") emit(carry);
    for (const line of job.closing) put(`${line}\n`);
    return bytes;
  } finally {
    closeSync(fd);
  }
}
