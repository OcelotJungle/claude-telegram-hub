import { readFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, relative, resolve } from "path";
import { z } from "zod";
import { arr, field } from "./guards.ts";
import { DEFAULT_PORT } from "./protocol.ts";

export const API_BASE = "https://api.telegram.org";
const DEFAULT_IDLE_MS = 5 * 60 * 1000;
const DEFAULT_LAUNCH_TIMEOUT_SEC = 90;
// Byte order marks.
const UTF16LE_BOM = [0xff, 0xfe];
const UTF16BE_BOM = [0xfe, 0xff];
const UTF8_BOM = [0xef, 0xbb, 0xbf];

// Shared by every cswap profile, so it never depends on CLAUDE_CONFIG_DIR.
export function paths() {
  const stateDir = process.env.TG_HUB_STATE_DIR || join(homedir(), ".claude", "channels", "tg-hub");
  return {
    stateDir,
    envFile: join(stateDir, ".env"),
    configFile: join(stateDir, "config.json"),
    sessionsFile: join(stateDir, "sessions.json"),
    outboxFile: join(stateDir, "outbox.json"),
    cardsFile: join(stateDir, "cards.json"),
    spoolDir: join(stateDir, "spool"),
    filesDir: join(stateDir, "outbox-files"),
    logFile: join(stateDir, "hub.log"),
    inboxDir: join(stateDir, "inbox"),
    execDir: join(stateDir, "exec"),
    execsFile: join(stateDir, "execs.json"),
  };
}

// path lies inside dir (not dir itself).
export function isInside(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function hubPort(): number {
  return Number(process.env.TG_HUB_PORT) || DEFAULT_PORT;
}

export function apiBase(): string {
  return process.env.TG_HUB_API_BASE || API_BASE;
}

// 0 (TG_HUB_IDLE_MS=0): the hub never exits for want of windows.
export function idleMs(): number {
  const v = process.env.TG_HUB_IDLE_MS;
  if (v === undefined || v.trim() === "") return DEFAULT_IDLE_MS;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_IDLE_MS;
}

// Hand-edited files on Windows come in whatever encoding the editor picked:
// Windows PowerShell 5.1 `>` writes UTF-16LE, Notepad may add a UTF-8 BOM.
export function readText(file: string): string {
  const b = readFileSync(file);
  const startsWith = (bom: number[]) => bom.every((byte, i) => b[i] === byte);
  if (startsWith(UTF16LE_BOM)) return b.subarray(UTF16LE_BOM.length).toString("utf16le");
  if (startsWith(UTF16BE_BOM)) return Buffer.from(b.subarray(UTF16BE_BOM.length)).swap16().toString("utf16le");
  if (startsWith(UTF8_BOM)) return b.subarray(UTF8_BOM.length).toString("utf8");
  return b.toString("utf8");
}

export function loadToken(): string | undefined {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  try {
    for (const line of readText(paths().envFile).split(/\r?\n/)) {
      const m = line.match(/^\s*TELEGRAM_BOT_TOKEN\s*=\s*(.*?)\s*$/);
      if (m && m[1]) return m[1];
    }
  } catch {}
  return undefined;
}

// How the hub starts a session that has no window: command is the program
// and its arguments, with {cwd}, {account} and {session} put in.
export type Launch = { command: string[]; timeoutSec: number };

// Topic commands: bash is the Git Bash /bash runs in.
export type ExecConfig = { bash?: string };

// launchError: config.json has a launch section that is not valid.
export type Config = { groupId?: string; allowFrom: string[]; launch?: Launch; launchError?: string; exec?: ExecConfig };

const execSchema: z.ZodType<ExecConfig> = z.object({ bash: z.string().min(1).optional() });

const launchSchema: z.ZodType<Launch> = z.object({
  command: z.array(z.string()).min(1),
  timeoutSec: z.number().positive().default(DEFAULT_LAUNCH_TIMEOUT_SEC),
});

export function loadConfig(): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(readText(paths().configFile));
  } catch {
    return { allowFrom: [] };
  }
  const groupId = field(raw, "groupId");
  const cfg: Config = { allowFrom: arr(field(raw, "allowFrom")).map(String) };
  if (groupId != null && groupId !== "") cfg.groupId = String(groupId);
  const launch = field(raw, "launch");
  if (launch !== undefined) {
    const parsed = launchSchema.safeParse(launch);
    if (parsed.success) cfg.launch = parsed.data;
    else cfg.launchError = z.prettifyError(parsed.error);
  }
  // A broken exec section is left out: /bash then looks in the default place.
  const exec = execSchema.safeParse(field(raw, "exec"));
  if (exec.success && exec.data.bash !== undefined) cfg.exec = exec.data;
  return cfg;
}
