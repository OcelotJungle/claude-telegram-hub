import type { ExecDeps } from "../src/hub/exec.ts";
import type { ExecRecord } from "../src/hub/exec-store.ts";
import type { RunnerSpec } from "../src/hub/exec-runner.ts";
import type { Button } from "../src/hub/telegram.ts";
import type { ChannelMeta } from "../src/shared/protocol.ts";
import type { Messages } from "../src/shared/i18n/index.ts";
import type { MessageKind } from "../src/shared/notification.ts";

import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { Execs, EXEC_CARD_LINES, EXEC_CHECK_MS, execCardText, HEARTBEAT_STALE_MS, logTail, MAX_EXECS } from "../src/hub/exec.ts";
import { loadExecs, saveExecs } from "../src/hub/exec-store.ts";
import { HEARTBEAT_MS, runnerSpecSchema } from "../src/hub/exec-runner.ts";
import { en } from "../src/shared/i18n/en.ts";
import { ru } from "../src/shared/i18n/ru.ts";
import { notifies } from "../src/shared/notification.ts";
import { platformFor } from "../src/shared/platform.ts";
import { manualClock } from "./manual-clock.ts";
import { memLogger, must, tempDir } from "./helpers.ts";

const SID = "s1";
const FIRST_PID = 1000;
const MIN_MS = 60_000;
const NOW = 1_800_000_000_000;
// A card pace shorter than the heartbeat staleness (so a run stays alive while the clock walks a pace), a cap on the
// checks a wait may run, a run of 1 min 05 s, a log longer than the agent's
// tail, a test file limit and a line well over it.
const CARD_MS = 5000;
const MAX_TICKS = 100;
const RUN_1_05_MS = 65_000;
const LOG_LINES = 40;
const FILE_LIMIT = 200;
const BIG_LINE_CHARS = 500;
// One two-byte UTF-8 character (Cyrillic ya).
const YA = "\u044f";
const MS_PER_S = 1000;
// A start's grace no test outlasts, and one a test waits out.
const LONG_GRACE_MS = 60_000;
const SHORT_GRACE_MS = 100;
// Long enough for any heartbeat to go stale.
const LONG_AGO_MS = 10 * MIN_MS;
const PERMISSION_BITS = 0o777;
const OWNER_ONLY = 0o600;

type CardCall = { sessionId: string; cardId: string; markdown: string; final: boolean; kind: MessageKind; buttons?: Button[][] };
type ReportCall = { sessionId: string; content: string; meta: ChannelMeta; onSent: () => void };

let dirs: string[] = [];
let managers: Execs[] = [];

