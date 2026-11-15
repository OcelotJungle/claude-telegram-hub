// Guards against waits on real time: tests must not sleep (they settle or drive a manual clock), and the
// hub's source reaches the clock only through the `Timers` shape (src/shared/timers.ts).
import type { Allowed } from "./real-time-scan.ts";

import { expect, test } from "bun:test";
import { join } from "path";
import { counts, countMatches, mismatches, scanCounts, SRC_CLOCK, TEST_WAIT } from "./real-time-scan.ts";

const TEST_DIR = import.meta.dir;
const SRC_DIR = join(import.meta.dir, "..", "src");

// Files whose raw use is the point. A new entry needs a reason that is not "a test waits".
const TEST_ALLOWED: Record<string, Allowed> = {
  "helpers.ts": { count: 1, reason: "waitFor, the polling primitive of every wait for a condition" },
  "fake-telegram.ts": { count: 2, reason: "the fake server's own latency: a long-poll that waits for updates, and delayNext" },
  "manual-clock.ts": { count: 1, reason: "makes a unique timer handle and cancels it at once; nothing waits" },
  "launch.test.ts": { count: 2, reason: "makes a timer handle for an injected timer that never fires; nothing waits" },
};

// Files that still wait on real time and are to be converted, one at a time, with the number of uses left.
// A converted file leaves this list; a count only goes down.
const TO_CONVERT: Record<string, number> = {
  "election.test.ts": 2,
  "exec-runner.test.ts": 2,
  "exec.test.ts": 8,
  "hub.test.ts": 72,
  "mod.test.ts": 5,
  "packaging.test.ts": 2,
  "plugin.test.ts": 17,
  "skill-cleanup.test.ts": 1,
  "tail.test.ts": 1,
  "telegram.test.ts": 3,
};

// Raw clock uses in the source that are not a wait the Timers shape could carry, and why.
const SRC_ALLOWED: Record<string, Allowed> = {
  "shared/timers.ts": { count: 4, reason: "the real implementation of Timers" },
  "hook/question.ts": { count: 2, reason: "a hook process that is its own composition root: a deadline and a heartbeat" },
  "plugin/main.ts": { count: 2, reason: "the plugin process entry: shutdown deadline and its interval" },
  "hub/exec-runner.ts": { count: 4, reason: "the detached runner is its own process: wall clock of its heartbeat and end time" },
  "mod/register.ts": { count: 1, reason: "the mod's clock at its entry point" },
  "hub/cards.ts": { count: 1, reason: "file-name suffix of a corrupt file set aside, not timing" },
  "hub/exec-store.ts": { count: 1, reason: "file-name suffix of a corrupt file set aside, not timing" },
  "hub/hub.ts": { count: 2, reason: "a corrupt-file name suffix, and the wall-clock stamp handed to the pure transcript cleaner" },
  "hub/machine-outbox.ts": { count: 1, reason: "file-name suffix of a corrupt file set aside, not timing" },
  "hub/outbox.ts": { count: 1, reason: "file-name suffix of a corrupt file set aside, not timing" },
  "hub/poll-offset.ts": { count: 1, reason: "file-name suffix of a corrupt file set aside, not timing" },
  "hub/sessions.ts": { count: 1, reason: "file-name suffix of a corrupt file set aside, not timing" },
  "hub/telegram.ts": { count: 1, reason: "file name of a downloaded file made unique, not timing" },
  "plugin/plugin.ts": { count: 1, reason: "file name of a spooled message made unique, not timing" },
};

test("no test file waits on real time except the allowed ones and the files still to convert", () => {
  const found = scanCounts(TEST_DIR, TEST_WAIT);
  for (const file of Object.keys(TEST_ALLOWED)) expect(TEST_ALLOWED[file]?.reason).toBeTruthy();
  expect(mismatches(found, { ...counts(TEST_ALLOWED), ...TO_CONVERT })).toEqual([]);
});

test("a file is either allowed or to convert, never both", () => {
  expect(Object.keys(TO_CONVERT).filter(file => file in TEST_ALLOWED)).toEqual([]);
});

test("the source reaches the clock only through Timers, apart from the allowed sites", () => {
  expect(mismatches(scanCounts(SRC_DIR, SRC_CLOCK), counts(SRC_ALLOWED))).toEqual([]);
});

test("the scan counts code, not comments, and counts each use", () => {
  const sleep = "Bun" + ".sleep(10)";
  const timeout = "setTimeout" + "(fn, 1)";
  expect(countMatches(`await ${sleep};\n// ${sleep}\n await new Promise(r => ${timeout}); ${sleep};`, TEST_WAIT)).toBe(3);
});

test("the comparison fails when a count grows, a new file appears, or a list entry is stale", () => {
  const allowed = { "a.ts": 2, "b.ts": 1 };
  expect(mismatches({ "a.ts": 2, "b.ts": 1 }, allowed)).toEqual([]);
  expect(mismatches({ "a.ts": 3, "b.ts": 1 }, allowed)).toEqual(["a.ts: 3 raw uses, 2 allowed"]);
  expect(mismatches({ "a.ts": 2, "b.ts": 1, "c.ts": 1 }, allowed)).toEqual(["c.ts: 1 raw uses, none allowed"]);
  expect(mismatches({ "a.ts": 1, "b.ts": 1 }, allowed)).toEqual(["a.ts: 1 raw uses, the list says 2: lower it"]);
  expect(mismatches({ "a.ts": 2 }, allowed)).toEqual(["b.ts: no raw uses left: remove it from the list"]);
});
