// Checks /cleanup's transcript edit on a copy of a transcript:
//   bun scripts/cleanup-check.ts <copy-of-transcript.jsonl>
// It keeps a pristine copy beside the given file, cleans the given file,
// then checks against the pristine one: the same number of lines, the same
// uuids, only invoked_skills lines differ and those have `skills: []`, every
// line that was valid JSON still is. Then it undoes the edit and checks the
// file is back byte for byte. Everything it made is deleted at the end, and
// the given copy is left restored, as it was.
import type { Line } from "../plugin/src/hub/skill-cleanup.ts";

import { copyFile, rm } from "fs/promises";
import { homedir } from "os";
import { basename, resolve, sep } from "path";
import { cleanTranscript, lines, restoreCleanup } from "../plugin/src/hub/skill-cleanup.ts";
import { field } from "../plugin/src/shared/guards.ts";

const ORIGINAL_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
const CR = 0x0d;
const PREVIEW_CHARS = 200;
const CHARS_PER_TOKEN = 4;

function parse(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

function withoutCr(bytes: Buffer): Buffer {
  return bytes.at(-1) === CR ? bytes.subarray(0, -1) : bytes;
}

function isInvokedSkills(rec: unknown): boolean {
  return field(rec, "type") === "attachment" && field(field(rec, "attachment"), "type") === "invoked_skills";
}

function namesOf(rec: unknown): string[] {
  const list = field(field(rec, "attachment"), "skills");
  if (!Array.isArray(list)) return [];
  return list.map(s => field(s, "name")).filter((n): n is string => typeof n === "string");
}

async function sameBytes(a: string, b: string): Promise<boolean> {
  const left = lines(a);
  const right = lines(b);
  for (;;) {
    const [l, r] = await Promise.all([left.next(), right.next()]);
    if (l.done || r.done) return l.done === r.done;
    if (!l.value.bytes.equals(r.value.bytes)) return false;
  }
}

async function main(): Promise<number> {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: bun scripts/cleanup-check.ts <copy-of-transcript.jsonl>");
    return 2;
  }
  const path = resolve(arg);
  const projects = resolve(homedir(), ".claude", "projects") + sep;
  if (ORIGINAL_NAME.test(basename(path)) || path.toLowerCase().startsWith(projects.toLowerCase())) {
    console.error(`${path} looks like a live transcript, not a copy: copy it elsewhere under another name first`);
    return 2;
  }
  const pristine = `${path}.pristine`;
  await copyFile(path, pristine);
  let backup: string | undefined;
  try {
    const res = await cleanTranscript(path, Date.now());
    console.log(`result: ${res.kind}, Claude Code ${res.version ?? "?"}`);
    if (res.kind !== "cleaned") return res.kind === "nothing" ? 0 : 1;
    backup = res.backup;
    const total = res.skills.reduce((n, s) => n + s.chars, 0);
    console.log(`records emptied: ${res.records}`);
    console.log(`last record's skills (~${Math.round(total / CHARS_PER_TOKEN)} tokens): ${res.skills.map(s => `${s.name} (${s.chars})`).join(", ") || "none"}`);

    const problems: string[] = [];
    const removed = new Set<string>();
    let count = 0;
    let changed = 0;
    let invalidBefore = 0;
    const before = lines(pristine);
    const after = lines(path);
    for (;;) {
      const [b, a] = await Promise.all([before.next(), after.next()]);
      if (b.done || a.done) {
        if (b.done !== a.done) problems.push(`line count differs after line ${count}`);
        break;
      }
      count++;
      const check = compare(b.value, a.value, removed);
      if (check.invalid) invalidBefore++;
      if (check.changed) changed++;
      if (check.problem) problems.push(check.problem);
    }
    console.log(`lines: ${count}, changed: ${changed}, not JSON in the original: ${invalidBefore}`);
    console.log(`skills removed across all records: ${[...removed].join(", ") || "none"}`);
    if (changed !== res.records) problems.push(`${changed} lines differ, ${res.records} records reported`);

    await restoreCleanup(path, res.backup);
    if (!(await sameBytes(path, pristine))) problems.push("restoreCleanup did not return the file byte for byte");
    else console.log("restore: byte for byte");

    for (const p of problems) console.log(`PROBLEM: ${p}`);
    console.log(problems.length ? "FAILED" : "OK");
    return problems.length ? 1 : 0;
  } finally {
    await rm(pristine, { force: true });
    if (backup) await rm(backup, { force: true });
  }
}

function compare(b: Line, a: Line, removed: Set<string>): { changed: boolean; invalid: boolean; problem?: string } {
  const at = `line ${b.no}`;
  if (a.bytes.equals(b.bytes)) return { changed: false, invalid: parse(withoutCr(b.bytes)) === undefined };
  const old = parse(withoutCr(b.bytes));
  const now = parse(withoutCr(a.bytes));
  const preview = withoutCr(b.bytes).toString("utf8").slice(0, PREVIEW_CHARS);
  if (now === undefined) return { changed: true, invalid: old === undefined, problem: `${at}: not JSON after the edit` };
  if (!isInvokedSkills(old)) return { changed: true, invalid: false, problem: `${at}: not an invoked_skills line changed: ${preview}` };
  if (field(now, "uuid") !== field(old, "uuid")) return { changed: true, invalid: false, problem: `${at}: uuid changed` };
  const skills = field(field(now, "attachment"), "skills");
  if (!Array.isArray(skills) || skills.length) return { changed: true, invalid: false, problem: `${at}: skills not emptied` };
  const expected = JSON.stringify({ ...Object(old), attachment: { ...Object(field(old, "attachment")), skills: [] } });
  if (withoutCr(a.bytes).toString("utf8") !== expected) return { changed: true, invalid: false, problem: `${at}: more than skills changed` };
  if (a.bytes.at(-1) === CR !== (b.bytes.at(-1) === CR)) return { changed: true, invalid: false, problem: `${at}: line ending changed` };
  for (const n of namesOf(old)) removed.add(n);
  return { changed: true, invalid: false };
}

process.exit(await main());
