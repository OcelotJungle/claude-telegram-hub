import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { manualClock } from "./manual-clock.ts";
import { scanCounts } from "./real-time-scan.ts";
import { runTimed } from "../src/shared/timed-run.ts";

const SRC_DIR = join(import.meta.dir, "..", "src");
const TIMEOUT_MS = 300;
// Longer than the timeout, as an idle process is: what expired Bun's own synchronous timeout.
const IDLE_GAP_MS = 5_000;
const HUNG_CHILD_MS = 60_000;
const SYNC_SPAWN = /\b(spawnSync|execFileSync|execSync)\b/;
const TIMEOUT_OPTION = /\btimeout\s*:/g;

const bunArgs = (script: string) => ["-e", script];

test("a quick child finishes after the process was idle longer than the timeout", async () => {
  const clock = manualClock();
  const first = await runTimed(process.execPath, bunArgs("0"), { timeoutMs: TIMEOUT_MS, timers: clock });
  expect(first.status).toBe(0);
  await clock.advance(IDLE_GAP_MS);
  const r = await runTimed(process.execPath, bunArgs("console.log('ok')"), { timeoutMs: TIMEOUT_MS, timers: clock });
  expect(r.timedOut).toBe(false);
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe("ok");
  clock.dispose();
});

test("a hung child is killed when the clock reaches the timeout, and not before", async () => {
  const clock = manualClock();
  let result: Awaited<ReturnType<typeof runTimed>> | undefined;
  const run = runTimed(process.execPath, bunArgs(`Bun.sleepSync(${HUNG_CHILD_MS})`), { timeoutMs: TIMEOUT_MS, timers: clock }).then(r => { result = r; });
  await clock.advance(TIMEOUT_MS - 1);
  expect(result).toBeUndefined();
  await clock.advance(1);
  await run;
  expect(result?.timedOut).toBe(true);
  expect(result?.status).toBeNull();
  clock.dispose();
});

test("a command that cannot start gives no status instead of throwing", async () => {
  const r = await runTimed("telegram-hub-no-such-command", [], { timeoutMs: TIMEOUT_MS, timers: manualClock() });
  expect(r.status).toBeNull();
  expect(r.timedOut).toBe(false);
});

test("no source file gives a synchronous spawn a timeout", () => {
  const offenders = Object.keys(scanCounts(SRC_DIR, TIMEOUT_OPTION)).filter(
    file => SYNC_SPAWN.test(readFileSync(join(SRC_DIR, file), "utf8")),
  );
  expect(offenders).toEqual([]);
});
