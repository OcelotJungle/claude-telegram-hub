// Runs one topic command apart from the hub, so a hub restart never kills it.
// The hub learns how it goes only from the files this writes: the log, as the
// output comes, and the exit file, once, when the command ends.
import { spawn } from "child_process";
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { z } from "zod";

export const runnerSpecSchema = z.object({
  argv: z.array(z.string()),
  verbatim: z.boolean(),
  cwd: z.string(),
  env: z.record(z.string(), z.string()),
  log: z.string(),
  exit: z.string(),
});
export type RunnerSpec = z.infer<typeof runnerSpecSchema>;

// code: the command's exit code; null with error when it never started.
export const exitInfoSchema = z.object({ code: z.number().nullable(), endedAt: z.number(), error: z.string().optional() });
export type ExitInfo = z.infer<typeof exitInfoSchema>;

// Starts the runner detached: out of the hub's process group and job, so it
// and its command outlive the hub. Returns the runner's pid.
export function spawnRunner(specFile: string): number {
  const child = spawn(process.execPath, [join(import.meta.dir, "exec-runner.ts"), specFile], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child.pid ?? 0;
}

function writeExit(file: string, info: ExitInfo): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(info));
  renameSync(tmp, file);
}

function run(specFile: string): void {
  const spec = runnerSpecSchema.parse(JSON.parse(readFileSync(specFile, "utf8")));
  appendFileSync(spec.log, "");
  let ended = false;
  const end = (info: ExitInfo) => {
    if (ended) return;
    ended = true;
    writeExit(spec.exit, info);
  };
  const failed = (message: string) => {
    appendFileSync(spec.log, `⚠️ не запустилось: ${message}\n`);
    end({ code: null, endedAt: Date.now(), error: message });
  };
  const [cmd, ...args] = spec.argv;
  if (cmd === undefined) return failed("пустая команда");
  const child = spawn(cmd, args, {
    cwd: spec.cwd,
    env: spec.env,
    windowsVerbatimArguments: spec.verbatim,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let startError: string | undefined;
  child.stdout.on("data", (chunk: Buffer) => appendFileSync(spec.log, chunk));
  child.stderr.on("data", (chunk: Buffer) => appendFileSync(spec.log, chunk));
  child.on("error", e => {
    // An error after the start (a failed kill) is not a failed start.
    if (child.pid !== undefined) return;
    startError = e.message;
    failed(e.message);
  });
  child.on("close", code => {
    if (startError === undefined) end({ code, endedAt: Date.now() });
  });
}

if (import.meta.main) {
  const specFile = process.argv[2];
  if (specFile !== undefined) run(specFile);
}
