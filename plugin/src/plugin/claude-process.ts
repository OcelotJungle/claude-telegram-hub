import type { Timers } from "../shared/timers.ts";

import { readFileSync } from "fs";
import { runTimed } from "../shared/timed-run.ts";

const CLAUDE_NAME = /^claude(\.exe)?$/i;
const NODE_NAME = /^node(?:\.exe)?$/i;
const CLAUDE_SCRIPT = /(?:^|\/)(?:@anthropic-ai\/claude-code\/cli\.js|claude(?:\.[cm]?js)?)$/;
// Bound the external Windows lookup, which otherwise can wait on WMI forever.
const LOOKUP_TIMEOUT_MS = 10_000;

export type ProcessInfo = { name: string; parent: number; argv?: string[] };

// A process reader answers at once (/proc) or later (an external command).
export type ProcessReader = (pid: number) => ProcessInfo | undefined | Promise<ProcessInfo | undefined>;

// The process reader for a platform: Windows asks PowerShell, every other platform reads /proc.
export function processInfoFor(platform: NodeJS.Platform): ProcessReader {
  return platform === "win32" ? windowsProcessInfo : linuxProcessInfo;
}

function isClaude(info: ProcessInfo | undefined): boolean {
  if (!info) return false;
  if (CLAUDE_NAME.test(info.name)) return true;
  return NODE_NAME.test(info.name) && CLAUDE_SCRIPT.test(info.argv?.[1] ?? "");
}

// The Claude Code process this plugin serves: CLAUDE_PID if it names one,
// else the first claude.exe up the chain of parents from `from`.
export async function findClaudePid(from: number, info: ProcessReader, claudePid?: string): Promise<number | undefined> {
  const given = Number(claudePid);
  if (Number.isInteger(given) && given > 0 && isClaude(await info(given))) return given;
  let pid = from;
  const visited = new Set<number>();
  while (pid > 0 && !visited.has(pid)) {
    visited.add(pid);
    const p = await info(pid);
    if (!p) return undefined;
    if (isClaude(p)) return pid;
    pid = p.parent;
  }
  return undefined;
}

// /proc's comm can contain spaces and parentheses; fields follow the last ')'.
export function linuxProcessInfo(pid: number, read: (path: string) => string | undefined = readProc): ProcessInfo | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const stat = read(`/proc/${pid}/stat`);
  if (!stat) return undefined;
  const opening = stat.indexOf("(");
  const closing = stat.lastIndexOf(")");
  if (opening < 0 || closing <= opening) return undefined;
  const parent = /^\s+\S+\s+(\d+)(?:\s|$)/.exec(stat.slice(closing + 1))?.[1];
  if (parent === undefined) return undefined;
  const argv = (read(`/proc/${pid}/cmdline`) ?? "").split("\0").filter(Boolean);
  return { name: stat.slice(opening + 1, closing), parent: Number(parent), argv };
}

function readProc(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); } catch { return undefined; }
}

// Name and parent of a Windows process.
export async function windowsProcessInfo(pid: number, timers?: Timers): Promise<ProcessInfo | undefined> {
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Math.trunc(pid)}"; if ($p) { "$($p.Name)|$($p.ParentProcessId)" }`;
  const r = await runTimed("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeoutMs: LOOKUP_TIMEOUT_MS, ...(timers ? { timers } : {}) });
  const m = r.stdout.trim().match(/^(.+)\|(\d+)$/);
  return m?.[1] && m[2] ? { name: m[1], parent: Number(m[2]) } : undefined;
}
