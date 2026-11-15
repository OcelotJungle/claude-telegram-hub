import type { ExecDeps } from "../src/hub/exec.ts";
import type { ExecRun } from "../src/hub/exec-runs.ts";
import type { Button } from "../src/hub/telegram.ts";
import type { ChannelMeta } from "../src/shared/protocol.ts";
import type { Messages } from "../src/shared/i18n/index.ts";
import type { MessageKind } from "../src/shared/notification.ts";

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { Execs, EXEC_CARD_LINES, EXEC_CHECK_MS, execCardText, execReportText, MAX_EXECS } from "../src/hub/exec.ts";
import { loadRuns, saveRuns } from "../src/hub/exec-runs.ts";
import { en } from "../src/shared/i18n/en.ts";
import { ru } from "../src/shared/i18n/ru.ts";
import { notifies } from "../src/shared/notification.ts";
import { platformFor } from "../src/shared/platform.ts";
import { FakeExec, RIG_PAGE_BYTES } from "./fake-exec.ts";
import { manualClock, turn } from "./manual-clock.ts";
import { memLogger, must, tempDir } from "./helpers.ts";

const SID = "s1";
const CHAT = "-1001";
const MIN_MS = 60_000;
const NOW = 1_800_000_000_000;
const MS_PER_S = 1000;
// A card pace shorter than rig's failure limit, and a cap on the checks a wait may run.
const CARD_MS = 5000;
const MAX_TICKS = 100;
const RUN_1_05_MS = 65_000;
const LOG_LINES = 40;
const BIG_LINE_CHARS = 500;
// One two-byte UTF-8 character (Cyrillic ya).
const YA = "\u044f";
// A start's grace no test outlasts, and one a test waits out.
const LONG_GRACE_MS = 60_000;
const SHORT_GRACE_MS = 100;
// Longer than the hub tolerates rig failing to answer (60 s), and shorter.
const FAILING_LONG_TICKS = 70;
const FAILING_SHORT_TICKS = 30;
// A log of a size that needs three of rig's status pages, and one above the hub's in-memory cap (1 MiB).
const THREE_PAGES_LINES = 20_000;
const OVER_MEMORY_CAP_CHARS = 1_200_000;
const YA_COUNT = 40_000;
const SMALL_PAGE_BYTES = 5;
// A page size that cuts a two-byte character in some pages and not in others.
const ODD_PAGE_BYTES = 4097;
// A file limit that a log of a few thousand bytes is over.
const SMALL_FILE_LIMIT = 1000;
const OVER_LIMIT_YA_COUNT = 2000;
const NAMES = platformFor("win32").shellNames;

type CardCall = { sessionId: string; cardId: string; markdown: string; final: boolean; kind: MessageKind; buttons?: Button[][] };
type ReportCall = { sessionId: string; content: string; meta: ChannelMeta; onSent: () => void };
type MachineCardCall = { id: string; text: string; final: boolean; kind: MessageKind; buttons?: Button[][] };

let dirs: string[] = [];
let managers: Execs[] = [];
let clocks: ReturnType<typeof manualClock>[] = [];

