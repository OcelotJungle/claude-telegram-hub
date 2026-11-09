// Whether an outside worker (Codex, volunteers) is available to a session:
// its rig feature is enabled in the rig state AND the session's Claude config
// dir holds the worker's agent file. /info shows a worker's block only then.
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";

export type Worker = "codex" | "volunteers";
export type WorkerAvailability = { available: false } | { available: true; repo: string | undefined };

// Agent file of each worker in <configDir>/agents/.
const AGENT_FILES: Record<Worker, string> = { codex: "codex.md", volunteers: "volunteer.md" };
const rigStateSchema = z.object({
  paths: z.object({ repo: z.string().optional() }).optional(),
  features: z.record(z.string(), z.boolean()).optional(),
});

function readRigState(rigDir: string): z.infer<typeof rigStateSchema> | undefined {
  try {
    const parsed = rigStateSchema.safeParse(JSON.parse(readFileSync(join(rigDir, "state.json"), "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function workerAvailability(worker: Worker, rigDir: string | undefined, configDir: string): WorkerAvailability {
  if (!rigDir) return { available: false };
  const state = readRigState(rigDir);
  if (state?.features?.[worker] !== true) return { available: false };
  if (!existsSync(join(configDir, "agents", AGENT_FILES[worker]))) return { available: false };
  return { available: true, repo: state.paths?.repo };
}

// A rig tool lives in the rig clone: <paths.repo>/features/<feature>/tools/<name>.
export function rigToolPath(repo: string | undefined, worker: Worker, name: string): string | undefined {
  return repo ? join(repo, "features", worker, "tools", name) : undefined;
}
