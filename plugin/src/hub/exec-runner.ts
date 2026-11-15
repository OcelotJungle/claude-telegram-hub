// Runs one topic command apart from the hub, so a hub restart never kills it.
// The hub learns how it goes only from the files this writes: the log, as the
// output comes, the heartbeat file, touched while the runner lives, and the
// exit file, once, when the command ends.
import { spawn, spawnSync } from "child_process";
import { appendFileSync, readFileSync, renameSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { field } from "../shared/guards.ts";
import { PLATFORM } from "../shared/platform.ts";

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
  // Set for a rig run: the streams are kept apart, each as whole lines. stderr (the progress) goes to
  // `log`, stdout (the result or the error) to this file. Unset: both go to `log` as the bytes come.
  result: z.string().optional(),
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
  if (child.pid === undefined) throw new Error(`runner did not start: ${runtime}`);
  return child.pid;
}

// A topic command's runner and everything it started.
export function killTree(pid: number): void {
  if (PLATFORM.windows) {
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

const NEWLINE = 0x0a;

// Cuts a byte stream into whole lines: push gives back the complete lines of what came so far (each with its
// "\n"), the partial tail waits for the next chunk; flush gives the tail as a line when the stream ends.
// It works on bytes, so a multi-byte character split between two chunks stays whole.
export function lineSplitter(): { push: (chunk: Buffer) => Buffer; flush: () => Buffer } {
  let tail: Buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      const all = Buffer.concat([tail, chunk]);
      const end = all.lastIndexOf(NEWLINE);
      if (end === -1) {
        tail = all;
        return Buffer.alloc(0);
      }
      tail = all.subarray(end + 1);
      return all.subarray(0, end + 1);
    },
    flush() {
      const rest = tail;
      tail = Buffer.alloc(0);
      return rest.length === 0 ? rest : Buffer.concat([rest, Buffer.from("\n")]);
    },
  };
}

function run(specFile: string): void {
  const spec = runnerSpecSchema.parse(JSON.parse(readFileSync(specFile, "utf8")));
  appendFileSync(spec.log, "");
  if (spec.result !== undefined) appendFileSync(spec.result, "");
  touch(spec.alive);
  const heartbeat = setInterval(() => touch(spec.alive), spec.heartbeatMs);
  let ended = false;
  const end = (info: ExitInfo) => {
    if (ended) return;
    ended = true;
    clearInterval(heartbeat);
    writeExit(spec.exit, info);
  };
  // The reason goes into the exit file; the hub words it for the user in the language it has then.
  const failed = (message: string) => {
    end({ code: null, endedAt: Date.now(), error: message });
  };
  const [cmd, ...args] = spec.argv;
  if (cmd === undefined) return failed("empty command");
  const child = spawn(cmd, args, {
    cwd: spec.cwd,
    env: spec.env,
    windowsVerbatimArguments: spec.verbatim,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let startError: string | undefined;
  const resultFile = spec.result;
  const out = lineSplitter();
  const err = lineSplitter();
  const append = (file: string, bytes: Buffer) => {
    if (bytes.length > 0) appendFileSync(file, bytes);
  };
  if (resultFile === undefined) {
    child.stdout.on("data", (chunk: Buffer) => appendFileSync(spec.log, chunk));
    child.stderr.on("data", (chunk: Buffer) => appendFileSync(spec.log, chunk));
  } else {
    child.stdout.on("data", (chunk: Buffer) => append(resultFile, out.push(chunk)));
    child.stderr.on("data", (chunk: Buffer) => append(spec.log, err.push(chunk)));
  }
  child.on("error", e => {
    // An error after the start (a failed kill) is not a failed start.
    if (child.pid !== undefined) return;
    startError = e.message;
    failed(e.message);
  });
  child.on("close", code => {
    // The last line of a stream may have no "\n"; it is a line too.
    if (resultFile !== undefined) {
      append(resultFile, out.flush());
      append(spec.log, err.flush());
    }
    if (startError === undefined) end({ code, endedAt: Date.now() });
  });
}

if (import.meta.main) {
  const specFile = process.argv[2];
  if (specFile !== undefined) run(specFile);
}