afterEach(() => {
  for (const m of managers) m.stop();
  managers = [];
  for (const c of clocks) c.dispose();
  clocks = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

// Fake deps over a FakeExec: rig's side is played by the test (it writes the run's log and ends it), the hub's
// side (cards, files, reports) is recorded. dir / fake: reuse those of an earlier setup, for a restarted hub.
// windows: sessions with a window; graceMs: the start's grace, none by default.
function setup(o: { messages?: () => Messages; dir?: string; fake?: FakeExec; sendOnSent?: boolean; windows?: string[]; graceMs?: number; fileLimit?: number; unavailable?: ExecDeps["unavailable"] } = {}) {
  const dir = o.dir ?? tempDir("telegramhub-exec-");
  if (o.dir === undefined) dirs.push(dir);
  const fake = o.fake ?? new FakeExec();
  const windows = new Set<string>(o.windows);
  const cards: CardCall[] = [];
  const files: { sessionId: string; name: string; text: string; kind: MessageKind }[] = [];
  const reports: ReportCall[] = [];
  const machineCards: MachineCardCall[] = [];
  const machineFiles: { id: string; name: string; text: string; kind: MessageKind }[] = [];
  const spawned: Promise<unknown>[] = [];
  const manual = manualClock();
  clocks.push(manual);
  const clock = { get now() { return NOW + manual.now(); }, advance: (ms: number) => manual.advance(ms) };
  // rig stamps ends with the clock of the test.
  fake.now = () => new Date(clock.now).toISOString();
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
  // Lets what is in flight (a start, a read) finish, without moving the clock.
  const settle = () => manual.advance(0);
  const log = memLogger();
  const deps: ExecDeps = {
    messages: o.messages ?? (() => en),
    file: join(dir, "exec-runs.json"),
    rig: fake,
    shellNames: NAMES,
    card: (sessionId, cardId, markdown, final, kind, buttons) => void cards.push({ sessionId, cardId, markdown, final, kind, buttons }),
    // The hub deletes the file when the call returns: its text is read now.
    sendFile: (sessionId, path, name, kind) => void files.push({ sessionId, name, text: readFileSync(path, "utf8"), kind }),
    report: (sessionId, content, meta, onSent) => {
      reports.push({ sessionId, content, meta, onSent });
      if (o.sendOnSent !== false) onSent();
    },
    spawn: work => void spawned.push(work),
    machineCard: (run, text, final, kind, buttons) => void machineCards.push({ id: run.id, text, final, kind, buttons }),
    machineFile: (run, path, name, kind) => void machineFiles.push({ id: run.id, name, text: readFileSync(path, "utf8"), kind }),
    timers: { ...manual, now: () => clock.now },
    checkMs: EXEC_CHECK_MS,
    cardMs: CARD_MS,
    maxAgeMs: 2 * MIN_MS,
    hasWindow: sid => windows.has(sid),
    graceMs: o.graceMs,
    ...(o.fileLimit !== undefined ? { fileLimit: o.fileLimit } : {}),
    log,
    unavailable: o.unavailable,
  };
  const execs = new Execs(deps);
  managers.push(execs);
  execs.start();
  const lastCard = () => must(cards.at(-1), "card");
  const lastMachineCard = () => must(machineCards.at(-1), "machine card");
  return { dir, deps, execs, fake, windows, cards, files, reports, machineCards, machineFiles, spawned, clock, log, lastCard, lastMachineCard, until, tick, settle };
}

const msg = (messageId: number, ageMs = 0, chatId = CHAT) => ({ chatId, messageId, date: Math.floor((NOW - ageMs) / MS_PER_S) });
const idOf = (cardId: string) => cardId.replace(/^exec-/, "");
const rigError = (code: string, message: string) => ({ kind: "rig" as const, code, message });

// A shell command that has been started and read once: its card, the hub's id and rig's run id.
async function started(t: ReturnType<typeof setup>, text = "npm run x", shell: "cmd" | "pwsh" | "bash" = "cmd", messageId = 1) {
  t.execs.command(SID, shell, text, "C:\\proj", msg(messageId));
  await t.settle();
  return { id: idOf(t.lastCard().cardId), runId: t.fake.last() };
}

describe("a shell command", () => {
  test("is started through rig with its text and folder, and shows a running card with a Stop button", async () => {
    const t = setup();
    t.execs.command(SID, "cmd", "npm run x", "C:\\proj", msg(1));
    await t.settle();
    expect(t.fake.starts).toEqual([{ shell: "cmd", cwd: "C:\\proj", text: "npm run x" }]);
    const first = t.lastCard();
    expect(first.markdown).toStartWith("▶ cmd");
    expect(first.markdown).toContain("`npm run x`");
    expect(first.kind).toBe("info");
    expect(first.buttons).toEqual([[{ text: en.execStopButton, data: `x:${idOf(first.cardId)}:stop` }]]);
    expect(t.execs.running()).toBe(1);
  });

  test("counts as running and starting while rig has not answered, and starts once", async () => {
    const t = setup();
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const start = t.fake.start.bind(t.fake);
    t.fake.start = async (...args) => { await gate; return start(...args); };
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    expect(t.execs.running()).toBe(1);
    expect(t.execs.starting()).toBe(1);
    // The hub sees the start as work in flight.
    let done = false;
    void must(t.spawned[0], "spawned start").then(() => { done = true; });
    await turn();
    expect(done).toBe(false);
    release();
    await t.settle();
    expect(done).toBe(true);
    expect(t.fake.starts).toHaveLength(1);
    expect(t.execs.running()).toBe(1);
    expect(t.execs.starting()).toBe(0);
  });

  test("runs, shows its output, ends and is reported once", async () => {
    const t = setup();
    const { id, runId } = await started(t);
    t.fake.write(runId, "a\nb\n");
    await t.until(() => t.cards.find(c => c.markdown.includes("b") && !c.final), "card with b");
    // Exactly 1 min 05 s after the start, whatever the checks have advanced.
    await t.clock.advance(NOW + RUN_1_05_MS - t.clock.now);
    t.fake.finish(runId, { kind: "exit", code: 0 });
    const last = await t.until(() => t.cards.find(c => c.final), "final card");
    expect(last.markdown).toStartWith(`${en.execOutcomeOk} · 1 min 05 s`);
    expect(last.kind).toBe("info");
    expect(last.buttons).toBeUndefined();
    await t.tick();
    expect(t.reports).toHaveLength(1);
    expect(t.reports[0]?.meta.source).toBe("exec");
    expect(t.reports[0]?.meta.exit_code).toBe("0");
    expect(t.reports[0]?.meta.exec_id).toBe(id);
    expect(t.files).toHaveLength(0);
    expect(t.execs.running()).toBe(0);
  });

  test("that fails reports its code loudly, with the log as a file and the way to the whole log", async () => {
    const t = setup();
    const { id, runId } = await started(t, "npm run x", "pwsh");
    t.fake.write(runId, Array.from({ length: LOG_LINES }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
    t.fake.finish(runId, { kind: "exit", code: 2 });
    const report = await t.until(() => t.reports[0], "report");
    expect(t.lastCard().markdown).toStartWith(en.execOutcomeCode({ code: 2 }));
    expect(t.lastCard().kind).toBe("error");
    expect(t.files).toHaveLength(1);
    expect(t.files[0]?.name).toBe(`${id}.log`);
    expect(notifies(must(t.files[0]).kind)).toBe(true);
    expect(t.files[0]?.text).toStartWith("line 1\n");
    expect(t.files[0]?.text).toEndWith(`line ${LOG_LINES}\n`);
    expect(report.content).toStartWith(`The topic command has ended: ${en.execOutcomeCode({ code: 2 })} in 0 s.`);
    expect(report.content).toContain(`Shell: ${NAMES.pwsh}, folder: C:\\proj`);
    expect(report.content).toContain("Command: npm run x");
    expect(report.content).toContain(`Full log: rig exec status ${runId} --from 0`);
    expect(report.content).toContain("line 11\n");
    expect(report.content).toContain(`line ${LOG_LINES}`);
    expect(report.content).not.toContain("line 10\n");
    expect(report.meta.exit_code).toBe("2");
  });

  test("reads a log that rig gives page by page, a character cut by a page waits for the next one", async () => {
    const t = setup();
    t.fake.page = SMALL_PAGE_BYTES;
    const { runId } = await started(t);
    const line = YA.repeat(10);
    t.fake.write(runId, `${line}\nend\n`);
    t.fake.finish(runId, { kind: "exit", code: 0 });
    const report = await t.until(() => t.reports[0], "report");
    expect(report.content).toContain(`\n${line}\nend`);
    expect(report.content).not.toContain("\uFFFD");
    const froms = t.fake.statuses.map(s => s.from);
    expect(froms[0]).toBe(0);
    expect(froms.slice(1).every((from, i) => from > must(froms[i]))).toBe(true);
  });

  test("reads a log over one rig page in one check, the whole of it, with no character cut", async () => {
    const t = setup();
    const { id, runId } = await started(t);
    // The first byte shifts every character, so rig's page boundary falls inside one.
    const big = `x${YA.repeat(YA_COUNT)}\nend\n`;
    expect(Buffer.byteLength(big)).toBeGreaterThan(RIG_PAGE_BYTES);
    t.fake.write(runId, big);
    t.fake.finish(runId, { kind: "exit", code: 0 });
    await t.tick();
    // The check reads the log in two pages; the file is then made from rig again, from the start.
    await t.until(() => t.files[0], "the log file");
    expect(t.fake.statuses.map(s => s.from)).toEqual([0, RIG_PAGE_BYTES - 1, 0, RIG_PAGE_BYTES - 1]);
    expect(t.cards.some(c => c.final)).toBe(true);
    expect(t.files).toHaveLength(1);
    expect(t.files[0]?.name).toBe(`${id}.log`);
    expect(t.files[0]?.text).toBe(big);
  });

  test("sends the whole of a log over what it holds in memory: the file is made from rig, not from the hub's tail", async () => {
    const t = setup();
    const { runId } = await started(t);
    const whole = `first line\n${"a".repeat(OVER_MEMORY_CAP_CHARS)}\nlast line\n`;
    t.fake.write(runId, whole);
    t.fake.finish(runId, { kind: "exit", code: 0 });
    await t.until(() => t.files[0], "the log file");
    expect(t.files[0]?.text).toBe(whole);
  });

  test("the same message never runs twice", async () => {
    const t = setup();
    t.execs.command(SID, "cmd", "echo", "C:\\proj", msg(7));
    t.execs.command(SID, "cmd", "echo", "C:\\proj", msg(7));
    await t.settle();
    expect(t.fake.starts).toHaveLength(1);
    expect(t.log.lines.some(l => l.includes("message 7") && l.includes("already"))).toBe(true);
  });

  test("the same message id in another chat is another command", async () => {
    const t = setup();
    t.execs.command(SID, "cmd", "echo", "C:\\proj", msg(7));
    t.execs.command(SID, "cmd", "echo", "C:\\proj", msg(7, 0, "-1002"));
    await t.settle();
    expect(t.fake.starts).toHaveLength(2);
  });

  test("a card survives backticks and carriage returns", async () => {
    const t = setup();
    const { runId } = await started(t, "x");
    t.fake.write(runId, "```js\nx\n10%\r50%\r100%\r\n");
    const card = await t.until(() => t.cards.find(c => c.markdown.includes("100%") && !c.final), "card");
    expect(card.markdown).toContain("\n````\n```js\nx\n100%\n````");
    expect(card.markdown).not.toContain("50%");
  });
});

describe("a shell command that does not start", () => {
  test("shows rig's message as it is, ends as failed (not lost) and reaches the agent", async () => {
    const t = setup();
    t.fake.startError = rigError("exec-unavailable", "The pwsh feature is off; run: rig feature pwsh enable");
    t.execs.command(SID, "pwsh", "ls", "C:\\proj", msg(1));
    await t.settle();
    const card = t.lastCard();
    expect(card.final).toBe(true);
    expect(card.kind).toBe("warning");
    expect(card.buttons).toBeUndefined();
    expect(card.markdown).toStartWith(en.execOutcomeFailed({ error: "The pwsh feature is off; run: rig feature pwsh enable" }));
    expect(t.execs.running()).toBe(0);
    expect(t.reports).toHaveLength(1);
    expect(t.reports[0]?.content).toContain("The pwsh feature is off");
    expect(t.reports[0]?.meta.exit_code).toBeUndefined();
    // No run exists in rig: nothing is polled.
    await t.tick();
    expect(t.fake.statuses).toEqual([]);
  });

  test("is worded in the language current when the failure is shown", async () => {
    let current: Messages = en;
    const t = setup({ messages: () => current });
    t.fake.startError = rigError("exec-launch", "cannot launch");
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    current = ru;
    await t.settle();
    expect(t.lastCard().markdown).toStartWith(ru.execOutcomeFailed({ error: "cannot launch" }));
    expect(t.lastCard().markdown).not.toContain("did not start");
  });

  test("a folder name a Windows command line cannot carry is told in words", async () => {
    const t = setup();
    t.fake.start = async () => ({ ok: false, error: { kind: "cwdUnsafe" } });
    t.execs.command(SID, "cmd", "x", "C:\\100%", msg(1));
    await t.settle();
    expect(t.lastCard().markdown).toStartWith(en.execOutcomeFailed({ error: en.execCwdUnsafe }));
  });

  test("a rig that is not there is told in words", async () => {
    const t = setup();
    t.fake.startError = { kind: "missing" };
    t.execs.command(SID, "bash", "x", "/proj", msg(1));
    await t.settle();
    expect(t.lastCard().markdown).toContain(en.rigMissing);
  });
});

describe("the Stop and Run buttons", () => {
  test("stop asks rig to stop the run; the run ends as stopped when rig says so", async () => {
    const t = setup();
    const { id, runId } = await started(t, "ping");
    expect(await t.execs.press(id, "stop")).toBe(en.execStopping);
    expect(t.fake.stops).toEqual([runId]);
    t.fake.finish(runId, { kind: "stopped" });
    await t.until(() => t.cards.find(c => c.final), "final card");
    expect(t.lastCard().markdown).toStartWith(en.execOutcomeStopped);
    expect(t.lastCard().kind).toBe("info");
    expect((await t.until(() => t.reports[0], "report")).meta.exit_code).toBeUndefined();
    // An ended run asks rig nothing.
    expect(await t.execs.press(id, "stop")).toBe(en.execAlreadyEnded);
    expect(await t.execs.press(id, "run")).toBe(en.execAlreadyEnded);
    expect(t.fake.stops).toHaveLength(1);
  });

  test("a command that ends on its own after stop was pressed keeps its code", async () => {
    const t = setup();
    const { id, runId } = await started(t, "x");
    expect(await t.execs.press(id, "stop")).toBe(en.execStopping);
    t.fake.finish(runId, { kind: "exit", code: 0 });
    await t.until(() => t.cards.find(c => c.final), "final card");
    expect(t.lastCard().markdown).toStartWith(en.execOutcomeOk);
  });

  test("stop of a run rig already ended says so and leaves the card to the next check", async () => {
    const t = setup();
    const { id, runId } = await started(t, "x");
    t.fake.finish(runId, { kind: "exit", code: 2 });
    expect(await t.execs.press(id, "stop")).toBe(en.execAlreadyEnded);
    await t.until(() => t.cards.find(c => c.final), "final card");
    expect(t.lastCard().markdown).toStartWith(en.execOutcomeCode({ code: 2 }));
  });

  test("stop that rig refuses shows rig's message as it is", async () => {
    const t = setup();
    const { id } = await started(t, "x");
    t.fake.stopError = rigError("exec-io", "cannot stop the process");
    expect(await t.execs.press(id, "stop")).toBe("cannot stop the process");
  });

  test("stop of an unknown card, and of a command still waiting for its button", async () => {
    const t = setup();
    expect(await t.execs.press("nope", "stop")).toBe(en.execNotFound);
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1, 3 * MIN_MS));
    expect(await t.execs.press(idOf(t.lastCard().cardId), "stop")).toBe(en.execNotStarted);
    expect(t.fake.stops).toEqual([]);
  });

  test("an old command waits for the button, which starts it once", async () => {
    const t = setup();
    t.execs.command(SID, "cmd", "npm run migrate", "C:\\proj", msg(1, 3 * MIN_MS));
    await t.settle();
    expect(t.fake.starts).toHaveLength(0);
    const card = t.lastCard();
    expect(card.markdown).toStartWith(en.execPending({ minutes: 3 }));
    const id = idOf(card.cardId);
    expect(card.buttons).toEqual([[{ text: en.execRunButton, data: `x:${id}:run` }]]);
    expect(await t.execs.press(id, "run")).toBe(en.execStarting);
    await t.settle();
    expect(t.fake.starts).toEqual([{ shell: "cmd", cwd: "C:\\proj", text: "npm run migrate" }]);
    expect(t.lastCard().markdown).toStartWith("▶ cmd");
    expect(await t.execs.press(id, "run")).toBe(en.execAlreadyRunning);
    expect(await t.execs.press("nope", "run")).toBe(en.execNotFound);
    expect(t.fake.starts).toHaveLength(1);
  });

  test("a second press of Run while the start is in flight does not start twice", async () => {
    const t = setup();
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const start = t.fake.start.bind(t.fake);
    t.fake.start = async (...args) => { await gate; return start(...args); };
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1, 3 * MIN_MS));
    const id = idOf(t.lastCard().cardId);
    expect(await t.execs.press(id, "run")).toBe(en.execStarting);
    expect(await t.execs.press(id, "run")).toBe(en.execStarting);
    release();
    await t.settle();
    expect(t.fake.starts).toHaveLength(1);
  });

  test("Run asks again whether the shell may start: its feature could have been switched off", async () => {
    let why: string | undefined;
    const t = setup({ unavailable: () => why });
    t.execs.command(SID, "pwsh", "x", "C:\\proj", msg(1, 3 * MIN_MS));
    const id = idOf(t.lastCard().cardId);
    why = "The pwsh feature is off";
    expect(await t.execs.press(id, "run")).toBe("The pwsh feature is off");
    await t.settle();
    expect(t.fake.starts).toEqual([]);
    why = undefined;
    expect(await t.execs.press(id, "run")).toBe(en.execStarting);
    await t.settle();
    expect(t.fake.starts).toHaveLength(1);
  });

  test("a failed start of a stale command ends it; a button of the old store finds nothing", async () => {
    const t = setup();
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1, 3 * MIN_MS));
    const id = idOf(t.lastCard().cardId);
    t.fake.startError = rigError("exec-launch", "cannot launch");
    await t.execs.press(id, "run");
    await t.settle();
    expect(t.lastCard().final).toBe(true);
    expect(await t.execs.press(id, "run")).toBe(en.execAlreadyEnded);
    expect(await t.execs.press("0badc0de", "stop")).toBe(en.execNotFound);
  });
});

