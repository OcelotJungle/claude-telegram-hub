import { readFileSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, relative, resolve } from "path";
import { arr, field } from "./guards.ts";
import { DEFAULT_PORT } from "./protocol.ts";

// Shared by every cswap profile, so it never depends on CLAUDE_CONFIG_DIR.
export function paths() {
  const stateDir = process.env.TG_HUB_STATE_DIR || join(homedir(), ".claude", "channels", "tg-hub");
  return {
    stateDir,
    envFile: join(stateDir, ".env"),
    configFile: join(stateDir, "config.json"),
    sessionsFile: join(stateDir, "sessions.json"),
    outboxFile: join(stateDir, "outbox.json"),
    spoolDir: join(stateDir, "spool"),
    filesDir: join(stateDir, "outbox-files"),
    logFile: join(stateDir, "hub.log"),
    inboxDir: join(stateDir, "inbox"),
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
  return process.env.TG_HUB_API_BASE || "https://api.telegram.org";
}

export function idleMs(): number {
  return Number(process.env.TG_HUB_IDLE_MS) || 5 * 60 * 1000;
}

// Hand-edited files on Windows come in whatever encoding the editor picked:
// Windows PowerShell 5.1 `>` writes UTF-16LE, Notepad may add a UTF-8 BOM.
export function readText(file: string): string {
  const b = readFileSync(file);
  if (b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString("utf16le");
  if (b[0] === 0xfe && b[1] === 0xff) return Buffer.from(b.subarray(2)).swap16().toString("utf16le");
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3).toString("utf8");
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

export type Config = { groupId?: string; allowFrom: string[] };

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
  return cfg;
}
