// Topic command runs, as Telegram sees them: rig runs the command (`rig exec`), the hub starts it, reads its
// log page by page, keeps its card and buttons, and hands each result to the agent. What it keeps on disk is
// only which run belongs to which card (exec-runs.ts); a restarted hub goes on polling a running run by its id.
import type { ExecRun } from "./exec-runs.ts";
import type { ExecClient, ExecError, ExecShellName, ExecStatus } from "./rig-exec.ts";
import type { Button } from "./telegram.ts";
import type { ChannelMeta } from "../shared/protocol.ts";
import type { Logger } from "../shared/log.ts";
import type { MessageKind } from "../shared/notification.ts";
import type { MachineDestination } from "./machine-outbox.ts";
import type { Messages } from "../shared/i18n/index.ts";
import type { Timers } from "../shared/timers.ts";

import { randomBytes, randomUUID } from "crypto";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildLogFile } from "./exec-log.ts";
import { loadRuns, saveRuns } from "./exec-runs.ts";
import { isGone } from "./rig-exec.ts";
import { rigErrorText } from "./rig.ts";
import { catalogOf } from "../shared/i18n/index.ts";
import { PLATFORM } from "../shared/platform.ts";
import { renderRigLine, renderRigLines } from "./rig-output.ts";

// What a run shows: its lines, and whether they start at the beginning of its output.
type Shown = { lines: string[]; whole: boolean };
type RunEnd = NonNullable<ExecRun["end"]>;

export const EXEC_CARD_MS = 60_000;
export const EXEC_CARD_LINES = 10;
export const EXEC_AGENT_LINES = 30;
export const MAX_EXECS = 50;
export const EXEC_MAX_AGE_MS = 120_000;
// How often a running run's log is read. Each read is one rig process.
export const EXEC_CHECK_MS = 1000;
const ID_BYTES = 4;
// The part of a log a restarted hub reads again before it goes on: what a rig status answer holds at most.
const TAIL_BYTES = 64 * 1024;
// The most of a log the hub keeps in memory for the card and the report: the end of it. The file that goes
// to Telegram is made from rig's whole log (exec-log.ts), not from this.
const LOG_KEEP_CHARS = 1024 * 1024;
// The largest file Telegram takes from a bot.
export const TELEGRAM_FILE_LIMIT = 50 * 1024 * 1024;
const LOG_DIR_PREFIX = "hub-exec-log-";
// A burst of pages one poll may read at most (a run that wrote a lot while the hub was off); the next poll goes on.
const PAGES_PER_POLL = 16;
// How long rig may fail to answer about a running run before the card says rig is not answering. The run is never
// ended for it: only rig knows a run is lost (its own end, from its heartbeat), so the hub keeps polling.
const RIG_SILENT_NOTE_MS = 60_000;
const LINE_MAX = 300;
const TEXT_MAX = 200;
const MIN_FENCE = 3;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const MS_PER_MINUTE = MS_PER_SECOND * SECONDS_PER_MINUTE;
const BYTES_PER_MB = 1024 * 1024;
const SIZE_DECIMALS = 1;
const LOST_PROCESS_GONE = "process-gone";
// rig's end.reason of a rig run that exited with no usable answer.
const NO_RESULT_REASONS = new Set(["empty-result", "invalid-result"]);

export type ExecDeps = {
  // The hub's current language: cards and answers are rendered in it each time.
  messages(): Messages;
  file: string;
  rig: ExecClient;
  shellNames?: Record<ExecShellName, string>;
  card(sessionId: string, cardId: string, markdown: string, final: boolean, kind: MessageKind, buttons?: Button[][]): void;
  // A log that does not fit the card: the file at `path` goes as a file called `name`. The file is deleted when
  // this returns, so the hub makes its own copy.
  sendFile(sessionId: string, path: string, name: string, kind: MessageKind): void;
  // The largest file Telegram takes; TELEGRAM_FILE_LIMIT when not given.
  fileLimit?: number;
  report(sessionId: string, content: string, meta: ChannelMeta, onSent: () => void): void;
  // Runs background work so that the hub counts it as busy until it is done.
  spawn(work: Promise<unknown>): void;
  timers: Timers;
  checkMs: number;
  cardMs: number;
  maxAgeMs: number;
  // Whether the session has a window connected now.
  hasWindow(sessionId: string): boolean;
  // How long after the start windows get to reconnect before results of runs
  // that ended meanwhile go on without them; none when not given.
  graceMs?: number;
  log: Logger;
  // Why a shell may not start now (its feature is off), or undefined; asked again when a stale Run button is pressed.
  unavailable?(shell: ExecRun["shell"]): string | undefined;
  machineCard?(run: ExecRun, text: string, final: boolean, kind: MessageKind, buttons?: Button[][]): void;
  // As sendFile, for a rig run.
  machineFile?(run: ExecRun, path: string, name: string, kind: MessageKind): void;
};