describe("a run that rig loses or that cannot be read", () => {
  test("a run rig does not know ends as lost", async () => {
    const t = setup();
    const { runId } = await started(t);
    t.fake.runs.delete(runId);
    await t.until(() => t.cards.find(c => c.final), "final card");
    expect(t.lastCard().markdown).toStartWith(en.execOutcomeLost({ reason: en.execLostProcessGone }));
    expect(t.lastCard().kind).toBe("warning");
    const report = await t.until(() => t.reports[0], "report");
    expect(report.content).toContain(en.execOutcomeLost({ reason: en.execLostProcessGone }));
    expect(report.meta.exit_code).toBeUndefined();
  });

  test("an end rig calls lost, or an exit without a code, ends as lost; rig's own reason is shown as it is", async () => {
    const t = setup();
    const a = await started(t, "a", "cmd", 1);
    const b = await started(t, "b", "cmd", 2);
    const c = await started(t, "c", "cmd", 3);
    t.fake.finish(a.runId, { kind: "lost" });
    t.fake.finish(b.runId, { kind: "exit", code: null });
    t.fake.finish(c.runId, { kind: "lost", reason: "the supervisor died" });
    await t.until(() => t.cards.filter(x => x.final).length === 3, "three final cards");
    const finals = t.cards.filter(x => x.final).map(x => x.markdown.split("\n")[0]);
    const gone = en.execOutcomeLost({ reason: en.execLostProcessGone });
    expect(finals.filter(l => l?.startsWith(gone))).toHaveLength(2);
    expect(finals.some(l => l?.startsWith(en.execOutcomeLost({ reason: "the supervisor died" })))).toBe(true);
  });

  test("rig that cannot be asked for a while is waited for; the run goes on when it answers again", async () => {
    const t = setup();
    const { runId } = await started(t);
    t.fake.statusDown = { kind: "timeout", seconds: 30 };
    for (let i = 0; i < FAILING_SHORT_TICKS; i++) await t.tick();
    expect(t.execs.running()).toBe(1);
    expect(t.cards.some(c => c.final)).toBe(false);
    t.fake.statusDown = undefined;
    t.fake.write(runId, "back\n");
    await t.until(() => t.cards.find(c => c.markdown.includes("back")), "card with the output");
    expect(t.log.lines.filter(l => l.includes("reading the run failed"))).toHaveLength(1);
  });

  test("rig that stays unreachable never ends the run: the card says rig is silent, and only rig's own end ends it", async () => {
    const t = setup();
    const { runId } = await started(t);
    t.fake.statusDown = { kind: "timeout", seconds: 30 };
    for (let i = 0; i < FAILING_LONG_TICKS; i++) await t.tick();
    expect(t.execs.running()).toBe(1);
    expect(t.cards.some(c => c.final)).toBe(false);
    expect(t.lastCard().markdown).toContain(en.execRigSilent({ reason: en.rigTimeout({ seconds: 30 }) }));
    // rig answers again and reports its own end: the note goes, the run ends as rig says.
    t.fake.statusDown = undefined;
    t.fake.finish(runId, { kind: "lost", reason: "the supervisor died" });
    await t.until(() => t.cards.find(c => c.final), "final card");
    const final = must(t.cards.find(c => c.final), "final card");
    expect(final.markdown).toStartWith(en.execOutcomeLost({ reason: "the supervisor died" }));
    expect(final.markdown).not.toContain(en.execRigSilent({ reason: en.rigTimeout({ seconds: 30 }) }));
    expect(t.execs.running()).toBe(0);
  });
});

