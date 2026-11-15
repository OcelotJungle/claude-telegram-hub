import type { InfoData } from "../shared/info-data.ts";

import { z } from "zod";

// rig's InfoData contract (its src/info-data.ts), checked where rig's answer enters the hub.
// Strict: a field rig does not promise fails the answer instead of being passed on to the window.
const time = z.string().nullable();
const blockError = z.strictObject({ error: z.strictObject({ code: z.string(), message: z.string() }) });
const claudeLimit = z.strictObject({ kind: z.string(), percentUsed: z.number(), resetsAt: time });
const claude = z.strictObject({ at: time, sessionId: z.string(), limits: z.array(claudeLimit) });
const codexLimit = z.strictObject({ windowMinutes: z.number(), usedPercent: z.number(), resetsAt: time });
const codex = z.strictObject({ at: z.string(), limits: z.array(codexLimit) });
const volunteerProvider = z.strictObject({ used: z.number(), cap: z.number().nullable() });
const volunteers = z.strictObject({
  at: z.string(),
  source: z.string(),
  dayPercent: z.number(),
  used: z.number().nullable(),
  cap: z.number().nullable(),
  resetsAt: time,
  providers: z.record(z.string(), volunteerProvider),
});
const context = z.strictObject({
  at: time,
  tokens: z.number(),
  window: z.number().nullable(),
  threshold: z.number().optional(),
  autocompact: z.boolean().optional(),
  estimated: z.literal(true).optional(),
});

export const infoDataSchema: z.ZodType<InfoData> = z.strictObject({
  session: z.string(),
  account: z.number().nullable(),
  claude: z.union([claude, blockError]),
  codex: z.union([codex, blockError]).optional(),
  volunteers: z.union([volunteers, blockError]).optional(),
  context: z.union([context, blockError]),
});
