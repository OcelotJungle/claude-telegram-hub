import type { Launch } from "../shared/config.ts";

import { closeSync, openSync, readdirSync, readSync, statSync } from "fs";
import { join } from "path";
import { field } from "../shared/guards.ts";

// The head of a transcript read for its cwd: its first records carry it.
const HEAD_BYTES = 1024 * 1024;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// cswap takes an account number or e-mail; nothing a shell would act on.
const ACCOUNT = /^[\w.@-]+$/;
// The command goes through cmd.exe, which acts on these even in a path.
const CMD_SPECIAL = /["%&|<>^]/;

// Why a session cannot be started, as the topic is told.
export class LaunchError extends Error {}

// The configured command with {cwd}, {account} and {session} put in. Every
// value is checked first, so nothing from outside can change what runs.
export function launchCommand(launch: Launch, v: { cwd: string; account: string; session: string }): string[] {
  if (!SESSION_ID.test(v.session)) throw new LaunchError(`странный id сессии: ${v.session}`);
  if (!ACCOUNT.test(v.account)) throw new LaunchError(`странный аккаунт: ${v.account}`);
  if (CMD_SPECIAL.test(v.cwd)) throw new LaunchError(`в пути папки сессии есть символы, опасные для cmd.exe: ${v.cwd}`);
  if (!isDir(v.cwd)) throw new LaunchError(`папки сессии нет: ${v.cwd}`);
  return launch.command.map(part => part.replaceAll("{cwd}", v.cwd).replaceAll("{account}", v.account).replaceAll("{session}", v.session));
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
