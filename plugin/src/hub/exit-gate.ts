export type ExitOutcome = "exited" | "reconnected" | "cancelled";
export type ExitGate = {
  readonly expired: boolean;
  settled: Promise<ExitOutcome | "deadline">;
  done: Promise<ExitOutcome>;
  reconnect(): void;
  cancel(): void;
};

type Options = {
  now(): number;
  sleep(ms: number): Promise<void>;
  isAlive(pid: number): boolean;
  pollMs: number;
  deadlineMs: number;
  settleMs: number;
};

// A deadline reports failure, but only death or a reconnect opens the gate.
export function exitGate(pid: number | undefined, opts: Options): ExitGate {
  let finish: (outcome: ExitOutcome) => void = () => {};
  let report: (outcome: ExitOutcome | "deadline") => void = () => {};
  let ended = false;
  let expired = false;
  const done = new Promise<ExitOutcome>(resolve => { finish = resolve; });
  const settled = new Promise<ExitOutcome | "deadline">(resolve => { report = resolve; });
  const end = (outcome: ExitOutcome) => {
    if (ended) return;
    ended = true;
    report(outcome);
    finish(outcome);
  };
  const start = opts.now();
  void (async () => {
    if (pid === undefined) {
      await opts.sleep(opts.settleMs);
      end("exited");
      return;
    }
    while (!ended && opts.isAlive(pid)) {
      if (!expired && opts.now() - start >= opts.deadlineMs) {
        expired = true;
        report("deadline");
      }
      await opts.sleep(opts.pollMs);
    }
    end("exited");
  })();
  return { get expired() { return expired; }, settled, done, reconnect: () => end("reconnected"), cancel: () => end("cancelled") };
}
