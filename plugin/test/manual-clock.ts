import type { TimerHandle, Timers } from "../src/shared/timers.ts";

type Entry = { at: number; fn(): void; every?: number };

// Deterministic timers (the Timers shape) for tests: nothing fires until `advance` moves the clock.
// Native handles are cancelled immediately; they only serve as unique keys of the right type.
export function manualClock(): Timers & { advance(ms: number): Promise<void>; armed(): number; dispose(): void } {
  let now = 0;
  const timers = new Map<TimerHandle, Entry>();
  const add = (entry: Entry): TimerHandle => {
    const handle = setTimeout(() => {}, 0);
    clearTimeout(handle);
    timers.set(handle, entry);
    return handle;
  };
  const setTimer = (fn: () => void, ms: number) => add({ at: now + ms, fn });
  return {
    now: () => now,
    setTimer,
    clearTimer: handle => { timers.delete(handle); },
    setRepeat: (fn, ms) => add({ at: now + ms, fn, every: ms }),
    sleep: ms => new Promise<void>(resolve => { setTimer(resolve, ms); }),
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [handle, timer] = next;
        now = timer.at;
        // A repeating timer is re-armed before it runs, so its callback can clear it.
        if (timer.every === undefined) timers.delete(handle);
        else timer.at += Math.max(timer.every, 1);
        timer.fn();
        await turn();
      }
      now = target;
      await turn();
    },
    // Timers not yet fired or cancelled: a test checks that a finished operation left none behind.
    armed: () => timers.size,
    dispose: () => timers.clear(),
  };
}

// Flush promise continuations without waiting for wall-clock time.
export function turn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}
