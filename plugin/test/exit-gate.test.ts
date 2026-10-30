import { describe, expect, test } from "bun:test";
import { exitGate } from "../src/hub/exit-gate.ts";
import { MAX_RECONNECT_PAUSE_MS } from "../src/shared/reconnect.ts";
import { manualClock, turn } from "./manual-clock.ts";

// Synthetic time units: three polls to the deadline, one more to settle.
const POLL_MS = 2;
const DEADLINE_MS = POLL_MS * 3;
const SETTLE_MS = MAX_RECONNECT_PAUSE_MS + POLL_MS;
const PID = 4242;

describe("exit gate", () => {
  test("an alive pid past the deadline stays gated until death", async () => {
    const clock = manualClock();
    let alive = true;
    const gate = exitGate(PID, { ...clock, isAlive: () => alive, pollMs: POLL_MS, deadlineMs: DEADLINE_MS, settleMs: SETTLE_MS });
    let opened = false;
    void gate.done.then(() => { opened = true; });
    await clock.advance(DEADLINE_MS);
    expect(await gate.settled).toBe("deadline");
    await clock.advance(DEADLINE_MS);
    expect(opened).toBe(false);
    alive = false;
    await clock.advance(POLL_MS);
    expect(await gate.done).toBe("exited");
    clock.dispose();
  });

  test("unknown pid settles beyond the maximum reconnect backoff", async () => {
    const clock = manualClock();
    const gate = exitGate(undefined, { ...clock, isAlive: () => true, pollMs: POLL_MS, deadlineMs: DEADLINE_MS, settleMs: SETTLE_MS });
    let opened = false;
    void gate.done.then(() => { opened = true; });
    await clock.advance(MAX_RECONNECT_PAUSE_MS);
    expect(opened).toBe(false);
    gate.reconnect();
    await turn();
    expect(await gate.done).toBe("reconnected");
    await clock.advance(POLL_MS);
    expect(await gate.settled).toBe("reconnected");
    clock.dispose();
  });
});
