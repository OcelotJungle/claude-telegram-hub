// Topic command runs: starts them through the detached runner, follows them by
// their files only, keeps their cards and hands each result to the agent. A
// restarted hub loads execs.json and goes on as if it never stopped.
import type { ExecRecord } from "./exec-store.ts";
import type { ExecShell, ShellPaths } from "./exec-shell.ts";
import type { RunnerSpec } from "./exec-runner.ts";
import type { Button } from "./telegram.ts";
import type { ChannelMeta } from "../shared/protocol.ts";
import type { Logger } from "../shared/log.ts";
import type { MessageKind } from "../shared/notification.ts";
import type { MachineDestination } from "./machine-outbox.ts";
import type { RigInvocation } from "./rig.ts";

import { randomBytes, randomUUID } from "crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from "fs";
import { join } from "path";
import { loadExecs, saveExecs } from "./exec-store.ts";
import { notifies } from "../shared/notification.ts";
import { SHELL_NAMES, shellRun, writeShellFiles } from "./exec-shell.ts";
import { exitInfoSchema, HEARTBEAT_MS } from "./exec-runner.ts";

export const EXEC_CARD_MS = 60_000;
export const EXEC_CARD_LINES = 10;
export const EXEC_AGENT_LINES = 30;
export const MAX_EXECS = 50;
export const EXEC_MAX_AGE_MS = 120_000;
export const EXEC_CHECK_MS = 1000;
export const TELEGRAM_FILE_LIMIT = 50 * 1024 * 1024;
// A runner is gone once its heartbeat is this old: a few missed beats.
export const HEARTBEAT_STALE_MS = 3 * HEARTBEAT_MS;
const ID_BYTES = 4;
const TAIL_BYTES = 64 * 1024;
const LINE_MAX = 300;
const TEXT_MAX = 200;
const MIN_FENCE = 3;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const MS_PER_MINUTE = MS_PER_SECOND * SECONDS_PER_MINUTE;
const COPY_CHUNK = 1024 * 1024;
const BYTES_PER_MB = 1024 * 1024;
// The first bytes of a UTF-8 character's continuation: 10xxxxxx.
const UTF8_CONT_MASK = 0xc0;
const UTF8_CONT = 0x80;
const LOST_REASON = "процесс исчез";

export type ExecDeps = {
  dir: string;
  file: string;
  shells(): ShellPaths;
  shellNames?: Record<ExecShell, string>;
  env(): Record<string, string>;
  spawnRunner(specFile: string): number;
  alive(pid: number): boolean;
  kill(pid: number): void;
  card(sessionId: string, cardId: string, markdown: string, final: boolean, kind: MessageKind, buttons?: Button[][]): void;
  notice(sessionId: string, text: string, kind: MessageKind): void;
  // Copies the file before it returns: the copy is what goes.
  sendFile(sessionId: string, path: string, name: string, kind: MessageKind): void;
  report(sessionId: string, content: string, meta: ChannelMeta, onSent: () => void): void;
  now(): number;
  checkMs: number;
  cardMs: number;
  maxAgeMs: number;
  // The largest file Telegram takes; TELEGRAM_FILE_LIMIT when not given.
  fileLimit?: number;
  // Whether the session has a window connected now.
  hasWindow(sessionId: string): boolean;
  // How long after the start windows get to reconnect before results of runs
  // that ended meanwhile go on without them; none when not given.
  graceMs?: number;
  log: Logger;
  // Why a shell may not start now (its feature is off), or undefined; asked again when a stale Run button is pressed.
  unavailable?(shell: ExecRecord["shell"]): string | undefined;
  machineCard?(record: ExecRecord, text: string, final: boolean, kind: MessageKind, buttons?: Button[][]): void;
  machineFile?(record: ExecRecord, path: string, kind: MessageKind): void;
};

