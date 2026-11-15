// The hub's client of `rig exec`: rig runs a topic command (a shell's text or a rig mutation) as a
// detached run that outlives the hub; the hub starts it, reads its log page by page, and stops it.
// Every call is one async rig call over Rig.query, so it is timed out, reported as data and never throws.
import type { Rig, RigError, RigResult } from "./rig.ts";

import { z } from "zod";

export type ExecShellName = "pwsh" | "cmd" | "bash";
export type ExecEndKind = "exit" | "stopped" | "lost";

const endSchema = z.object({
  kind: z.enum(["exit", "stopped", "lost"]),
  // null: the process was killed or the exit code is unknown.
  code: z.number().nullable().optional(),
  at: z.string(),
  // Rig's free text for the end: "empty-result", "invalid-result" or why a run was lost.
  reason: z.string().optional(),
});
// from, to and size count bytes; text is the decoded slice (rig keeps a character that a page cuts for the next one).
const logSchema = z.object({ from: z.number(), to: z.number(), size: z.number(), text: z.string() });

const startSchema = z.object({ id: z.string(), shell: z.string(), pid: z.number().optional(), startedAt: z.string() });
export const execStatusSchema = z.object({
  id: z.string(),
  shell: z.string(),
  startedAt: z.string(),
  state: z.enum(["running", "ended"]),
  end: endSchema.optional(),
  // Only a rig run that has ended, and only when rig printed a JSON object: the answer of the command.
  result: z.unknown().optional(),
  log: logSchema,
});
const stopSchema = z.object({ id: z.string(), stopping: z.boolean().optional(), state: z.string().optional() });

export type ExecStart = z.infer<typeof startSchema>;
export type ExecStatus = z.infer<typeof execStatusSchema>;
export type ExecEnd = z.infer<typeof endSchema>;
export type ExecStop = z.infer<typeof stopSchema>;
// A rig failure, or a working folder that cannot be put on a Windows command line.
export type ExecError = RigError | { kind: "cwdUnsafe" };

// A working folder that cmd.exe would read as something else once it is on a command line.
const UNSAFE_CWD = /["%\r\n]/;
const PLAIN_CWD = /^[A-Za-z0-9._:\\/-]+$/;

export type CwdCheck = { ok: true; arg: string } | { ok: false };

// The --cwd value as the command line carries it. On Windows rig is a .cmd file started through cmd.exe
// with its arguments joined verbatim, so a folder with a space needs quotes and one with a quote or a
// percent sign cannot be passed at all.
export function cwdArg(cwd: string, windows: boolean): CwdCheck {
  if (!windows) return { ok: true, arg: cwd };
  if (UNSAFE_CWD.test(cwd)) return { ok: false };
  return { ok: true, arg: PLAIN_CWD.test(cwd) ? cwd : `"${cwd}"` };
}

// What the hub's run manager needs of rig exec; RigExec is the real one, tests give a fake.
export type ExecClient = {
  start(shell: ExecShellName, cwd: string, text: string): Promise<RigResult<ExecStart, ExecError>>;
  startRig(args: string[]): Promise<RigResult<ExecStart>>;
  status(id: string, from: number): Promise<RigResult<ExecStatus>>;
  stop(id: string): Promise<RigResult<ExecStop>>;
};

export class RigExec implements ExecClient {
  constructor(private rig: Rig, private windows: boolean) {}

  // The text goes to rig on stdin, never onto a command line.
  async start(shell: ExecShellName, cwd: string, text: string): Promise<RigResult<ExecStart, ExecError>> {
    const folder = cwdArg(cwd, this.windows);
    if (!folder.ok) return { ok: false, error: { kind: "cwdUnsafe" } };
    return this.rig.query(["exec", "start", shell, "--cwd", folder.arg], startSchema, { stdin: text });
  }

  // The arguments are the ones rigAction has validated.
  startRig(args: string[]): Promise<RigResult<ExecStart>> {
    return this.rig.query(["exec", "start", "rig", "--", ...args], startSchema);
  }

  status(id: string, from: number): Promise<RigResult<ExecStatus>> {
    return this.rig.query(["exec", "status", id, "--from", String(from)], execStatusSchema);
  }

  stop(id: string): Promise<RigResult<ExecStop>> {
    return this.rig.query(["exec", "stop", id], stopSchema);
  }
}

// Rig codes that say the run is not there and never will be: polling it again changes nothing.
const GONE_CODES = new Set(["exec-unknown", "exec-bad-id"]);

export function isGone(error: ExecError): boolean {
  return error.kind === "rig" && GONE_CODES.has(error.code);
}