describe("a restarted hub", () => {
  test("goes on polling a running run by its id, a little before where it stopped, and reports once", async () => {
    const t = setup();
    const { runId } = await started(t);
    const lines = Array.from({ length: THREE_PAGES_LINES }, (_, i) => `line ${i}`).join("\n") + "\n";
    t.fake.write(runId, lines);
    await t.tick();
    const size = Buffer.byteLength(lines);
    expect(t.fake.statuses.at(-1)?.from).toBeLessThan(size);
    expect(loadRuns(join(t.dir, "exec-runs.json"))[0]?.offset).toBe(size);
    t.execs.stop();
    const before = t.fake.statuses.length;
    const t2 = setup({ dir: t.dir, fake: t.fake });
    // At once: the first read is from a page before the end of what was read.
    expect(t2.fake.statuses[before]).toEqual({ id: runId, from: size - RIG_PAGE_BYTES });
    t.fake.write(runId, "after\n");
    t.fake.finish(runId, { kind: "exit", code: 0 });
    const report = await t2.until(() => t2.reports[0], "report");
    await t2.tick();
    expect(t2.reports).toHaveLength(1);
    expect(t.reports).toHaveLength(0);
    expect(t2.lastCard().markdown).toStartWith(en.execOutcomeOk);
    expect(t2.lastCard().markdown).toContain("after");
    expect(report.content).toContain("after");
    expect(report.content).not.toContain("line 0\n");
  });

  test("a stopped hub's manager polls nothing more", async () => {
    const t = setup();
    await started(t);
    t.execs.stop();
    const before = t.fake.statuses.length;
    await t.tick();
    await t.tick();
    expect(t.fake.statuses).toHaveLength(before);
  });

  test("a run that ended while no hub watched waits for its window, then for the sweep", async () => {
    const t = setup();
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    t.execs.command("s2", "cmd", "y", "C:\\proj", msg(2));
    await t.settle();
    t.execs.stop();
    t.fake.finish("r1", { kind: "exit", code: 0 });
    t.fake.finish("r2", { kind: "exit", code: 0 });
    const t2 = setup({ dir: t.dir, fake: t.fake, graceMs: LONG_GRACE_MS });
    await t2.settle();
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
    await t.settle();
    t.execs.stop();
    const t2 = setup({ dir: t.dir, fake: t.fake, windows: ["s2"], graceMs: LONG_GRACE_MS });
    await t2.settle();
    t.fake.finish("r1", { kind: "exit", code: 0 });
    t.fake.finish("r2", { kind: "exit", code: 0 });
    await t2.until(() => t2.cards.filter(c => c.final).length === 2, "final cards");
    expect(t2.reports.map(r => r.sessionId)).toEqual(["s2"]);
    t2.windows.add(SID);
    t2.execs.connected(SID);
    expect(t2.reports.map(r => r.sessionId)).toEqual(["s2", SID]);
  });

  test("the grace ends with a sweep of its own", async () => {
    const t = setup();
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    await t.settle();
    t.execs.stop();
    t.fake.finish("r1", { kind: "exit", code: 0 });
    const t2 = setup({ dir: t.dir, fake: t.fake, graceMs: SHORT_GRACE_MS });
    await t2.settle();
    expect(t2.reports).toHaveLength(0);
    await t2.until(() => t2.reports[0], "report after the grace");
  });

  test("an unreported result goes again when the session connects", async () => {
    const t = setup({ sendOnSent: false });
    const { runId } = await started(t, "x");
    t.fake.finish(runId, { kind: "exit", code: 0 });
    await t.until(() => t.reports[0], "report");
    t.execs.connected("other");
    expect(t.reports).toHaveLength(1);
    t.execs.connected(SID);
    expect(t.reports).toHaveLength(2);
    t.reports[1]?.onSent();
    t.execs.connected(SID);
    expect(t.reports).toHaveLength(2);
  });
});