afterEach(() => {
  for (const m of managers) m.stop();
  managers = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

// Fake deps: runners are only their spec files, which the test plays out by
// writing the log and the exit file itself.
// alive: runner pids alive from the start, for a manager that finds runs on disk.
// windows: sessions with a window; graceMs: the start's grace, none by default.
function setup(o: { env?: ExecDeps["env"]; messages?: () => Messages; dir?: string; sendOnSent?: boolean; fileLimit?: number; alive?: number[]; windows?: string[]; graceMs?: number } = {}) {
  const dir = o.dir ?? tempDir("telegramhub-exec-");
  if (o.dir === undefined) dirs.push(dir);
  const specs: RunnerSpec[] = [];
  const alive = new Set<number>(o.alive);
  const windows = new Set<string>(o.windows);
  const killed: number[] = [];
  const cards: CardCall[] = [];
  const notices: { text: string; loud: boolean }[] = [];
  const files: { path: string; name: string; loud: boolean }[] = [];
  const reports: ReportCall[] = [];
  const machineCards: { text: string; final: boolean }[] = [];
  const machineFiles: { path: string; kind: MessageKind }[] = [];
  const manual = manualClock();
  // Time is NOW plus a skew (the machine sleeping: a jump no timer fires for) plus what the manual clock advanced.
  let skew = 0;
  const clock = {
    get now() { return NOW + skew + manual.now(); },
    jump: (ms: number) => { skew += ms; },
    advance: (ms: number) => manual.advance(ms),
  };
  // Waits for a condition by letting the manager's checks run, one check period at a time.
  const until = async <T>(pred: () => T | undefined | false | null, label: string): Promise<T> => {
    for (let i = 0; i < MAX_TICKS; i++) {
      const v = pred();
      if (v) return v;
      await manual.advance(EXEC_CHECK_MS);
    }
    throw new Error(`no ${label} after ${MAX_TICKS} checks`);
  };
  const tick = () => manual.advance(EXEC_CHECK_MS);
  const log = memLogger();
  const deps: ExecDeps = {
    messages: o.messages ?? (() => en),
    dir,
    file: join(dir, "execs.json"),
    shells: () => ({ powershell: "powershell.exe", bash: "bash.exe" }),
    env: o.env ?? (() => ({ A: "1" })),
    spawnRunner: specFile => {
      specs.push(runnerSpecSchema.parse(JSON.parse(readFileSync(specFile, "utf8"))));
      const pid = FIRST_PID + specs.length;
      alive.add(pid);
      return pid;
    },
    alive: pid => alive.has(pid),
    kill: pid => void killed.push(pid),
    card: (sessionId, cardId, markdown, final, kind, buttons) => void cards.push({ sessionId, cardId, markdown, final, kind, buttons }),
    notice: (_sessionId, text, kind) => void notices.push({ text, loud: kind !== "info" }),
    sendFile: (_sessionId, path, name, kind) => void files.push({ path, name, loud: notifies(kind) }),
    report: (sessionId, content, meta, onSent) => {
      reports.push({ sessionId, content, meta, onSent });
      if (o.sendOnSent !== false) onSent();
    },
    machineCard: (_record, text, final) => void machineCards.push({ text, final }),
    machineFile: (_record, path, kind) => void machineFiles.push({ path, kind }),
    timers: { ...manual, now: () => clock.now },
    checkMs: EXEC_CHECK_MS,
    cardMs: CARD_MS,
    maxAgeMs: 2 * MIN_MS,
    fileLimit: o.fileLimit,
    hasWindow: sid => windows.has(sid),
    graceMs: o.graceMs,
    log,
  };
  const execs = new Execs(deps);
  managers.push(execs);
  execs.start();
  const spec = (n = 0) => must(specs[n], `spec ${n}`);
  const lastCard = () => must(cards.at(-1), "card");
  const finish = (n: number, code: number | null, error?: string) => {
    const s = spec(n);
    writeFileSync(s.exit, JSON.stringify({ code, endedAt: clock.now, ...(error === undefined ? {} : { error }) }));
  };
  // The runner's last heartbeat, as its file's time.
  const beat = (n: number, at: number) => utimesSync(spec(n).alive, at / MS_PER_S, at / MS_PER_S);
  return { dir, deps, execs, specs, alive, windows, killed, cards, machineCards, machineFiles, notices, files, reports, clock, log, spec, lastCard, finish, beat, until, tick };
}

const CHAT = "-1001";
const msg = (messageId: number, ageMs = 0, chatId = CHAT) => ({ chatId, messageId, date: Math.floor((NOW - ageMs) / MS_PER_S) });
const idOf = (cardId: string) => cardId.replace(/^exec-/, "");

describe("Execs", () => {
  test("a command whose environment comes later starts once it is there, and only once", async () => {
    let release: (env: Record<string, string>) => void = () => {};
    const t = setup({ env: () => new Promise<Record<string, string>>(resolve => { release = resolve; }) });
    t.execs.command(SID, "cmd", "npm run x", "C:\\proj", msg(1));
    expect(t.specs).toHaveLength(0);
    // Waiting for the environment counts as running, so the hub does not go idle under it.
    expect(t.execs.running()).toBe(1);
    expect(t.execs.starting()).toBe(1);
    release({ A: "late" });
    await t.clock.advance(1);
    expect(t.specs).toHaveLength(1);
    expect(t.spec().env.A).toBe("late");
    expect(t.execs.running()).toBe(1);
    expect(t.execs.starting()).toBe(0);
  });

  test("a command whose environment fails no longer counts as running", async () => {
    let fail: (e: Error) => void = () => {};
    const t = setup({ env: () => new Promise<Record<string, string>>((_, reject) => { fail = reject; }) });
    t.execs.command(SID, "cmd", "npm run x", "C:\\proj", msg(1));
    expect(t.execs.running()).toBe(1);
    fail(new Error("registry gone"));
    await t.clock.advance(1);
    expect(t.specs).toHaveLength(0);
    expect(t.execs.running()).toBe(0);
    expect(t.execs.starting()).toBe(0);
  });

  test("a command runs, edits its card and reports once", async () => {
    const t = setup();
    t.execs.command(SID, "cmd", "npm run x", "C:\\proj", msg(1));
    expect(t.specs).toHaveLength(1);
    expect(t.spec().cwd).toBe("C:\\proj");
    expect(t.spec().env.A).toBe("1");
    const first = t.lastCard();
    expect(first.markdown).toStartWith("▶ cmd");
    expect(first.kind).toBe("info");
    expect(first.markdown).toContain("`npm run x`");
    expect(first.buttons).toEqual([[{ text: en.execStopButton, data: `x:${idOf(first.cardId)}:stop` }]]);
    expect(t.execs.running()).toBe(1);
    appendFileSync(t.spec().log, "a\nb\n");
    await t.until(() => t.cards.find(c => c.markdown.includes("b") && !c.final), "card with b");
    // The run started at NOW: jump to exactly 1 min 05 s after it, whatever the checks have advanced.
    t.clock.jump(NOW + RUN_1_05_MS - t.clock.now);
    t.finish(0, 0);
    const last = await t.until(() => t.cards.find(c => c.final), "final card");
    expect(last.markdown).toStartWith(`${en.execOutcomeOk} · 1 min 05 s`);
    expect(last.kind).toBe("info");
    expect(last.buttons).toBeUndefined();
    await t.tick();
    expect(t.reports).toHaveLength(1);
    expect(t.reports[0]?.meta.source).toBe("exec");
    expect(t.reports[0]?.meta.exit_code).toBe("0");
    expect(t.reports[0]?.meta.exec_id).toBe(idOf(first.cardId));
    expect(t.files).toHaveLength(0);
    expect(t.execs.running()).toBe(0);
  });

  test("a failing command reports its code loudly with the log file", async () => {
    const t = setup();
    t.execs.command(SID, "powershell", "npm run x", "C:\\proj", msg(1));
    appendFileSync(t.spec().log, Array.from({ length: LOG_LINES }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
    t.finish(0, 2);
    const report = await t.until(() => t.reports[0], "report");
    expect(t.lastCard().markdown).toStartWith(en.execOutcomeCode({ code: 2 }));
    expect(t.lastCard().kind).toBe("error");
    expect(t.files).toEqual([{ path: t.spec().log, name: `${report.meta.exec_id}.log`, loud: true }]);
    expect(report.content).toStartWith(`The topic command has ended: ${en.execOutcomeCode({ code: 2 })} in 0 s.`);
    expect(report.content).toContain("Shell: PowerShell, folder: C:\\proj");
    expect(report.content).toContain("Command: npm run x");
    expect(report.content).toContain(`Full log: ${t.spec().log}`);
    expect(report.content).toContain("line 11\n");
    expect(report.content).toContain(`line ${LOG_LINES}`);
    expect(report.content).not.toContain("line 10\n");
    expect(report.meta.exit_code).toBe("2");
  });

  test("a log over the file limit goes as its last bytes, whole characters, with a note", async () => {
    const t = setup({ fileLimit: FILE_LIMIT });
    // One byte apart, so one of the two cuts falls inside a character.
    // "\u043a\u043e\u043d\u0435\u0446" spells "end" in Russian.
    for (const [n, last] of ["\u043a\u043e\u043d\u0435\u0446\n", "\u043a\u043e\u043d\u0435\u0446!\n"].entries()) {
      t.execs.command(SID, "cmd", "x", "C:\\proj", msg(n + 1));
      appendFileSync(t.spec(n).log, `${YA.repeat(BIG_LINE_CHARS)}\n${last}`);
      t.finish(n, 1);
      const sent = await t.until(() => t.files[n], "sent file");
      expect(sent.path).not.toBe(t.spec(n).log);
      expect(sent.name).toEndWith(".log");
      const bytes = readFileSync(sent.path);
      expect(bytes.length).toBeLessThanOrEqual(FILE_LIMIT);
      const text = bytes.toString("utf8");
      expect(text).toStartWith("[log trimmed");
      expect(text).not.toContain("\uFFFD");
      expect(text).toEndWith(`${YA}\n${last}`);
    }
  });

  test("the same message never runs twice", () => {
    const t = setup();
    t.execs.command(SID, "cmd", "echo", "C:\\proj", msg(7));
    t.execs.command(SID, "cmd", "echo", "C:\\proj", msg(7));
    expect(t.specs).toHaveLength(1);
    expect(t.log.lines.some(l => l.includes("message 7") && l.includes("already"))).toBe(true);
  });

  test("the same message id in another chat is another command", () => {
    const t = setup();
    t.execs.command(SID, "cmd", "echo", "C:\\proj", msg(7));
    t.execs.command(SID, "cmd", "echo", "C:\\proj", msg(7, 0, "-1002"));
    expect(t.specs).toHaveLength(2);
  });

  test("a command that ends on its own after stop was pressed keeps its code", async () => {
    const t = setup();
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    const id = idOf(t.lastCard().cardId);
    expect(t.execs.press(id, "stop")).toBe(en.execStopping);
    t.finish(0, 0);
    await t.until(() => t.cards.find(c => c.final), "final card");
    expect(t.lastCard().markdown).toStartWith(en.execOutcomeOk);
  });

  test("stop after the exit file is there kills nothing and shows the code", () => {
    const t = setup();
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    const id = idOf(t.lastCard().cardId);
    t.finish(0, 2);
    expect(t.execs.press(id, "stop")).toBe(en.execAlreadyEnded);
    expect(t.killed).toEqual([]);
    expect(t.lastCard().markdown).toStartWith(en.execOutcomeCode({ code: 2 }));
  });

  test("an old command waits for the button", () => {
    const t = setup();
    t.execs.command(SID, "cmd", "npm run migrate", "C:\\proj", msg(1, 3 * MIN_MS));
    expect(t.specs).toHaveLength(0);
    const card = t.lastCard();
    expect(card.markdown).toStartWith(en.execPending({ minutes: 3 }));
    const id = idOf(card.cardId);
    expect(card.buttons).toEqual([[{ text: en.execRunButton, data: `x:${id}:run` }]]);
    expect(t.execs.press(id, "run")).toBe(en.execStarting);
    expect(t.specs).toHaveLength(1);
    expect(t.lastCard().markdown).toStartWith("▶ cmd");
    expect(t.execs.press(id, "run")).toBe(en.execAlreadyRunning);
    expect(t.specs).toHaveLength(1);
    expect(t.execs.press("nope", "run")).toBe(en.execNotFound);
  });

  test("stop kills the process and ends as stopped", async () => {
    const t = setup();
    t.execs.command(SID, "cmd", "ping", "C:\\proj", msg(1));
    const id = idOf(t.lastCard().cardId);
    expect(t.execs.press(id, "stop")).toBe(en.execStopping);
    expect(t.killed).toEqual([FIRST_PID + 1]);
    t.alive.clear();
    await t.until(() => t.cards.find(c => c.final), "final card");
    expect(t.lastCard().markdown).toStartWith(en.execOutcomeStopped);
    expect(t.execs.press(id, "stop")).toBe(en.execAlreadyEnded);
    expect(t.execs.press(id, "run")).toBe(en.execAlreadyEnded);
  });

  test("a vanished process ends as lost", async () => {
    const t = setup();
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    t.alive.clear();
    await t.until(() => t.cards.find(c => c.final), "final card");
    expect(t.lastCard().markdown).toStartWith(en.execOutcomeLost({ reason: en.execLostProcessGone }));
    const report = await t.until(() => t.reports[0], "report");
    expect(report.content).toContain(en.execOutcomeLost({ reason: en.execLostProcessGone }));
    expect(report.meta.exit_code).toBeUndefined();
  });

  test("a command that could not start ends as lost with the reason", async () => {
    const t = setup();
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    t.finish(0, null, "spawn ENOENT");
    await t.until(() => t.cards.find(c => c.final), "final card");
    expect(t.lastCard().markdown).toStartWith(en.execOutcomeLost({ reason: en.execLostNotStarted({ error: "spawn ENOENT" }) }));
  });

  test("a command that could not start is worded in the language current when it ends", async () => {
    let current: Messages = en;
    const t = setup({ messages: () => current });
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    current = ru;
    t.finish(0, null, "spawn ENOENT");
    await t.until(() => t.cards.find(c => c.final), "final card");
    expect(t.lastCard().markdown).toStartWith(ru.execOutcomeLost({ reason: ru.execLostNotStarted({ error: "spawn ENOENT" }) }));
    expect(t.lastCard().markdown).not.toContain("did not start");
  });

  test("a restarted manager goes on", async () => {
    const t = setup();
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    t.execs.stop();
    const t2 = setup({ dir: t.dir, alive: [FIRST_PID + 1] });
    t.finish(0, 0);
    await t2.until(() => t2.reports[0], "report");
    await t2.tick();
    expect(t2.reports).toHaveLength(1);
    expect(t.reports).toHaveLength(0);
    expect(t2.lastCard().markdown).toStartWith(en.execOutcomeOk);
  });

  test("a launch gives the runner its heartbeat file", () => {
    const t = setup();
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    expect(existsSync(t.spec().alive)).toBe(true);
    expect(t.spec().heartbeatMs).toBeGreaterThan(0);
  });

  test("the runner spec, which carries the environment, is readable by its owner only", () => {
    const t = setup();
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    const specFile = t.spec().alive.replace(/\.alive$/, ".spec.json");
    expect(existsSync(specFile)).toBe(true);
    // Windows has no permission bits to assert.
    if (process.platform !== "win32") expect(statSync(specFile).mode & PERMISSION_BITS).toBe(OWNER_ONLY);
  });

  test("a run whose heartbeat stopped ends as lost, whoever has its pid now", async () => {
    const dir = tempDir("telegramhub-exec-");
    dirs.push(dir);
    const rec: ExecRecord = { id: "abcd1234", sessionId: SID, messageId: 1, shell: "cmd", text: "x", cwd: "C:\\proj", state: "running", startedAt: NOW - LONG_AGO_MS, pid: 4242, reported: false };
    saveExecs(join(dir, "execs.json"), [rec]);
    writeFileSync(join(dir, "abcd1234.alive"), "");
    utimesSync(join(dir, "abcd1234.alive"), (NOW - LONG_AGO_MS) / MS_PER_S, (NOW - LONG_AGO_MS) / MS_PER_S);
    const t = setup({ dir, alive: [4242] });
    await t.until(() => t.cards.find(c => c.final), "final card");
    expect(t.lastCard().markdown).toStartWith(en.execOutcomeLost({ reason: en.execLostProcessGone }));
    expect(t.execs.press("abcd1234", "stop")).toBe(en.execAlreadyEnded);
    expect(t.killed).toEqual([]);
  });

  test("stop on a run whose heartbeat went stale kills nothing and ends it as lost", () => {
    const t = setup();
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    const id = idOf(t.lastCard().cardId);
    t.beat(0, NOW - LONG_AGO_MS);
    expect(t.execs.press(id, "stop")).toBe(en.execAlreadyEnded);
    expect(t.killed).toEqual([]);
    expect(t.lastCard().markdown).toStartWith(en.execOutcomeLost({ reason: en.execLostProcessGone }));
  });

  test("a run the hub slept through waits for its next heartbeat", async () => {
    const t = setup();
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    // The machine slept: the clock jumps, the heartbeat is old.
    t.clock.jump(LONG_AGO_MS);
    await t.tick();
    expect(t.execs.running()).toBe(1);
    t.beat(0, t.clock.now);
    await t.clock.advance(HEARTBEAT_STALE_MS / 2);
    expect(t.execs.running()).toBe(1);
    // No beat for the whole grace: the runner is gone.
    await t.clock.advance(HEARTBEAT_STALE_MS);
    await t.until(() => t.cards.find(c => c.final), "final card");
    expect(t.lastCard().markdown).toStartWith(en.execOutcomeLost({ reason: en.execLostProcessGone }));
  });

  test("a run that ended while no manager watched waits for its window, then for the sweep", async () => {
    const t = setup();
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    t.execs.command("s2", "cmd", "y", "C:\\proj", msg(2));
    t.execs.stop();
    t.finish(0, 0);
    t.finish(1, 0);
    const t2 = setup({ dir: t.dir, alive: [FIRST_PID + 1, FIRST_PID + 2], graceMs: LONG_GRACE_MS });
    expect(t2.cards.filter(c => c.final)).toHaveLength(2);
    expect(t2.reports).toHaveLength(0);
    t2.windows.add(SID);
    t2.execs.connected(SID);
    expect(t2.reports.map(r => r.sessionId)).toEqual([SID]);
    t2.execs.sweep();
    expect(t2.reports.map(r => r.sessionId)).toEqual([SID, "s2"]);
    t2.execs.sweep();
    expect(t2.reports).toHaveLength(2);
  });

  test("a run that ends in the start's grace waits for its window, one with a window does not", async () => {
    const t = setup();
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    t.execs.command("s2", "cmd", "y", "C:\\proj", msg(2));
    t.execs.stop();
    const t2 = setup({ dir: t.dir, alive: [FIRST_PID + 1, FIRST_PID + 2], windows: ["s2"], graceMs: LONG_GRACE_MS });
    t.finish(0, 0);
    t.finish(1, 0);
    await t2.until(() => t2.cards.filter(c => c.final).length === 2, "final cards");
    expect(t2.reports.map(r => r.sessionId)).toEqual(["s2"]);
    t2.windows.add(SID);
    t2.execs.connected(SID);
    expect(t2.reports.map(r => r.sessionId)).toEqual(["s2", SID]);
  });

  test("the grace ends with a sweep of its own", async () => {
    const t = setup();
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    t.execs.stop();
    t.finish(0, 0);
    const t2 = setup({ dir: t.dir, graceMs: SHORT_GRACE_MS });
    expect(t2.reports).toHaveLength(0);
    await t2.until(() => t2.reports[0], "report after the grace");
  });

  test("an unreported result goes again when the session connects", async () => {
    const t = setup({ sendOnSent: false });
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    t.finish(0, 0);
    await t.until(() => t.reports[0], "report");
    t.execs.connected("other");
    expect(t.reports).toHaveLength(1);
    t.execs.connected(SID);
    expect(t.reports).toHaveLength(2);
    t.reports[1]?.onSent();
    t.execs.connected(SID);
    expect(t.reports).toHaveLength(2);
  });

  test("the card survives backticks and carriage returns", async () => {
    const t = setup();
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    appendFileSync(t.spec().log, "```js\nx\n10%\r50%\r100%\r\n");
    const card = await t.until(() => t.cards.find(c => c.markdown.includes("100%") && !c.final), "card");
    expect(card.markdown).toContain("\n````\n```js\nx\n100%\n````");
    expect(card.markdown).not.toContain("50%");
  });

  test("more than MAX_EXECS runs drop the oldest with their files", () => {
    const dir = tempDir("telegramhub-exec-");
    dirs.push(dir);
    const old: ExecRecord[] = Array.from({ length: MAX_EXECS }, (_, i) => ({
      id: `0000${String(i).padStart(4, "0")}`,
      sessionId: SID,
      messageId: i + 1,
      shell: "cmd",
      text: "x",
      cwd: "C:\\proj",
      state: "ended",
      startedAt: NOW,
      end: { kind: "exit", code: 0, at: NOW },
      reported: true,
    }));
    saveExecs(join(dir, "execs.json"), old);
    for (const r of old.slice(0, 2)) {
      writeFileSync(join(dir, `${r.id}.log`), "x");
      writeFileSync(join(dir, `${r.id}.exit.json`), "{}");
    }
    const t = setup({ dir });
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1000));
    const recs = loadExecs(join(dir, "execs.json"));
    expect(recs).toHaveLength(MAX_EXECS);
    expect(recs.find(r => r.id === "00000000")).toBeUndefined();
    expect(recs.find(r => r.id === "00000001")).toBeDefined();
    expect(readdirSync(dir).filter(f => f.startsWith("00000000."))).toEqual([]);
    expect(existsSync(join(dir, "00000001.log"))).toBe(true);
  });
});

describe("rig run cards", () => {
  const INVOCATION = { argv: ["rig", "update"], verbatim: false };
  const startRig = () => {
    const t = setup();
    t.execs.machine(INVOCATION, "rig update", "C:\\proj", { chatId: CHAT }, 1);
    return t;
  };

  test("new output redraws the card at once, without waiting for the card pace", async () => {
    const t = startRig();
    expect(t.machineCards).toHaveLength(1);
    appendFileSync(t.spec().log, "waiting for the lock\n");
    const card = await t.until(() => t.machineCards.find(c => c.text.includes("waiting for the lock")), "card with the lock line");
    expect(card.final).toBe(false);
    expect(t.machineCards).toHaveLength(2);
  });

  test("unchanged output is not redrawn between card paces, only when the pace passes", async () => {
    const t = startRig();
    expect(t.machineCards).toHaveLength(1);
    // Checks run every second, and the seconds counter changes with the clock, but less than a pace is no reason to redraw.
    await t.clock.advance(CARD_MS - 1);
    expect(t.machineCards).toHaveLength(1);
    await t.clock.advance(1);
    expect(t.machineCards).toHaveLength(2);
    await t.tick();
    expect(t.machineCards).toHaveLength(2);
  });

  test("a finished run draws its final card once", async () => {
    const t = startRig();
    t.finish(0, 0);
    await t.until(() => t.machineCards.find(c => c.final), "final card");
    await t.tick();
    expect(t.machineCards.filter(c => c.final)).toHaveLength(1);
  });

  // What rig writes: progress on stderr and the result or the error on stdout, as JSON lines.
  const progress = (code: string, data?: unknown) => JSON.stringify({ progress: { code, ...(data === undefined ? {} : { data }) } });
  const resultFile = (t: ReturnType<typeof startRig>) => must(t.spec().result, "result file");

  test("progress and the result are shown in words, never as JSON", async () => {
    const t = startRig();
    appendFileSync(t.spec().log, `${progress("lock-waiting")}\n${progress("update-step-output", { line: "fetching" })}\n`);
    const waiting = await t.until(() => t.machineCards.find(c => c.text.includes("fetching")), "card with the step line");
    expect(waiting.text).toContain(en.rigProgressLockWaiting);
    expect(waiting.text).not.toContain("{");
    appendFileSync(resultFile(t), `${JSON.stringify({ mode: "server", outcome: "complete" })}\n`);
    t.finish(0, 0);
    const done = await t.until(() => t.machineCards.find(c => c.final), "final card");
    expect(done.text).toContain(en.rigUpdateComplete({ pending: false }));
    expect(done.text).not.toContain("{");
    expect(done.text).not.toContain("outcome");
  });

  test("a rig run's runner keeps the result apart from the progress; a shell run's has no result file", () => {
    const t = startRig();
    expect(t.spec().result).toBe(t.spec().log.replace(/\.log$/, ".result"));
    const shell = setup();
    shell.execs.command(SID, "cmd", "npm run x", "C:\\proj", msg(1));
    expect(shell.spec().result).toBeUndefined();
  });

  // The card's tail: the lines between its two fences.
  const tailOf = (text: string) => {
    const lines = text.split("\n");
    return lines.slice(lines.indexOf("```") + 1, lines.lastIndexOf("```"));
  };

  test("a progress line still being written is not shown cut; it shows once whole", async () => {
    const t = startRig();
    const whole = progress("update-step-output", { line: "first" });
    const half = progress("update-step-output", { line: "second" });
    // The half line has no newline yet, in the same write as a whole line: the card with the whole line proves the read saw it.
    appendFileSync(t.spec().log, `${whole}\n${half.slice(0, half.length - 5)}`);
    const first = await t.until(() => t.machineCards.find(c => c.text.includes("first")), "card with the whole line");
    expect(first.text).not.toContain("{");
    expect(first.text).not.toContain("progress");
    expect(first.text).not.toContain("second");
    appendFileSync(t.spec().log, `${half.slice(half.length - 5)}\n`);
    const second = await t.until(() => t.machineCards.find(c => c.text.includes("second")), "card with the second line");
    expect(tailOf(second.text)).toEqual(["first", "second"]);
  });

  test("the result is the last line of the card even when progress is written after it", async () => {
    const t = startRig();
    appendFileSync(resultFile(t), `${JSON.stringify({ feature: "pwsh", enabled: true })}\n`);
    appendFileSync(t.spec().log, `${progress("update-step-output", { line: "late step" })}\n`);
    t.finish(0, 0);
    const done = await t.until(() => t.machineCards.find(c => c.final), "final card");
    expect(tailOf(done.text)).toEqual(["late step", en.rigFeatureEnabled({ name: "pwsh" })]);
  });

  test("a multi-line error shows its last lines on the card and all of them in the sent file", async () => {
    const t = startRig();
    const message = Array.from({ length: LOG_LINES }, (_, i) => `detail ${i}`).join("\n") + "\nthe real cause";
    appendFileSync(resultFile(t), `${JSON.stringify({ error: { code: "update-failed", message } })}\n`);
    t.finish(0, 1);
    const done = await t.until(() => t.machineCards.find(c => c.final), "final card");
    const shown = tailOf(done.text);
    expect(shown).toHaveLength(EXEC_CARD_LINES);
    expect(shown.at(-1)).toBe("the real cause");
    expect(done.text).not.toContain("detail 0\n");
    await t.until(() => t.machineFiles.length === 1, "the log file");
    const sent = readFileSync(must(t.machineFiles[0]).path, "utf8");
    expect(sent).toContain("detail 0\n");
    expect(sent.trimEnd().endsWith("the real cause")).toBe(true);
    expect(sent).not.toContain("{");
  });

  test("a progress line with an empty code is no empty line; an unknown code is a catalog line", async () => {
    const t = startRig();
    appendFileSync(t.spec().log, `${progress("")}\n${progress("brand-new-step")}\n${progress("update-step-output", { line: "tail" })}\n`);
    const card = await t.until(() => t.machineCards.find(c => c.text.includes("tail")), "card with the last line");
    expect(tailOf(card.text)).toEqual([en.rigProgressUnknown({ code: "brand-new-step" }), "tail"]);
  });

  test("a line that is not JSON (a traceback) is shown as text", async () => {
    const t = startRig();
    appendFileSync(t.spec().log, "Traceback (most recent call last):\n  File x\n");
    const card = await t.until(() => t.machineCards.find(c => c.text.includes("File x")), "card with the traceback");
    expect(tailOf(card.text)).toEqual(["Traceback (most recent call last):", "  File x"]);
  });

  test("a failure is rig's message as it is, the exit code still decides the outcome", async () => {
    const t = startRig();
    appendFileSync(resultFile(t), `${JSON.stringify({ error: { code: "update-busy", message: "Another update is running" } })}\n`);
    t.finish(0, 1);
    const done = await t.until(() => t.machineCards.find(c => c.final), "final card");
    expect(done.text).toContain("Another update is running");
    expect(done.text).not.toContain("update-busy");
    expect(done.text).toContain(en.execOutcomeCode({ code: 1 }));
  });

  test("the words are made when the card is drawn, in the language current then", async () => {
    let current: Messages = en;
    const t = setup({ messages: () => current });
    t.execs.machine(INVOCATION, "rig update", "C:\\proj", { chatId: CHAT }, 1);
    appendFileSync(t.spec().log, `${progress("service-stopping")}\n`);
    await t.until(() => t.machineCards.find(c => c.text.includes(en.rigProgressServiceStopping)), "English card");
    current = ru;
    t.finish(0, 0);
    const done = await t.until(() => t.machineCards.find(c => c.final), "final card");
    expect(done.text).toContain(ru.rigProgressServiceStopping);
    expect(done.text).not.toContain(en.rigProgressServiceStopping);
  });

  test("a log that does not fit the card goes as a file of words, not of JSON", async () => {
    const t = startRig();
    const lines = Array.from({ length: LOG_LINES }, (_, i) => progress("update-step-output", { line: `step ${i}` }));
    appendFileSync(t.spec().log, `${lines.join("\n")}\n`);
    t.finish(0, 0);
    await t.until(() => t.machineFiles.length === 1, "the log file");
    const sent = readFileSync(must(t.machineFiles[0]).path, "utf8");
    expect(sent).toContain("step 0\n");
    expect(sent).toContain(`step ${LOG_LINES - 1}`);
    expect(sent).not.toContain("progress");
    expect(sent).not.toContain("{");
  });

  test("a log that fits the card is not sent as a file even when its JSON lines are long", async () => {
    const t = startRig();
    appendFileSync(t.spec().log, `${progress("update-step-output", { line: "ok", note: "x".repeat(BIG_LINE_CHARS) })}\n`);
    t.finish(0, 0);
    await t.until(() => t.machineCards.find(c => c.final), "final card");
    // end() draws the final card and hands over the file in one step, so the file list is already final.
    expect(t.machineFiles).toEqual([]);
  });
});

describe("exec texts", () => {
  test("logTail keeps the last lines, after the last carriage return, cut long", () => {
    const dir = tempDir("telegramhub-exec-");
    dirs.push(dir);
    const path = join(dir, "a.log");
    writeFileSync(path, `one\r\ntwo\nthr\rthree\n${"y".repeat(400)}\n\n`);
    expect(logTail(path, 3)).toBe(`two\nthree\n${"y".repeat(299)}…`);
    expect(logTail(join(dir, "none.log"), 3)).toBe("");
  });

  test("an empty tail makes no block; a short run counts seconds", () => {
    const rec: ExecRecord = {
      id: "abcd1234",
      sessionId: SID,
      messageId: 1,
      shell: "bash",
      text: "make",
      cwd: "C:\\proj",
      state: "running",
      startedAt: NOW,
      reported: false,
    };
    expect(execCardText(rec, "", NOW + 42_000, en, platformFor("win32").shellNames)).toBe("▶ Git Bash · 42 s\n`make`");
    expect(execCardText(rec, "", NOW + 3 * MIN_MS + 12_000, en, platformFor("win32").shellNames)).toBe("▶ Git Bash · 3 min 12 s\n`make`");
    expect(execCardText(rec, "", NOW + 42_000, en, platformFor("linux").shellNames)).toBe("▶ bash · 42 s\n`make`");
  });
});
