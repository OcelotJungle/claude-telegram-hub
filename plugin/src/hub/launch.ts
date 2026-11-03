import type { Launch } from "../shared/config.ts";
import type { Messages } from "../shared/i18n/index.ts";
import type { Platform } from "../shared/platform.ts";

import { spawn } from "child_process";
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { field } from "../shared/guards.ts";
import { catalogOf } from "../shared/i18n/index.ts";
import { PLATFORM } from "../shared/platform.ts";

// A launch command that ends within this time with a non-zero code failed to
// launch (tmux new-session -d exits at once and reports through its code). One
// that is still running after it (a Windows terminal window) launched.
export const LAUNCH_EXIT_GRACE_MS = 2000;
// The part of the command's stderr the topic is told.
const STDERR_LIMIT = 1000;
const TMUX_EXECUTABLE = /^tmux(\.exe)?$/i;
const TMUX_SESSION_FLAG = "-s";

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

// Why a session cannot be started. `message` is English for the log; `render` is the text the topic is told, in the hub's language.
export class LaunchError extends Error {
  constructor(readonly render: (m: Messages) => string) {
    super(render(catalogOf("en")));
  }
}

// The configured command with {cwd}, {account}, {session} and {mode} put in. Every
// value is checked first, so nothing from outside can change what runs.
export function launchCommand(launch: Launch, v: { cwd: string; account: string; session: string; mode?: string }, platform: Platform = PLATFORM): string[] {
  if (!SESSION_ID.test(v.session)) throw new LaunchError(m => m.launchBadSession({ session: v.session }));
  if (v.account !== "" && !ACCOUNT.test(v.account)) throw new LaunchError(m => m.launchBadAccount({ account: v.account }));
  if (v.mode !== undefined && !isPermissionMode(v.mode)) {
    const mode = v.mode;
    throw new LaunchError(m => m.launchBadMode({ mode }));
  }
  if (v.mode !== undefined && !hasModePlaceholder(launch)) throw new LaunchError(m => m.launchNeedModePlaceholder);
  // On Windows cmd may sit anywhere in the template (wt.exe starts it), so the check always applies;
  // on Linux the command runs without a shell.
  if (platform.windows && CMD_SPECIAL.test(v.cwd)) throw new LaunchError(m => m.launchUnsafeCwd({ cwd: v.cwd }));
  if (!isDir(v.cwd)) throw new LaunchError(m => m.launchNoDirectory({ cwd: v.cwd }));
  const mode = v.mode === undefined ? "" : `--permission-mode ${v.mode}`;
  return launch.command.flatMap(part => {
    if (part === "{mode}") return mode ? ["--permission-mode", v.mode ?? ""] : [];
    const expanded = part.replaceAll("{cwd}", v.cwd).replaceAll("{account}", v.account).replaceAll("{session}", v.session).replaceAll("{mode}", mode);
    return expanded === "" ? [] : [expanded];
  });
}

// A launch command that ended with a failure soon after it started.
export class LaunchExitError extends LaunchError {
  constructor(readonly code: number | null, readonly stderr: string) {
    super(m => m.launchExited({ code, stderr }));
  }
}

export type SpawnTimers = {
  graceMs: number;
  setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
};

// Starts the launch command detached. Resolves once it is running past the
// grace time or has ended with code 0; rejects when it cannot start or ends
// within the grace time with another code. Its stderr goes to a file, so a
// long-lived command never meets a closed pipe.
export function spawnDetached(command: string[], timers: SpawnTimers = { graceMs: LAUNCH_EXIT_GRACE_MS, setTimer: setTimeout, clearTimer: clearTimeout }): Promise<void> {
  const [exe, ...args] = command;
  if (!exe) throw new LaunchError(m => m.launchEmptyCommand);
  const dir = mkdtempSync(join(tmpdir(), "hub-launch-"));
  const errPath = join(dir, "stderr");
  const errFd = openSync(errPath, "w");
  const cleanup = () => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* still open on Windows: the temp dir is swept later */ }
  };
  const readStderr = () => {
    try { return readFileSync(errPath, "utf8").trim().slice(0, STDERR_LIMIT); } catch { return ""; }
  };
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(exe, args, { detached: true, stdio: ["ignore", "ignore", errFd] });
  } catch (e) {
    closeSync(errFd);
    cleanup();
    throw e;
  }
  closeSync(errFd);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      // Held until now so that its exit is seen; after, it must not keep the hub alive.
      child.unref();
      timers.clearTimer(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = timers.setTimer(() => finish(), timers.graceMs);
    child.once("error", e => { cleanup(); finish(e); });
    child.once("exit", code => {
      const stderr = settled || code === 0 ? "" : readStderr();
      cleanup();
      finish(code === 0 ? undefined : new LaunchExitError(code, stderr));
    });
  });
}

export function isTmuxCommand(command: string[]): boolean {
  const [exe] = command;
  return exe !== undefined && TMUX_EXECUTABLE.test(basename(exe));
}

// The tmux session a launch command creates (its -s value), if it names one.
export function tmuxSession(command: string[]): string | undefined {
  if (!isTmuxCommand(command)) return undefined;
  const at = command.indexOf(TMUX_SESSION_FLAG);
  return at < 0 ? undefined : command[at + 1];
}

// Where to look at a tmux session the user must answer in.
export function tmuxAttachHint(command: string[], m: Messages): string {
  const session = tmuxSession(command);
  return session ? `tmux attach -t ${session}` : m.tmuxGenericHint;
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
