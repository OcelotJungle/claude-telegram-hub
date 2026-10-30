// Deterministic timers for lifecycle races; native handles are cancelled immediately.
export function manualClock() {
  let now = 0;
  const timers = new Map<ReturnType<typeof setTimeout>, { at: number; fn(): void }>();
  const set = (fn: () => void, ms: number) => {
    const handle = setTimeout(() => {}, 0);
    clearTimeout(handle);
    timers.set(handle, { at: now + ms, fn });
    return handle;
  };
  const clear = (handle: ReturnType<typeof setTimeout>) => { timers.delete(handle); };
  return {
    now: () => now,
    set,
    clear,
    sleep: (ms: number) => new Promise<void>(resolve => { set(resolve, ms); }),
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [handle, timer] = next;
        timers.delete(handle);
        now = timer.at;
        timer.fn();
        await turn();
      }
      now = target;
      await turn();
    },
    dispose: () => timers.clear(),
  };
}

// Flush promise continuations without waiting for wall-clock time.
export function turn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}