export class Execs {
  private recs: ExecRecord[] = [];
  private timers: ReturnType<typeof setInterval>[] = [];
  // The last check, and till when a stale heartbeat still counts: after a
  // gap in the checks the machine slept, and the runners slept with it.
  private lastCheck: number | undefined;
  private graceUntil = 0;
  // Runs that ended at start or in its grace with no window: their results
  // wait for the windows to reconnect, then for sweep().
  private deferred = new Set<string>();
  private deferUntil = 0;
  private sweepTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private deps: ExecDeps) {}

  start(): void {
    this.timers.push(setInterval(() => this.check(), this.deps.checkMs));
    this.timers.push(setInterval(() => this.editCards(), this.deps.cardMs));
    const grace = this.deps.graceMs ?? 0;
    this.deferUntil = this.deps.now() + grace;
    // At once: a run gone while no hub watched never gets a stop button press.
    // Its result is not reported yet: a window about to reconnect gets it.
    this.restore();
    this.sweepTimer = setTimeout(() => this.sweep(), grace);
  }

  restore(): void {
    this.recs = loadExecs(this.deps.file);
    this.check(true);
    for (const rec of this.recs) {
      if (rec.shell !== "rig" || rec.state !== "ended") continue;
      this.showCard(rec);
      if (rec.end) this.sendLog(rec, rec.end);
    }
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

  // Only the timers: the runners go on and a next manager picks them up.
  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    clearTimeout(this.sweepTimer);
  }

  running(): number {
    return this.recs.filter(r => r.state === "running").length;
  }

  command(sessionId: string, shell: ExecShell, text: string, cwd: string, msg: { chatId: string; messageId: number; date: number }): void {
    // Telegram may hand a restarted hub the same message again. Message ids
    // count per chat; a run saved without its chat matches any.
    const same = this.recs.find(r => r.messageId === msg.messageId && (r.chatId ?? msg.chatId) === msg.chatId);
    if (same) {
      this.deps.log.info(`exec: message ${msg.messageId} in chat ${msg.chatId} already ran as ${same.id}, skipped`);
      return;
    }
    const sentAt = msg.date * MS_PER_SECOND;
    const rec: ExecRecord = {
      id: randomBytes(ID_BYTES).toString("hex"),
      sessionId,
      chatId: msg.chatId,
      messageId: msg.messageId,
      shell,
      text,
      cwd,
      state: "pending",
      sentAt,
      reported: false,
    };
    this.recs.push(rec);
    this.prune();
    if (this.deps.now() - sentAt > this.deps.maxAgeMs) {
      this.save();
      this.showCard(rec);
      return;
    }
    this.launch(rec);
  }

  // `sentAt` (ms) is when the user sent the command; one older than the age limit waits for the button like a stale /bash.
  // A command the user confirmed later passes none: the confirmation press had its own age check.
  machine(invocation: RigInvocation, text: string, cwd: string, destination: MachineDestination, messageId: number, sentAt?: number): void {
    if (this.recs.some(rec => rec.messageId === messageId && rec.chatId === destination.chatId)) return;
    const rec: ExecRecord = { id: randomUUID().replaceAll("-", ""), shell: "rig", invocation,
      destination, chatId: destination.chatId, messageId, text, cwd, state: "pending", sentAt, reported: false };
    this.recs.push(rec);
    this.prune();
    if (sentAt !== undefined && this.deps.now() - sentAt > this.deps.maxAgeMs) {
      this.save();
      this.showCard(rec);
      return;
    }
    this.launch(rec);
  }

  press(id: string, action: "stop" | "run"): string {
    const rec = this.recs.find(r => r.id === id);
    if (!rec) return "Запуск не найден";
    if (rec.state === "ended") return "Команда уже закончилась";
    if (action === "run") {
      if (rec.state === "running") return "Команда уже запущена";
      // The button may be old: the feature could have been switched off since the card was shown.
      const why = this.deps.unavailable?.(rec.shell);
      if (why) return why;
      this.launch(rec);
      return "Запускаю";
    }
    if (rec.state === "pending" || rec.pid === undefined) return "Команда ещё не запущена";
    // A run that ended, or whose runner is gone, is not killed: its pid may
    // belong to another process by now.
    if (existsSync(this.path(rec.id, "exit.json")) || !this.beating(rec)) {
      this.check();
      return "Команда уже закончилась";
    }
    rec.stopping = true;
    this.save();
    this.deps.kill(rec.pid);
    return "Останавливаю";
  }

  // Results the agent has not got go again once its session is back.
  connected(sessionId: string): void {
    for (const rec of this.recs) {
      if (rec.sessionId === sessionId && rec.state === "ended" && !rec.reported) this.report(rec);
    }
  }

  // Whether the run's runner touched its heartbeat file lately.
  private beating(rec: ExecRecord): boolean {
    const now = this.deps.now();
    if (now < this.graceUntil) return true;
    try {
      return now - statSync(this.path(rec.id, "alive")).mtimeMs < HEARTBEAT_STALE_MS;
    } catch {
      return false;
    }
  }

  private path(id: string, ext: string): string {
    return join(this.deps.dir, `${id}.${ext}`);
  }

  private save(): boolean {
    try {
      saveExecs(this.deps.file, this.recs);
      return true;
    } catch (e) {
      this.deps.log.error(`exec: saving runs failed: ${e}`);
      return false;
    }
  }

  private launch(rec: ExecRecord): void {
    try {
      const run = rec.shell === "rig"
        ? rec.invocation && { ...rec.invocation, files: [], env: {} }
        : shellRun(rec.shell, rec.text, this.deps.dir, rec.id, this.deps.shells());
      if (!run) return this.end(rec, { kind: "lost", at: this.deps.now(), reason: "нет команды rig" });
      writeShellFiles(run);
      const spec: RunnerSpec = {
        argv: run.argv,
        verbatim: run.verbatim,
        cwd: rec.cwd,
        env: { ...this.deps.env(), ...run.env },
        log: this.path(rec.id, "log"),
        exit: this.path(rec.id, "exit.json"),
        alive: this.path(rec.id, "alive"),
        heartbeatMs: HEARTBEAT_MS,
      };
      const specFile = this.path(rec.id, "spec.json");
      mkdirSync(this.deps.dir, { recursive: true });
      // The first beat, so a runner still starting counts as alive.
      const at = this.deps.now() / MS_PER_SECOND;
      writeFileSync(spec.alive, "");
      utimesSync(spec.alive, at, at);
      writeFileSync(specFile, JSON.stringify(spec));
      rec.state = "running";
      rec.startedAt = this.deps.now();
      if (!this.save()) {
        this.end(rec, { kind: "lost", at: this.deps.now(), reason: "не удалось сохранить запуск" });
        return;
      }
      rec.pid = this.deps.spawnRunner(specFile);
      this.deps.log.info(`exec ${rec.id}: started ${rec.shell} in ${rec.cwd}, runner ${rec.pid}`);
      this.save();
      this.showCard(rec);
    } catch (e) {
      this.deps.log.error(`exec ${rec.id}: start failed: ${e}`);
      rec.startedAt = this.deps.now();
      this.end(rec, { kind: "lost", at: this.deps.now(), reason: `не запустилось: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  // Drops the oldest ended runs, with their files, past MAX_EXECS.
  private prune(): void {
    let extra = this.recs.length - MAX_EXECS;
    if (extra <= 0) return;
    let names: string[] = [];
    try {
      names = readdirSync(this.deps.dir);
    } catch {}
    this.recs = this.recs.filter(r => {
      if (extra <= 0 || r.state !== "ended") return true;
      extra--;
      for (const n of names) {
        if (n.startsWith(`${r.id}.`)) rmSync(join(this.deps.dir, n), { force: true });
      }
      return false;
    });
  }

  // quiet: the runs that ended are not reported; see start().
  private check(quiet = false): void {
    const now = this.deps.now();
    if (this.lastCheck !== undefined && now - this.lastCheck > HEARTBEAT_MS) this.graceUntil = now + HEARTBEAT_STALE_MS;
    this.lastCheck = now;
    for (const rec of this.recs) {
      if (rec.state !== "running") continue;
      const exit = this.path(rec.id, "exit.json");
      if (existsSync(exit)) {
        this.ended(rec, exit, quiet);
        continue;
      }
      // A runner without a fresh heartbeat is gone, whoever has its pid now
      // (after a reboot, a sign-out, a Fast Startup shutdown): that one is
      // neither waited for nor killed.
      if (this.beating(rec) && (rec.pid === undefined || this.deps.alive(rec.pid))) {
        if (rec.shell === "rig") this.showCard(rec);
        continue;
      }
      // The runner may have written the file just before it exited.
      if (existsSync(exit)) this.ended(rec, exit, quiet);
      else this.end(rec, rec.stopping ? { kind: "stopped", at: this.deps.now() } : { kind: "lost", at: this.deps.now(), reason: LOST_REASON }, quiet);
    }
  }

  private ended(rec: ExecRecord, exitFile: string, quiet: boolean): void {
    let info;
    try {
      info = exitInfoSchema.parse(JSON.parse(readFileSync(exitFile, "utf8")));
    } catch (e) {
      this.deps.log.warn(`exec ${rec.id}: unreadable exit file: ${e}`);
      return;
    }
    const at = info.endedAt;
    if (info.error !== undefined) this.end(rec, { kind: "lost", at, reason: `не запустилось: ${info.error}` }, quiet);
    // After a stop, a non-zero code is most likely the kill's; a run that
    // ended before the press never got killed (see press).
    else if (rec.stopping && info.code !== 0) this.end(rec, { kind: "stopped", at }, quiet);
    else if (info.code === null) this.end(rec, { kind: "lost", at, reason: LOST_REASON }, quiet);
    else this.end(rec, { kind: "exit", code: info.code, at }, quiet);
  }

  private end(rec: ExecRecord, end: NonNullable<ExecRecord["end"]>, quiet = false): void {
    rec.state = "ended";
    rec.end = end;
    this.deps.log.info(`exec ${rec.id}: ended ${end.kind}${end.code === undefined ? "" : ` ${end.code}`}`);
    this.save();
    this.showCard(rec);
    this.sendLog(rec, end);
    // In the start's grace a session without a window may be reconnecting:
    // reporting now would launch a second copy of it or say "not delivered".
    if (rec.shell === "rig") return;
    const inGrace = this.deps.now() < this.deferUntil && (rec.sessionId === undefined || !this.deps.hasWindow(rec.sessionId));
    if (quiet || inGrace) this.deferred.add(rec.id);
    else this.report(rec);
  }

  // A log that does not fit the card goes as a file. Also called on restore for
  // a rig record: the hub may have died between saving the end and handing the
  // file over, and the machine outbox ignores a log it already knows.
  private sendLog(rec: ExecRecord, end: NonNullable<ExecRecord["end"]>): void {
    const log = this.path(rec.id, "log");
    const kind = end.kind === "lost" ? "warning" : end.kind === "exit" && end.code !== 0 ? "error" : "info";
    if (fitsCard(log)) return;
    try {
      const file = this.fileToSend(rec.id, log);
      if (rec.shell === "rig") this.deps.machineFile?.(rec, file, kind);
      else if (rec.sessionId !== undefined) this.deps.sendFile(rec.sessionId, file, `${rec.id}.log`, kind);
    } catch (e) {
      this.deps.log.warn(`exec ${rec.id}: sending the log failed: ${e}`);
    }
  }

  // The log, or a copy of its last bytes with a note when Telegram would
  // refuse the whole of it.
  private fileToSend(id: string, log: string): string {
    const limit = this.deps.fileLimit ?? TELEGRAM_FILE_LIMIT;
    const size = statSync(log).size;
    if (size <= limit) return log;
    const note = Buffer.from(`[лог обрезан: здесь последние ${mb(limit)} из ${mb(size)}]\n`);
    const copy = this.path(id, "tail.log");
    copyTail(log, copy, note, Math.max(0, limit - note.length));
    return copy;
  }

  private report(rec: ExecRecord): void {
    if (rec.sessionId === undefined || rec.shell === "rig") return;
    const log = this.path(rec.id, "log");
    const meta: ChannelMeta = { source: "exec", exec_id: rec.id, ts: new Date(rec.end?.at ?? this.deps.now()).toISOString() };
    if (rec.end?.kind === "exit" && rec.end.code !== undefined) meta.exit_code = String(rec.end.code);
    this.deps.report(rec.sessionId, execReportText(rec, logTail(log, EXEC_AGENT_LINES), log, this.deps.shellNames), meta, () => {
      rec.reported = true;
      this.save();
    });
  }

  private editCards(): void {
    for (const rec of this.recs) if (rec.state === "running") this.showCard(rec);
  }

  private showCard(rec: ExecRecord): void {
    const tail = rec.state === "pending" ? "" : logTail(this.path(rec.id, "log"), EXEC_CARD_LINES);
    const buttons: Button[][] | undefined =
      rec.state === "running"
        ? [[{ text: "⏹ Остановить", data: `x:${rec.id}:stop` }]]
        : rec.state === "pending"
          ? [[{ text: "▶ Запустить", data: `x:${rec.id}:run` }]]
          : undefined;
    const kind = rec.state !== "ended" || rec.end?.kind === "stopped" || (rec.end?.kind === "exit" && rec.end.code === 0)
      ? "info"
      : rec.end?.kind === "exit" ? "error" : "warning";
    const text = execCardText(rec, tail, this.deps.now(), this.deps.shellNames);
    if (rec.shell === "rig") this.deps.machineCard?.(rec, text, rec.state === "ended", kind, rec.state === "pending" ? buttons : undefined);
    else if (rec.sessionId !== undefined) this.deps.card(rec.sessionId, `exec-${rec.id}`, text, rec.state === "ended", kind, buttons);
  }
}

function mb(bytes: number): string {
  return `${Math.round(bytes / BYTES_PER_MB)} МБ`;
}

// The note, then the last `bytes` of the file, from a character's start.
function copyTail(src: string, dest: string, note: Buffer, bytes: number): void {
  const size = statSync(src).size;
  const inFd = openSync(src, "r");
  const outFd = openSync(dest, "w");
  try {
    writeSync(outFd, note);
    let pos = Math.max(0, size - bytes);
    const buf = Buffer.alloc(COPY_CHUNK);
    let first = true;
    while (pos < size) {
      const n = readSync(inFd, buf, 0, Math.min(COPY_CHUNK, size - pos), pos);
      if (n <= 0) break;
      let start = 0;
      if (first) {
        while (start < n && ((buf[start] ?? 0) & UTF8_CONT_MASK) === UTF8_CONT) start++;
        first = false;
      }
      writeSync(outFd, buf, start, n - start);
      pos += n;
    }
  } finally {
    closeSync(inFd);
    closeSync(outFd);
  }
}

// The log's lines as a terminal would leave them: a progress bar's line is
// what follows its last carriage return.
function screenLines(text: string): string[] {
  const lines = text.split("\n").map(l => {
    const line = l.endsWith("\r") ? l.slice(0, -1) : l;
    return line.slice(line.lastIndexOf("\r") + 1);
  });
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines;
}

function readEnd(path: string, bytes: number): { text: string; whole: boolean } | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const size = statSync(path).size;
    const n = Math.min(size, bytes);
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, size - n);
    return { text: buf.subarray(0, read).toString("utf8"), whole: n === size };
  } finally {
    closeSync(fd);
  }
}

export function logTail(path: string, lines: number): string {
  const end = readEnd(path, TAIL_BYTES);
  if (!end) return "";
  const all = screenLines(end.text);
  // A read from the middle starts in the middle of a line.
  if (!end.whole) all.shift();
  return all
    .slice(-lines)
    .map(l => (l.length > LINE_MAX ? `${l.slice(0, LINE_MAX - 1)}…` : l))
    .join("\n");
}

// Whether the card's tail already shows the whole log.
function fitsCard(path: string): boolean {
  const end = readEnd(path, TAIL_BYTES);
  if (!end) return true;
  if (!end.whole) return false;
  const lines = screenLines(end.text);
  return lines.length <= EXEC_CARD_LINES && lines.every(l => l.length <= LINE_MAX);
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / MS_PER_SECOND));
  if (s < SECONDS_PER_MINUTE) return `${s} с`;
  const m = Math.floor(s / SECONDS_PER_MINUTE);
  if (m < MINUTES_PER_HOUR) return `${m} мин ${String(s % SECONDS_PER_MINUTE).padStart(2, "0")} с`;
  return `${Math.floor(m / MINUTES_PER_HOUR)} ч ${String(m % MINUTES_PER_HOUR).padStart(2, "0")} мин`;
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

function outcome(rec: ExecRecord): string {
  const end = rec.end;
  if (!end) return "";
  if (end.kind === "stopped") return "⏹ остановлена";
  if (end.kind === "lost") return `⚠️ прервана: ${end.reason ?? LOST_REASON}`;
  return end.code === 0 ? "✅ код 0" : `❌ код ${end.code}`;
}

export function execCardText(rec: ExecRecord, tail: string, now: number, names = SHELL_NAMES): string {
  let head: string;
  if (rec.state === "pending") {
    const minutes = Math.round((now - (rec.sentAt ?? now)) / MS_PER_MINUTE);
    head = `⏸ Команда пришла ${minutes} мин назад, пока хаб был выключен`;
  } else if (rec.state === "running") {
    head = `▶ ${rec.shell === "rig" ? "rig" : names[rec.shell]} · ${duration(now - (rec.startedAt ?? now))}`;
  } else {
    head = `${outcome(rec)} · ${duration((rec.end?.at ?? now) - (rec.startedAt ?? now))}`;
  }
  const lines = [head, inlineCode(rec.text)];
  if (tail) {
    const fence = "`".repeat(Math.max(MIN_FENCE, longestRun(tail, "`") + 1));
    lines.push(fence, tail, fence);
  }
  return lines.join("\n");
}

export function execReportText(rec: ExecRecord, tail: string, logPath: string, names = SHELL_NAMES): string {
  const took = duration((rec.end?.at ?? 0) - (rec.startedAt ?? rec.end?.at ?? 0));
  return [
    `Команда из топика закончилась: ${outcome(rec)} за ${took}.`,
    `Оболочка: ${rec.shell === "rig" ? "rig" : names[rec.shell]}, папка: ${rec.cwd}`,
    `Команда: ${rec.text}`,
    `Полный лог: ${logPath}`,
    tail ? `Последние ${EXEC_AGENT_LINES} строк:\n${tail}` : "Вывода не было.",
  ].join("\n");
}
