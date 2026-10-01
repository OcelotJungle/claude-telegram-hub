import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// Shared by every cswap profile, so it never depends on CLAUDE_CONFIG_DIR.
export function paths() {
  const stateDir = process.env.TG_HUB_STATE_DIR || join(homedir(), '.claude', 'channels', 'tg-hub')
  return {
    stateDir,
    envFile: join(stateDir, '.env'),
    configFile: join(stateDir, 'config.json'),
    sessionsFile: join(stateDir, 'sessions.json'),
    logFile: join(stateDir, 'hub.log'),
    inboxDir: join(stateDir, 'inbox'),
  }
}

export const DEFAULT_PORT = 47613

export function hubPort(): number {
  return Number(process.env.TG_HUB_PORT) || DEFAULT_PORT
}

export function apiBase(): string {
  return process.env.TG_HUB_API_BASE || 'https://api.telegram.org'
}

export function idleMs(): number {
  return Number(process.env.TG_HUB_IDLE_MS) || 5 * 60 * 1000
}

export function loadToken(): string | undefined {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN
  try {
    for (const line of readFileSync(paths().envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*TELEGRAM_BOT_TOKEN\s*=\s*(.*?)\s*$/)
      if (m && m[1]) return m[1]
    }
  } catch {}
  return undefined
}

export type Config = { groupId?: string; allowFrom: string[] }

export function loadConfig(): Config {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(paths().configFile, 'utf8'))
  } catch {
    return { allowFrom: [] }
  }
  const obj = (raw ?? {}) as { groupId?: unknown; allowFrom?: unknown }
  const cfg: Config = {
    allowFrom: Array.isArray(obj.allowFrom) ? obj.allowFrom.map(String) : [],
  }
  if (obj.groupId != null && obj.groupId !== '') cfg.groupId = String(obj.groupId)
  return cfg
}