describe("the run store", () => {
  const ended = (i: number): ExecRun => ({
    id: `0000${String(i).padStart(4, "0")}`,
    sessionId: SID,
    messageId: i + 1,
    shell: "cmd",
    text: "x",
    cwd: "C:\\proj",
    state: "ended",
    startedAt: NOW,
    offset: 0,
    end: { kind: "exit", code: 0, at: NOW },
    reported: true,
  });

  test("more than MAX_EXECS runs drop the oldest ended ones; the hub keeps nothing else on disk", async () => {
    const dir = tempDir("telegramhub-exec-");
    dirs.push(dir);
    saveRuns(join(dir, "exec-runs.json"), Array.from({ length: MAX_EXECS }, (_, i) => ended(i)));
    const t = setup({ dir });
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1000));
    await t.settle();
    const runs = loadRuns(join(dir, "exec-runs.json"));
    expect(runs).toHaveLength(MAX_EXECS);
    expect(runs.find(r => r.id === "00000000")).toBeUndefined();
    expect(runs.find(r => r.id === "00000001")).toBeDefined();
    expect(runs.at(-1)?.runId).toBe("r1");
    expect(readdirSync(dir)).toEqual(["exec-runs.json"]);
  });

  test("a store the hub cannot read is set aside and the hub starts with none", async () => {
    const dir = tempDir("telegramhub-exec-");
    dirs.push(dir);
    writeFileSync(join(dir, "exec-runs.json"), "{ not json");
    const t = setup({ dir });
    expect(t.execs.running()).toBe(0);
    expect(readdirSync(dir).filter(f => f.startsWith("exec-runs.json.corrupt-"))).toHaveLength(1);
  });

  test("the files of the old runner are never read: a button of an old card finds nothing", async () => {
    const dir = tempDir("telegramhub-exec-");
    dirs.push(dir);
    writeFileSync(join(dir, "execs.json"), JSON.stringify([{ id: "abcd1234", sessionId: SID, messageId: 1, shell: "cmd", text: "x", cwd: "C:\\proj", state: "running", pid: 4242, reported: false }]));
    const t = setup({ dir });
    expect(t.execs.running()).toBe(0);
    expect(await t.execs.press("abcd1234", "stop")).toBe(en.execNotFound);
    await t.tick();
    expect(t.fake.statuses).toEqual([]);
    expect(t.fake.stops).toEqual([]);
  });

  test("a saved run keeps what the next hub needs", async () => {
    const t = setup();
    const { id, runId } = await started(t, "make", "bash");
    t.fake.write(runId, "abc\n");
    await t.tick();
    const [run] = loadRuns(join(t.dir, "exec-runs.json"));
    expect(run).toMatchObject({ id, runId, shell: "bash", text: "make", cwd: "C:\\proj", state: "running", sessionId: SID, chatId: CHAT, messageId: 1, offset: 4, reported: false });
  });
});

