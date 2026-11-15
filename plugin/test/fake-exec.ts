// A fake of `rig exec` for the tests: it keeps runs the way rig does (a byte log, pages of at most `page`
// bytes that never cut a UTF-8 character, an end, a result for a rig run) and records every call.
import type { ExecClient, ExecEnd, ExecError, ExecShellName, ExecStart, ExecStatus, ExecStop } from "../src/hub/rig-exec.ts";
import type { RigError, RigResult } from "../src/hub/rig.ts";

// What rig reads of a log in one status call (rig 0.7.1): 64 KiB.
export const RIG_PAGE_BYTES = 64 * 1024;
const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION = 0x80;

export type FakeRun = {
  id: string;
  shell: ExecShellName | "rig";
  cwd?: string;
  text?: string;
  args?: string[];
  startedAt: string;
  log: Buffer;
  end?: ExecEnd;
  result?: unknown;
};

export class FakeExec implements ExecClient {
  runs = new Map<string, FakeRun>();
  starts: { shell: ExecShellName; cwd: string; text: string }[] = [];
  rigStarts: string[][] = [];
  statuses: { id: string; from: number }[] = [];
  stops: string[] = [];
  page = RIG_PAGE_BYTES;
  // The next start / status / stop fails with this, once, when set.
  startError: RigError | undefined;
  statusError: RigError | undefined;
  stopError: RigError | undefined;
  // Every status call fails with this while set.
  statusDown: RigError | undefined;
  private count = 0;
  now = () => new Date(0).toISOString();

  async start(shell: ExecShellName, cwd: string, text: string): Promise<RigResult<ExecStart, ExecError>> {
    this.starts.push({ shell, cwd, text });
    const failed = this.fail("startError");
    if (failed) return failed;
    return { ok: true, value: this.add({ shell, cwd, text }) };
  }

  async startRig(args: string[]): Promise<RigResult<ExecStart>> {
    this.rigStarts.push(args);
    const failed = this.fail("startError");
    if (failed) return failed;
    return { ok: true, value: this.add({ shell: "rig", args }) };
  }

  // With waitMs this is rig 0.7.2 `--wait`: the answer comes at once when the run ended or the log has whole bytes
  // past `from`; otherwise it is held until a write or an end, or until the test calls expireWaits (the wait ran out).
  async status(id: string, from: number, waitMs?: number): Promise<RigResult<ExecStatus>> {
    this.statuses.push({ id, from });
    if (waitMs !== undefined) this.waitCalls.push({ id, from, waitMs });
    const failed = this.fail("statusError") ?? (this.statusDown ? { ok: false as const, error: this.statusDown } : undefined);
    if (failed) return failed;
    const run = this.runs.get(id);
    if (!run) return { ok: false, error: { kind: "rig", code: "exec-unknown", message: `no run ${id}` } };
    if (waitMs !== undefined && !run.end && this.page_(run, from).stop === this.page_(run, from).start) {
      await new Promise<void>(resolve => { this.parked.push({ id, from, resolve }); });
    }
    return this.answer(id, from);
  }

  // The status calls made with a wait, and the ones held now.
  waitCalls: { id: string; from: number; waitMs: number }[] = [];
  private parked: { id: string; from: number; resolve: () => void }[] = [];

  // How many calls rig is holding.
  held(): number {
    return this.parked.length;
  }

  // The wait of every held call runs out: each is answered as it stands, the way rig answers at the timeout.
  expireWaits(): void {
    this.wake(() => true);
  }

  // A held call is answered when its run wrote whole bytes past its offset or ended.
  private wake(which: (p: { id: string; from: number }) => boolean): void {
    const woken = this.parked.filter(which);
    this.parked = this.parked.filter(p => !which(p));
    for (const p of woken) p.resolve();
  }

  private wakeReady(): void {
    this.wake(p => {
      const run = this.runs.get(p.id);
      return !run || run.end !== undefined || this.page_(run, p.from).stop > this.page_(run, p.from).start;
    });
  }

  // The byte range one status call reads from `from`.
  private page_(run: FakeRun, from: number): { start: number; stop: number } {
    const start = Math.min(from, run.log.length);
    let stop = Math.min(start + this.page, run.log.length);
    // Rig keeps a character that the page cuts for the next one.
    if (stop < run.log.length) while (stop > start && ((run.log[stop] ?? 0) & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION) stop--;
    return { start, stop };
  }

  private answer(id: string, from: number): RigResult<ExecStatus> {
    const run = this.runs.get(id);
    if (!run) return { ok: false, error: { kind: "rig", code: "exec-unknown", message: `no run ${id}` } };
    const { start, stop } = this.page_(run, from);
    const slice = run.log.subarray(start, stop);
    const status: ExecStatus = {
      id,
      shell: run.shell,
      startedAt: run.startedAt,
      state: run.end ? "ended" : "running",
      ...(run.end ? { end: run.end } : {}),
      ...(run.end && run.result !== undefined ? { result: run.result } : {}),
      log: { from: start, to: stop, size: run.log.length, text: slice.toString("utf8") },
    };
    return { ok: true, value: status };
  }

  async stop(id: string): Promise<RigResult<ExecStop>> {
    this.stops.push(id);
    const failed = this.fail("stopError");
    if (failed) return failed;
    const run = this.runs.get(id);
    if (!run) return { ok: false, error: { kind: "rig", code: "exec-unknown", message: `no run ${id}` } };
    if (run.end) return { ok: true, value: { id, state: "ended" } };
    return { ok: true, value: { id, stopping: true } };
  }

  // Test controls.
  write(id: string, text: string): void {
    const run = this.must(id);
    run.log = Buffer.concat([run.log, Buffer.from(text, "utf8")]);
    this.wakeReady();
  }

  finish(id: string, end: { kind: ExecEnd["kind"]; code?: number | null; reason?: string }, result?: unknown): void {
    const run = this.must(id);
    run.end = { kind: end.kind, ...(end.code !== undefined ? { code: end.code } : {}), ...(end.reason !== undefined ? { reason: end.reason } : {}), at: this.now() };
    if (result !== undefined) run.result = result;
    this.wakeReady();
  }

  // The newest run's id.
  last(): string {
    const ids = [...this.runs.keys()];
    const id = ids[ids.length - 1];
    if (id === undefined) throw new Error("no run was started");
    return id;
  }

  must(id: string): FakeRun {
    const run = this.runs.get(id);
    if (!run) throw new Error(`no run ${id}`);
    return run;
  }

  private add(run: { shell: ExecShellName | "rig"; cwd?: string; text?: string; args?: string[] }): ExecStart {
    this.count++;
    const id = `r${this.count}`;
    const startedAt = this.now();
    this.runs.set(id, { id, ...run, startedAt, log: Buffer.alloc(0) });
    return { id, shell: run.shell, pid: 1000 + this.count, startedAt };
  }

  private fail(slot: "startError" | "statusError" | "stopError"): { ok: false; error: RigError } | undefined {
    const error = this[slot];
    if (!error) return undefined;
    this[slot] = undefined;
    return { ok: false, error };
  }
}
