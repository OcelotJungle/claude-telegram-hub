import type { Platform } from "./platform.ts";

import { spawn } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { PLATFORM } from "./platform.ts";

export type ChimeKind = "ask" | "done";

// The terminal sound is a shell command; {kind} is put in.
export function defaultTurnEndChime(platform: Platform = PLATFORM): string {
  if (!platform.sound) return "";
  const script = `${homedir().replaceAll("\\", "/")}/.claude/skills/chime/chime.ps1`;
  return `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" -Kind {kind}`;
}

// undefined: no sound (an empty template).
export function chimeCommand(template: string, kind: ChimeKind): string | undefined {
  if (template.trim() === "") return undefined;
  return template.replaceAll("{kind}", kind);
}

// Starts a shell command that outlives this process.
//
// On Windows a detached child has no console at all, so a console program the
// shell starts gets a new one, and Windows Terminal (the default terminal)
// opens it as a visible window: windowsHide does not reach it. An attached
// child would get a hidden console, but it sits in this process's job and dies
// with it. So a detached relay runs the shell attached and waits for it.
export function spawnShellDetached(cmd: string): void {
  const options = { detached: true, stdio: "ignore", windowsHide: true } as const;
  const child = PLATFORM.windows
    ? spawn(process.execPath, [join(import.meta.dir, "shell-relay.ts"), cmd], options)
    : spawn(cmd, { ...options, shell: true });
  child.on("error", () => {});
  child.unref();
}

// Starts the sound without waiting for it; never throws.
export function playChime(template: string, kind: ChimeKind, run: (cmd: string) => void = spawnShellDetached, platform: Platform = PLATFORM): void {
  if (!platform.sound) return;
  const cmd = chimeCommand(template, kind);
  if (cmd === undefined) return;
  try {
    run(cmd);
  } catch {}
}
