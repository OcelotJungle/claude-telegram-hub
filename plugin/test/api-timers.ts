import type { TimerHandle, Timers } from "../src/shared/timers.ts";

import { realTimers } from "../src/shared/timers.ts";

// Timers for a TelegramApi that talks to the in-process fake: its per-attempt timeout never fires.
// A real attempt timeout races the fake's real I/O, so under CPU load it aborts a healthy request.
// A test of what the api does when an attempt times out drives it with `manualClock` instead, and a
// call the network drops is simulated with `fake.dropNext` (the connection closes at once).
export const noAttemptTimeouts: Timers = {
  ...realTimers,
  setTimer: () => {
    // The handle only has to be a valid, already-cancelled timer.
    const handle: TimerHandle = setTimeout(() => {}, 0);
    clearTimeout(handle);
    return handle;
  },
  clearTimer: () => {},
};