describe("rig run cards", () => {
  const ARGS = ["update"];
  const startRig = async () => {
    const t = setup();
    t.execs.machine(ARGS, "rig update", { chatId: CHAT }, 1);
    await t.settle();
    return { t, runId: t.fake.last() };
  };

  test("a rig command is started through rig exec with its arguments and no agent is told", async () => {
    const { t, runId } = await startRig();
    expect(t.fake.rigStarts).toEqual([ARGS]);
    expect(t.cards).toEqual([]);
    expect(t.lastMachineCard().text).toStartWith("▶ rig");
    expect(t.lastMachineCard().text).toContain("`rig update`");
    t.fake.finish(runId, { kind: "exit", code: 0 }, { mode: "server", outcome: "complete" });
    await t.until(() => t.machineCards.find(c => c.final), "final card");
    await t.tick();
    expect(t.reports).toEqual([]);
  });

  test("the same message never runs twice", async () => {
    const { t } = await startRig();
    t.execs.machine(ARGS, "rig update", { chatId: CHAT }, 1);
    await t.settle();
    expect(t.fake.rigStarts).toHaveLength(1);
    t.execs.machine(ARGS, "rig update", { chatId: "-1002" }, 1);
    await t.settle();
    expect(t.fake.rigStarts).toHaveLength(2);
  });

  test("a command that is too old waits for its button, which starts it", async () => {
    const t = setup();
    t.execs.machine(["feature", "pwsh", "enable"], "rig feature pwsh enable", { chatId: CHAT }, 1, NOW - 3 * MIN_MS);
    await t.settle();
    expect(t.fake.rigStarts).toEqual([]);
    const card = t.lastMachineCard();
    expect(card.text).toStartWith(en.execPending({ minutes: 3 }));
    expect(card.buttons).toEqual([[{ text: en.execRunButton, data: `x:${card.id}:run` }]]);
    expect(await t.execs.press(card.id, "run")).toBe(en.execStarting);
    await t.settle();
    expect(t.fake.rigStarts).toEqual([["feature", "pwsh", "enable"]]);
  });

  test("a rig that cannot start the command shows its message as the card", async () => {
    const t = setup();
    t.fake.startError = rigError("exec-launch", "cannot launch rig");
    t.execs.machine(ARGS, "rig update", { chatId: CHAT }, 1);
    await t.settle();
    expect(t.lastMachineCard().final).toBe(true);
    expect(t.lastMachineCard().kind).toBe("warning");
    expect(t.lastMachineCard().text).toContain("cannot launch rig");
    expect(t.execs.running()).toBe(0);
  });

  test("new output redraws the card at once, without waiting for the card pace", async () => {
    const { t, runId } = await startRig();
    expect(t.machineCards).toHaveLength(1);
    t.fake.write(runId, "waiting for the lock\n");
    const card = await t.until(() => t.machineCards.find(c => c.text.includes("waiting for the lock")), "card with the lock line");
    expect(card.final).toBe(false);
    expect(t.machineCards).toHaveLength(2);
  });

  test("unchanged output is not redrawn between card paces, only when the pace passes", async () => {
    const { t } = await startRig();
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
    const { t, runId } = await startRig();
    t.fake.finish(runId, { kind: "exit", code: 0 });
    await t.until(() => t.machineCards.find(c => c.final), "final card");
    await t.tick();
    expect(t.machineCards.filter(c => c.final)).toHaveLength(1);
  });

  // What rig keeps in the run's log: its progress on stderr, as JSON lines. Its answer is the run's `result`.
  const progress = (code: string, data?: unknown) => JSON.stringify({ progress: { code, ...(data === undefined ? {} : { data }) } });
  // The card's tail: the lines between its two fences.
  const tailOf = (text: string) => {
    const lines = text.split("\n");
    return lines.slice(lines.indexOf("```") + 1, lines.lastIndexOf("```"));
  };

  test("progress and the result are shown in words, never as JSON", async () => {
    const { t, runId } = await startRig();
    t.fake.write(runId, `${progress("lock-waiting")}\n${progress("update-step-output", { line: "fetching" })}\n`);
    const waiting = await t.until(() => t.machineCards.find(c => c.text.includes("fetching")), "card with the step line");
    expect(waiting.text).toContain(en.rigProgressLockWaiting);
    expect(waiting.text).not.toContain("{");
    t.fake.finish(runId, { kind: "exit", code: 0 }, { mode: "server", outcome: "complete" });
    const done = await t.until(() => t.machineCards.find(c => c.final), "final card");
    expect(done.text).toContain(en.rigUpdateComplete({ pending: false }));
    expect(done.text).not.toContain("{");
    expect(done.text).not.toContain("outcome");
    expect(done.kind).toBe("info");
  });

  test("the result is the last line of the card even when progress is written after it", async () => {
    const { t, runId } = await startRig();
    t.fake.write(runId, `${progress("update-step-output", { line: "late step" })}\n`);
    t.fake.finish(runId, { kind: "exit", code: 0 }, { feature: "pwsh", enabled: true });
    const done = await t.until(() => t.machineCards.find(c => c.final), "final card");
    expect(tailOf(done.text)).toEqual(["late step", en.rigFeatureEnabled({ name: "pwsh" })]);
  });

  test("a run that ended with no result says so, with rig's reason", async () => {
    const { t, runId } = await startRig();
    t.fake.write(runId, `${progress("update-step-output", { line: "step" })}\n`);
    t.fake.finish(runId, { kind: "exit", code: 1, reason: "empty-result" });
    const empty = await t.until(() => t.machineCards.find(c => c.final), "final card");
    expect(tailOf(empty.text)).toEqual(["step", en.execRigNoResult({ reason: "empty-result" })]);
    expect(empty.text).toContain(en.execOutcomeCode({ code: 1 }));
    expect(empty.kind).toBe("error");
    const second = await startRig();
    second.t.fake.finish(second.runId, { kind: "exit", code: 0, reason: "invalid-result" });
    const invalid = await second.t.until(() => second.t.machineCards.find(c => c.final), "final card");
    expect(tailOf(invalid.text)).toEqual([en.execRigNoResult({ reason: "invalid-result" })]);
  });

  test("a progress line still being written is not shown cut; it shows once whole", async () => {
    const { t, runId } = await startRig();
    const whole = progress("update-step-output", { line: "first" });
    const half = progress("update-step-output", { line: "second" });
    // The half line has no newline yet, in the same write as a whole line: the card with the whole line proves the read saw it.
    t.fake.write(runId, `${whole}\n${half.slice(0, half.length - 5)}`);
    const first = await t.until(() => t.machineCards.find(c => c.text.includes("first")), "card with the whole line");
    expect(first.text).not.toContain("{");
    expect(first.text).not.toContain("progress");
    expect(first.text).not.toContain("second");
    t.fake.write(runId, `${half.slice(half.length - 5)}\n`);
    const second = await t.until(() => t.machineCards.find(c => c.text.includes("second")), "card with the second line");
    expect(tailOf(second.text)).toEqual(["first", "second"]);
  });

  test("a multi-line error shows its last lines on the card and all of them in the sent file", async () => {
    const { t, runId } = await startRig();
    const message = Array.from({ length: LOG_LINES }, (_, i) => `detail ${i}`).join("\n") + "\nthe real cause";
    t.fake.finish(runId, { kind: "exit", code: 1 }, { error: { code: "update-failed", message } });
    const done = await t.until(() => t.machineCards.find(c => c.final), "final card");
    const shown = tailOf(done.text);
    expect(shown).toHaveLength(EXEC_CARD_LINES);
    expect(shown.at(-1)).toBe("the real cause");
    expect(done.text).not.toContain("detail 0\n");
    expect(t.machineFiles).toHaveLength(1);
    const sent = must(t.machineFiles[0]);
    expect(sent.name).toEndWith(".log");
    expect(sent.id).toBe(done.id);
    expect(notifies(sent.kind)).toBe(true);
    expect(sent.text).toContain("detail 0\n");
    expect(sent.text.trimEnd().endsWith("the real cause")).toBe(true);
    expect(sent.text).not.toContain("{");
  });

  test("a progress line with an empty code is no empty line; an unknown code is a catalog line", async () => {
    const { t, runId } = await startRig();
    t.fake.write(runId, `${progress("")}\n${progress("brand-new-step")}\n${progress("update-step-output", { line: "tail" })}\n`);
    const card = await t.until(() => t.machineCards.find(c => c.text.includes("tail")), "card with the last line");
    expect(tailOf(card.text)).toEqual([en.rigProgressUnknown({ code: "brand-new-step" }), "tail"]);
  });

  test("a line that is not JSON (a traceback) is shown as text", async () => {
    const { t, runId } = await startRig();
    t.fake.write(runId, "Traceback (most recent call last):\n  File x\n");
    const card = await t.until(() => t.machineCards.find(c => c.text.includes("File x")), "card with the traceback");
    expect(tailOf(card.text)).toEqual(["Traceback (most recent call last):", "  File x"]);
  });

  test("a failure is rig's message as it is, the exit code still decides the outcome", async () => {
    const { t, runId } = await startRig();
    t.fake.finish(runId, { kind: "exit", code: 1 }, { error: { code: "update-busy", message: "Another update is running" } });
    const done = await t.until(() => t.machineCards.find(c => c.final), "final card");
    expect(done.text).toContain("Another update is running");
    expect(done.text).not.toContain("update-busy");
    expect(done.text).toContain(en.execOutcomeCode({ code: 1 }));
  });

  test("the words are made when the card is drawn, in the language current then", async () => {
    let current: Messages = en;
    const t = setup({ messages: () => current });
    t.execs.machine(ARGS, "rig update", { chatId: CHAT }, 1);
    await t.settle();
    t.fake.write(t.fake.last(), `${progress("service-stopping")}\n`);
    await t.until(() => t.machineCards.find(c => c.text.includes(en.rigProgressServiceStopping)), "English card");
    current = ru;
    t.fake.finish(t.fake.last(), { kind: "exit", code: 0 });
    const done = await t.until(() => t.machineCards.find(c => c.final), "final card");
    expect(done.text).toContain(ru.rigProgressServiceStopping);
    expect(done.text).not.toContain(en.rigProgressServiceStopping);
  });

  test("a log that does not fit the card goes as a file of words, not of JSON", async () => {
    const { t, runId } = await startRig();
    const lines = Array.from({ length: LOG_LINES }, (_, i) => progress("update-step-output", { line: `step ${i}` }));
    t.fake.write(runId, `${lines.join("\n")}\n`);
    t.fake.finish(runId, { kind: "exit", code: 0 });
    await t.until(() => t.machineFiles.length === 1, "the log file");
    const sent = must(t.machineFiles[0]).text;
    expect(sent).toContain("step 0\n");
    expect(sent).toContain(`step ${LOG_LINES - 1}`);
    expect(sent).not.toContain("progress");
    expect(sent).not.toContain("{");
  });

  test("a log of words over the file limit is cut from its start on a line, and says so", async () => {
    const t = setup({ fileLimit: SMALL_FILE_LIMIT });
    t.execs.machine(ARGS, "rig update", { chatId: CHAT }, 1);
    await t.settle();
    const runId = t.fake.last();
    const lines = Array.from({ length: LOG_LINES * LOG_LINES }, (_, i) => progress("update-step-output", { line: `step ${i}` }));
    t.fake.write(runId, `${lines.join("\n")}\n`);
    t.fake.finish(runId, { kind: "exit", code: 0 });
    const file = await t.until(() => t.machineFiles[0], "the log file");
    expect(file.text).toStartWith("[log trimmed");
    expect(Buffer.byteLength(file.text)).toBeLessThanOrEqual(SMALL_FILE_LIMIT);
    expect(file.text).toContain(`step ${LOG_LINES * LOG_LINES - 1}\n`);
    expect(file.text).not.toContain("step 0\n");
    expect(file.text).not.toContain("{");
  });

  test("a log that fits the card is not sent as a file even when its JSON lines are long", async () => {
    const { t, runId } = await startRig();
    t.fake.write(runId, `${progress("update-step-output", { line: "ok", note: "x".repeat(BIG_LINE_CHARS) })}\n`);
    t.fake.finish(runId, { kind: "exit", code: 0 });
    await t.until(() => t.machineCards.find(c => c.final), "final card");
    expect(t.machineFiles).toEqual([]);
  });

  test("a run rig lost ends as an interrupted card", async () => {
    const { t, runId } = await startRig();
    t.fake.runs.delete(runId);
    const done = await t.until(() => t.machineCards.find(c => c.final), "final card");
    expect(done.text).toStartWith(en.execOutcomeLost({ reason: en.execLostProcessGone }));
    expect(done.kind).toBe("warning");
    expect(t.reports).toEqual([]);
  });

  test("a restarted hub goes on with a running rig run and draws its final card", async () => {
    const { t, runId } = await startRig();
    t.fake.write(runId, `${progress("update-step-output", { line: "one" })}\n`);
    await t.tick();
    t.execs.stop();
    const t2 = setup({ dir: t.dir, fake: t.fake });
    t.fake.finish(runId, { kind: "exit", code: 0 }, { mode: "server", outcome: "complete" });
    const done = await t2.until(() => t2.machineCards.find(c => c.final), "final card");
    expect(tailOf(done.text)).toEqual(["one", en.rigUpdateComplete({ pending: false })]);
    expect(t.machineCards.some(c => c.final)).toBe(false);
  });
});

