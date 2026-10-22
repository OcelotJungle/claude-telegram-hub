import type { ExecDeps } from "../src/hub/exec.ts";
import type { ExecRecord } from "../src/hub/exec-store.ts";
import type { RunnerSpec } from "../src/hub/exec-runner.ts";
import type { Button } from "../src/hub/telegram.ts";
import type { ChannelMeta } from "../src/shared/protocol.ts";

import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { Execs, execCardText, HEARTBEAT_STALE_MS, logTail, MAX_EXECS } from "../src/hub/exec.ts";
import { loadExecs, saveExecs } from "../src/hub/exec-store.ts";
import { HEARTBEAT_MS, runnerSpecSchema } from "../src/hub/exec-runner.ts";
import { memLogger, must, tempDir, waitFor } from "./helpers.ts";

const SID = "s1";
const FIRST_PID = 1000;
const MIN_MS = 60_000;
const NOW = 1_800_000_000_000;
// A wait for what a check brings, a pause for what must not come, the fake
// manager's timer periods, a run of 1 min 05 s, a log longer than the agent's
// tail, a test file limit and a line well over it.
const WAIT_MS = 2000;
const SETTLE_MS = 100;
const CHECK_MS = 10;
const CARD_MS = 50;
const RUN_1_05_MS = 65_000;
const LOG_LINES = 40;
const FILE_LIMIT = 200;
const BIG_LINE_CHARS = 500;
const MS_PER_S = 1000;
const CHECKS_PER_STEP = 3;
// A start's grace no test outlasts, and one a test waits out.
const LONG_GRACE_MS = 60_000;
const SHORT_GRACE_MS = 100;
// Long enough for any heartbeat to go stale.
const LONG_AGO_MS = 10 * MIN_MS;

type CardCall = { sessionId: string; cardId: string; markdown: string; final: boolean; buttons?: Button[][] };
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
function setup(o: { dir?: string; sendOnSent?: boolean; fileLimit?: number; alive?: number[]; windows?: string[]; graceMs?: number } = {}) {
  const dir = o.dir ?? tempDir("tghub-exec-");
  if (o.dir === undefined) dirs.push(dir);
  const specs: RunnerSpec[] = [];
  const alive = new Set<number>(o.alive);
  const windows = new Set<string>(o.windows);
  const killed: number[] = [];
  const cards: CardCall[] = [];
  const notices: { text: string; loud: boolean }[] = [];
  const files: { path: string; name: string; loud: boolean }[] = [];
  const reports: ReportCall[] = [];
  const clock = { now: NOW };
  const log = memLogger();
  const deps: ExecDeps = {
    dir,
    file: join(dir, "execs.json"),
    shells: () => ({ powershell: "powershell.exe", bash: "bash.exe" }),
    env: () => ({ A: "1" }),
    spawnRunner: specFile => {
      specs.push(runnerSpecSchema.parse(JSON.parse(readFileSync(specFile, "utf8"))));
      const pid = FIRST_PID + specs.length;
      alive.add(pid);
      return pid;
    },
    alive: pid => alive.has(pid),
    kill: pid => void killed.push(pid),
    card: (sessionId, cardId, markdown, final, buttons) => void cards.push({ sessionId, cardId, markdown, final, buttons }),
    notice: (_sessionId, text, loud) => void notices.push({ text, loud }),
    sendFile: (_sessionId, path, name, loud) => void files.push({ path, name, loud }),
    report: (sessionId, content, meta, onSent) => {
      reports.push({ sessionId, content, meta, onSent });
      if (o.sendOnSent !== false) onSent();
    },
    now: () => clock.now,
    checkMs: CHECK_MS,
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
  return { dir, deps, execs, specs, alive, windows, killed, cards, notices, files, reports, clock, log, spec, lastCard, finish, beat };
}

// Moves the fake clock in steps short enough not to look like a sleep, a few
// checks apart.
async function walk(clock: { now: number }, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= HEARTBEAT_MS / 2) {
    clock.now += Math.min(left, HEARTBEAT_MS / 2);
    await Bun.sleep(CHECK_MS * CHECKS_PER_STEP);
  }
}

const CHAT = "-1001";
const msg = (messageId: number, ageMs = 0, chatId = CHAT) => ({ chatId, messageId, date: Math.floor((NOW - ageMs) / MS_PER_S) });
const idOf = (cardId: string) => cardId.replace(/^exec-/, "");

