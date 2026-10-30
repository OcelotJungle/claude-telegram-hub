import type { Launch } from "../shared/config.ts";

import { closeSync, openSync, readdirSync, readSync, statSync } from "fs";
import { join } from "path";
import { field } from "../shared/guards.ts";

// The head of a transcript read for its cwd: its first records carry it.
const HEAD_BYTES = 1024 * 1024;
// Read backwards in MiB blocks; a record can span several blocks.
const MODE_BLOCK_BYTES = 1024 * 1024;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PERMISSION_MODES = ["manual", "auto", "acceptEdits", "plan", "dontAsk"] as const;
export type PermissionMode = typeof PERMISSION_MODES[number];
// cswap takes an account number or e-mail; nothing a shell would act on.
const ACCOUNT = /^[\w.@-]+$/;
// The command goes through cmd.exe, which acts on these even in a path.
const CMD_SPECIAL = /["%&|<>^]/;

// Why a session cannot be started, as the topic is told.
export class LaunchError extends Error {}

// The configured command with {cwd}, {account}, {session} and {mode} put in. Every
// value is checked first, so nothing from outside can change what runs.
export function launchCommand(launch: Launch, v: { cwd: string; account: string; session: string; mode?: string }): string[] {
  if (!SESSION_ID.test(v.session)) throw new LaunchError(`странный id сессии: ${v.session}`);
  if (!ACCOUNT.test(v.account)) throw new LaunchError(`странный аккаунт: ${v.account}`);
  if (v.mode !== undefined && !isPermissionMode(v.mode)) throw new LaunchError(`неизвестный режим разрешений: ${v.mode}`);
  if (v.mode !== undefined && !hasModePlaceholder(launch)) throw new LaunchError("добавь {mode} в launch.command в config.json");
  if (CMD_SPECIAL.test(v.cwd)) throw new LaunchError(`в пути папки сессии есть символы, опасные для cmd.exe: ${v.cwd}`);
  if (!isDir(v.cwd)) throw new LaunchError(`папки сессии нет: ${v.cwd}`);
  const mode = v.mode === undefined ? "" : `--permission-mode ${v.mode}`;
  return launch.command.flatMap(part => {
    if (part === "{mode}") return mode ? ["--permission-mode", v.mode ?? ""] : [];
    const expanded = part.replaceAll("{cwd}", v.cwd).replaceAll("{account}", v.account).replaceAll("{session}", v.session).replaceAll("{mode}", mode);
    return expanded === "" ? [] : [expanded];
  });
}

export function isPermissionMode(mode: string): mode is PermissionMode {
  return PERMISSION_MODES.some(value => value === mode);
}

export function hasModePlaceholder(launch: Launch): boolean {
  return launch.command.some(part => part.includes("{mode}"));
}

// The last complete permission-mode record at or after the byte offset.
export function transcriptMode(path: string, offset?: number): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const size = statSync(path).size;
    const lower = offset ?? 0;
    if (lower > size || lower < 0) return undefined;
    let end = size;
    let suffix = Buffer.alloc(0);
    while (end > lower) {
      const start = Math.max(lower, end - MODE_BLOCK_BYTES);
      const buf = Buffer.alloc(end - start);
      const n = readSync(fd, buf, 0, buf.length, start);
      const block = Buffer.concat([buf.subarray(0, n), suffix]);
      const boundary = start === lower ? 0 : block.indexOf("\n") + 1;
      if (start !== lower && boundary === 0) {
        suffix = block;
        end = start;
        continue;
      }
      for (const line of block.subarray(boundary).toString("utf8").split("\n").reverse()) {
        let record: unknown;
        try { record = JSON.parse(line); } catch { continue; }
        if (field(record, "type") !== "permission-mode") continue;
        const mode = field(record, "permissionMode");
        if (typeof mode === "string") return mode === "default" ? "manual" : mode;
      }
      suffix = block.subarray(0, boundary);
      end = start;
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

// The cwd a session ran in, from its transcript in
// <projectsDir>/<project>/<sessionId>.jsonl.
export function sessionCwd(sessionId: string, projectsDir: string): string | undefined {
  let dirs: string[];
  try {
    dirs = readdirSync(projectsDir);
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    const head = readHead(join(projectsDir, dir, `${sessionId}.jsonl`));
    if (head === undefined) continue;
    for (const line of head.split("\n")) {
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const cwd = field(rec, "cwd");
      if (typeof cwd === "string" && cwd) return cwd;
    }
  }
  return undefined;
}

// The transcript file of a session: <projectsDir>/<project>/<sessionId>.jsonl.
export function sessionTranscript(sessionId: string, projectsDir: string): string | undefined {
  if (!SESSION_ID.test(sessionId)) return undefined;
  let dirs: string[];
  try {
    dirs = readdirSync(projectsDir);
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    const path = join(projectsDir, dir, `${sessionId}.jsonl`);
    if (isFile(path)) return path;
  }
  return undefined;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readHead(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
