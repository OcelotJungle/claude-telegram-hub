import { spawn } from "child_process";
import { homedir } from "os";

export type ChimeKind = "ask" | "done";

// The terminal sound is a shell command; {kind} is put in.
export function defaultTurnEndChime(): string {
  const script = `${homedir().replaceAll("\\", "/")}/.claude/skills/chime/chime.ps1`;
  return `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" -Kind {kind}`;
}

// undefined: no sound (an empty template).
export function chimeCommand(template: string, kind: ChimeKind): string | undefined {
  if (template.trim() === "") return undefined;
  return template.replaceAll("{kind}", kind);
}

export function spawnShellDetached(cmd: string): void {
  const child = spawn(cmd, { shell: true, detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
}

// Starts the sound without waiting for it; never throws.
export function playChime(template: string, kind: ChimeKind, run: (cmd: string) => void = spawnShellDetached): void {
  const cmd = chimeCommand(template, kind);
  if (cmd === undefined) return;
  try {
    run(cmd);
  } catch {}
}
