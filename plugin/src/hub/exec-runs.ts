// What the hub keeps of the topic commands it started through `rig exec`: only what is Telegram's, which
// run belongs to which card (chat, message, session), whether the agent has the result, and how far the
// run's log has been read. The run itself, its log and its end are rig's; a restarted hub goes on
// polling a running one by its id.
import type { ExecEndKind, ExecShellName } from "./rig-exec.ts";
import type { MachineDestination } from "./machine-outbox.ts";

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import { z } from "zod";

// id: the hub's own, in the card's button data; runId: rig's, once the run has started. pending: the
// command waits for its Run button (it came too old, or its start failed before). chatId and messageId:
// the command message's. sentAt: its date (ms). args: a rig run's arguments (shell "rig"); cwd: a shell run's
// folder. offset: the byte of the run's log to read next. end.reason: why a lost run was lost, a code
// (process-gone, start-failed with end.detail the text of the failure) or rig's own text (shown as it is).
// reported: the agent has the result; reportTail: the last lines the agent report will carry, kept
// until the agent has it.
export type ExecRun = {
  id: string;
  runId?: string;
  sessionId?: string;
  destination?: MachineDestination;
  chatId?: string;
  messageId: number;
  shell: ExecShellName | "rig";
  text: string;
  args?: string[];
  cwd?: string;
  state: "pending" | "running" | "ended";
  sentAt?: number;
  startedAt?: number;
  offset: number;
  end?: { kind: ExecEndKind; code?: number; at: number; reason?: string; detail?: string };
  reported: boolean;
  reportTail?: string;
  // starting: the record was saved before `rig exec start` was asked and rig's answer is not kept yet. startUnknown: a hub
  // restarted in that window; whether rig started the run is not known, so only the Run button starts it again.
  starting?: boolean;
  startUnknown?: boolean;
  // The run's log file (a log that does not fit the card): "owed" is saved with the run's end, "sent" once the file
  // was handed over. A restarted hub builds and sends an owed file; a sent one never goes again. None: no file.
  logFile?: "owed" | "sent";
};

const fileSchema: z.ZodType<ExecRun[]> = z.array(
  z.object({
    id: z.string(),
    runId: z.string().optional(),
    sessionId: z.string().optional(),
    destination: z.object({ chatId: z.string(), topicId: z.number().optional() }).optional(),
    chatId: z.string().optional(),
    messageId: z.number(),
    shell: z.enum(["pwsh", "cmd", "bash", "rig"]),
    text: z.string(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    state: z.enum(["pending", "running", "ended"]),
    sentAt: z.number().optional(),
    startedAt: z.number().optional(),
    offset: z.number(),
    end: z
      .object({ kind: z.enum(["exit", "stopped", "lost"]), code: z.number().optional(), at: z.number(), reason: z.string().optional(), detail: z.string().optional() })
      .optional(),
    reported: z.boolean(),
    reportTail: z.string().optional(),
    starting: z.boolean().optional(),
    startUnknown: z.boolean().optional(),
    logFile: z.enum(["owed", "sent"]).optional(),
  }).refine(run => (run.shell === "rig" ? run.destination !== undefined && run.args !== undefined : run.sessionId !== undefined && run.cwd !== undefined))
    .refine(run => run.state !== "running" || run.runId !== undefined),
);

// The runs, oldest first; none when the file is missing, and none, the file set aside, when it is unreadable.
export function loadRuns(file: string): ExecRun[] {
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

export function saveRuns(file: string, runs: ExecRun[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(runs));
  renameSync(tmp, file);
}
