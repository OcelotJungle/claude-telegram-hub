// The one shape of "time" every part of the plugin depends on, so a test can drive it by hand
// instead of waiting. The real implementation is the default everywhere.
export type TimerHandle = ReturnType<typeof setTimeout>;

export type Timers = {
  now(): number;
  // One-shot timer.
  setTimer(fn: () => void, ms: number): TimerHandle;
  // Clears a one-shot or a repeating timer, like clearTimeout and clearInterval.
  clearTimer(handle: TimerHandle): void;
  // Repeating timer, setInterval semantics.
  setRepeat(fn: () => void, ms: number): TimerHandle;
  sleep(ms: number): Promise<void>;
};

export const realTimers: Timers = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: handle => clearTimeout(handle),
  setRepeat: (fn, ms) => setInterval(fn, ms),
  sleep: ms => Bun.sleep(ms),
};