describe("a run's log file", () => {
  // A log with a two-byte character at every position, over the small limit; the prefix moves the cut by a byte.
  for (const prefix of ["", "x"]) {
    test(`over the file limit is cut from its start, says so, and holds no half a character (cut shifted by ${prefix.length})`, async () => {
      const t = setup({ fileLimit: SMALL_FILE_LIMIT });
      const { runId } = await started(t);
      t.fake.write(runId, `${prefix}${YA.repeat(OVER_LIMIT_YA_COUNT)}\nlast line\n`);
      t.fake.finish(runId, { kind: "exit", code: 0 });
      const file = await t.until(() => t.files[0], "the log file");
      expect(file.text).toStartWith("[log trimmed");
      expect(Buffer.byteLength(file.text)).toBeLessThanOrEqual(SMALL_FILE_LIMIT);
      expect(file.text).toEndWith(`${YA}\nlast line\n`);
      expect(file.text).not.toContain("\uFFFD");
    });
  }

  test("a log over the card but under the limit comes whole, from its first byte", async () => {
    const t = setup();
    const { runId } = await started(t);
    const whole = Array.from({ length: THREE_PAGES_LINES }, (_, i) => `line ${i}`).join("\n") + "\n";
    t.fake.write(runId, whole);
    t.fake.finish(runId, { kind: "exit", code: 0 });
    const file = await t.until(() => t.files[0], "the log file");
    expect(file.text).toBe(whole);
  });

  test("a character cut by the end of a page comes out whole, whatever the page size", async () => {
    const t = setup();
    t.fake.page = ODD_PAGE_BYTES;
    const { runId } = await started(t);
    const big = `x${YA.repeat(YA_COUNT)}\nend\n`;
    t.fake.write(runId, big);
    t.fake.finish(runId, { kind: "exit", code: 0 });
    const file = await t.until(() => t.files[0], "the log file");
    expect(file.text).toBe(big);
  });

  test("a hub restarted in the middle of a run still sends the whole log, not what it read after the restart", async () => {
    const t = setup();
    const { runId } = await started(t);
    const first = Array.from({ length: THREE_PAGES_LINES }, (_, i) => `line ${i}`).join("\n") + "\n";
    t.fake.write(runId, first);
    await t.tick();
    t.execs.stop();
    const t2 = setup({ dir: t.dir, fake: t.fake });
    t.fake.write(runId, "after\n");
    t.fake.finish(runId, { kind: "exit", code: 0 });
    const file = await t2.until(() => t2.files[0], "the log file");
    expect(file.text).toBe(`${first}after\n`);
    expect(t.files).toHaveLength(0);
  });

  test("when rig cannot be read for the file, the end the hub holds goes instead, and says so in the log", async () => {
    const t = setup();
    const { runId } = await started(t);
    t.fake.write(runId, `first line\n${"a".repeat(OVER_MEMORY_CAP_CHARS)}\nlast line\n`);
    t.fake.finish(runId, { kind: "exit", code: 0 });
    // The watching read starts at byte 0 once; every later read from 0 is the file's, and rig fails it.
    const real = t.fake.status.bind(t.fake);
    let fromStart = 0;
    t.fake.status = async (id, from) => (from === 0 && ++fromStart > 1 ? { ok: false, error: rigError("boom", "no pages") } : real(id, from));
    const file = await t.until(() => t.files[0], "the log file");
    expect(file.text).toStartWith("[log trimmed");
    expect(file.text).toEndWith("last line\n");
    expect(file.text).not.toContain("first line");
    expect(t.log.lines.some(l => l.includes("could not give the whole log"))).toBe(true);
  });
});

describe("a log file across a hub restart", () => {
  const WHOLE = Array.from({ length: THREE_PAGES_LINES }, (_, i) => `line ${i}`).join("\n") + "\n";
  const RESTART_TICKS = 3;

  test("a hub that died after saving the end and before the file went out sends it once after the restart", async () => {
    const t = setup();
    const { id, runId } = await started(t);
    t.fake.write(runId, WHOLE);
    t.fake.finish(runId, { kind: "exit", code: 0 });
    // The hub dies while it reads the pages for the file: the end is saved, the file has not gone out.
    const real = t.fake.status.bind(t.fake);
    let fromStart = 0;
    t.fake.status = async (rid, from) => {
      if (from === 0 && ++fromStart > 1) t.execs.stop();
      return real(rid, from);
    };
    await t.until(() => loadRuns(join(t.dir, "exec-runs.json")).find(r => r.id === id)?.state === "ended", "the saved end");
    await t.settle();
    expect(t.files).toHaveLength(0);
    expect(loadRuns(join(t.dir, "exec-runs.json")).find(r => r.id === id)?.logFile).toBe("owed");
    t.fake.status = real;
    const t2 = setup({ dir: t.dir, fake: t.fake });
    const file = await t2.until(() => t2.files[0], "the resent log file");
    expect(file.text).toBe(WHOLE);
    for (let i = 0; i < RESTART_TICKS; i++) await t2.tick();
    expect(t2.files).toHaveLength(1);
    expect(loadRuns(join(t.dir, "exec-runs.json")).find(r => r.id === id)?.logFile).toBe("sent");
    // A third start: it went out, so nothing goes again.
    t2.execs.stop();
    const t3 = setup({ dir: t.dir, fake: t.fake });
    for (let i = 0; i < RESTART_TICKS; i++) await t3.tick();
    expect(t3.files).toHaveLength(0);
  });

  test("a hub restarted after the file went out sends nothing again", async () => {
    const t = setup();
    const { runId } = await started(t);
    t.fake.write(runId, WHOLE);
    t.fake.finish(runId, { kind: "exit", code: 0 });
    await t.until(() => t.files[0], "the log file");
    t.execs.stop();
    const t2 = setup({ dir: t.dir, fake: t.fake });
    for (let i = 0; i < RESTART_TICKS; i++) await t2.tick();
    expect(t2.files).toHaveLength(0);
    expect(t.files).toHaveLength(1);
  });

  test("a rig run's file is owed and resent the same way", async () => {
    const t = setup();
    t.execs.machine(["update"], "rig update", { chatId: CHAT }, 7);
    await t.settle();
    const runId = t.fake.last();
    t.fake.write(runId, `${Array.from({ length: THREE_PAGES_LINES }, (_, i) => `{"type":"step","n":${i}}`).join("\n")}\n`);
    t.fake.finish(runId, { kind: "exit", code: 0 });
    const real = t.fake.status.bind(t.fake);
    let fromStart = 0;
    t.fake.status = async (rid, from) => {
      if (from === 0 && ++fromStart > 1) t.execs.stop();
      return real(rid, from);
    };
    await t.until(() => loadRuns(join(t.dir, "exec-runs.json"))[0]?.state === "ended", "the saved end");
    await t.settle();
    expect(t.machineFiles).toHaveLength(0);
    t.fake.status = real;
    const t2 = setup({ dir: t.dir, fake: t.fake });
    await t2.until(() => t2.machineFiles[0], "the resent log file");
    for (let i = 0; i < RESTART_TICKS; i++) await t2.tick();
    expect(t2.machineFiles).toHaveLength(1);
  });
});