// What the hub holds of a running run in memory: the end of its log, and how the polling stands.
type Live = {
  text: string;
  // Whether `text` starts at the beginning of the run's output.
  whole: boolean;
  // rig's log size on the last read, in bytes.
  size: number;
  // The byte to read next.
  next: number;
  result?: unknown;
  polling: boolean;
  failingSince?: number;
  // The failure shown on the card while rig does not answer; cleared by the next answer.
  silentReason?: string;
  // The log grew since the card was drawn last.
  changed: boolean;
  shownTail?: string;
  shownAt?: number;
};

export class Execs {
  private recs: ExecRun[] = [];
  private live = new Map<string, Live>();
  private repeaters: ReturnType<typeof setInterval>[] = [];
  private stopped = false;
  // Runs that ended at start or in its grace with no window: their results
  // wait for the windows to reconnect, then for sweep().
  private deferred = new Set<string>();
  private deferUntil = 0;
  // Runs whose start is in flight.
  private launching = new Set<string>();
  private sweepTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private deps: ExecDeps) {}

  start(): void {
    this.stopped = false;
    this.recs = loadRuns(this.deps.file);
    // A run goes on after a hub restart: its log is read again from a little before where the last read stopped.
    for (const rec of this.recs) if (rec.state === "running") this.resumeLive(rec);
    this.markUnknownStarts();
    this.resendLogs();
    this.repeaters.push(this.deps.timers.setRepeat(() => this.poll(), this.deps.checkMs));
    this.repeaters.push(this.deps.timers.setRepeat(() => this.editCards(), this.deps.cardMs));
    const grace = this.deps.graceMs ?? 0;
    this.deferUntil = this.deps.timers.now() + grace;
    this.sweepTimer = this.deps.timers.setTimer(() => this.sweep(), grace);
    // At once: a run that ended while no hub watched is found now. Its result is not reported yet: a window
    // about to reconnect gets it.
    this.poll();
  }

  // After the start's grace: deferred results go to the sessions that still
  // have no window, so they launch or get the notice; a window that connected
  // got them on connect, and one connecting now gets them so.
  sweep(): void {
    for (const rec of this.recs) {
      if (!this.deferred.has(rec.id) || rec.reported || (rec.sessionId !== undefined && this.deps.hasWindow(rec.sessionId))) continue;
      this.report(rec);
    }
    this.deferred.clear();
  }

  // Only the timers: the runs go on in rig and a next manager picks them up.
  stop(): void {
    this.stopped = true;
    for (const t of this.repeaters) this.deps.timers.clearTimer(t);
    this.repeaters = [];
    if (this.sweepTimer !== undefined) this.deps.timers.clearTimer(this.sweepTimer);
  }

  // A run still starting counts: it is about to run, so the hub must not go idle under it.
  running(): number {
    return this.recs.filter(r => r.state === "running" || this.launching.has(r.id)).length;
  }

  // Runs whose start is in flight.
  starting(): number {
    return this.launching.size;
  }

  command(sessionId: string, shell: ExecShellName, text: string, cwd: string, msg: { chatId: string; messageId: number; date: number }): void {
    // Telegram may hand a restarted hub the same message again. Message ids
    // count per chat.
    const same = this.recs.find(r => r.messageId === msg.messageId && (r.chatId ?? msg.chatId) === msg.chatId);
    if (same) {
      this.deps.log.info(`exec: message ${msg.messageId} in chat ${msg.chatId} already ran as ${same.id}, skipped`);
      return;
    }
    const sentAt = msg.date * MS_PER_SECOND;
    const rec: ExecRun = {
      id: randomBytes(ID_BYTES).toString("hex"),
      sessionId,
      chatId: msg.chatId,
      messageId: msg.messageId,
      shell,
      text,
      cwd,
      state: "pending",
      sentAt,
      offset: 0,
      reported: false,
    };
    this.recs.push(rec);
    this.prune();
    this.begin(rec, sentAt);
  }

  // A rig command (rig update, rig feature … enable|disable, rig language …) the user sent or confirmed. `sentAt` (ms)
  // is when the user sent it; one older than the age limit waits for the button like a stale /bash. A command the
  // user confirmed later passes none: the confirmation press had its own age check.
  machine(args: string[], text: string, destination: MachineDestination, messageId: number, sentAt?: number): void {
    if (this.recs.some(rec => rec.messageId === messageId && rec.chatId === destination.chatId)) return;
    const rec: ExecRun = {
      id: randomUUID().replaceAll("-", ""),
      shell: "rig",
      args,
      destination,
      chatId: destination.chatId,
      messageId,
      text,
      state: "pending",
      sentAt,
      offset: 0,
      reported: false,
    };
    this.recs.push(rec);
    this.prune();
    this.begin(rec, sentAt);
  }

  async press(id: string, action: "stop" | "run"): Promise<string> {
    const m = this.deps.messages();
    const rec = this.recs.find(r => r.id === id);
    if (!rec) return m.execNotFound;
    if (rec.state === "ended") return m.execAlreadyEnded;
    if (action === "run") {
      if (rec.state === "running") return m.execAlreadyRunning;
      // The button may be old: the feature could have been switched off since the card was shown.
      const why = this.deps.unavailable?.(rec.shell);
      if (why) return why;
      this.launch(rec);
      return m.execStarting;
    }
    if (rec.state === "pending" || rec.runId === undefined) return m.execNotStarted;
    // rig stops the run; the next poll reads how it ended.
    const stopped = await this.deps.rig.stop(rec.runId);
    if (!stopped.ok) return rigErrorText(stopped.error, m);
    return stopped.value.state === "ended" ? m.execAlreadyEnded : m.execStopping;
  }

  // Results the agent has not got go again once its session is back.
  connected(sessionId: string): void {
    for (const rec of this.recs) {
      if (rec.sessionId === sessionId && rec.state === "ended" && !rec.reported) this.report(rec);
    }
  }

  private save(): boolean {
    try {
      saveRuns(this.deps.file, this.recs);
      return true;
    } catch (e) {
      this.deps.log.error(`exec: saving runs failed: ${e}`);
      return false;
    }
  }

  // A command too old waits for its button; any other starts at once.
  private begin(rec: ExecRun, sentAt: number | undefined): void {
    if (sentAt !== undefined && this.deps.timers.now() - sentAt > this.deps.maxAgeMs) {
      this.save();
      this.showCard(rec);
      return;
    }
    this.launch(rec);
  }

  // A second press of the Run button while the start is in flight does not start the run twice.
  private launch(rec: ExecRun): void {
    if (this.launching.has(rec.id)) return;
    this.launching.add(rec.id);
    this.deps.spawn(this.startRun(rec));
  }

  // A record saved as starting whose answer never came: the hub died in the start. Whether rig started the run is not
  // known, so it is neither started nor re-run on redelivery; its card says so and the Run button may start it.
  private markUnknownStarts(): void {
    const unknown = this.recs.filter(r => r.state === "pending" && r.starting === true);
    if (unknown.length === 0) return;
    for (const rec of unknown) {
      delete rec.starting;
      rec.startUnknown = true;
    }
    this.save();
    for (const rec of unknown) this.showCard(rec);
  }

  private async startRun(rec: ExecRun): Promise<void> {
    // The record is on disk before rig is asked: a hub that dies in the start must not run the command twice.
    rec.starting = true;
    delete rec.startUnknown;
    if (!this.save()) {
      this.launching.delete(rec.id);
      delete rec.starting;
      return this.startFailed(rec, { kind: "notRecorded" });
    }
    const started = rec.shell === "rig"
      ? await this.deps.rig.startRig(rec.args ?? [])
      : await this.deps.rig.start(rec.shell, rec.cwd ?? "", rec.text);
    // The run leaves `launching` before it begins or fails: what those report (an end, the hub going idle) already
    // sees the run as started or gone, not as still starting.
    this.launching.delete(rec.id);
    delete rec.starting;
    if (rec.state !== "pending") return;
    if (!started.ok) return this.startFailed(rec, started.error);
    rec.runId = started.value.id;
    rec.state = "running";
    rec.startedAt = this.deps.timers.now();
    rec.offset = 0;
    this.live.set(rec.id, newLive(0));
    this.save();
    this.deps.log.info(`exec ${rec.id}: started ${rec.shell} as rig run ${rec.runId}`);
    this.showCard(rec);
  }

  private startFailed(rec: ExecRun, error: ExecError): void {
    const text = execErrorText(error, this.deps.messages());
    this.deps.log.error(`exec ${rec.id}: start failed: ${text}`);
    rec.startedAt = this.deps.timers.now();
    this.end(rec, { kind: "failed", at: this.deps.timers.now(), detail: text });
  }

  private resumeLive(rec: ExecRun): void {
    this.live.set(rec.id, newLive(Math.max(0, rec.offset - TAIL_BYTES)));
  }

  // Drops the oldest ended runs past MAX_EXECS.
  private prune(): void {
    let extra = this.recs.length - MAX_EXECS;
    if (extra <= 0) return;
    this.recs = this.recs.filter(r => {
      if (extra <= 0 || r.state !== "ended") return true;
      extra--;
      return false;
    });
  }

  private poll(): void {
    if (this.stopped) return;
    for (const rec of this.recs) {
      if (rec.state !== "running" || rec.runId === undefined) continue;
      let live = this.live.get(rec.id);
      if (!live) {
        this.resumeLive(rec);
        live = this.live.get(rec.id);
      }
      // A standing wait, like the Telegram poll, not work busy() waits for: rig holds the read until the run writes
      // or ends (--wait), so a quiet run would keep the hub busy for as long as it runs. stop() lets the read go
      // (abandon); handling an answer is synchronous, and what it starts (card edits, the log file, the agent's
      // report) is tracked where it starts.
      if (live && !live.polling) void this.follow(rec, rec.runId, live);
    }
  }

  // Reads the run's log from where it stopped until rig has no more, then the end. Nothing awaits it, so it never
  // rejects: a failure is logged here.
  private async follow(rec: ExecRun, runId: string, live: Live): Promise<void> {
    live.polling = true;
    const offset = rec.offset;
    try {
      for (let page = 0; page < PAGES_PER_POLL; page++) {
        const got = await this.deps.rig.status(runId, live.next);
        if (this.stopped || rec.state !== "running") return;
        if (!got.ok) return this.pollFailed(rec, live, got.error);
        live.failingSince = undefined;
        if (live.silentReason !== undefined) {
          live.silentReason = undefined;
          this.showCard(rec);
        }
        const status = got.value;
        const progressed = this.absorb(rec, live, status);
        const drained = status.log.to >= status.log.size;
        // An ended run whose log stops in the middle of a character has nothing more to give.
        if (status.state === "ended" && (drained || !progressed)) return this.finish(rec, live, status);
        if (drained || !progressed) break;
      }
      if (rec.offset !== offset) this.save();
      if (rec.shell === "rig") this.refreshRigCard(rec, live);
    } catch (error) {
      this.deps.log.error(`exec ${rec.id}: reading the run failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      live.polling = false;
    }
  }

  // Adds a page to what the hub holds; whether the page moved the reading on.
  private absorb(rec: ExecRun, live: Live, status: ExecStatus): boolean {
    const { log } = status;
    live.size = log.size;
    if (status.result !== undefined) live.result = status.result;
    if (log.to <= live.next) return false;
    live.text += log.text;
    if (live.text.length > LOG_KEEP_CHARS) {
      live.text = live.text.slice(-LOG_KEEP_CHARS);
      live.whole = false;
    }
    live.next = log.to;
    live.changed = true;
    rec.offset = log.to;
    return true;
  }

  private pollFailed(rec: ExecRun, live: Live, error: ExecError): void {
    const now = this.deps.timers.now();
    if (isGone(error)) return this.end(rec, { kind: "lost", at: now, reason: LOST_PROCESS_GONE });
    if (live.failingSince === undefined) {
      live.failingSince = now;
      this.deps.log.warn(`exec ${rec.id}: reading the run failed: ${rigErrorText(error.kind === "cwdUnsafe" ? { kind: "badSession" } : error, catalogOf("en"))}`);
    }
    if (now - live.failingSince > RIG_SILENT_NOTE_MS && live.silentReason === undefined) {
      live.silentReason = execErrorText(error, this.deps.messages());
      this.showCard(rec);
    }
  }

  private finish(rec: ExecRun, live: Live, status: ExecStatus): void {
    if (status.result !== undefined) live.result = status.result;
    this.end(rec, runEnd(status, this.deps.timers.now()));
  }

  private end(rec: ExecRun, end: RunEnd): void {
    const live = this.live.get(rec.id);
    rec.state = "ended";
    rec.end = end;
    this.deps.log.info(`exec ${rec.id}: ended ${end.kind}${end.code === undefined ? "" : ` ${end.code}`}`);
    this.showCard(rec);
    this.sendLog(rec, end);
    if (rec.shell !== "rig") rec.reportTail = tailText(this.shown(rec, live), EXEC_AGENT_LINES);
    this.live.delete(rec.id);
    this.save();
    // In the start's grace a session without a window may be reconnecting:
    // reporting now would launch a second copy of it or say "not delivered".
    if (rec.shell === "rig") return;
    const inGrace = this.deps.timers.now() < this.deferUntil && (rec.sessionId === undefined || !this.deps.hasWindow(rec.sessionId));
    if (inGrace) this.deferred.add(rec.id);
    else this.report(rec);
  }

  // A log that does not fit the card goes as a file: a rig run as the words the card shows, any other as its text.
  // The file is the run's whole log, read from rig page by page (the hub holds only its end), cut from the start
  // when it is over the file limit. What the hub holds goes instead when rig cannot be read.
  private sendLog(rec: ExecRun, end: RunEnd): void {
    const live = this.live.get(rec.id);
    if (!live || rec.runId === undefined) return;
    const shown = this.shown(rec, live);
    if (fitsCard(shown)) return;
    const m = this.deps.messages();
    const note = shown.whole ? "" : `${m.execLogTrimmed({ limit: mb(Buffer.byteLength(live.text), m), size: mb(live.size, m) })}\n`;
    const held = rec.shell === "rig" ? `${note}${shown.lines.join("\n")}\n` : `${note}${live.text}`;
    // Saved with the end (end() saves after this): a hub that dies before the file went out sends it at its start.
    rec.logFile = "owed";
    this.deps.spawn(this.deliverLog(rec, end, { runId: rec.runId, size: live.size, result: live.result, held }));
  }

  // At start: the file of an ended run that was owed and did not go out. The hub holds no log of it, so the size and
  // the result come from rig; with rig unreadable the file stays owed for the next start.
  private resendLogs(): void {
    for (const rec of this.recs) {
      if (rec.state !== "ended" || rec.logFile !== "owed" || rec.runId === undefined || rec.end === undefined) continue;
      this.deps.spawn(this.resendLog(rec, rec.runId, rec.end));
    }
  }

  private async resendLog(rec: ExecRun, runId: string, end: RunEnd): Promise<void> {
    const got = await this.deps.rig.status(runId, 0);
    if (this.stopped) return;
    if (!got.ok) {
      this.deps.log.warn(`exec ${rec.id}: the log file stays unsent, rig could not be read: ${rigErrorText(got.error, catalogOf("en"))}`);
      return;
    }
    await this.deliverLog(rec, end, { runId, size: got.value.log.size, result: got.value.result });
  }

  // `held`: what the hub holds of the log, for when rig cannot give the pages; a file resent after a restart has none.
  private async deliverLog(rec: ExecRun, end: RunEnd, log: { runId: string; size: number; result: unknown; held?: string }): Promise<void> {
    const m = this.deps.messages();
    const limit = this.deps.fileLimit ?? TELEGRAM_FILE_LIMIT;
    const kind = end.kind === "lost" ? "warning" : end.kind === "exit" && end.code !== 0 ? "error" : "info";
    const name = `${rec.id}.log`;
    let dir: string | undefined;
    try {
      dir = mkdtempSync(join(tmpdir(), LOG_DIR_PREFIX));
      const path = join(dir, name);
      const built = await buildLogFile({
        rig: this.deps.rig,
        runId: log.runId,
        size: log.size,
        path,
        limit,
        note: `${m.execLogTrimmed({ limit: mb(limit, m), size: mb(log.size, m) })}\n`,
        ...(rec.shell === "rig" ? { line: (raw: string) => renderRigLine(screenLine(raw), m) } : {}),
        closing: rec.shell === "rig" ? this.rigClosing(rec, log.result) : [],
        aborted: () => this.stopped,
      });
      if (built.kind === "aborted") return;
      if (built.kind === "unreadable") {
        if (log.held === undefined) {
          this.deps.log.warn(`exec ${rec.id}: rig could not give the log, the file stays unsent`);
          return;
        }
        this.deps.log.warn(`exec ${rec.id}: rig could not give the whole log, the file holds its end`);
        writeFileSync(path, log.held);
      }
      let handedOver = false;
      if (rec.shell === "rig" && this.deps.machineFile) {
        this.deps.machineFile(rec, path, name, kind);
        handedOver = true;
      } else if (rec.shell !== "rig" && rec.sessionId !== undefined) {
        this.deps.sendFile(rec.sessionId, path, name, kind);
        handedOver = true;
      }
      // Only after the hand-over succeeded: a throw above leaves the file owed.
      if (handedOver) {
        rec.logFile = "sent";
        this.save();
      }
    } catch (e) {
      this.deps.log.warn(`exec ${rec.id}: sending the log failed: ${e}`);
    } finally {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  }

  // What a rig run shows after its progress: its result in words, and why it has none.
  private rigClosing(rec: ExecRun, result: unknown): string[] {
    const m = this.deps.messages();
    const lines = result === undefined ? [] : renderRigLine(JSON.stringify(result), m);
    const reason = rec.end?.kind === "exit" ? rec.end.reason : undefined;
    if (reason !== undefined && NO_RESULT_REASONS.has(reason)) lines.push(m.execRigNoResult({ reason }));
    return lines;
  }

  private report(rec: ExecRun): void {
    if (rec.sessionId === undefined || rec.shell === "rig") return;
    const meta: ChannelMeta = { source: "exec", exec_id: rec.id, ts: new Date(rec.end?.at ?? this.deps.timers.now()).toISOString() };
    if (rec.end?.kind === "exit" && rec.end.code !== undefined) meta.exit_code = String(rec.end.code);
    this.deps.report(rec.sessionId, execReportText(rec, rec.reportTail ?? "", this.deps.shellNames), meta, () => {
      rec.reported = true;
      delete rec.reportTail;
      this.save();
    });
  }

  // Cards of the other runs are paced by the poll: see refreshRigCard.
  private editCards(): void {
    for (const rec of this.recs) if (rec.state === "running" && rec.shell !== "rig") this.showCard(rec);
  }

  // A rig card shows its output as it arrives, so it is redrawn at once when the
  // output changed; otherwise only at the card pace (the seconds counter alone
  // changes every poll, which would edit the card every poll).
  private refreshRigCard(rec: ExecRun, live: Live): void {
    if (!live.changed && live.shownAt !== undefined && this.deps.timers.now() - live.shownAt < this.deps.cardMs) return;
    const tail = tailText(this.shown(rec, live), EXEC_CARD_LINES);
    if (live.shownTail === tail && live.shownAt !== undefined && this.deps.timers.now() - live.shownAt < this.deps.cardMs) {
      live.changed = false;
      return;
    }
    this.showCard(rec);
  }

  // The one reading of a run's output: the card, the sent file and the report all come from it. A rig run
  // is the whole lines of its progress, in words, then its result, in words, last; any other run is its log.
  private shown(rec: ExecRun, live: Live | undefined): Shown {
    if (!live) return { lines: [], whole: true };
    if (rec.shell !== "rig") {
      const lines = screenLines(live.text);
      // A read from the middle starts in the middle of a line.
      if (!live.whole) lines.shift();
      return { lines, whole: live.whole };
    }
    // A line still being written is never shown cut; an ended run has no such line.
    const text = rec.state === "ended" ? live.text : live.text.slice(0, live.text.lastIndexOf("\n") + 1);
    const progress = screenLines(text);
    if (!live.whole) progress.shift();
    const lines = [...renderRigLines(progress, this.deps.messages()), ...this.rigClosing(rec, live.result)];
    return { lines, whole: live.whole };
  }

  private showCard(rec: ExecRun): void {
    const m = this.deps.messages();
    const live = this.live.get(rec.id);
    const now = this.deps.timers.now();
    const tail = rec.state === "pending" ? "" : tailText(this.shown(rec, live), EXEC_CARD_LINES);
    const buttons: Button[][] | undefined =
      rec.state === "running"
        ? [[{ text: m.execStopButton, data: `x:${rec.id}:stop` }]]
        : rec.state === "pending"
          ? [[{ text: m.execRunButton, data: `x:${rec.id}:run` }]]
          : undefined;
    const kind = rec.state !== "ended" || rec.end?.kind === "stopped" || (rec.end?.kind === "exit" && rec.end.code === 0)
      ? "info"
      : rec.end?.kind === "exit" ? "error" : "warning";
    const text = execCardText(rec, tail, now, m, this.deps.shellNames, live?.silentReason);
    if (live) {
      live.shownTail = tail;
      live.shownAt = now;
      live.changed = false;
    }
    if (rec.shell === "rig") this.deps.machineCard?.(rec, text, rec.state === "ended", kind, rec.state === "pending" ? buttons : undefined);
    else if (rec.sessionId !== undefined) this.deps.card(rec.sessionId, `exec-${rec.id}`, text, rec.state === "ended", kind, buttons);
  }
}

function newLive(next: number): Live {
  return { text: "", whole: next === 0, size: 0, next, polling: false, changed: false };
}

// rig's end of a run as the hub keeps it. An exit with no code (the process was killed) and a run rig lost are lost.
function runEnd(status: ExecStatus, now: number): RunEnd {
  const end = status.end;
  if (!end) return { kind: "lost", at: now, reason: LOST_PROCESS_GONE };
  const parsed = Date.parse(end.at);
  const at = Number.isNaN(parsed) ? now : parsed;
  if (end.kind === "stopped") return { kind: "stopped", at };
  if (end.kind === "exit" && typeof end.code === "number") {
    return end.reason === undefined ? { kind: "exit", code: end.code, at } : { kind: "exit", code: end.code, at, reason: end.reason };
  }
  return { kind: "lost", at, reason: end.reason ?? LOST_PROCESS_GONE };
}

function execErrorText(error: ExecError, m: Messages): string {
  return error.kind === "cwdUnsafe" ? m.execCwdUnsafe : rigErrorText(error, m);
}

// A size in megabytes, to one decimal.
function mb(bytes: number, m: Messages): string {
  return `${Number((bytes / BYTES_PER_MB).toFixed(SIZE_DECIMALS))} ${m.unitMegabyte}`;
}

// One log line as a terminal would leave it.
function screenLine(l: string): string {
  const line = l.endsWith("\r") ? l.slice(0, -1) : l;
  return line.slice(line.lastIndexOf("\r") + 1);
}

// The log's lines as a terminal would leave them: a progress bar's line is
// what follows its last carriage return.
function screenLines(text: string): string[] {
  const lines = text.split("\n").map(screenLine);
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines;
}

// The card's text: the last lines, each cut to the width.
function tailText(shown: Shown, lines: number): string {
  return shown.lines
    .slice(-lines)
    .map(l => (l.length > LINE_MAX ? `${l.slice(0, LINE_MAX - 1)}…` : l))
    .join("\n");
}

// Whether the card's tail already shows everything.
function fitsCard(shown: Shown): boolean {
  return shown.whole && shown.lines.length <= EXEC_CARD_LINES && shown.lines.every(l => l.length <= LINE_MAX);
}

export function duration(ms: number, m: Messages): string {
  const s = Math.max(0, Math.floor(ms / MS_PER_SECOND));
  if (s < SECONDS_PER_MINUTE) return `${s} ${m.unitSecond}`;
  const minutes = Math.floor(s / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) return `${minutes} ${m.unitMinute} ${String(s % SECONDS_PER_MINUTE).padStart(2, "0")} ${m.unitSecond}`;
  return `${Math.floor(minutes / MINUTES_PER_HOUR)} ${m.unitHour} ${String(minutes % MINUTES_PER_HOUR).padStart(2, "0")} ${m.unitMinute}`;
}

function longestRun(text: string, ch: string): number {
  let best = 0;
  let cur = 0;
  for (const c of text) {
    cur = c === ch ? cur + 1 : 0;
    best = Math.max(best, cur);
  }
  return best;
}

// The command as one inline code span: newlines shown as ↵, cut at
// TEXT_MAX, delimited by more backticks than any run inside.
function inlineCode(text: string): string {
  const flat = text.replace(/\r?\n/g, " ↵ ");
  const cut = flat.length > TEXT_MAX ? `${flat.slice(0, TEXT_MAX)}…` : flat;
  const ticks = "`".repeat(longestRun(cut, "`") + 1);
  const pad = cut.startsWith("`") || cut.endsWith("`") ? " " : "";
  return `${ticks}${pad}${cut}${pad}${ticks}`;
}

// Why a run was lost, in the catalog's language; a reason that is not a known
// code (rig's own text) is shown as it is.
function lostReason(end: RunEnd, m: Messages): string {
  switch (end.reason) {
    case undefined:
    case LOST_PROCESS_GONE: return m.execLostProcessGone;
    default: return end.reason;
  }
}

function outcome(rec: ExecRun, m: Messages): string {
  const end = rec.end;
  if (!end) return "";
  if (end.kind === "stopped") return m.execOutcomeStopped;
  if (end.kind === "failed") return m.execOutcomeFailed({ error: end.detail ?? "" });
  if (end.kind === "lost") return m.execOutcomeLost({ reason: lostReason(end, m) });
  return end.code === 0 ? m.execOutcomeOk : m.execOutcomeCode({ code: end.code });
}

function shellName(rec: ExecRun, names: Record<ExecShellName, string>): string {
  return rec.shell === "rig" ? "rig" : names[rec.shell];
}

// silentReason: why rig does not answer about a running run, when it does not.
export function execCardText(rec: ExecRun, tail: string, now: number, m: Messages, names = PLATFORM.shellNames, silentReason?: string): string {
  let head: string;
  if (rec.state === "pending") {
    const minutes = Math.round((now - (rec.sentAt ?? now)) / MS_PER_MINUTE);
    head = rec.startUnknown === true ? m.execStartUnknown : m.execPending({ minutes });
  } else if (rec.state === "running") {
    head = `▶ ${shellName(rec, names)} · ${duration(now - (rec.startedAt ?? now), m)}`;
  } else {
    head = `${outcome(rec, m)} · ${duration((rec.end?.at ?? now) - (rec.startedAt ?? now), m)}`;
  }
  const lines = [head, inlineCode(rec.text)];
  if (rec.state === "running" && silentReason !== undefined) lines.push(m.execRigSilent({ reason: silentReason }));
  if (tail) {
    const fence = "`".repeat(Math.max(MIN_FENCE, longestRun(tail, "`") + 1));
    lines.push(fence, tail, fence);
  }
  return lines.join("\n");
}

// The report to the agent: always English, whatever the hub's language.
export function execReportText(rec: ExecRun, tail: string, names = PLATFORM.shellNames): string {
  const m = catalogOf("en");
  const took = duration((rec.end?.at ?? 0) - (rec.startedAt ?? rec.end?.at ?? 0), m);
  return [
    `The topic command has ended: ${outcome(rec, m)} in ${took}.`,
    // A rig mutation runs in no folder of its own.
    rec.cwd === undefined ? `Shell: ${shellName(rec, names)}` : `Shell: ${shellName(rec, names)}, folder: ${rec.cwd}`,
    `Command: ${rec.text}`,
    ...(rec.runId === undefined ? [] : [`Full log: rig exec status ${rec.runId} --from 0`]),
    tail ? `Last ${EXEC_AGENT_LINES} lines:\n${tail}` : "There was no output.",
  ].join("\n");
}
