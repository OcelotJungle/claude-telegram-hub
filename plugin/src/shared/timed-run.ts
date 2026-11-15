import type { Timers } from "./timers.ts";

import { spawn } from "child_process";
import { realTimers } from "./timers.ts";

// Runs a short external command and collects its output; the deadline comes from the injected
// timers and kills the child. Never a synchronous spawn with a `timeout`: Bun's one is measured on
// a private loop clock that only moves during synchronous spawns, so after an idle gap longer than
// the timeout it expires at once and kills a fast child (test/timed-run.test.ts holds that scan).
export type TimedRunOptions = {
  timeoutMs: number;
  windowsVerbatimArguments?: boolean;
  timers?: Timers;
};

// status is null when the child did not exit by itself (timed out, or could not start).
export type TimedRunResult = { status: number | null; stdout: string; timedOut: boolean };

export function runTimed(file: string, args: string[], options: TimedRunOptions): Promise<TimedRunResult> {
  const timers = options.timers ?? realTimers;
  return new Promise(resolve => {
    let stdout = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(file, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      ...(options.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    const settle = (status: number | null): void => {
      if (settled) return;
      settled = true;
      timers.clearTimer(timer);
      resolve({ status, stdout, timedOut });
    };
    const timer = timers.setTimer(() => {
      timedOut = true;
      child.kill();
      // The deadline is final: a child that ignores the kill must not hold the caller.
      settle(null);
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.on("error", () => settle(null));
    child.on("close", code => settle(code));
  });
}
