// Runs one topic command apart from the hub, so a hub restart never kills it.
// The hub learns how it goes only from the files this writes: the log, as the
// output comes, the heartbeat file, touched while the runner lives, and the
// exit file, once, when the command ends.
import { spawn, spawnSync } from "child_process";
import { appendFileSync, readFileSync, renameSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { field } from "../shared/guards.ts";

// How often the runner touches its heartbeat file.
export const HEARTBEAT_MS = 10_000;
const MS_PER_SECOND = 1000;

export const runnerSpecSchema = z.object({
  argv: z.array(z.string()),
  verbatim: z.boolean(),
  cwd: z.string(),
  env: z.record(z.string(), z.string()),
  log: z.string(),
  exit: z.string(),
  // The heartbeat file: its time is the runner's last sign of life.
  alive: z.string(),
  heartbeatMs: z.number(),
});
export type RunnerSpec = z.infer<typeof runnerSpecSchema>;

// code: the command's exit code; null with error when it never started.
export const exitInfoSchema = z.object({ code: z.number().nullable(), endedAt: z.number(), error: z.string().optional() });
export type ExitInfo = z.infer<typeof exitInfoSchema>;

// Starts the runner detached: out of the hub's process group and job, so it
// and its command outlive the hub. Returns the runner's pid; throws when the
// runner did not start, since no pid means nothing to follow or stop.
// runtime: what runs the runner, for tests.
export function spawnRunner(specFile: string, runtime = process.execPath): number {
  const child = spawn(runtime, [join(import.meta.dir, "exec-runner.ts"), specFile], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  // A failed spawn reports here too; unheard, it would take the hub down.
  child.on("error", () => {});
  child.unref();
  if (child.pid === undefined) throw new Error(`раннер не запустился: ${runtime}`);
  return child.pid;
}

// A topic command's runner and everything it started.
export function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
}

// EPERM: the process is there, only not ours to signal.
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return field(e, "code") === "EPERM";
  }
}

function writeExit(file: string, info: ExitInfo): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(info));
  renameSync(tmp, file);
}

function touch(file: string): void {
  const now = Date.now() / MS_PER_SECOND;
  try {
    utimesSync(file, now, now);
  } catch {
    try {
      writeFileSync(file, "");
    } catch {}
  }
}

function run(specFile: string): void {
  const spec = runnerSpecSchema.parse(JSON.parse(readFileSync(specFile, "utf8")));
  appendFileSync(spec.log, "");
  touch(spec.alive);
  const heartbeat = setInterval(() => touch(spec.alive), spec.heartbeatMs);
  let ended = false;
  const end = (info: ExitInfo) => {
    if (ended) return;
    ended = true;
    clearInterval(heartbeat);
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
