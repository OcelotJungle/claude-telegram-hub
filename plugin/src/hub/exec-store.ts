// The hub's topic command runs on disk, so a restarted hub goes on watching
// the commands that still run and delivers the results it has not delivered.
import type { ExecShell } from "./exec-shell.ts";
import type { MachineDestination } from "./machine-outbox.ts";
import type { RigInvocation } from "./rig.ts";

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import { z } from "zod";

// pending: came while the hub was off, waits for its button. chatId and
// messageId: the command message's. sentAt: the
// command message's date. pid: the runner's. stopping: the stop button was
// pressed. end.reason: why a lost run was lost. reported: the agent has it.
export type ExecRecord = {
  id: string;
  sessionId?: string;
  destination?: MachineDestination;
  invocation?: RigInvocation;
  chatId?: string;
  messageId: number;
  shell: ExecShell | "rig";
  text: string;
  cwd: string;
  state: "pending" | "running" | "ended";
  sentAt?: number;
  startedAt?: number;
  pid?: number;
  stopping?: boolean;
  end?: { kind: "exit" | "stopped" | "lost"; code?: number; at: number; reason?: string };
  reported: boolean;
};

const fileSchema: z.ZodType<ExecRecord[]> = z.array(
  z.object({
    id: z.string(),
    sessionId: z.string().optional(),
    destination: z.object({ chatId: z.string(), topicId: z.number().optional() }).optional(),
    invocation: z.object({ argv: z.array(z.string()).min(1), verbatim: z.boolean() }).optional(),
    chatId: z.string().optional(),
    messageId: z.number(),
    shell: z.enum(["powershell", "cmd", "bash", "rig"]),
    text: z.string(),
    cwd: z.string(),
    state: z.enum(["pending", "running", "ended"]),
    sentAt: z.number().optional(),
    startedAt: z.number().optional(),
    pid: z.number().optional(),
    stopping: z.boolean().optional(),
    end: z
      .object({ kind: z.enum(["exit", "stopped", "lost"]), code: z.number().optional(), at: z.number(), reason: z.string().optional() })
      .optional(),
    reported: z.boolean(),
  }).refine(record => record.shell === "rig" ? record.destination !== undefined && record.invocation !== undefined : record.sessionId !== undefined),
);

// The runs, oldest first; none when the file is missing, and none, the file
// set aside, when it is unreadable.
export function loadExecs(file: string): ExecRecord[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  try {
    return fileSchema.parse(JSON.parse(raw));
  } catch {
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {}
    return [];
  }
}

export function saveExecs(file: string, recs: ExecRecord[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(recs));
  renameSync(tmp, file);
}