describe("exec texts", () => {
  const rec: ExecRun = {
    id: "abcd1234",
    sessionId: SID,
    messageId: 1,
    shell: "bash",
    text: "make",
    cwd: "C:\\proj",
    state: "running",
    startedAt: NOW,
    offset: 0,
    reported: false,
  };

  test("an empty tail makes no block; a short run counts seconds", () => {
    expect(execCardText(rec, "", NOW + 42_000, en, NAMES)).toBe("▶ Git Bash · 42 s\n`make`");
    expect(execCardText(rec, "", NOW + 3 * MIN_MS + 12_000, en, NAMES)).toBe("▶ Git Bash · 3 min 12 s\n`make`");
    expect(execCardText(rec, "", NOW + 42_000, en, platformFor("linux").shellNames)).toBe("▶ bash · 42 s\n`make`");
  });

  test("a card with a tail fences it by more backticks than the tail holds", () => {
    expect(execCardText(rec, "a\nb", NOW, en, NAMES)).toBe("▶ Git Bash · 0 s\n`make`\n```\na\nb\n```");
    expect(execCardText(rec, "```x", NOW, en, NAMES)).toContain("\n````\n```x\n````");
  });

  test("the report to the agent is English whatever the hub's language and names the full log by its run id", () => {
    const done: ExecRun = { ...rec, runId: "r7", state: "ended", end: { kind: "exit", code: 3, at: NOW + 5000 } };
    const text = execReportText(done, "last", NAMES);
    expect(text).toStartWith(`The topic command has ended: ${en.execOutcomeCode({ code: 3 })} in 5 s.`);
    expect(text).toContain("Shell: Git Bash, folder: C:\\proj");
    expect(text).toContain("Full log: rig exec status r7 --from 0");
    expect(text).toContain("Last 30 lines:\nlast");
    expect(execReportText({ ...done, runId: undefined }, "", NAMES)).not.toContain("Full log");
    expect(execReportText({ ...done, runId: undefined }, "", NAMES)).toContain("There was no output.");
  });
});

// A fake rig whose start reads the run store as it is at that moment, and can hang as a dying hub would.
class SpyExec extends FakeExec {
  seen: ExecRun[][] = [];
  hang = false;
  constructor(private file: () => string) {
    super();
  }
  private spy(): Promise<void> | undefined {
    this.seen.push(loadRuns(this.file()));
    return this.hang ? new Promise<void>(() => {}) : undefined;
  }
  override async start(...args: Parameters<FakeExec["start"]>): ReturnType<FakeExec["start"]> {
    await this.spy();
    return super.start(...args);
  }
  override async startRig(...args: Parameters<FakeExec["startRig"]>): ReturnType<FakeExec["startRig"]> {
    await this.spy();
    return super.startRig(...args);
  }
}

const DESTINATION = { chatId: CHAT };

describe("a start that the hub may not survive", () => {
  const spyIn = () => {
    const dir = tempDir("telegramhub-exec-");
    dirs.push(dir);
    return { dir, fake: new SpyExec(() => join(dir, "exec-runs.json")) };
  };

  test("a shell command is on disk, pending with no rig id, before rig is asked; the rig id is added after", async () => {
    const { dir, fake } = spyIn();
    const t = setup({ dir, fake });
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    await t.settle();
    const before = must(fake.seen[0]?.[0], "record at start");
    expect(before).toMatchObject({ messageId: 1, chatId: CHAT, state: "pending", starting: true });
    expect(before.runId).toBeUndefined();
    expect(loadRuns(join(dir, "exec-runs.json"))[0]).toMatchObject({ state: "running", runId: fake.last() });
    expect(loadRuns(join(dir, "exec-runs.json"))[0]?.starting).toBeUndefined();
  });

  test("a rig mutation is on disk before rig is asked", async () => {
    const { dir, fake } = spyIn();
    const t = setup({ dir, fake });
    t.execs.machine(["update"], "rig update", DESTINATION, 7);
    await t.settle();
    expect(fake.seen[0]?.[0]).toMatchObject({ messageId: 7, shell: "rig", state: "pending", starting: true });
    expect(loadRuns(join(dir, "exec-runs.json"))[0]).toMatchObject({ state: "running", runId: fake.last() });
  });

  test("a hub that died in the start does not start again on restart or on redelivery, and says the outcome is unknown", async () => {
    const { dir, fake } = spyIn();
    fake.hang = true;
    const t = setup({ dir, fake });
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    t.execs.machine(["update"], "rig update", DESTINATION, 2);
    await t.settle();
    t.execs.stop();
    fake.hang = false;
    const t2 = setup({ dir, fake });
    t2.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    t2.execs.machine(["update"], "rig update", DESTINATION, 2);
    await t2.settle();
    expect(fake.seen).toHaveLength(2);
    expect(fake.starts).toHaveLength(0);
    expect(fake.rigStarts).toHaveLength(0);
    expect(t2.lastCard().markdown).toContain(en.execStartUnknown);
    expect(t2.lastCard().buttons?.[0]?.[0]?.text).toBe(en.execRunButton);
    expect(t2.lastMachineCard().text).toContain(en.execStartUnknown);
    expect(ru.execStartUnknown).not.toBe(en.execStartUnknown);
    expect(loadRuns(join(dir, "exec-runs.json")).every(r => r.state === "pending" && r.startUnknown === true && r.starting === undefined)).toBe(true);
  });

  test("the Run button starts such a command again", async () => {
    const { dir, fake } = spyIn();
    fake.hang = true;
    const t = setup({ dir, fake });
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    await t.settle();
    t.execs.stop();
    fake.hang = false;
    const t2 = setup({ dir, fake });
    expect(await t2.execs.press(idOf(t2.lastCard().cardId), "run")).toBe(en.execStarting);
    await t2.settle();
    expect(fake.seen).toHaveLength(2);
    expect(fake.starts).toHaveLength(1);
    expect(loadRuns(join(dir, "exec-runs.json"))[0]).toMatchObject({ state: "running", runId: fake.last() });
    expect(loadRuns(join(dir, "exec-runs.json"))[0]?.startUnknown).toBeUndefined();
  });

  test("a failed start ends the record with rig's message, and so does a failed start from the Run button", async () => {
    const { dir, fake } = spyIn();
    const t = setup({ dir, fake });
    fake.startError = rigError("boom", "no way");
    t.execs.command(SID, "cmd", "x", "C:\\proj", msg(1));
    await t.settle();
    expect(loadRuns(join(dir, "exec-runs.json"))[0]).toMatchObject({ state: "ended", end: { kind: "failed", detail: expect.stringContaining("no way") } });
    expect(loadRuns(join(dir, "exec-runs.json"))[0]?.starting).toBeUndefined();
    // An old command waits for its button; the press saves the record before the start, and a failure ends it.
    t.execs.command(SID, "cmd", "y", "C:\\proj", msg(2, 10 * MIN_MS));
    await t.settle();
    const id = idOf(t.lastCard().cardId);
    fake.startError = rigError("boom", "still no way");
    fake.seen = [];
    await t.execs.press(id, "run");
    await t.settle();
    expect(fake.seen[0]?.find(r => r.id === id)).toMatchObject({ state: "pending", starting: true });
    expect(loadRuns(join(dir, "exec-runs.json")).find(r => r.id === id)).toMatchObject({ state: "ended", end: { kind: "failed", detail: expect.stringContaining("still no way") } });
  });
});
