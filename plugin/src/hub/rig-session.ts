import { z } from "zod";

// Rig allows ten minutes for a queued compaction, fifteen seconds for stop, and
// ninety seconds plus a two-second launch grace. Keep the hub outside that budget.
const RIG_COMPACT_LIMIT_MS = 10 * 60 * 1000;
const RIG_STOP_LIMIT_MS = 15 * 1000;
const RIG_LAUNCH_LIMIT_MS = (90 + 2) * 1000;
const RIG_TRANSPORT_GRACE_MS = 30 * 1000;
export const RIG_SESSION_LIMIT_MS = RIG_COMPACT_LIMIT_MS + RIG_STOP_LIMIT_MS + RIG_LAUNCH_LIMIT_MS + RIG_TRANSPORT_GRACE_MS;
export const PERMISSION_MODES = ["manual", "auto", "acceptEdits", "plan", "dontAsk"] as const;
const modeSchema = z.enum(PERMISSION_MODES);
const session = z.string();
const tokens = { tokensBefore: z.number().nonnegative(), tokensAfter: z.number().nonnegative() };
const compacted = z.strictObject(tokens);
const skipped = z.strictObject({ skip: z.string() });
const compactError = z.strictObject({ error: z.string() });

export const rigCompactSchema = z.union([z.strictObject({ session, ...tokens }), z.strictObject({ session, skip: z.string() })]);
export const rigRenameSchema = z.strictObject({ session, name: z.string() });
export const rigAutocompactSchema = z.strictObject({ session, window: z.union([z.number().int().positive(), z.literal("auto")]), text: z.string().optional() });
export const rigStopSchema = z.union([
  z.strictObject({ session, stopped: z.literal(false), reason: z.literal("not-running") }),
  z.strictObject({ session, stopped: z.literal(true), compacted: z.union([compacted, skipped, compactError]).nullable() }),
]);
export const rigCleanupSchema = z.strictObject({ session, compacted, backup: z.string(), skillsRemoved: z.number().int().nonnegative() });
export const rigRunSchema = z.strictObject({ session, pid: z.number().int().positive(), mode: modeSchema.nullable(), account: z.number().int().positive().nullable() });
export const rigModeSchema = z.union([
  z.strictObject({ session, mode: modeSchema, pid: z.number().int().positive() }),
  z.strictObject({ session, mode: modeSchema, changed: z.literal(false) }),
]);

export type PermissionMode = z.infer<typeof modeSchema>;
export type RigCompact = z.infer<typeof rigCompactSchema>;
export type RigRename = z.infer<typeof rigRenameSchema>;
export type RigAutocompact = z.infer<typeof rigAutocompactSchema>;
export type RigStop = z.infer<typeof rigStopSchema>;
export type RigCleanup = z.infer<typeof rigCleanupSchema>;
export type RigRun = z.infer<typeof rigRunSchema>;
export type RigMode = z.infer<typeof rigModeSchema>;
export type RigRunOptions = { account?: string; mode?: PermissionMode };

export function isPermissionMode(value: unknown): value is PermissionMode {
  return modeSchema.safeParse(value).success;
}

// Where a request to a session's window stands, as rig (0.7.6 and later) reports it on each change: waiting behind a
// running turn or an earlier request, or running after such a wait. A request that runs at once reports nothing.
const SESSION_PROGRESS = { "session-waiting": "waiting", "session-running": "running" } as const;
const sessionProgressSchema = z.object({ progress: z.object({ code: z.enum(["session-waiting", "session-running"]) }) });

export type SessionProgress = (typeof SESSION_PROGRESS)[keyof typeof SESSION_PROGRESS];

// JSON progress is a separate stderr protocol; unrelated stderr remains diagnostic text. A result's error code of the
// same words (`rig session run` refusing a running session) comes in the final JSON, never as a progress line.
export function sessionProgress(line: string): SessionProgress | undefined {
  try {
    const parsed = sessionProgressSchema.safeParse(JSON.parse(line));
    return parsed.success ? SESSION_PROGRESS[parsed.data.progress.code] : undefined;
  } catch {
    return undefined;
  }
}
