import { readdirSync, readFileSync } from "fs";
import { join, relative } from "path";

// Source lines count only when they are code: a line that is a comment is not.
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;
// Escaped so this file does not contain the text it looks for.
export const TEST_WAIT = /Bun\.sleep\(|setTimeout\(/g;
export const SRC_CLOCK = /setTimeout\(|setInterval\(|Bun\.sleep\(|Date\.now\(|AbortSignal\.timeout\(/g;

// A file allowed to keep its raw uses, with the number it keeps and why.
export type Allowed = { count: number; reason: string };

export function countMatches(text: string, pattern: RegExp): number {
  let count = 0;
  for (const line of text.split("\n")) {
    if (COMMENT_LINE.test(line)) continue;
    count += line.match(pattern)?.length ?? 0;
  }
  return count;
}

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTs(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

// Per file (relative to `dir`, forward slashes) the matches of `pattern`; files with none are left out.
export function scanCounts(dir: string, pattern: RegExp): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const path of listTs(dir)) {
    const count = countMatches(readFileSync(path, "utf8"), pattern);
    if (count > 0) counts[relative(dir, path).replaceAll("\\", "/")] = count;
  }
  return counts;
}

// What differs between a scan and what is allowed: a file over its number, a new file, and a number that
// is now too high (the list must shrink as files are converted, so it always tells the truth).
export function mismatches(found: Record<string, number>, allowed: Record<string, number>): string[] {
  const out: string[] = [];
  for (const [file, count] of Object.entries(found)) {
    const limit = allowed[file];
    if (limit === undefined) out.push(`${file}: ${count} raw uses, none allowed`);
    else if (count > limit) out.push(`${file}: ${count} raw uses, ${limit} allowed`);
    else if (count < limit) out.push(`${file}: ${count} raw uses, the list says ${limit}: lower it`);
  }
  for (const file of Object.keys(allowed)) if (found[file] === undefined) out.push(`${file}: no raw uses left: remove it from the list`);
  return out;
}

export function counts(list: Record<string, Allowed>): Record<string, number> {
  return Object.fromEntries(Object.entries(list).map(([file, a]) => [file, a.count]));
}