describe("Execs", () => {
  test("a command runs, edits its card and reports once", async () => {
    const t = setup();
    t.execs.command(SID, "cmd", "npm run x", "C:\\proj", msg(1));
    expect(t.specs).toHaveLength(1);
    expect(t.spec().cwd).toBe("C:\\proj");
    expect(t.spec().env.A).toBe("1");
    const first = t.lastCard();
    expect(first.markdown).toStartWith("▶ cmd");
    expect(first.markdown).toContain("`npm run x`");
    expect(first.buttons).toEqual([[{ text: "⏹ Остановить", data: `x:${idOf(first.cardId)}:stop` }]]);
    expect(t.execs.running()).toBe(1);
    appendFileSync(t.spec().log, "a\nb\n");
    await waitFor(() => t.cards.find(c => c.markdown.includes("b") && !c.final), WAIT_MS, "card with b");
    t.clock.now += RUN_1_05_MS;
    t.finish(0, 0);
    const last = await waitFor(() => t.cards.find(c => c.final), WAIT_MS, "final card");
    expect(last.markdown).toStartWith("✅ код 0 · 1 мин 05 с");
    expect(last.buttons).toBeUndefined();
    await Bun.sleep(SETTLE_MS);
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
    const report = await waitFor(() => t.reports[0], WAIT_MS, "report");
    expect(t.lastCard().markdown).toStartWith("❌ код 2");
    expect(t.files).toEqual([{ path: t.spec().log, name: `${report.meta.exec_id}.log`, loud: true }]);
    expect(report.content).toStartWith("Команда из топика закончилась: ❌ код 2 за 0 с.");
    expect(report.content).toContain("Оболочка: PowerShell, папка: C:\\proj");
    expect(report.content).toContain("Команда: npm run x");
    expect(report.content).toContain(`Полный лог: ${t.spec().log}`);
    expect(report.content).toContain("line 11\n");
    expect(report.content).toContain(`line ${LOG_LINES}`);
    expect(report.content).not.toContain("line 10\n");
    expect(report.meta.exit_code).toBe("2");
  });

  test("a log over the file limit goes as its last bytes, whole characters, with a note", async () => {
    const t = setup({ fileLimit: FILE_LIMIT });
    // One byte apart, so one of the two cuts falls inside a character.
    for (const [n, last] of ["конец\n", "конец!\n"].entries()) {
      t.execs.command(SID, "cmd", "x", "C:\\proj", msg(n + 1));
      appendFileSync(t.spec(n).log, `${"я".repeat(BIG_LINE_CHARS)}\n${last}`);
      t.finish(n, 1);
      const sent = await waitFor(() => t.files[n], WAIT_MS, "sent file");
      expect(sent.path).not.toBe(t.spec(n).log);
      expect(sent.name).toEndWith(".log");
      const bytes = readFileSync(sent.path);
      expect(bytes.length).toBeLessThanOrEqual(FILE_LIMIT);
      const text = bytes.toString("utf8");
      expect(text).toStartWith("[лог обрезан");
      expect(text).not.toContain("\uFFFD");
      expect(text).toEndWith(`я\n${last}`);
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
    expect(t.execs.press(id, "stop")).toBe("Останавливаю");
    t.finish(0, 0);
    await waitFor(() => t.cards.find(c => c.final), WAIT_MS, "final card");
    expect(t.lastCard().markdown).toStartWith("✅ код 0");
  });

  test("stop after the exit file is there kills nothing and shows the code", () => {
    const t = setup();
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    const id = idOf(t.lastCard().cardId);
    t.finish(0, 2);
    expect(t.execs.press(id, "stop")).toBe("Команда уже закончилась");
    expect(t.killed).toEqual([]);
    expect(t.lastCard().markdown).toStartWith("❌ код 2");
  });

  test("an old command waits for the button", () => {
    const t = setup();
    t.execs.command(SID, "cmd", "npm run migrate", "C:\\proj", msg(1, 3 * MIN_MS));
    expect(t.specs).toHaveLength(0);
    const card = t.lastCard();
    expect(card.markdown).toStartWith("⏸ Команда пришла 3 мин назад, пока хаб был выключен");
    const id = idOf(card.cardId);
    expect(card.buttons).toEqual([[{ text: "▶ Запустить", data: `x:${id}:run` }]]);
    expect(t.execs.press(id, "run")).toBe("Запускаю");
    expect(t.specs).toHaveLength(1);
    expect(t.lastCard().markdown).toStartWith("▶ cmd");
    expect(t.execs.press(id, "run")).toBe("Команда уже запущена");
    expect(t.specs).toHaveLength(1);
    expect(t.execs.press("nope", "run")).toBe("Запуск не найден");
  });

  test("stop kills the process and ends as stopped", async () => {
    const t = setup();
    t.execs.command(SID, "cmd", "ping", "C:\\proj", msg(1));
    const id = idOf(t.lastCard().cardId);
    expect(t.execs.press(id, "stop")).toBe("Останавливаю");
    expect(t.killed).toEqual([FIRST_PID + 1]);
    t.alive.clear();
    await waitFor(() => t.cards.find(c => c.final), WAIT_MS, "final card");
    expect(t.lastCard().markdown).toStartWith("⏹ остановлена");
    expect(t.execs.press(id, "stop")).toBe("Команда уже закончилась");
    expect(t.execs.press(id, "run")).toBe("Команда уже закончилась");
  });

  test("a vanished process ends as lost", async () => {
    const t = setup();
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    t.alive.clear();
    await waitFor(() => t.cards.find(c => c.final), WAIT_MS, "final card");
    expect(t.lastCard().markdown).toStartWith("⚠️ прервана: процесс исчез");
    const report = await waitFor(() => t.reports[0], WAIT_MS, "report");
    expect(report.content).toContain("⚠️ прервана: процесс исчез");
    expect(report.meta.exit_code).toBeUndefined();
  });

  test("a command that could not start ends as lost with the reason", async () => {
    const t = setup();
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    t.finish(0, null, "spawn ENOENT");
    await waitFor(() => t.cards.find(c => c.final), WAIT_MS, "final card");
    expect(t.lastCard().markdown).toStartWith("⚠️ прервана: не запустилось: spawn ENOENT");
  });

  test("a restarted manager goes on", async () => {
    const t = setup();
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    t.execs.stop();
    const t2 = setup({ dir: t.dir, alive: [FIRST_PID + 1] });
    t.finish(0, 0);
    await waitFor(() => t2.reports[0], WAIT_MS, "report");
    await Bun.sleep(SETTLE_MS);
    expect(t2.reports).toHaveLength(1);
    expect(t.reports).toHaveLength(0);
    expect(t2.lastCard().markdown).toStartWith("✅ код 0");
  });

  test("a launch gives the runner its heartbeat file", () => {
    const t = setup();
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    expect(existsSync(t.spec().alive)).toBe(true);
    expect(t.spec().heartbeatMs).toBeGreaterThan(0);
  });

  test("a run whose heartbeat stopped ends as lost, whoever has its pid now", async () => {
    const dir = tempDir("tghub-exec-");
    dirs.push(dir);
    const rec: ExecRecord = { id: "abcd1234", sessionId: SID, messageId: 1, shell: "cmd", text: "x", cwd: "C:\\proj", state: "running", startedAt: NOW - LONG_AGO_MS, pid: 4242, reported: false };
    saveExecs(join(dir, "execs.json"), [rec]);
    writeFileSync(join(dir, "abcd1234.alive"), "");
    utimesSync(join(dir, "abcd1234.alive"), (NOW - LONG_AGO_MS) / MS_PER_S, (NOW - LONG_AGO_MS) / MS_PER_S);
    const t = setup({ dir, alive: [4242] });
    await waitFor(() => t.cards.find(c => c.final), WAIT_MS, "final card");
    expect(t.lastCard().markdown).toStartWith("⚠️ прервана: процесс исчез");
    expect(t.execs.press("abcd1234", "stop")).toBe("Команда уже закончилась");
    expect(t.killed).toEqual([]);
  });

  test("stop on a run whose heartbeat went stale kills nothing and ends it as lost", () => {
    const t = setup();
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    const id = idOf(t.lastCard().cardId);
    t.beat(0, NOW - LONG_AGO_MS);
    expect(t.execs.press(id, "stop")).toBe("Команда уже закончилась");
    expect(t.killed).toEqual([]);
    expect(t.lastCard().markdown).toStartWith("⚠️ прервана: процесс исчез");
  });

  test("a run the hub slept through waits for its next heartbeat", async () => {
    const t = setup();
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    // The machine slept: the clock jumps, the heartbeat is old.
    t.clock.now += LONG_AGO_MS;
    await Bun.sleep(SETTLE_MS);
    expect(t.execs.running()).toBe(1);
    t.beat(0, t.clock.now);
    await walk(t.clock, HEARTBEAT_STALE_MS / 2);
    expect(t.execs.running()).toBe(1);
    // No beat for the whole grace: the runner is gone.
    await walk(t.clock, HEARTBEAT_STALE_MS);
    await waitFor(() => t.cards.find(c => c.final), WAIT_MS, "final card");
    expect(t.lastCard().markdown).toStartWith("⚠️ прервана: процесс исчез");
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
    await waitFor(() => t2.cards.filter(c => c.final).length === 2, WAIT_MS, "final cards");
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
    await waitFor(() => t2.reports[0], WAIT_MS, "report after the grace");
  });

  test("an unreported result goes again when the session connects", async () => {
    const t = setup({ sendOnSent: false });
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    t.finish(0, 0);
    await waitFor(() => t.reports[0], WAIT_MS, "report");
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
    const card = await waitFor(() => t.cards.find(c => c.markdown.includes("100%") && !c.final), WAIT_MS, "card");
    expect(card.markdown).toContain("\n````\n```js\nx\n100%\n````");
    expect(card.markdown).not.toContain("50%");
  });

  test("more than MAX_EXECS runs drop the oldest with their files", () => {
    const dir = tempDir("tghub-exec-");
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

describe("exec texts", () => {
  test("logTail keeps the last lines, after the last carriage return, cut long", () => {
    const dir = tempDir("tghub-exec-");
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
    expect(execCardText(rec, "", NOW + 42_000)).toBe("▶ Git Bash · 42 с\n`make`");
    expect(execCardText(rec, "", NOW + 3 * MIN_MS + 12_000)).toBe("▶ Git Bash · 3 мин 12 с\n`make`");
  });
});
