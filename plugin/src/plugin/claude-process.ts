import { spawnSync } from "child_process";

// claude.exe → bun run … start → bun src/plugin/main.ts: a few steps up at most.
const MAX_DEPTH = 4;
const CLAUDE_NAME = /^claude(\.exe)?$/i;
const LOOKUP_TIMEOUT_MS = 10_000;

export type ProcessInfo = { name: string; parent: number };

// The Claude Code process this plugin serves: CLAUDE_PID if it names one,
// else the first claude.exe up the chain of parents from `from`.
export function findClaudePid(from: number, info: (pid: number) => ProcessInfo | undefined, claudePid?: string): number | undefined {
  const given = Number(claudePid);
  if (Number.isInteger(given) && given > 0 && CLAUDE_NAME.test(info(given)?.name ?? "")) return given;
  let pid = from;
  for (let i = 0; i < MAX_DEPTH && pid > 0; i++) {
    const p = info(pid);
    if (!p) return undefined;
    if (CLAUDE_NAME.test(p.name)) return pid;
    pid = p.parent;
  }
  return undefined;
}

// Name and parent of a Windows process.
export function windowsProcessInfo(pid: number): ProcessInfo | undefined {
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Math.trunc(pid)}"; if ($p) { "$($p.Name)|$($p.ParentProcessId)" }`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: LOOKUP_TIMEOUT_MS, windowsHide: true });
  const m = (r.stdout ?? "").trim().match(/^(.+)\|(\d+)$/);
  return m?.[1] && m[2] ? { name: m[1], parent: Number(m[2]) } : undefined;
}
