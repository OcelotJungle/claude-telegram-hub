import type { ExecClient } from "../src/hub/rig-exec.ts";
import type { RigInvocation, RigOutput, RigProgress } from "../src/hub/rig.ts";
import type { VideoTools } from "../src/hub/video.ts";
import type { Config } from "../src/shared/config.ts";
import type { MessageKind } from "../src/shared/notification.ts";
import type { Timers } from "../src/shared/timers.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { z } from "zod";
import { Hub, MAX_CARDS, projectName } from "../src/hub/hub.ts";
import { CANCEL_REASON } from "../src/hub/questions.ts";
import { RIG_SESSION_LIMIT_MS } from "../src/hub/rig-session.ts";
import { en } from "../src/shared/i18n/en.ts";
import { ru } from "../src/shared/i18n/ru.ts";
import { SessionStore } from "../src/hub/sessions.ts";
import { saveRuns } from "../src/hub/exec-runs.ts";
import { TelegramApi } from "../src/hub/telegram.ts";
import { arr, field } from "../src/shared/guards.ts";
import { PROTOCOL_VERSION } from "../src/shared/protocol.ts";
import { toTelegram } from "../src/shared/markdown.ts";
import { notifies } from "../src/shared/notification.ts";
import { FakeExec } from "./fake-exec.ts";
import { buttonPress, FakeTelegram, topicMsg } from "./fake-telegram.ts";
import { hasFfmpeg, makeVideo, memLogger, must, NO_PACE, settled, tempDir, waitFor, wsClient } from "./helpers.ts";
import { manualClock } from "./manual-clock.ts";
import { commandFailure, fullInfo } from "./info-fixtures.ts";
import { PLATFORM, platformFor } from "../src/shared/platform.ts";

const GROUP = "-1001";
const ME = "123456789";
// A session folder that exists: the repository itself.
const CWD = join(import.meta.dir, "..", "..");
const DEFAULT_DIR = "C:\\Users\\me\\.claude";
// Topic commands: a real command's run, a wait for what it shows, the idle
// time a test hub exits after, a pause for what must not come, the age of a
// command from while the hub was off, a test file limit.
// A file limit that a log of forty lines is over.
const FILE_LIMIT = 200;
const LOG_LINES = 40;
const WAIT_MS = 5000;
const IDLE_MS = 300;
const SETTLE_MS = 300;
const OLD_COMMAND_S = 5 * 60;
const MS_PER_S = 1000;
// How long a test hub waits for windows before it delivers results of runs
// that ended while it was off.
const EXEC_GRACE_MS = 300;
// How often a test hub looks at the exit files of running commands, and how often it redraws their cards.
const EXEC_CHECK_MS = 20;
const EXEC_CARD_MS = 100;
// A grace long enough to end a run and connect a window inside it.
const LONG_GRACE_MS = 2000;
// Topic messages that come together go as one; a short quiet window keeps
// the other tests quick.
const BATCH_QUIET_MS = 5;
const READY_DELAY_MS = 50;
// A slow send keeps a question unsent.
const SLOW_SEND_MS = 300;
// Telegram takes at most this many characters in one message.
const TELEGRAM_LIMIT = 4096;
// The test windows do not answer the hub's catch-up before a question, so
// it waits briefly by default; the catch-up tests pick their own wait.
const CATCH_UP_MS = 20;
const SHORT_CATCH_UP_MS = 150;
// A steady stream of topic messages: its quiet window outlasts the stream, so only the age cap sends a part of it.
const STREAM_QUIET_MS = 1000;
const STREAM_MAX_MS = 300;
const STREAM_STEP_MS = 100;
// How long the hub waits before it shows ✍ on a message the agent has not reported seen.
const REACTION_DELAY_MS = 300;
// Subagent card edits: the delay after a card's last edit, and the gap between edits of different cards.
const CARD_EDIT_MS = 50;
const CARD_GAP_MS = 300;
const CARD_THROTTLE_MS = 400;
// How often the hub renews "typing" for a busy window.
const TYPING_EVERY_MS = 4000;
const LONG_CATCH_UP_MS = 2000;
// What the fake rig answers: the sizes of a compaction and the pid of a started session.
const TOKENS_BEFORE = 120_000;
const TOKENS_AFTER = 30_000;
const RIG_PID = 4242;
// The line rig prints on stderr while a session command waits for the turn to end.
const WAITING_LINE = JSON.stringify({ progress: { code: "session-waiting" } });
// How long the hub waits for the window of a session rig has started.
const CONNECT_WAIT_MS = 90_000;
// Several times the longest wait the hub has (the 90 s start wait): a window that stays open this long after a stop still gets no held item.
const LINGERING_WINDOW_MS = 5 * CONNECT_WAIT_MS;
// How many event-loop turns a test lets released work run for.
const EVENT_LOOP_TURNS = 20;
// The id the hub gives the first message of a topic.
const TOPIC_ID = 100;

let fake: FakeTelegram;
let hub: Hub;
let port: number;
let dir: string;
let config: Config;
let log: ReturnType<typeof memLogger>;
let exited: boolean;
const clients: { close(): void }[] = [];

type HubExtras = {
  projectsDir?: string;
  defaultAccount?(): Promise<string | undefined>;
  execClient?: ExecClient;
  execGraceMs?: number;
  execFileLimit?: number;
  timers?: Timers;
  catchUpMs?: number;
  rigDir?: string;
  findRig?(): string | undefined;
  runRig?(invocation: RigInvocation, signal?: AbortSignal, progress?: RigProgress): Promise<RigOutput>;
  pollOffsetFile?: string;
};

type StartOptions = { port?: number; idleMs?: number; token?: boolean | string; videoTools?: VideoTools; cardEditMs?: number; cardGapMs?: number; reactionDelayMs?: number; typingEveryMs?: number; batchQuietMs?: number; batchMaxMs?: number; accountsAvailable?: () => boolean } & HubExtras;

// The hub binds the port itself (0: the OS picks a free one) and the test reads it back, so no other socket can take it in between.
async function startHub(o: StartOptions = {}): Promise<void> {
  hub = new Hub({
    platform: platformFor("win32"),
    accountsAvailable: o.accountsAvailable ?? (() => true),
    port: o.port ?? 0,
    sessionsFile: join(dir, "sessions.json"),
    outboxFile: join(dir, "outbox.json"),
    cardsFile: join(dir, "cards.json"),
    spoolDir: join(dir, "spool"),
    spoolScanMs: 50,
    filesDir: join(dir, "outbox-files"),
    inboxDir: join(dir, "inbox"),
    ...(o.videoTools ? { videoTools: o.videoTools } : {}),
    ...(o.pollOffsetFile ? { pollOffsetFile: o.pollOffsetFile } : {}),
    api: o.token === false ? undefined : new TelegramApi({ token: typeof o.token === "string" ? o.token : fake.token, base: fake.url, baseDelayMs: 1, maxAttempts: 2, attemptTimeoutMs: 300, sendAttemptTimeoutMs: 300, networkRetryMs: 5, deadlineMs: 500, groupPace: NO_PACE }),
    config: () => config,
    idleMs: o.idleMs ?? 60_000,
    pollTimeoutSec: 1,
    pollRetryBaseMs: 10,
    sendRetryBaseMs: 10,
    sendRetryMaxMs: 50,
    cardEditMs: o.cardEditMs ?? 50,
    cardGapMs: o.cardGapMs ?? 0,
    typingEveryMs: o.typingEveryMs ?? 50,
    reactionDelayMs: o.reactionDelayMs ?? 50,
    readyDelayMs: READY_DELAY_MS,
    batchQuietMs: o.batchQuietMs ?? BATCH_QUIET_MS,
    catchUpMs: o.catchUpMs ?? CATCH_UP_MS,
    ...(o.batchMaxMs ? { batchMaxMs: o.batchMaxMs } : {}),
    ...(o.projectsDir ? { projectsDir: o.projectsDir } : {}),
    ...(o.timers ? { timers: o.timers } : {}),
    ...(o.rigDir ? { rigDir: o.rigDir, hubCommit: () => "invented-commit", repository: dir } : {}),
    ...(o.findRig ? { findRig: o.findRig } : {}),
    ...(o.runRig ? { runRig: o.runRig } : {}),
    defaultConfigDir: DEFAULT_DIR,
    defaultAccount: o.defaultAccount ?? (async () => undefined),
    execRunsFile: join(dir, "exec-runs.json"),
    execClient: o.execClient ?? new FakeExec(),
    execCheckMs: EXEC_CHECK_MS,
    execCardMs: EXEC_CARD_MS,
    execGraceMs: o.execGraceMs ?? EXEC_GRACE_MS,
    ...(o.execFileLimit ? { execFileLimit: o.execFileLimit } : {}),
    log,
    onExit: () => {
      exited = true;
    },
  });
  if (!hub.start()) throw new Error("hub did not start");
  port = hub.port;
}

// Resolves when the hub has handled everything sent so far: use it instead of a sleep before "nothing happened".
const settle = () => settled(hub, { fake });

type Clock = ReturnType<typeof manualClock>;

// A test that drives a hub timer runs the hub on a manual clock; every clock is disposed after its test.
const clocks: Clock[] = [];
function newClock(): Clock {
  const clock = manualClock();
  clocks.push(clock);
  return clock;
}

// On a manual clock a topic message waits in its batch until the quiet window passes: wait for the batch, then close it.
async function closeBatch(clock: Clock, quietMs = BATCH_QUIET_MS): Promise<void> {
  await waitFor(() => hub.busy().includes("message batches"), WAIT_MS, "the batch opened");
  await clock.advance(quietMs);
}

// On a manual clock a window that connects gets the results it missed only after the ready delay. The hub arms it in the same step that answers the window's hello, so a window that has its "state" back has it armed.
async function passReadyDelay(clock: Clock): Promise<void> {
  await clock.advance(READY_DELAY_MS);
}

// For a hub that has work waiting on something outside it (a /cleanup waiting for Claude Code to exit), so `settle` cannot resolve: wait until the hub has handled every update pushed so far (the poller confirms an update only after handling it).
async function updatesHandled(): Promise<void> {
  await waitFor(() => fake.unconfirmedUpdates === 0, WAIT_MS, "the pushed updates handled");
}

// On a manual clock the batches stay open: wait until the hub has taken every update pushed so far and only open batches or their sends remain.
async function updatesTaken(): Promise<void> {
  await waitFor(() => fake.unconfirmedUpdates === 0 && hub.busy().every(part => part === "message batches"), WAIT_MS, "the pushed updates taken");
}

const PROFILE = "C:\\Users\\me\\.claude-swap-backup\\sessions\\2-me_gmail.com";
const hello = (sessionId: string, windowKey = `win-${sessionId}`) => ({ type: "hello", v: PROTOCOL_VERSION, windowKey, sessionId, cwd: CWD, configDir: PROFILE, reportsSeen: true });

async function plugin(sessionId: string, windowKey?: string) {
  const c = await wsClient(port, hello(sessionId, windowKey));
  clients.push(c);
  await c.next("state");
  return c;
}

let reqId = 0;
async function req(c: Awaited<ReturnType<typeof plugin>>, body: object) {
  const id = `r${++reqId}`;
  c.send({ type: "req", id, ...body });
  return c.next("res", m => m.id === id, 5000);
}

async function enabled(sessionId: string, title = "Title") {
  const c = await plugin(sessionId);
  const res = await req(c, { op: "enable", title });
  expect(res.ok).toBe(true);
  return c;
}

beforeEach(() => {
  fake = new FakeTelegram();
  dir = tempDir();
  config = { groupId: GROUP, allowFrom: [ME], turnEndChime: "" };
  log = memLogger();
  exited = false;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await hub?.stop();
  for (const clock of clocks.splice(0)) clock.dispose();
  fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("enable", () => {
  test('creates a topic named "<project> · <title>"', async () => {
    await startHub();
    const c = await plugin("s1");
    const state = c.nextNew("state", m => m.enabled === true);
    const res = await req(c, { op: "enable", title: "\u0420\u0435\u0430\u043b\u0438\u0437\u0430\u0446\u0438\u044f \u0445\u0430\u0431\u0430" });
    await state;
    expect(res).toMatchObject({ ok: true, result: { topicTitle: `${projectName(CWD)} · \u0420\u0435\u0430\u043b\u0438\u0437\u0430\u0446\u0438\u044f \u0445\u0430\u0431\u0430`, created: true } });
    expect(fake.callsOf("createForumTopic")).toEqual([{ chat_id: GROUP, name: `${projectName(CWD)} · \u0420\u0435\u0430\u043b\u0438\u0437\u0430\u0446\u0438\u044f \u0445\u0430\u0431\u0430` }]);
    expect(new SessionStore(join(dir, "sessions.json")).get("s1")).toEqual({ topicId: 100, title: "\u0420\u0435\u0430\u043b\u0438\u0437\u0430\u0446\u0438\u044f \u0445\u0430\u0431\u0430", project: projectName(CWD), enabled: true, cwd: CWD, account: "2" });
  });

  test("the session record follows the window's cwd and account", async () => {
    await startHub();
    await enabled("s1");
    const c = await wsClient(port, { ...hello("s1", "w2"), cwd: "C:\\elsewhere", configDir: "C:\\p\\sessions\\1-other_mail.com" });
    clients.push(c);
    await c.next("state");
    expect(new SessionStore(join(dir, "sessions.json")).get("s1")).toMatchObject({ cwd: "C:\\elsewhere", account: "1" });
  });

  test("a window on the default login gets the account cswap names for it", async () => {
    await startHub({ defaultAccount: async () => "2" });
    const c = await wsClient(port, { ...hello("s1"), configDir: DEFAULT_DIR });
    clients.push(c);
    await c.next("state");
    expect((await req(c, { op: "enable", title: "T" })).ok).toBe(true);
    await waitFor(() => new SessionStore(join(dir, "sessions.json")).get("s1")?.account === "2");
  });

  test("a second enable reuses the topic", async () => {
    await startHub();
    const c = await plugin("s1");
    await req(c, { op: "enable", title: "T" });
    await req(c, { op: "disable" });
    const res = await req(c, { op: "enable", title: "T" });
    expect(res.result).toMatchObject({ created: false });
    expect(fake.callsOf("createForumTopic").length).toBe(1);
  });

  test("enable with a changed title renames the topic", async () => {
    await startHub();
    const c = await plugin("s1");
    await req(c, { op: "enable", title: "Old" });
    await req(c, { op: "enable", title: "New" });
    expect(fake.callsOf("editForumTopic")).toEqual([{ chat_id: GROUP, message_thread_id: 100, name: `${projectName(CWD)} · New` }]);
  });

  test("without groupId the error explains what to configure", async () => {
    config = { allowFrom: [ME], turnEndChime: "" };
    await startHub();
    const c = await plugin("s1");
    const res = await req(c, { op: "enable", title: "T" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("config.json");
    expect(res.error).toContain("hub.log");
  });

  test("without a bot token the error says so", async () => {
    await startHub({ token: false });
    const c = await plugin("s1");
    const res = await req(c, { op: "enable", title: "T" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("TELEGRAM_BOT_TOKEN");
  });

  test("a failing createForumTopic is reported", async () => {
    await startHub();
    fake.failNext("createForumTopic", { code: 400, description: "Bad Request: not enough rights to create a topic" });
    const c = await plugin("s1");
    const res = await req(c, { op: "enable", title: "T" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not enough rights");
  });
});

// A window started from the terminal CLI (CLAUDE_CODE_ENTRYPOINT "cli") says so in hello.
const cliHello = (sessionId: string, extra: object = {}, windowKey = `win-${sessionId}`) => ({ ...hello(sessionId, windowKey), entrypoint: "cli", ...extra });
const STORE_FILE = () => join(dir, "sessions.json");

async function connect(body: object) {
  const c = await wsClient(port, body);
  clients.push(c);
  await c.next("state");
  return c;
}

describe("interactive windows", () => {
  test("an interactive window is on at once and gets no topic before it writes", async () => {
    await startHub();
    const c = await connect(cliHello("s1", { title: "\u0424\u0438\u043a\u0441 \u0432\u0445\u043e\u0434\u0430" }));
    expect(c.messages.filter(m => m.type === "state").at(-1)?.enabled).toBe(true);
    expect(fake.callsOf("createForumTopic")).toEqual([]);
    const rec = new SessionStore(STORE_FILE()).get("s1");
    expect(rec).toMatchObject({ enabled: true, project: basename(CWD) });
    expect(rec?.topicId).toBeUndefined();
  });

  test("the first text of an interactive window creates its topic from the title, later text reuses it", async () => {
    await startHub();
    const c = await connect(cliHello("s1", { title: "\u0424\u0438\u043a\u0441 \u0432\u0445\u043e\u0434\u0430" }));
    c.send({ type: "send", id: "x1", text: "\u043f\u0435\u0440\u0432\u044b\u0439", notify: false });
    await waitFor(() => fake.texts().length === 1, 3000, "the first message");
    expect(fake.callsOf("createForumTopic")).toEqual([{ chat_id: GROUP, name: `${basename(CWD)} · \u0424\u0438\u043a\u0441 \u0432\u0445\u043e\u0434\u0430` }]);
    expect(fake.texts()[0]).toMatchObject({ message_thread_id: 100 });
    c.send({ type: "send", id: "x2", text: "\u0432\u0442\u043e\u0440\u043e\u0439", notify: false });
    await waitFor(() => fake.texts().length === 2, 3000, "the second message");
    expect(fake.callsOf("createForumTopic").length).toBe(1);
    expect(new SessionStore(STORE_FILE()).get("s1")?.topicId).toBe(100);
  });

  test("a window started by an SDK or another entrypoint, or without one, stays off", async () => {
    await startHub();
    const sdk = await connect({ ...hello("s1"), entrypoint: "sdk-cli" });
    const plain = await connect(hello("s2"));
    expect(sdk.messages.filter(m => m.type === "state").at(-1)?.enabled).toBe(false);
    expect(plain.messages.filter(m => m.type === "state").at(-1)?.enabled).toBe(false);
    expect(new SessionStore(STORE_FILE()).get("s1")).toBeUndefined();
    expect(new SessionStore(STORE_FILE()).get("s2")).toBeUndefined();
    expect(fake.callsOf("createForumTopic")).toEqual([]);
  });

  test("tg_disable survives a restart of the window: it stays off and is remembered", async () => {
    await startHub();
    const first = await connect(cliHello("s1"));
    await req(first, { op: "disable" });
    first.close();
    const again = await connect(cliHello("s1", {}, "win-again"));
    expect(again.messages.filter(m => m.type === "state").at(-1)?.enabled).toBe(false);
    expect(new SessionStore(STORE_FILE()).get("s1")).toMatchObject({ enabled: false, disabledByUser: true });
  });

  test("switching a CLI window to a new session turns it on without creating a topic", async () => {
    await startHub();
    const c = await connect(cliHello("old", { title: "Old title" }));
    c.send({ type: "session", sessionId: "new", cwd: CWD, entrypoint: "cli", title: "After clear" });
    await c.nextNew("state", m => m.enabled);
    expect(new SessionStore(STORE_FILE()).get("new")).toMatchObject({ enabled: true, title: "After clear" });
    expect(new SessionStore(STORE_FILE()).get("old")?.enabled).toBe(true);
    expect(fake.callsOf("createForumTopic")).toEqual([]);
    c.send({ type: "send", id: "new-text", text: "first text", notify: false });
    await waitFor(() => fake.texts().length === 1, 3000, "the first text in the new session");
    expect(fake.callsOf("createForumTopic")).toEqual([{ chat_id: GROUP, name: `${basename(CWD)} · After clear` }]);
  });

  test("switching to a session disabled by the user keeps it off", async () => {
    await startHub();
    const window = await connect(cliHello("window"));
    const disabled = await connect(cliHello("disabled", { title: "Before switch" }));
    await req(disabled, { op: "disable" });
    disabled.close();
    await waitFor(() => !hub.isConnected("disabled"), 3000, "disabled session window closed");
    window.send({ type: "session", sessionId: "disabled", cwd: CWD, entrypoint: "cli", title: "Disabled" });
    await window.nextNew("state", m => !m.enabled);
    await waitFor(() => new SessionStore(STORE_FILE()).get("disabled")?.title === "Disabled", 3000, "the new title");
    expect(new SessionStore(STORE_FILE()).get("disabled")).toMatchObject({ enabled: false, disabledByUser: true });
  });

  test("switching in an SDK window stays off and preserves the old session mode", async () => {
    await startHub();
    const old = await connect(cliHello("old"));
    const disabled = await connect(cliHello("sdk-disabled", { title: "Before SDK switch" }));
    await req(disabled, { op: "disable" });
    disabled.close();
    await waitFor(() => !hub.isConnected("sdk-disabled"), 3000, "disabled session window closed");
    const c = await connect({ ...hello("old", "sdk-window"), entrypoint: "sdk-cli" });
    expect(new SessionStore(STORE_FILE()).get("old")?.enabled).toBe(true);
    c.send({ type: "session", sessionId: "sdk-next", cwd: CWD, entrypoint: "sdk-cli", title: "SDK" });
    await c.nextNew("state", m => !m.enabled);
    expect(new SessionStore(STORE_FILE()).get("sdk-next")).toBeUndefined();
    expect(new SessionStore(STORE_FILE()).get("old")?.enabled).toBe(true);
    c.send({ type: "session", sessionId: "sdk-disabled", cwd: CWD, entrypoint: "sdk-cli", title: "SDK title" });
    await c.nextNew("state", m => !m.enabled);
    await waitFor(() => new SessionStore(STORE_FILE()).get("sdk-disabled")?.title === "SDK title", 3000, "the SDK switch title");
    expect(new SessionStore(STORE_FILE()).get("sdk-disabled")).toMatchObject({ enabled: false, disabledByUser: true });
  });

  test("a topic message turns a disabled window back on and clears the flag", async () => {
    await startHub();
    const c = await enabled("s1", "T");
    await req(c, { op: "disable" });
    expect(new SessionStore(STORE_FILE()).get("s1")).toMatchObject({ enabled: false, disabledByUser: true });
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "\u0432\u0435\u0440\u043d\u0438\u0441\u044c" }));
    await c.nextNew("inbound");
    expect(new SessionStore(STORE_FILE()).get("s1")?.enabled).toBe(true);
    expect(new SessionStore(STORE_FILE()).get("s1")?.disabledByUser).toBeUndefined();
  });

  test("tg_enable clears the explicit off", async () => {
    await startHub();
    const c = await enabled("s1", "T");
    await req(c, { op: "disable" });
    expect(new SessionStore(STORE_FILE()).get("s1")).toMatchObject({ disabledByUser: true });
    await req(c, { op: "enable", title: "T" });
    expect(new SessionStore(STORE_FILE()).get("s1")?.disabledByUser).toBeUndefined();
  });

  test("an old record the terminal turned off is turned on by an interactive window", async () => {
    new SessionStore(STORE_FILE()).set("s1", { topicId: 100, title: "T", project: "p", enabled: false });
    await startHub();
    const c = await connect(cliHello("s1"));
    expect(c.messages.filter(m => m.type === "state").at(-1)?.enabled).toBe(true);
    expect(new SessionStore(STORE_FILE()).get("s1")?.enabled).toBe(true);
  });

  test("an old record the user turned off stays off for an interactive window", async () => {
    new SessionStore(STORE_FILE()).set("s1", { topicId: 100, title: "T", project: "p", enabled: false, disabledByUser: true });
    await startHub();
    const c = await connect(cliHello("s1"));
    expect(c.messages.filter(m => m.type === "state").at(-1)?.enabled).toBe(false);
  });

  test("a title sent before the topic exists only changes the stored title; the topic gets it at creation", async () => {
    await startHub();
    const c = await connect(cliHello("s1", { title: "A" }));
    c.send({ type: "title", title: "B" });
    await waitFor(() => new SessionStore(STORE_FILE()).get("s1")?.title === "B", 3000, "the stored title");
    expect(fake.callsOf("editForumTopic")).toEqual([]);
    expect(fake.callsOf("createForumTopic")).toEqual([]);
    c.send({ type: "send", id: "x1", text: "\u0442\u0435\u043a\u0441\u0442", notify: false });
    await waitFor(() => fake.texts().length === 1, 3000, "the message");
    expect(fake.callsOf("createForumTopic")).toEqual([{ chat_id: GROUP, name: `${basename(CWD)} · B` }]);
  });

  test("tg_enable on an interactive window without a topic creates the topic at once", async () => {
    await startHub();
    const c = await connect(cliHello("s1", { title: "T" }));
    const res = await req(c, { op: "enable", title: "T" });
    expect(res.result).toMatchObject({ created: true, topicTitle: `${basename(CWD)} · T` });
    expect(new SessionStore(STORE_FILE()).get("s1")?.topicId).toBe(100);
  });

  test("a busy interactive window with no topic yet shows no typing and does not break", async () => {
    await startHub();
    const c = await connect({ ...cliHello("s1"), busy: true });
    await settle();
    expect(fake.callsOf("sendChatAction")).toEqual([]);
    c.send({ type: "send", id: "x1", text: "\u0433\u043e\u0442\u043e\u0432\u043e", notify: false });
    await waitFor(() => fake.texts().length === 1, 3000, "the message");
  });
});

describe("inbound", () => {
  test("a topic message reaches the right one of two sessions and enables it", async () => {
    await startHub();
    const a = await enabled("a", "A");
    const b = await enabled("b", "B");
    await req(b, { op: "disable" });
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 101, fromId: ME, text: "\u043f\u0440\u0438\u0432\u0435\u0442 B" }));
    const msg = await b.nextNew("inbound");
    expect(msg.content).toBe("\u043f\u0440\u0438\u0432\u0435\u0442 B");
    expect(msg.meta).toMatchObject({ chat_id: GROUP, user_id: ME, user: "user" });
    await waitFor(() => b.messages.filter(m => m.type === "state").at(-1)?.enabled === true, 3000, "enabled state");
    expect(new SessionStore(join(dir, "sessions.json")).get("b")?.enabled).toBe(true);
    expect(a.messages.some(m => m.type === "inbound")).toBe(false);
  });

  test("a reply carries what it answers before the text, a forward its origin before it", async () => {
    await startHub();
    const a = await enabled("a");
    const original = { message_id: 50, date: 0, chat: { id: Number(GROUP), type: "supergroup" }, from: { id: 1, is_bot: true, first_name: "Hub" }, text: "\u0433\u043e\u0442\u043e\u0432\u043e" };
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "!\u0441\u0442\u043e\u043f", extra: { reply_to_message: original } }));
    const stop = await a.nextNew("inbound");
    expect(stop.content).toBe("[reply to your message]\n> \u0433\u043e\u0442\u043e\u0432\u043e\n\n\u0441\u0442\u043e\u043f");
    expect(stop.interrupt).toBe(true);
    const origin = { type: "hidden_user", date: 0, sender_user_name: "\u0410\u043d\u043e\u043d\u0438\u043c" };
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "\u0441\u043c\u043e\u0442\u0440\u0438", extra: { forward_origin: origin } }));
    expect((await a.nextNew("inbound", m => m.content.endsWith("\u0441\u043c\u043e\u0442\u0440\u0438"))).content).toBe("[forwarded from \u0410\u043d\u043e\u043d\u0438\u043c]\n\u0441\u043c\u043e\u0442\u0440\u0438");
  });

  test("a message the agent has at once never wears ✍", async () => {
    const clock = newClock();
    await startHub({ reactionDelayMs: REACTION_DELAY_MS, timers: clock });
    const a = await enabled("a");
    const u = topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "\u043f\u0440\u0438\u0432\u0435\u0442" });
    fake.pushUpdate(u);
    await closeBatch(clock);
    await a.next("inbound");
    a.send({ type: "seen", messageIds: [u.message?.message_id] });
    await settle();
    await clock.advance(REACTION_DELAY_MS * 2);
    await settle();
    expect(fake.callsOf("setMessageReaction")).toEqual([]);
  });

  test("a message taken for the agent wears ✍ until the window says the agent has it", async () => {
    await startHub();
    const a = await enabled("a");
    const u = topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "\u043f\u0440\u0438\u0432\u0435\u0442" });
    const id = u.message?.message_id;
    fake.pushUpdate(u);
    await a.nextNew("inbound");
    await waitFor(() => fake.callsOf("setMessageReaction").length === 1);
    expect(fake.callsOf("setMessageReaction")[0]).toEqual({ chat_id: GROUP, message_id: id, reaction: [{ type: "emoji", emoji: "✍" }] });
    a.send({ type: "seen", messageIds: [id] });
    await waitFor(() => fake.callsOf("setMessageReaction").length === 2);
    expect(fake.callsOf("setMessageReaction")[1]).toEqual({ chat_id: GROUP, message_id: id, reaction: [] });
  });

  test("✍ comes off only after it went on, however slow Telegram is", async () => {
    await startHub();
    const a = await enabled("a");
    fake.hangNext("setMessageReaction");
    const u = topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "\u043f\u0440\u0438\u0432\u0435\u0442" });
    fake.pushUpdate(u);
    await a.nextNew("inbound");
    await waitFor(() => fake.callsOf("setMessageReaction").length === 1);
    a.send({ type: "seen", messageIds: [u.message?.message_id] });
    await waitFor(() => fake.callsOf("setMessageReaction").length === 3, 3000);
    expect(fake.callsOf("setMessageReaction").map(c => arr(c.reaction).length)).toEqual([1, 1, 0]);
  });

  test("the topic of a busy agent shows typing until its turn ends", async () => {
    const clock = newClock();
    await startHub({ typingEveryMs: TYPING_EVERY_MS, timers: clock });
    const a = await enabled("a");
    a.send({ type: "busy", busy: true });
    await waitFor(() => fake.callsOf("sendChatAction").length === 1);
    await clock.advance(TYPING_EVERY_MS);
    await waitFor(() => fake.callsOf("sendChatAction").length === 2);
    expect(fake.callsOf("sendChatAction")[0]).toEqual({ chat_id: GROUP, message_thread_id: 100, action: "typing" });
    a.send({ type: "busy", busy: false });
    await settle();
    await clock.advance(TYPING_EVERY_MS * 3);
    await settle();
    expect(fake.callsOf("sendChatAction").length).toBe(2);
  });

  // Some networks let few new connections through: parallel requests hang,
  // while one connection, reused, takes them in turn.
  test("typing in several topics goes one request at a time", async () => {
    await startHub({ typingEveryMs: 60_000 });
    const a = await enabled("a");
    const b = await enabled("b");
    const release = fake.holdNext("sendChatAction");
    a.send({ type: "busy", busy: true });
    await waitFor(() => fake.callsOf("sendChatAction").length === 1);
    b.send({ type: "busy", busy: true });
    // The window's later request is answered after its busy message, so the hub has taken b's by now.
    expect((await req(b, { op: "enable", title: "Title" })).ok).toBe(true);
    expect(fake.callsOf("sendChatAction").length).toBe(1);
    release();
    await waitFor(() => fake.callsOf("sendChatAction").length === 2);
    expect(new Set(fake.callsOf("sendChatAction").map(c => c.message_thread_id)).size).toBe(2);
  });

  test("failing typing is logged once, and how long it failed once it works again", async () => {
    await startHub();
    const a = await enabled("a");
    for (let i = 0; i < 3; i++) fake.failNext("sendChatAction", { code: 500, description: "Internal" });
    a.send({ type: "busy", busy: true });
    await waitFor(() => log.lines.some(l => l.includes("works again")));
    expect(log.lines.filter(l => l.includes("typing"))).toEqual([
      "WARN showing typing in the topic of session a failed: Error: Telegram 500: Internal",
      "INFO typing in the topic of session a works again after 3 failed attempt(s)",
    ]);
  });

  test("no typing while the mode is off", async () => {
    await startHub();
    const a = await enabled("a");
    await req(a, { op: "disable" });
    a.send({ type: "busy", busy: true });
    await settle();
    expect(fake.callsOf("sendChatAction")).toEqual([]);
  });

  test("a window that connects busy shows typing at once", async () => {
    await startHub();
    await enabled("a");
    const c = await wsClient(port, { ...hello("a", "w2"), busy: true });
    clients.push(c);
    await waitFor(() => fake.callsOf("sendChatAction").length >= 1);
  });

  test("a window whose plugin cannot report seen messages gets no ✍ that would never come off", async () => {
    const clock = newClock();
    await startHub({ reactionDelayMs: REACTION_DELAY_MS, timers: clock });
    const old = await wsClient(port, { ...hello("a"), reportsSeen: undefined });
    clients.push(old);
    await old.next("state");
    expect((await req(old, { op: "enable", title: "T" })).ok).toBe(true);
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "\u043f\u0440\u0438\u0432\u0435\u0442" }));
    await closeBatch(clock);
    await old.next("inbound");
    await clock.advance(REACTION_DELAY_MS * 2);
    await settle();
    expect(fake.callsOf("setMessageReaction")).toEqual([]);
  });

  test("a command for the plugin wears no ✍", async () => {
    const clock = newClock();
    await startHub({ reactionDelayMs: REACTION_DELAY_MS, timers: clock });
    await enabled("a");
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "/info" }));
    await settle();
    await clock.advance(REACTION_DELAY_MS * 2);
    await settle();
    expect(fake.callsOf("setMessageReaction")).toEqual([]);
  });

  // Rich text pasted into Telegram arrives as text plus entities.
  test("a formatted message is delivered as its text, and the log names it without the text", async () => {
    await startHub();
    const a = await enabled("a");
    const text = "# \u041f\u043b\u0430\u043d\n\n\u0421\u043d\u0430\u0447\u0430\u043b\u0430 **v2g1**, \u043f\u043e\u0442\u043e\u043c `cleanup`.";
    const entities = [
      { type: "bold", offset: 0, length: 6 },
      { type: "bold", offset: 17, length: 4 },
      { type: "code", offset: 29, length: 7 },
    ];
    const u = topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text, extra: { entities } });
    fake.pushUpdate(u);
    expect((await a.nextNew("inbound")).content).toBe(text);
    const line = log.lines.find(l => l.includes(`message ${u.message?.message_id}`));
    expect(line).toBe(`INFO message ${u.message?.message_id} in topic 100 → session a: text, ${text.length} chars, entities bold, code`);
  });

  // What Telegram makes of a Markdown file pasted into the chat.
  test("a rich message reaches the session as Markdown", async () => {
    await startHub();
    const a = await enabled("a");
    const rich_message = { blocks: [{ type: "heading", size: 2, text: "\u041f\u043b\u0430\u043d" }, { type: "paragraph", text: ["\u0421\u043d\u0430\u0447\u0430\u043b\u0430 ", { type: "bold", text: "v2g1" }] }] };
    const u = topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, extra: { rich_message } });
    fake.pushUpdate(u);
    const msg = await a.nextNew("inbound");
    expect(msg.content).toBe("## \u041f\u043b\u0430\u043d\n\n\u0421\u043d\u0430\u0447\u0430\u043b\u0430 **v2g1**");
    expect(log.lines).toContain(`INFO message ${u.message?.message_id} in topic 100 → session a: rich_message, 25 chars`);
  });

  test("photos of a rich message are downloaded into the inbox, other files keep their file_id", async () => {
    await startHub();
    const a = await enabled("a");
    fake.files.set("P2", { path: "photos/p.jpg", body: new Uint8Array([9]) });
    const rich_message = {
      blocks: [
        { type: "photo", photo: [{ file_id: "P1" }, { file_id: "P2" }] },
        { type: "photo", photo: [{ file_id: "GONE" }] },
        { type: "document", document: { file_id: "D1", file_name: "plan.pdf" } },
      ],
    };
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, extra: { rich_message } }));
    const msg = await a.nextNew("inbound");
    const [photo, gone, doc] = msg.content.split("\n\n");
    expect(photo.startsWith(`(photo: ${join(dir, "inbox")}`)).toBe(true);
    expect(gone).toBe("(photo, file_id: GONE)");
    expect(doc).toBe("(document: plan.pdf, file_id: D1)");
    expect(msg.meta.image_path).toBeUndefined();
    expect(log.lines.some(l => l.startsWith("WARN photo download failed"))).toBe(true);
  });

  test("a topic of a session without a window, on a machine without rig, says rig is missing and that the message waits", async () => {
    await startHub();
    const a = await enabled("a");
    a.close();
    await waitFor(() => !hub.isConnected("a"), 3000, "disconnect");
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "hello?" }));
    const sent = await waitFor(() => fake.texts().find(p => p.text === en.rigMissing), WAIT_MS, "rig missing notice");
    expect(sent).toMatchObject({ chat_id: GROUP, message_thread_id: 100, disable_notification: false });
    expect(fake.texts().map(p => p.text)).toContain(en.pendingDelivery({ count: 1 }));
  });

  test("General, other chats and other users are ignored and the chat id is logged", async () => {
    await startHub();
    const a = await enabled("a");
    fake.pushUpdate(topicMsg({ chatId: GROUP, fromId: ME, text: "general" }));
    fake.pushUpdate(topicMsg({ chatId: "-555", threadId: 100, fromId: ME, text: "other chat" }));
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: "42", text: "stranger" }));
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "mine" }));
    const msg = await a.nextNew("inbound");
    expect(msg.content).toBe("mine");
    expect(a.messages.filter(m => m.type === "inbound").length).toBe(1);
    expect(log.lines.some(l => l.includes("-555"))).toBe(true);
    expect(fake.texts().length).toBe(0);
  });

  test("a photo is downloaded into the inbox and passed as image_path", async () => {
    await startHub();
    const a = await enabled("a");
    fake.files.set("P2", { path: "photos/p.jpg", body: new Uint8Array([9]) });
    fake.pushUpdate(
      topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, extra: { caption: "look", photo: [{ file_id: "P1", file_unique_id: "u1" }, { file_id: "P2", file_unique_id: "u2" }] } }),
    );
    const msg = await a.nextNew("inbound");
    expect(msg.content).toBe("look");
    expect(msg.meta.image_path.startsWith(join(dir, "inbox"))).toBe(true);
  });

  test("a document is passed as attachment meta with a sanitized name", async () => {
    await startHub();
    const a = await enabled("a");
    fake.pushUpdate(
      topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, extra: { document: { file_id: "D1", file_unique_id: "d", file_name: "a<b>.txt", file_size: 5, mime_type: "text/plain" } } }),
    );
    const msg = await a.nextNew("inbound");
    expect(msg.content).toBe("(document: a_b_.txt)");
    expect(msg.meta).toMatchObject({ attachment_kind: "document", attachment_file_id: "D1", attachment_name: "a_b_.txt", attachment_size: "5" });
  });
});

describe("batching", () => {
  const msg = (text?: string, extra?: Record<string, unknown>) => topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text, extra });
  const inbounds = (c: { messages: { type: string; content?: unknown }[] }) => c.messages.filter(m => m.type === "inbound").map(m => m.content);
  const flags = (c: { messages: { type: string; interrupt?: unknown }[] }) => c.messages.filter(m => m.type === "inbound").map(m => m.interrupt);

  test("an album of photos reaches the agent as one notification naming every photo", async () => {
    await startHub();
    const a = await enabled("a");
    for (const id of ["A1", "A2", "A3"]) fake.files.set(id, { path: `photos/${id}.jpg`, body: new Uint8Array([1]) });
    const photo = (id: string) => [{ file_id: id, file_unique_id: id }];
    fake.pushUpdate(msg(undefined, { caption: "look", photo: photo("A1") }));
    fake.pushUpdate(msg(undefined, { photo: photo("A2") }));
    fake.pushUpdate(msg(undefined, { photo: photo("A3") }));
    const inbound = await a.nextNew("inbound");
    const parts = inbound.content.split("\n\n");
    expect(parts.length).toBe(3);
    expect(parts[0].startsWith(`look (photo: ${join(dir, "inbox")}`)).toBe(true);
    for (const p of parts.slice(1)) expect(p.startsWith(`(photo: ${join(dir, "inbox")}`)).toBe(true);
    expect(inbound.meta.image_path).toBeUndefined();
    await settle();
    expect(inbounds(a).length).toBe(1);
  });

  test('an album captioned "!x" while the agent works interrupts and starts with "x"', async () => {
    await startHub();
    const a = await enabled("a");
    a.send({ type: "busy", busy: true });
    await settle();
    for (const id of ["B1", "B2"]) fake.files.set(id, { path: `photos/${id}.jpg`, body: new Uint8Array([1]) });
    const photo = (id: string) => [{ file_id: id, file_unique_id: id }];
    fake.pushUpdate(msg(undefined, { caption: "!x", photo: photo("B1") }));
    fake.pushUpdate(msg(undefined, { photo: photo("B2") }));
    const inbound = await a.nextNew("inbound");
    expect(inbound.content.startsWith("x (photo: ")).toBe(true);
    expect(inbound.interrupt).toBe(true);
  });

  test("forwards and the text sent after them come as one notification", async () => {
    await startHub();
    const a = await enabled("a");
    const forward_origin = { type: "hidden_user", date: 0, sender_user_name: "\u0410\u043d\u043e\u043d\u0438\u043c" };
    fake.pushUpdate(msg("\u0440\u0430\u0437", { forward_origin }));
    fake.pushUpdate(msg("\u0434\u0432\u0430", { forward_origin }));
    fake.pushUpdate(msg("\u0447\u0442\u043e \u0441\u043a\u0430\u0436\u0435\u0448\u044c?"));
    expect((await a.nextNew("inbound")).content).toBe("[forwarded from \u0410\u043d\u043e\u043d\u0438\u043c]\n\u0440\u0430\u0437\n\n[forwarded from \u0410\u043d\u043e\u043d\u0438\u043c]\n\u0434\u0432\u0430\n\n\u0447\u0442\u043e \u0441\u043a\u0430\u0436\u0435\u0448\u044c?");
  });

  test("a message after the quiet window is a notification of its own", async () => {
    const clock = newClock();
    await startHub({ timers: clock });
    const a = await enabled("a");
    fake.pushUpdate(msg("one"));
    await updatesTaken();
    await clock.advance(BATCH_QUIET_MS);
    await waitFor(() => inbounds(a).length === 1);
    fake.pushUpdate(msg("two"));
    await updatesTaken();
    await clock.advance(BATCH_QUIET_MS);
    await waitFor(() => inbounds(a).length === 2);
    expect(inbounds(a)).toEqual(["one", "two"]);
  });

  test("a steady stream is sent once the batch is old enough", async () => {
    // The quiet window outlasts the whole stream, so only the cap can send a
    // part of it before the stream ends.
    const clock = newClock();
    await startHub({ batchQuietMs: STREAM_QUIET_MS, batchMaxMs: STREAM_MAX_MS, timers: clock });
    const a = await enabled("a");
    const texts = Array.from({ length: 8 }, (_, i) => `m${i}`);
    for (const [i, t] of texts.entries()) {
      fake.pushUpdate(msg(t));
      await updatesTaken();
      // The batch of m0..m2 is as old as the cap at the end of the third step.
      if (i === 1) expect(inbounds(a)).toEqual([]);
      await clock.advance(STREAM_STEP_MS);
    }
    await waitFor(() => inbounds(a).length >= 1);
    expect(inbounds(a)[0]).toBe("m0\n\nm1\n\nm2");
    await clock.advance(STREAM_QUIET_MS);
    await waitFor(() => inbounds(a).join("\n\n") === texts.join("\n\n"), 3000, "the whole stream");
  });

  test('a "!" message sends the waiting batch and starts its own', async () => {
    await startHub();
    const a = await enabled("a");
    fake.pushUpdate(msg("a"));
    fake.pushUpdate(msg("!b"));
    fake.pushUpdate(msg("c"));
    await waitFor(() => inbounds(a).length === 2);
    expect(inbounds(a)).toEqual(["a", "b\n\nc"]);
    expect(flags(a)).toEqual([undefined, true]);
  });

  test('a lone "!" interrupts with an empty message', async () => {
    await startHub();
    const a = await enabled("a");
    fake.pushUpdate(msg("!"));
    const inbound = await a.nextNew("inbound");
    expect(inbound.content).toBe("");
    expect(inbound.interrupt).toBe(true);
  });

  test('a lone "!" leaves no blank line before the messages after it', async () => {
    await startHub();
    const a = await enabled("a");
    fake.pushUpdate(msg("!"));
    fake.pushUpdate(msg("c"));
    const inbound = await a.nextNew("inbound");
    expect(inbound.content).toBe("c");
    expect(inbound.interrupt).toBe(true);
  });

  test('a forward whose text starts with "!" is no interrupt and joins the batch', async () => {
    await startHub();
    const a = await enabled("a");
    fake.pushUpdate(msg("a"));
    fake.pushUpdate(msg("!b", { forward_origin: { type: "hidden_user", date: 0, sender_user_name: "X" } }));
    await waitFor(() => inbounds(a).length === 1);
    await settle();
    expect(inbounds(a)).toEqual(["a\n\n[forwarded from X]\n!b"]);
    expect(flags(a)).toEqual([undefined]);
  });

  test("seeing the first message of a batch takes ✍ off all of its messages", async () => {
    await startHub();
    const a = await enabled("a");
    const us = [msg("one"), msg("two"), msg("three")];
    const ids = us.map(u => u.message?.message_id);
    for (const u of us) fake.pushUpdate(u);
    await a.nextNew("inbound");
    await waitFor(() => fake.callsOf("setMessageReaction").length === 3);
    a.send({ type: "seen", messageIds: [ids[0]] });
    await waitFor(() => fake.callsOf("setMessageReaction").length === 6);
    const cleared = fake.callsOf("setMessageReaction").slice(3);
    expect(cleared.every(c => arr(c.reaction).length === 0)).toBe(true);
    expect(new Set(cleared.map(c => c.message_id))).toEqual(new Set(ids));
  });
});

describe("send", () => {
  test("technical message kinds set Telegram notification through the send path", async () => {
    await startHub();
    const a = await enabled("a");
    const cases: { text: string; kind: MessageKind; loud: boolean }[] = [
      { text: "/info reply", kind: "info", loud: false },
      { text: "✅ /autocompact 80 done.", kind: "info", loud: false },
      { text: "🗜 Compaction is running…", kind: "info", loud: false },
      { text: "✅ Compaction done.", kind: "info", loud: false },
      { text: "🧹 Cleanup done", kind: "info", loud: false },
      { text: "✅ Session started", kind: "info", loud: false },
      { text: "🚀 Starting the session…", kind: "info", loud: false },
      { text: "⏹ Session ended", kind: "info", loud: false },
      { text: "⏳ Session is already ending", kind: "info", loud: false },
      { text: "✅ code 0", kind: "info", loud: false },
      { text: "⏹ stopped", kind: "info", loud: false },
      { text: "❌ code 2", kind: "error", loud: true },
      { text: "⚠️ interrupted: the process disappeared", kind: "warning", loud: true },
      { text: "🔐 Confirmation needed", kind: "action", loud: true },
      { text: "Pick an answer option", kind: "action", loud: true },
      { text: "⚠️ Compaction failed", kind: "error", loud: true },
    ];
    for (const [index, item] of cases.entries()) a.send({ type: "send", id: `kind-${index}`, text: item.text, notify: notifies(item.kind) });
    await waitFor(() => fake.texts().length === cases.length, WAIT_MS, "technical messages");
    expect(fake.texts().map(message => [message.text, message.disable_notification])).toEqual(
      cases.map(item => [item.text, !item.loud]),
    );
  });

  test("silent and notify map to disable_notification and every send is acked", async () => {
    await startHub();
    const a = await enabled("a");
    a.send({ type: "send", id: "x1", text: "working", notify: false });
    a.send({ type: "send", id: "x2", text: "done", notify: true });
    await a.next("ack", m => m.id === "x2");
    expect(a.messages.some(m => m.type === "ack" && m.id === "x1")).toBe(true);
    // The ack comes when the text is queued; the send follows.
    await waitFor(() => fake.callsOf("sendMessage").length === 2, WAIT_MS, "both sends");
    expect(fake.callsOf("sendMessage")).toEqual([
      { chat_id: GROUP, message_thread_id: 100, text: "working", disable_notification: true },
      { chat_id: GROUP, message_thread_id: 100, text: "done", disable_notification: false },
    ]);
  });

  test("long text goes in several messages and only the first notifies", async () => {
    await startHub();
    const a = await enabled("a");
    a.send({ type: "send", id: "x1", text: "z".repeat(10000), notify: true });
    await waitFor(() => fake.texts().length === 3);
    const sent = fake.texts();
    expect(fake.callsOf("sendRichMessage")).toEqual([]);
    expect(sent.map(s => s.text).join("")).toBe("z".repeat(10000));
    expect(sent.map(s => s.disable_notification)).toEqual([false, true, true]);
  });

  test("long formatted text goes in several rich messages and only the first notifies", async () => {
    await startHub();
    const a = await enabled("a");
    a.send({ type: "send", id: "x1", text: `## z\n\n${"z".repeat(20000)}\n\n${"y".repeat(20000)}`, notify: true });
    await waitFor(() => fake.texts().length === 2);
    expect(fake.callsOf("sendMessage")).toEqual([]);
    expect(fake.texts().map(s => s.text.endsWith("y".repeat(20000)))).toEqual([false, true]);
    expect(fake.texts().map(s => s.disable_notification)).toEqual([false, true]);
  });

  // The plugin decides what goes out: only it knows the text was written while
  // the mode was on, even if the hub turned the mode off meanwhile.
  test("text sent after the mode was turned off is still delivered", async () => {
    await startHub();
    const a = await enabled("a");
    await req(a, { op: "disable" });
    a.send({ type: "send", id: "x1", text: "written while on", notify: false });
    await waitFor(() => fake.texts().length === 1);
    expect(fake.texts()[0]).toMatchObject({ text: "written while on" });
  });

  test("text for a session without a topic is acked, logged and not sent", async () => {
    await startHub();
    const a = await plugin("a");
    a.send({ type: "send", id: "x1", text: "nowhere", notify: false });
    await a.next("ack", m => m.id === "x1");
    expect(fake.texts().length).toBe(0);
    expect(log.lines.some(l => l.startsWith("WARN") && l.includes("nowhere"))).toBe(true);
  });

  test("text carrying a session id goes to that session, not to the current one of the window", async () => {
    await startHub();
    const a = await enabled("a");
    a.send({ type: "session", sessionId: "a2", cwd: CWD });
    await waitFor(() => hub.isConnected("a2"));
    a.send({ type: "send", id: "x1", sessionId: "a", text: "old session text", notify: false });
    await waitFor(() => fake.texts().length === 1);
    expect(fake.texts()[0]).toMatchObject({ message_thread_id: 100, text: "old session text" });
  });

  test("text queued while enabled is delivered even if the mode goes off while an earlier send is retrying", async () => {
    await startHub();
    const a = await enabled("a");
    fake.failNext("sendMessage", { code: 429, description: "Too Many Requests", retry_after: 1 });
    a.send({ type: "send", id: "x1", text: "first", notify: false });
    a.send({ type: "send", id: "x2", text: "final", notify: false });
    a.send({ type: "req", id: "d1", op: "disable" });
    await waitFor(() => fake.texts().length === 3, 5000, "both delivered");
    expect(fake.texts().map(p => p.text)).toEqual(["first", "first", "final"]);
  });

  test("a deleted topic is recreated and the message still delivered", async () => {
    await startHub();
    const a = await enabled("a", "T");
    fake.deleteTopic(100);
    // The ack comes when the message is queued, before Telegram rejects the old topic.
    const release = fake.holdNext("sendMessage");
    a.send({ type: "send", id: "x1", text: "still here", notify: false });
    await a.next("ack", m => m.id === "x1");
    release();
    await waitFor(() => fake.texts().at(-1)?.message_thread_id === 101, 3000, "the message in the new topic");
    expect(fake.callsOf("createForumTopic").length).toBe(2);
    expect(fake.texts().at(-1)).toMatchObject({ message_thread_id: 101, text: "still here" });
    expect(new SessionStore(join(dir, "sessions.json")).get("a")?.topicId).toBe(101);
  });

  test("a background job that fails is logged once, leaves no unhandled rejection and leaves busy()", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      await startHub();
      const c = await connect(cliHello("s1", { title: "A" }));
      // The store saves through "<file>.tmp": a folder under that name makes the title write fail.
      mkdirSync(join(dir, "sessions.json.tmp"));
      c.send({ type: "title", title: "B" });
      await waitFor(() => log.lines.some(line => line.startsWith("ERROR background work failed")), WAIT_MS, "the failure logged");
      await settle();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(log.lines.filter(line => line.startsWith("ERROR background work failed")).length).toBe(1);
      expect(unhandled).toEqual([]);
      expect(hub.busy()).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("a title change renames the topic", async () => {
    await startHub();
    const a = await enabled("a", "Old");
    a.send({ type: "title", title: "New" });
    await waitFor(() => fake.callsOf("editForumTopic").length === 1);
    expect(fake.callsOf("editForumTopic")[0]).toMatchObject({ name: `${projectName(CWD)} · New` });
    a.send({ type: "title", title: "New" });
    await settle();
    expect(fake.callsOf("editForumTopic").length).toBe(1);
  });

  test("a permission request is sent with sound only while enabled", async () => {
    await startHub();
    const a = await enabled("a");
    a.send({ type: "permission", toolName: "Bash", description: "rm -rf build" });
    await waitFor(() => fake.texts().length === 1);
    expect(fake.texts()[0]).toMatchObject({ text: "🔐 Confirmation needed: Bash", disable_notification: false });
    await req(a, { op: "disable" });
    a.send({ type: "permission", toolName: "Bash", description: "again" });
    await settle();
    expect(fake.texts().length).toBe(1);
  });

  test("a deny button sends the answer to the session's window", async () => {
    await startHub();
    const a = await enabled("a");
    a.send({ type: "permission", requestId: "r1", toolName: "Bash", description: "general tool description", inputPreview: '{"command":"rm -rf build","description":"Remove build output"}' });
    await waitFor(() => fake.texts().length === 1);
    const data = String(field(arr(arr(field(field(fake.callsOf("sendMessage")[0], "reply_markup"), "inline_keyboard"))[0])[1], "callback_data"));
    fake.pushUpdate(buttonPress({ chatId: GROUP, fromId: ME, messageId: fake.lastMessageId, data }));
    expect(await a.next("permissionReply")).toEqual({ type: "permissionReply", requestId: "r1", behavior: "deny" });
    await waitFor(() => fake.callsOf("editMessageText").length === 1);
    expect(fake.callsOf("editMessageText")[0].text).toBe("🔐 Confirmation needed: Bash\nRemove build output\n\ncommand: rm -rf build\n\n❌ Denied");
  });

  test("a button pressed by a stranger or outside the group does nothing", async () => {
    await startHub();
    const a = await enabled("a");
    a.send({ type: "permission", requestId: "r1", toolName: "Bash", description: "rm -rf build" });
    await waitFor(() => fake.texts().length === 1);
    const data = String(field(arr(arr(field(field(fake.callsOf("sendMessage")[0], "reply_markup"), "inline_keyboard"))[0])[0], "callback_data"));
    fake.pushUpdate(buttonPress({ chatId: GROUP, fromId: "666", messageId: fake.lastMessageId, data }));
    fake.pushUpdate(buttonPress({ chatId: "-1009", fromId: ME, messageId: fake.lastMessageId, data }));
    await waitFor(() => fake.callsOf("answerCallbackQuery").length === 2);
    expect(fake.callsOf("answerCallbackQuery").every(c => c.text === undefined)).toBe(true);
    expect(a.messages.some(m => m.type === "permissionReply")).toBe(false);
    expect(fake.callsOf("editMessageText")).toEqual([]);
    expect(log.lines.some(l => l.includes("button press by 666, not allowed"))).toBe(true);
  });

  test("a button of a prompt the hub does not know loses its keyboard", async () => {
    await startHub();
    await enabled("a");
    fake.pushUpdate(buttonPress({ chatId: GROUP, fromId: ME, messageId: 77, data: "p:deadbeef:allow" }));
    await waitFor(() => fake.callsOf("editMessageReplyMarkup").length === 1);
    expect(fake.callsOf("editMessageReplyMarkup")[0]).toEqual({ chat_id: GROUP, message_id: 77 });
    expect(fake.callsOf("answerCallbackQuery")[0]).toMatchObject({ text: "The request is outdated" });
  });

  test("a button pressed after the window closed says the session is not active", async () => {
    await startHub();
    const a = await enabled("a");
    a.send({ type: "permission", requestId: "r1", toolName: "Bash", description: "rm -rf build" });
    await waitFor(() => fake.texts().length === 1);
    const data = String(field(arr(arr(field(field(fake.callsOf("sendMessage")[0], "reply_markup"), "inline_keyboard"))[0])[0], "callback_data"));
    a.close();
    await waitFor(() => !hub.isConnected("a"));
    fake.pushUpdate(buttonPress({ chatId: GROUP, fromId: ME, messageId: fake.lastMessageId, data }));
    await waitFor(() => fake.callsOf("editMessageText").length === 1);
    expect(fake.callsOf("editMessageText")[0].text).toEndWith("⚠️ The session is not active, the answer was not delivered");
  });

  test("download saves the file into the inbox", async () => {
    await startHub();
    const a = await enabled("a");
    fake.files.set("F", { path: "docs/x.pdf", body: new Uint8Array([1]) });
    const res = await req(a, { op: "download", fileId: "F" });
    expect(res.ok).toBe(true);
    expect(String(res.result).startsWith(join(dir, "inbox"))).toBe(true);
  });
});

describe("delivery", () => {
  const texts = () => fake.texts().map(p => p.text);

  test("the plugin gets its ack once the text is on disk, before Telegram answers", async () => {
    await startHub();
    const a = await enabled("a");
    fake.hangNext("sendMessage", 1000);
    a.send({ type: "send", id: "x1", text: "kept safe", notify: false });
    await a.next("ack", m => m.id === "x1");
    expect(readFileSync(join(dir, "outbox.json"), "utf8")).toContain("kept safe");
  });

  test("an outage longer than the API retries delays the text but keeps it and its order", async () => {
    await startHub();
    const a = await enabled("a");
    for (let i = 0; i < 7; i++) fake.failNext("sendMessage", { code: 502, description: "Bad Gateway" });
    a.send({ type: "send", id: "x1", text: "first", notify: false });
    a.send({ type: "send", id: "x2", text: "second", notify: true });
    await waitFor(() => texts().includes("second"), 5000, "second delivered");
    expect(texts()).toEqual([...Array(8).fill("first"), "second"]);
    expect(fake.texts().at(-1)).toMatchObject({ disable_notification: false });
    expect(log.lines.some(l => l.startsWith("INFO") && l.includes("works again"))).toBe(true);
  });

  test("a dead network is waited out", async () => {
    await startHub();
    const a = await enabled("a");
    fake.hangNext("sendMessage", 6);
    a.send({ type: "send", id: "x1", text: "patience", notify: false });
    await waitFor(() => fake.texts().length === 7, 8000, "delivered after the hangs");
    await settle();
    expect(fake.texts().length).toBe(7);
  });

  test("a restarted hub sends what the previous one had queued", async () => {
    await startHub();
    const a = await enabled("a");
    fake.hangNext("sendMessage", 1000);
    a.send({ type: "send", id: "x1", text: "survivor", notify: true });
    await a.next("ack", m => m.id === "x1");
    a.close();
    await hub.stop();
    fake.stop();
    fake = new FakeTelegram();
    await startHub();
    await waitFor(() => texts().includes("survivor"), 3000, "delivery by the new hub");
    expect(fake.texts()[0]).toMatchObject({ message_thread_id: 100, disable_notification: false });
  });

  test("a text re-sent by a plugin after reconnecting is not delivered twice", async () => {
    await startHub();
    const a = await enabled("a");
    a.send({ type: "send", id: "x1", text: "once", notify: false });
    await a.next("ack", m => m.id === "x1");
    a.send({ type: "send", id: "x1", text: "once", notify: false });
    await waitFor(() => a.messages.filter(m => m.type === "ack" && m.id === "x1").length === 2);
    await settle();
    expect(texts()).toEqual(["once"]);
  });

  test("a text Telegram rejects is logged and replaced in the topic by a loud notice", async () => {
    await startHub();
    const a = await enabled("a");
    fake.failNext("sendMessage", { code: 400, description: "Bad Request: message text is empty" });
    a.send({ type: "send", id: "x1", text: "odd words", notify: false });
    a.send({ type: "send", id: "x2", text: "after", notify: false });
    await waitFor(() => texts().includes("after"), 3000);
    expect(log.lines.some(l => l.startsWith("ERROR") && l.includes("odd words") && l.includes("message text is empty"))).toBe(true);
    const sent = fake.texts();
    expect(sent.map(p => p.text)).toEqual(["odd words", "⚠️ Telegram did not accept the message: Bad Request: message text is empty. The text is in hub.log.", "after"]);
    expect(sent[1].disable_notification).toBe(false);
  });

  test("a bot thrown out of the group keeps the text queued until it is back", async () => {
    await startHub();
    const a = await enabled("a");
    fake.failNext("sendMessage", { code: 403, description: "Forbidden: bot was kicked from the supergroup chat" });
    fake.failNext("sendMessage", { code: 400, description: "Bad Request: chat not found" });
    a.send({ type: "send", id: "x1", text: "waiting", notify: false });
    await waitFor(() => fake.texts().length === 3, 3000);
    expect(texts()).toEqual(["waiting", "waiting", "waiting"]);
    expect(log.lines.some(l => l.startsWith("WARN") && l.includes("kicked"))).toBe(true);
    expect(log.lines.some(l => l.includes("⚠️"))).toBe(false);
  });

  test("the hub does not exit while its queue is not delivered", async () => {
    const clock = newClock();
    await startHub({ idleMs: IDLE_MS, timers: clock });
    const a = await enabled("a");
    const release = fake.holdNext("sendMessage");
    a.send({ type: "send", id: "x1", text: "last words", notify: true });
    await a.next("ack", m => m.id === "x1");
    a.close();
    await waitFor(() => !hub.isConnected("a"));
    await clock.advance(IDLE_MS);
    await waitFor(() => log.lines.some(l => l.includes("exiting once 1 queued")), WAIT_MS, "the idle time passed with the queue undelivered");
    expect(exited).toBe(false);
    release();
    await waitFor(() => exited, 8000, "exit after delivery");
    expect(texts().at(-1)).toBe("last words");
    expect(log.lines.some(l => l.includes("queued"))).toBe(true);
  });

  test("a queue blocked by configuration stays on disk and does not keep the hub alive", async () => {
    new SessionStore(join(dir, "sessions.json")).set("a", { topicId: 100, title: "T", project: "p", enabled: true });
    await startHub({ idleMs: 100, token: false });
    const a = await plugin("a");
    a.send({ type: "send", id: "x1", text: "for later", notify: false });
    await a.next("ack", m => m.id === "x1");
    a.close();
    await waitFor(() => exited, 3000, "idle exit");
    expect(readFileSync(join(dir, "outbox.json"), "utf8")).toContain("for later");
  });

  test("text a closing window left in spool/ is delivered and the file removed", async () => {
    await startHub();
    await enabled("a");
    mkdirSync(join(dir, "spool"), { recursive: true });
    const file = join(dir, "spool", "a-1.json");
    writeFileSync(file, JSON.stringify([{ id: "s1", sessionId: "a", text: "from the grave", notify: true }]));
    await waitFor(() => texts().includes("from the grave"), 3000);
    expect(fake.texts()[0]).toMatchObject({ disable_notification: false });
    expect(existsSync(file)).toBe(false);
  });

  test("an unreadable spool file is set aside and reported", async () => {
    await startHub();
    mkdirSync(join(dir, "spool"), { recursive: true });
    writeFileSync(join(dir, "spool", "bad.json"), "{nope");
    await waitFor(() => log.lines.some(l => l.startsWith("ERROR") && l.includes("bad.json")), 3000);
    expect(existsSync(join(dir, "spool", "bad.json"))).toBe(false);
  });
});

describe("formatting", () => {
  test("short formatted text goes as an ordinary message with entities", async () => {
    await startHub();
    const a = await enabled("a");
    a.send({ type: "send", id: "x1", text: "**\u0418\u0442\u043e\u0433**\n\n**\u0433\u043e\u0442\u043e\u0432\u043e**", notify: false });
    await waitFor(() => fake.texts().length === 1);
    expect(fake.callsOf("sendRichMessage")).toEqual([]);
    expect(fake.callsOf("sendMessage")[0]).toMatchObject({
      text: "\u0418\u0442\u043e\u0433\n\n\u0433\u043e\u0442\u043e\u0432\u043e",
      entities: [
        { type: "bold", offset: 0, length: 4 },
        { type: "bold", offset: 6, length: 6 },
      ],
    });
  });

  test("agent markdown with a table goes as a rich message in blocks", async () => {
    await startHub();
    const a = await enabled("a");
    a.send({ type: "send", id: "x1", text: "## \u0418\u0442\u043e\u0433\n\n**\u0433\u043e\u0442\u043e\u0432\u043e**, \u0441\u043c. `hub.ts`\n\n| a | b |\n|---|---|\n| 1 | 2 |", notify: false });
    await waitFor(() => fake.texts().length === 1);
    expect(fake.callsOf("sendMessage")).toEqual([]);
    expect(field(fake.callsOf("sendRichMessage")[0].rich_message, "blocks")).toEqual([
      { type: "heading", size: 2, text: "\u0418\u0442\u043e\u0433" },
      { type: "paragraph", text: [{ type: "bold", text: "\u0433\u043e\u0442\u043e\u0432\u043e" }, ", \u0441\u043c. ", { type: "code", text: "hub.ts" }] },
      {
        type: "table",
        cells: [
          [
            { text: "a", is_header: true, align: "center", valign: "middle" },
            { text: "b", is_header: true, align: "center", valign: "middle" },
          ],
          [
            { text: "1", align: "left", valign: "middle" },
            { text: "2", align: "left", valign: "middle" },
          ],
        ],
        is_bordered: true,
        is_striped: true,
      },
    ]);
  });

  test("a block too big for a rich message goes as plain text with entities, cut in pieces", async () => {
    await startHub();
    const a = await enabled("a");
    a.send({ type: "send", id: "x1", text: "## \u0434\u043e\n\n```\n" + "z".repeat(31000) + "\n```", notify: true });
    await waitFor(() => fake.texts().length === 9);
    const [first, ...rest] = fake.texts();
    expect(first).toMatchObject({ text: "\u0434\u043e", disable_notification: false });
    expect(rest.map(s => s.text).join("")).toBe("z".repeat(31000));
    expect(rest.every(s => field(arr(s.entities)[0], "type") === "pre" && s.disable_notification === true)).toBe(true);
  });

  test("a rich message Telegram rejects goes as plain text with entities, then without them", async () => {
    await startHub();
    const a = await enabled("a");
    fake.failNext("sendRichMessage", { code: 400, description: "Bad Request: RICH_MESSAGE_INVALID" });
    fake.failNext("sendMessage", { code: 400, description: "Bad Request: can't parse entities" });
    a.send({ type: "send", id: "x1", text: "## bold\n\n1\n\n2\n\n3", notify: true });
    await waitFor(() => fake.texts().length === 3);
    const [rich, formatted, plain] = fake.texts();
    expect(rich).toMatchObject({ text: "bold\n\n1\n\n2\n\n3", disable_notification: false });
    expect(formatted).toMatchObject({ text: "bold\n\n1\n\n2\n\n3", entities: [{ type: "bold", offset: 0, length: 4 }], disable_notification: false });
    expect(plain).toEqual({ chat_id: GROUP, message_thread_id: 100, text: "bold\n\n1\n\n2\n\n3", disable_notification: false });
    expect(log.lines.some(l => l.startsWith("WARN") && l.includes("RICH_MESSAGE_INVALID"))).toBe(true);
    expect(log.lines.some(l => l.startsWith("WARN") && l.includes("can't parse entities"))).toBe(true);
  });

  test("the hub's own texts are not parsed as markdown", async () => {
    await startHub();
    const a = await enabled("a");
    a.send({ type: "permission", toolName: "Bash", description: "Executes a given bash command", inputPreview: '{"description":"rm *.tmp and *.log"}' });
    await waitFor(() => fake.texts().length === 1);
    expect(fake.texts()[0].text).toBe("🔐 Confirmation needed: Bash\nrm *.tmp and *.log");
    expect(fake.texts()[0].entities).toBeUndefined();
  });
});

describe("files", () => {
  let n = 0;
  // A copy the plugin put into outbox-files/<message id>/.
  const queued = (id: string, name: string, body = `body of ${name}`) => {
    const d = join(dir, "outbox-files", id);
    mkdirSync(d, { recursive: true });
    const path = join(d, `${n++}-${name}`);
    writeFileSync(path, body);
    return { path, name, size: body.length };
  };
  const sendFiles = (c: { send(o: object): void }, id: string, files: object[], o: { caption?: string; notify?: boolean; sessionId?: string } = {}) =>
    c.send({ type: "sendFiles", id, sessionId: o.sessionId ?? "a", files, caption: o.caption ?? "", notify: o.notify ?? false });
  const done = (c: Awaited<ReturnType<typeof plugin>>, id: string) => c.next("filesSent", m => m.id === id, 5000);
  const sends = () => fake.calls.filter(c => c.method.startsWith("send")).map(c => c.method);

  test("a photo goes with a formatted caption, the plugin hears it is sent, the copy is removed", async () => {
    await startHub();
    const a = await enabled("a");
    const f = queued("f1", "shot.png");
    sendFiles(a, "f1", [f], { caption: "see **this**" });
    await a.next("ack", m => m.id === "f1");
    expect(await done(a, "f1")).toEqual({ type: "filesSent", id: "f1" });
    expect(fake.callsOf("sendPhoto")).toEqual([
      {
        chat_id: GROUP,
        message_thread_id: "100",
        disable_notification: "true",
        photo: { file: "shot.png", size: f.size, body: "body of shot.png" },
        caption: "see this",
        caption_entities: [{ type: "bold", offset: 4, length: 4 }],
      },
    ]);
    expect(existsSync(join(dir, "outbox-files", "f1"))).toBe(false);
  });

  test("a caption without a visible character is not sent", async () => {
    await startHub();
    const a = await enabled("a");
    sendFiles(a, "f1", [queued("f1", "shot.png")], { caption: " ​\n" });
    await done(a, "f1");
    expect(fake.callsOf("sendPhoto")[0]).not.toHaveProperty("caption");
  });

  test("a turn text without a visible character sends nothing", async () => {
    await startHub();
    const a = await enabled("a");
    a.send({ type: "send", id: "t1", sessionId: "a", text: "​", notify: true });
    await a.next("ack", m => m.id === "t1");
    a.send({ type: "send", id: "t2", sessionId: "a", text: "ok", notify: true });
    await a.next("ack", m => m.id === "t2");
    await waitFor(() => fake.callsOf("sendMessage").length > 0);
    expect(fake.callsOf("sendMessage").map(c => c.text)).toEqual(["ok"]);
  });

  test("albums follow the files, the caption and the sound go with the first send only", async () => {
    await startHub();
    const a = await enabled("a");
    const files = [queued("f1", "1.png"), queued("f1", "2.mp4"), queued("f1", "a.pdf"), queued("f1", "b.pdf"), queued("f1", "clip.gif")];
    sendFiles(a, "f1", files, { caption: "cap", notify: true });
    await done(a, "f1");
    expect(sends()).toEqual(["sendMediaGroup", "sendMediaGroup", "sendAnimation"]);
    const [visual, docs] = fake.callsOf("sendMediaGroup");
    expect(visual.media).toEqual([
      { type: "photo", media: "attach://file0", caption: "cap" },
      { type: "video", media: "attach://file1" },
    ]);
    expect(visual.disable_notification).toBe("false");
    expect(docs.media).toEqual([
      { type: "document", media: "attach://file0" },
      { type: "document", media: "attach://file1" },
    ]);
    expect(docs.disable_notification).toBe("true");
    expect(fake.callsOf("sendAnimation")[0]).toMatchObject({ animation: { file: "clip.gif" }, disable_notification: "true" });
  });

  test("files keep their place between texts", async () => {
    await startHub();
    const a = await enabled("a");
    a.send({ type: "send", id: "x1", text: "before", notify: false });
    sendFiles(a, "f1", [queued("f1", "a.txt")]);
    a.send({ type: "send", id: "x2", text: "after", notify: false });
    await waitFor(() => sends().length === 3);
    expect(sends()).toEqual(["sendMessage", "sendDocument", "sendMessage"]);
    expect(fake.texts().map(s => s.text)).toEqual(["before", "after"]);
  });

  test("files re-sent after a reconnect are not sent twice, and the plugin still hears they are sent", async () => {
    await startHub();
    const a = await enabled("a");
    const f = queued("f1", "a.txt");
    sendFiles(a, "f1", [f]);
    await done(a, "f1");
    a.messages.length = 0;
    sendFiles(a, "f1", [f]);
    expect(await done(a, "f1")).toEqual({ type: "filesSent", id: "f1" });
    expect(fake.callsOf("sendDocument").length).toBe(1);
  });

  test("a session without a topic gets an error and the copies are removed", async () => {
    await startHub();
    const a = await plugin("a");
    sendFiles(a, "f1", [queued("f1", "a.txt")]);
    expect((await done(a, "f1")).error).toContain("tg_enable");
    expect(existsSync(join(dir, "outbox-files", "f1"))).toBe(false);
    expect(sends()).toEqual([]);
  });

  test("a path outside outbox-files is refused and left alone", async () => {
    await startHub();
    const a = await enabled("a");
    const outside = join(dir, "precious.txt");
    writeFileSync(outside, "keep me");
    sendFiles(a, "f1", [{ path: outside, name: "precious.txt", size: 7 }]);
    expect((await done(a, "f1")).error).toContain("outbox-files");
    expect(readFileSync(outside, "utf8")).toBe("keep me");
    expect(sends()).toEqual([]);
    expect(log.lines.some(l => l.startsWith("ERROR") && l.includes("precious.txt"))).toBe(true);
  });

  test("photos Telegram rejects go again as documents, other files of the album as they were", async () => {
    await startHub();
    const a = await enabled("a");
    fake.failNext("sendMediaGroup", { code: 400, description: "Bad Request: PHOTO_INVALID_DIMENSIONS" });
    sendFiles(a, "f1", [queued("f1", "tall.png"), queued("f1", "clip.mp4")], { caption: "cap", notify: true });
    expect(await done(a, "f1")).toEqual({ type: "filesSent", id: "f1" });
    expect(sends()).toEqual(["sendMediaGroup", "sendDocument", "sendVideo"]);
    expect(fake.callsOf("sendDocument")[0]).toMatchObject({ document: { file: "tall.png" }, caption: "cap", disable_notification: "false" });
    expect(fake.callsOf("sendVideo")[0]).toMatchObject({ video: { file: "clip.mp4" }, disable_notification: "true" });
    expect(fake.callsOf("sendVideo")[0].caption).toBeUndefined();
    expect(log.lines.some(l => l.startsWith("WARN") && l.includes("as documents"))).toBe(true);
  });

  // A real clip the plugin put into outbox-files/<message id>/.
  const video = (id: string, name: string) => {
    const d = join(dir, "outbox-files", id);
    mkdirSync(d, { recursive: true });
    const path = join(d, `${n++}-${name}`);
    makeVideo(path, { width: 640, height: 360, seconds: 3 });
    return { path, name, size: Bun.file(path).size };
  };
  const thumbPart = { file: "thumbnail.jpg", size: expect.any(Number), body: expect.any(String) };
  const videoFields = { width: 640, height: 360, duration: 3, supports_streaming: true };

  test.skipIf(!hasFfmpeg)("a video goes with its size, duration, streaming and a thumbnail, which is removed with the copy", async () => {
    await startHub();
    const a = await enabled("a");
    sendFiles(a, "f1", [video("f1", "clip.mp4")], { caption: "cap" });
    expect(await done(a, "f1")).toEqual({ type: "filesSent", id: "f1" });
    const [sent] = fake.callsOf("sendVideo");
    expect(field(sent.thumbnail, "size")).toBeLessThan(200 * 1024);
    expect(sent).toMatchObject({ video: { file: "clip.mp4" }, caption: "cap", width: "640", height: "360", duration: "3", supports_streaming: "true", thumbnail: thumbPart });
    expect(existsSync(join(dir, "outbox-files", "f1"))).toBe(false);
  });

  test.skipIf(!hasFfmpeg)("a video in an album has its fields and its thumbnail attached", async () => {
    await startHub();
    const a = await enabled("a");
    sendFiles(a, "f1", [queued("f1", "1.png"), video("f1", "clip.mp4")], { caption: "cap" });
    await done(a, "f1");
    const [album] = fake.callsOf("sendMediaGroup");
    expect(album.media).toEqual([
      { type: "photo", media: "attach://file0", caption: "cap" },
      { type: "video", media: "attach://file1", ...videoFields, thumbnail: "attach://thumb1" },
    ]);
    expect(album).toMatchObject({ file1: { file: "clip.mp4" }, thumb1: thumbPart });
    expect(album.thumb0).toBeUndefined();
    expect(existsSync(join(dir, "outbox-files", "f1"))).toBe(false);
  });

  test.skipIf(!hasFfmpeg)("a video split off an album Telegram rejected keeps its metadata", async () => {
    await startHub();
    const a = await enabled("a");
    fake.failNext("sendMediaGroup", { code: 400, description: "Bad Request: PHOTO_INVALID_DIMENSIONS" });
    sendFiles(a, "f1", [queued("f1", "tall.png"), video("f1", "clip.mp4")]);
    expect(await done(a, "f1")).toEqual({ type: "filesSent", id: "f1" });
    expect(sends()).toEqual(["sendMediaGroup", "sendDocument", "sendVideo"]);
    expect(fake.callsOf("sendVideo")[0]).toMatchObject({ video: { file: "clip.mp4" }, width: "640", height: "360", duration: "3", supports_streaming: "true", thumbnail: thumbPart });
    expect(existsSync(join(dir, "outbox-files", "f1"))).toBe(false);
  });

  test("without ffprobe and ffmpeg a video is sent as before, with a warning", async () => {
    await startHub({ videoTools: { ffprobe: "no-such-ffprobe", ffmpeg: "no-such-ffmpeg" } });
    const a = await enabled("a");
    const f = queued("f1", "clip.mp4");
    sendFiles(a, "f1", [f]);
    expect(await done(a, "f1")).toEqual({ type: "filesSent", id: "f1" });
    expect(fake.callsOf("sendVideo")).toEqual([{ chat_id: GROUP, message_thread_id: "100", disable_notification: "true", video: { file: "clip.mp4", size: f.size, body: "body of clip.mp4" } }]);
    expect(log.lines.some(l => l.startsWith("WARN") && l.includes("clip.mp4"))).toBe(true);
  });

  test("files Telegram rejects are reported to the plugin, not in the topic, and their copies removed", async () => {
    await startHub();
    const a = await enabled("a");
    fake.failNext("sendDocument", { code: 400, description: "Bad Request: file is too big" });
    sendFiles(a, "f1", [queued("f1", "huge.bin")]);
    expect((await done(a, "f1")).error).toBe("huge.bin: Bad Request: file is too big");
    expect(fake.texts()).toEqual([]);
    expect(existsSync(join(dir, "outbox-files", "f1"))).toBe(false);
    expect(log.lines.some(l => l.startsWith("ERROR") && l.includes("huge.bin"))).toBe(true);
  });

  test("an album Telegram finds too large goes again file by file, not retried forever", async () => {
    await startHub();
    const a = await enabled("a");
    fake.failNext("sendMediaGroup", { code: 413, description: "Request Entity Too Large" });
    fake.failNext("sendVideo", { code: 413, description: "Request Entity Too Large" });
    sendFiles(a, "f1", [queued("f1", "1.mp4"), queued("f1", "2.mp4")], { caption: "cap", notify: true });
    expect((await done(a, "f1")).error).toBe("1.mp4: Request Entity Too Large");
    expect(sends()).toEqual(["sendMediaGroup", "sendVideo", "sendVideo"]);
    expect(fake.texts()).toEqual([]);
    expect(fake.callsOf("sendVideo")[1]).toMatchObject({ video: { file: "2.mp4" } });
    expect(log.lines.some(l => l.startsWith("WARN") && l.includes("one by one"))).toBe(true);
  });

  test("a copy gone from disk is reported like a rejection, not retried forever", async () => {
    await startHub();
    const a = await enabled("a");
    const gone = { path: join(dir, "outbox-files", "f1", "0-gone.png"), name: "gone.png", size: 3 };
    sendFiles(a, "f1", [gone]);
    expect((await done(a, "f1")).error).toContain("gone.png");
    expect(sends()).toEqual([]);
  });

  test("files a closing window left in spool/ are sent", async () => {
    await startHub();
    await enabled("a");
    const f = queued("f1", "a.txt");
    mkdirSync(join(dir, "spool"), { recursive: true });
    writeFileSync(join(dir, "spool", "a-1.json"), JSON.stringify([{ type: "sendFiles", id: "f1", sessionId: "a", files: [f], caption: "", notify: false }]));
    await waitFor(() => fake.callsOf("sendDocument").length === 1, 3000, "document sent");
  });

  test("a restarted hub sends the files the previous one had queued and tells the plugin", async () => {
    await startHub();
    const a = await enabled("a");
    fake.hangNext("sendDocument", 100);
    sendFiles(a, "f1", [queued("f1", "a.txt")]);
    await a.next("ack", m => m.id === "f1");
    await hub.stop();
    fake.clearHangs();
    await startHub();
    const b = await plugin("a");
    expect(await done(b, "f1")).toEqual({ type: "filesSent", id: "f1" });
    expect(existsSync(join(dir, "outbox-files", "f1"))).toBe(false);
  });
});

describe("hooks and transport", () => {
  test("a SessionStart hook is forwarded to the window with the same messaging socket", async () => {
    await startHub();
    const a = await plugin("a", "pipe-A");
    const b = await plugin("b", "pipe-B");
    const res = await fetch(`http://127.0.0.1:${port}/hook`, {
      method: "POST",
      body: JSON.stringify({ messagingSocket: "pipe-B", session_id: "b2", transcript_path: "C:\\t\\b2.jsonl", cwd: CWD, source: "clear" }),
    });
    expect(res.status).toBe(200);
    const sw = await b.next("switchSession");
    expect(sw).toEqual({ type: "switchSession", sessionId: "b2", transcriptPath: "C:\\t\\b2.jsonl", cwd: CWD });
    expect(a.messages.some(m => m.type === "switchSession")).toBe(false);
  });

  test("a turn-end decision goes to the window with the same messaging socket", async () => {
    await startHub();
    const a = await plugin("a", "pipe-A");
    const b = await plugin("b", "pipe-B");
    const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/turn-end`, { method: "POST", body: JSON.stringify(body) });
    expect((await post({ messagingSocket: "pipe-B", session_id: "b", final: true, kind: "ask" })).status).toBe(200);
    expect(await b.next("turnEnd")).toEqual({ type: "turnEnd", final: true, kind: "ask" });
    expect((await post({ messagingSocket: "pipe-B", session_id: "b", final: false })).status).toBe(200);
    expect(await b.next("turnEnd", m => !m.final)).toEqual({ type: "turnEnd", final: false });
    expect(a.messages.some(m => m.type === "turnEnd")).toBe(false);
  });

  test("a turn-end decision for an unknown window is 404, a bad body is 400", async () => {
    await startHub();
    await plugin("a", "pipe-A");
    const post = (body: unknown) => fetch(`http://127.0.0.1:${port}/turn-end`, { method: "POST", body: JSON.stringify(body) });
    expect((await post({ messagingSocket: "pipe-X", session_id: "x", final: true, kind: "done" })).status).toBe(404);
    expect((await post({ messagingSocket: "pipe-A", session_id: "a", final: "yes" })).status).toBe(400);
    expect((await post({ messagingSocket: "pipe-A", session_id: "a", final: true, kind: "loud" })).status).toBe(400);
  });

  test("a hook that arrives before the window says hello is applied on hello", async () => {
    await startHub();
    await fetch(`http://127.0.0.1:${port}/hook`, {
      method: "POST",
      body: JSON.stringify({ messagingSocket: "pipe-C", session_id: "c", transcript_path: "C:\\t\\c.jsonl", cwd: CWD, source: "startup" }),
    });
    const c = await plugin("c", "pipe-C");
    await c.next("switchSession");
  });

  test("the session message re-registers a window under a new session id", async () => {
    await startHub();
    const a = await plugin("a");
    a.send({ type: "session", sessionId: "a2", cwd: CWD });
    await waitFor(() => hub.isConnected("a2"));
    expect(hub.isConnected("a")).toBe(false);
  });

  test("requests from a browser (Origin header) are rejected", async () => {
    await startHub();
    const res = await fetch(`http://127.0.0.1:${port}/hook`, { method: "POST", headers: { Origin: "https://evil.example" }, body: "{}" });
    expect(res.status).toBe(403);
    const ws = await fetch(`http://127.0.0.1:${port}/ws`, { headers: { Origin: "https://evil.example", Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" } });
    expect(ws.status).toBe(403);
  });

  test("health reports the hub pid", async () => {
    await startHub();
    const res: unknown = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    expect(res).toEqual({ ok: true, pid: process.pid });
  });

  test("a second hub on the same port does not start", async () => {
    await startHub();
    const second = new Hub({ port, sessionsFile: join(dir, "s2.json"), outboxFile: join(dir, "o2.json"), filesDir: join(dir, "f2"), inboxDir: dir, api: undefined, config: () => config, idleMs: 1000, log, onExit() {} });
    expect(second.start()).toBe(false);
  });
});

describe("polling", () => {
  test("the log says which bot is polled", async () => {
    await startHub();
    await waitFor(() => log.lines.some(l => l.includes("polling Telegram as @test_bot")), 3000, "bot name in log");
  });

  test("recovery after failed polls is logged", async () => {
    fake.failNext("getUpdates", { code: 502, description: "Bad Gateway" });
    await startHub();
    await waitFor(() => log.lines.some(l => l.includes("Telegram polling works again")), 3000, "recovery in log");
  });

  test("the hub keeps trying until Telegram answers", async () => {
    for (let i = 0; i < 4; i++) fake.failNext("getMe", { code: 502, description: "Bad Gateway" });
    await startHub();
    await waitFor(() => log.lines.some(l => l.includes("polling Telegram as @test_bot")), 3000, "bot name in log");
    // The line is logged before getUpdates reaches the fake.
    await waitFor(() => fake.callsOf("getUpdates").length > 0, 3000, "getUpdates after getMe");
  });

  describe("the update offset", () => {
    const FAKE_BOT_ID = 1;
    const OTHER_BOT_ID = 2;
    const STALE_OFFSET = 500;
    const savedSchema = z.object({ botId: z.number(), offset: z.number() });
    const savedOffset = (file: string) => {
      try {
        return savedSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      } catch {
        return undefined;
      }
    };
    // The offset of the first getUpdates a hub sends after `before` calls.
    const firstOffsetAfter = async (before: number) => {
      await waitFor(() => fake.callsOf("getUpdates").length > before, WAIT_MS, "poll after the restart");
      return Number(fake.callsOf("getUpdates")[before]?.offset ?? 0);
    };

    test("a restarted hub polls on from the saved offset, so it does not act twice on a handled message", async () => {
      const file = join(dir, "poll-offset.json");
      await startHub({ pollOffsetFile: file });
      const first = await enabled("a");
      const handled = fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "one" }));
      await first.nextNew("inbound");
      await waitFor(() => savedOffset(file), WAIT_MS, "offset saved");
      expect(savedOffset(file)).toEqual({ botId: FAKE_BOT_ID, offset: handled.update_id + 1 });
      await hub.stop();
      first.close();
      // Telegram never saw the confirmation of the first message, and sends it again with the next one.
      fake.pushAgain(handled);
      fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "two" }));
      const before = fake.callsOf("getUpdates").length;
      await startHub({ pollOffsetFile: file });
      const second = await plugin("a");
      expect(await firstOffsetAfter(before)).toBe(handled.update_id + 1);
      const inbound = await second.next("inbound");
      expect(inbound.content).toContain("two");
      expect(inbound.content).not.toContain("one");
    });

    test("an offset saved for another bot is not used", async () => {
      const file = join(dir, "poll-offset.json");
      writeFileSync(file, JSON.stringify({ botId: OTHER_BOT_ID, offset: STALE_OFFSET }));
      await startHub({ pollOffsetFile: file });
      expect(await firstOffsetAfter(0)).toBe(0);
    });

    test("an unreadable offset file is set aside and polling starts from the beginning", async () => {
      const file = join(dir, "poll-offset.json");
      writeFileSync(file, "{not json");
      await startHub({ pollOffsetFile: file });
      expect(await firstOffsetAfter(0)).toBe(0);
      expect(readdirSync(dir).some(name => name.startsWith("poll-offset.json.corrupt-"))).toBe(true);
    });
  });

  test("a hung getUpdates warms the connection up with getMe and polls again", async () => {
    await startHub();
    await waitFor(() => fake.callsOf("getUpdates").length > 0, 3000, "first poll");
    fake.hangNext("getUpdates");
    await waitFor(() => log.lines.some(l => l.includes("Telegram polling works again")), 5000, "recovery in log");
    expect(fake.callsOf("getMe").length).toBe(2);
    const polls = fake.callsOf("getUpdates").length;
    await waitFor(() => fake.callsOf("getUpdates").length > polls, 5000, "polling resumed");
  });

  test("a wrong token is reported plainly", async () => {
    await startHub({ token: "1:wrong" });
    await waitFor(() => log.lines.some(l => l.startsWith("ERROR") && l.includes("bot token rejected")), 3000, "token error in log");
  });
});

describe("subagent cards", () => {
  const card = (id: string, markdown: string, final = false) => ({ type: "card", id, sessionId: "a", ...toTelegram(markdown), final });

  test("a card is sent silently once, then edited in place", async () => {
    await startHub();
    const a = await enabled("a");
    a.send(card("x-0", "🤖 **Explore**\n⏳ 1 action"));
    await waitFor(() => fake.texts().length === 1);
    expect(fake.texts()[0]).toMatchObject({ text: "🤖 Explore\n⏳ 1 action", disable_notification: true, entities: [{ type: "bold", offset: 3, length: 7 }] });
    const id = fake.lastMessageId;
    a.send(card("x-0", "🤖 **Explore**\n✅ done", true));
    await waitFor(() => fake.callsOf("editMessageText").length === 1);
    expect(fake.callsOf("editMessageText")[0]).toMatchObject({ chat_id: GROUP, message_id: id, text: "🤖 Explore\n✅ done" });
    a.send(card("x-0", "🤖 **Explore**\n✅ done", true));
    await settle();
    expect(fake.texts().length).toBe(1);
    expect(fake.callsOf("editMessageText").length).toBe(1);
  });

  test("a card from a window older than formatted cards is still shown formatted", async () => {
    await startHub();
    const a = await enabled("a");
    a.send({ type: "card", id: "x-0", sessionId: "a", text: "🤖 **Explore**\n⏳ 1 action", final: false });
    await waitFor(() => fake.texts().length === 1);
    expect(fake.texts()[0]).toMatchObject({ text: "🤖 Explore\n⏳ 1 action", entities: [{ type: "bold", offset: 3, length: 7 }] });
  });

  test("a queued card whose record was forgotten goes as its formatted text, not parsed as Markdown again", async () => {
    await startHub();
    const a = await enabled("a");
    // The first message holds the queue while the card is queued and then
    // forgotten behind MAX_CARDS newer ones.
    fake.failNext("sendMessage", { code: 502, description: "Bad Gateway" });
    a.send({ type: "send", id: "s1", text: "first", notify: false });
    a.send({ type: "card", id: "x-0", sessionId: "a", text: "a *b* c", entities: [], final: false });
    for (let i = 1; i <= MAX_CARDS; i++) a.send(card(`y-${i}`, `card ${i}`));
    const sent = await waitFor(() => fake.texts().find(t => t.text === "a *b* c" || t.text === "a b c"), 5000, "first card sent");
    expect(sent).toMatchObject({ text: "a *b* c" });
    expect(sent.entities).toBeUndefined();
  });

  test("a new part replies to the previous card in the same topic", async () => {
    await startHub();
    const a = await enabled("a");
    a.send(card("x-0", "first", true));
    await waitFor(() => fake.texts().length === 1);
    const previousMessageId = fake.lastMessageId;
    a.send({ ...card("x-1", "continued"), replyTo: "x-0" });
    await waitFor(() => fake.texts().length === 2);
    expect(fake.callsOf("sendMessage")[1]).toMatchObject({
      message_thread_id: 100,
      reply_parameters: { message_id: previousMessageId, allow_sending_without_reply: true },
    });
  });

  test("an unknown previous card sends without reply parameters", async () => {
    await startHub();
    const a = await enabled("a");
    a.send({ ...card("x-1", "continued"), replyTo: "missing-0" });
    await waitFor(() => fake.texts().length === 1);
    expect(fake.callsOf("sendMessage")[0]?.reply_parameters).toBeUndefined();
  });

  test("a queued card keeps its reply target across a hub restart", async () => {
    await startHub();
    const a = await enabled("a");
    a.send(card("x-0", "first", true));
    await waitFor(() => fake.texts().length === 1);
    const previousMessageId = fake.lastMessageId;
    // The blocker's send is received and never answered, so the card stays queued behind it.
    fake.holdNext("sendMessage");
    a.send({ type: "send", id: "blocker", sessionId: "a", text: "wait", notify: false });
    await waitFor(() => fake.callsOf("sendMessage").length === 2, WAIT_MS, "the blocker's send");
    a.send({ ...card("x-1", "continued"), replyTo: "x-0" });
    // The plugin's messages are handled in order: the answer means the card is queued.
    await req(a, { op: "enable", title: "Title" });
    await hub.stop();
    await startHub();
    await enabled("a");
    await waitFor(() => fake.texts().some(t => t.text === "continued"), 5000);
    const continued = fake.callsOf("sendMessage").find(c => c.text === "continued");
    expect(continued).toMatchObject({
      message_thread_id: 100,
      reply_parameters: { message_id: previousMessageId, allow_sending_without_reply: true },
    });
  });

  test("a restarted hub goes on editing the cards it sent", async () => {
    await startHub();
    const a = await enabled("a");
    a.send(card("x-0", "v1"));
    await waitFor(() => fake.texts().length === 1);
    const x = fake.lastMessageId;
    a.send(card("y-0", "done", true));
    await waitFor(() => fake.texts().length === 2);
    // The hub records a sent card's message id and its end only once Telegram's answer is handled.
    await settle();
    await hub.stop();
    await startHub();
    const b = await enabled("a");
    b.send(card("x-0", "v2"));
    await waitFor(() => fake.callsOf("editMessageText").length === 1);
    expect(fake.callsOf("editMessageText")[0]).toMatchObject({ message_id: x, text: "v2" });
    // A finished card stays finished.
    b.send(card("y-0", "late", true));
    await settle();
    expect(fake.texts().length).toBe(2);
    expect(fake.callsOf("editMessageText").map(c => c.message_id)).toEqual([x]);
  });

  test("a done card reopens only with the flag, persists and keeps its message", async () => {
    await startHub();
    const a = await enabled("a");
    a.send(card("x-0", "Earlier question", true));
    await waitFor(() => fake.texts().length === 1);
    const id = fake.lastMessageId;
    // Another message does not affect where the card is edited.
    a.send(card("y-0", "Another card", true));
    await waitFor(() => fake.texts().length === 2);
    a.send({ ...card("x-0", "Ignored late version"), reopen: false });
    await settle();
    expect(fake.callsOf("editMessageText")).toEqual([]);
    a.send({ ...card("x-0", "Earlier question\nContinuation"), reopen: true });
    await waitFor(() => fake.callsOf("editMessageText").length === 1);
    expect(fake.callsOf("editMessageText")[0]).toMatchObject({ message_id: id, text: "Earlier question\nContinuation" });
    expect(fake.texts().length).toBe(2);
    // A restart must remember that the formerly done card can change.
    await hub.stop();
    await startHub();
    const b = await enabled("a");
    b.send(card("x-0", "Continuation final", true));
    await waitFor(() => fake.callsOf("editMessageText").length === 2);
    expect(fake.callsOf("editMessageText")[1]).toMatchObject({ message_id: id, text: "Continuation final" });
    b.send(card("x-0", "Ignored after final"));
    await settle();
    expect(fake.callsOf("editMessageText").length).toBe(2);
  });

  test("reopen sends a missing card as a new message", async () => {
    await startHub();
    const a = await enabled("a");
    a.send({ ...card("unknown-0", "Restored history\nContinuation"), reopen: true });
    await waitFor(() => fake.texts().length === 1);
    expect(fake.texts()[0]?.text).toBe("Restored history\nContinuation");
    expect(fake.callsOf("editMessageText")).toEqual([]);
  });

  test("edits are throttled, and only the latest version goes", async () => {
    const clock = newClock();
    await startHub({ cardEditMs: CARD_THROTTLE_MS, timers: clock });
    const a = await enabled("a");
    a.send(card("x-0", "v1"));
    await waitFor(() => fake.texts().length === 1);
    a.send(card("x-0", "v2"));
    a.send(card("x-0", "v3"));
    a.send(card("x-0", "v4"));
    await settle();
    await clock.advance(CARD_THROTTLE_MS - 1);
    await settle();
    expect(fake.callsOf("editMessageText")).toEqual([]);
    await clock.advance(1);
    await waitFor(() => fake.callsOf("editMessageText").length === 1);
    await settle();
    await clock.advance(CARD_THROTTLE_MS);
    await settle();
    expect(fake.callsOf("editMessageText").map(c => c.text)).toEqual(["v4"]);
  });

  test("edits of many cards share one pace", async () => {
    const clock = newClock();
    await startHub({ cardGapMs: CARD_GAP_MS, cardEditMs: CARD_EDIT_MS, timers: clock });
    const a = await enabled("a");
    for (const id of ["x-0", "y-0", "z-0"]) a.send(card(id, `${id} v1`));
    await waitFor(() => fake.texts().length === 3);
    await settle();
    for (const id of ["x-0", "y-0", "z-0"]) a.send(card(id, `${id} v2`));
    await settle();
    // The edits take slots one gap apart: at the edit delay, then a gap later, then another gap later.
    await clock.advance(CARD_EDIT_MS);
    await waitFor(() => fake.callsOf("editMessageText").length === 1);
    await clock.advance(CARD_GAP_MS - 1);
    await settle();
    expect(fake.callsOf("editMessageText").length).toBe(1);
    await clock.advance(1);
    await waitFor(() => fake.callsOf("editMessageText").length === 2);
    await clock.advance(CARD_GAP_MS - 1);
    await settle();
    expect(fake.callsOf("editMessageText").length).toBe(2);
    await clock.advance(1);
    await waitFor(() => fake.callsOf("editMessageText").length === 3);
  });

  test("card edits wait while the session's text is being delivered", async () => {
    await startHub();
    const a = await enabled("a");
    a.send(card("x-0", "v1"));
    await waitFor(() => fake.texts().length === 1);
    fake.hangNext("sendMessage", 3);
    a.send({ type: "send", id: "t1", sessionId: "a", text: "urgent", notify: false });
    await waitFor(() => fake.callsOf("sendMessage").length === 2, WAIT_MS, "the first attempt of the text");
    a.send(card("x-0", "v2"));
    // The card's own send and four attempts of the text.
    await waitFor(() => fake.callsOf("sendMessage").length === 5 && fake.callsOf("editMessageText").length === 1, 5000);
    const order = fake.calls.map(c => c.method);
    expect(order.indexOf("editMessageText")).toBeGreaterThan(order.lastIndexOf("sendMessage"));
  });

  test("a card changed while queued is sent as its latest version", async () => {
    await startHub();
    const a = await enabled("a");
    fake.hangNext("sendMessage");
    a.send({ type: "send", id: "t1", sessionId: "a", text: "before", notify: false });
    a.send(card("x-0", "v1"));
    a.send(card("x-0", "v2"));
    await waitFor(() => fake.texts().some(t => t.text === "v2"), 5000);
    // The hung send of "before" is retried, the card goes after it.
    expect([...new Set(fake.texts().map(t => t.text))]).toEqual(["before", "v2"]);
    await settle();
    expect(fake.callsOf("editMessageText")).toEqual([]);
  });

  test("a card whose message is gone is forgotten", async () => {
    await startHub();
    const a = await enabled("a");
    a.send(card("x-0", "v1"));
    await waitFor(() => fake.texts().length === 1);
    fake.failNext("editMessageText", { code: 400, description: "Bad Request: message to edit not found" });
    a.send(card("x-0", "v2"));
    await waitFor(() => fake.callsOf("editMessageText").length === 1);
    a.send(card("x-0", "v3"));
    await waitFor(() => fake.texts().length === 2);
    expect(fake.texts()[1]?.text).toBe("v3");
  });

  test("a card of a session without a topic is dropped", async () => {
    await startHub();
    const a = await plugin("a");
    a.send(card("x-0", "v1"));
    await settle();
    expect(fake.texts()).toEqual([]);
  });
});

type RigCall = { sub: string; sid: string; args: string[] };
type RigGate = { signal?: AbortSignal; progress?: RigProgress };
type RigAnswer = RigOutput | ((gate: RigGate) => Promise<RigOutput>);

const rigOk = (value: object): RigOutput => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
const rigRefused = (code: string, message: string): RigOutput => ({ code: 1, stdout: commandFailure(code, message), stderr: "" });
const RIG_FEATURES = ["cmd", "pwsh", "bash"].map(name => ({ name, description: `the ${name} command`, enabled: true, platformAllowed: true }));

// The words of the command line the hub gave cmd.exe: the outer quotes off, the caret escapes undone (they are applied twice), then split like cmd would.
function rigTokens(invocation: RigInvocation): string[] {
  const line = must(invocation.argv.at(-1), "the command line");
  const plain = line.slice(1, -1).replace(/\^(.)/g, "$1").replace(/\^(.)/g, "$1");
  return Array.from(plain.matchAll(/"([^"]*)"|(\S+)/g), m => m[1] ?? m[2] ?? "");
}

// A rig that answers like the real one: the session commands with the recorded shapes, and what the hub asks at start.
function sessionRig() {
  const calls: RigCall[] = [];
  const infos: string[] = [];
  const answers = new Map<string, RigAnswer>();
  const compacted = { tokensBefore: TOKENS_BEFORE, tokensAfter: TOKENS_AFTER };
  const fixture = (sub: string, session: string, args: string[]): RigOutput => {
    switch (sub) {
      case "compact": return rigOk({ session, ...compacted });
      case "rename": return rigOk({ session, name: args[0] });
      case "autocompact": return rigOk({ session, window: args[0] === "auto" ? "auto" : Number(args[0]) });
      case "stop": return rigOk({ session, stopped: true, compacted });
      case "cleanup": return rigOk({ session, compacted, backup: "backup.jsonl", skillsRemoved: 0 });
      case "run": return rigOk({ session, pid: RIG_PID, mode: null, account: null });
      case "mode": return rigOk({ session, mode: args[0], pid: RIG_PID });
      default: return rigRefused("session-unknown", `no such session command: ${sub}`);
    }
  };
  const run = async (invocation: RigInvocation, signal?: AbortSignal, progress?: RigProgress): Promise<RigOutput> => {
    const [, command, sub = "", sid = "", ...args] = rigTokens(invocation);
    if (command === "feature") return rigOk({ features: RIG_FEATURES });
    if (command === "language") return rigOk({ language: "en" });
    if (command === "info") {
      infos.push(sid);
      return rigOk(fullInfo());
    }
    calls.push({ sub, sid, args });
    const answer = answers.get(sub) ?? fixture(sub, sid, args);
    return typeof answer === "function" ? answer({ ...(signal ? { signal } : {}), ...(progress ? { progress } : {}) }) : answer;
  };
  return { run, calls, infos, answer: (sub: string, answer: RigAnswer) => void answers.set(sub, answer) };
}

// An answer that prints its progress lines, then waits to be released.
function gatedAnswer(lines: string[], output: RigOutput) {
  let release = () => {};
  const opened = new Promise<void>(resolve => {
    release = resolve;
  });
  const answer: RigAnswer = async gate => {
    for (const line of lines) gate.progress?.(line);
    await opened;
    return output;
  };
  return { answer, release: () => release() };
}

describe("session commands", () => {
  const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const ACCOUNT = "2";
  const msg = (text: string) => topicMsg({ chatId: GROUP, threadId: TOPIC_ID, fromId: ME, text });
  let rig: ReturnType<typeof sessionRig>;
  beforeEach(() => {
    rig = sessionRig();
  });
  // The hub on the fake rig; rig's own start-up questions are answered before a command goes in.
  const start = async (extra: StartOptions = {}) => {
    await startHub({ findRig: () => "rig-file", runRig: rig.run, ...extra });
    await settle();
  };
  const texts = () => fake.texts().map(t => t.text);
  const edits = () => fake.callsOf("editMessageText").map(c => String(c.text));
  const shown = () => [...texts(), ...edits()];
  const callsOf = (sub: string) => rig.calls.filter(c => c.sub === sub);
  const closedSession = () => new SessionStore(join(dir, "sessions.json")).set(SID, { topicId: TOPIC_ID, title: "T", project: "p", enabled: true, cwd: CWD, account: ACCOUNT });
  const buttonsOf = (call: object) =>
    arr(field(field(call, "reply_markup"), "inline_keyboard"))
      .flatMap(row => arr(row))
      .map(b => String(field(b, "callback_data")));
  const sent = (text: string) => fake.texts().find(t => t.text === text);
  const startedAs = (text: string) => waitFor(() => sent(text), WAIT_MS, `"${text}" sent`);

  const SUCCESS = [
    { command: "/compact", sub: "compact", args: [], running: en.compactRunning, done: "✅ Compaction done: 120k → 30k tokens." },
    { command: "/compact keep the tests", sub: "compact", args: ["--instructions", "keep the tests"], running: en.compactRunning, done: "✅ Compaction done: 120k → 30k tokens." },
    { command: "/rename New name", sub: "rename", args: ["New name"], running: en.renameRunning, done: "✅ Renamed: New name" },
    { command: "/stop", sub: "stop", args: [], running: en.stopRunning, done: "⏹ Session ended\n✅ Compaction done: 120k → 30k tokens." },
    { command: "/cleanup", sub: "cleanup", args: [], running: en.cleanupRunning, done: "🧹 Cleanup done: 120k → 30k tokens." },
  ];
  for (const c of SUCCESS) {
    test(`${c.command} is one rig session ${c.sub} call and its result replaces the running message`, async () => {
      await start();
      await enabled(SID);
      fake.pushUpdate(msg(c.command));
      await waitFor(() => edits().includes(c.done), WAIT_MS, "result");
      expect(callsOf(c.sub)).toEqual([{ sub: c.sub, sid: SID, args: c.args }]);
      const started = must(sent(c.running), "running message");
      expect(started.disable_notification).toBe(true);
      expect(fake.callsOf("editMessageText")).toEqual([{ chat_id: GROUP, message_id: fake.lastMessageId, text: c.done }]);
      expect(fake.callsOf("deleteMessage")).toEqual([]);
    });
  }

  const SESSION_ENDED = "The session has ended";
  const FAILURES = [
    { command: "/compact", sub: "compact", code: "session-no-module", message: "The session has no hooks module", shows: `The session has no hooks module\n${en.sessionRestartHint}`, running: en.compactRunning },
    { command: "/rename New name", sub: "rename", code: "session-ended", message: SESSION_ENDED, shows: SESSION_ENDED, running: en.renameRunning },
    { command: "/stop", sub: "stop", code: "session-unknown", message: "No such session", shows: "No such session", running: en.stopRunning },
    { command: "/cleanup", sub: "cleanup", code: "session-cleanup-not-compacted", message: "Compact the session first", shows: "Compact the session first", running: en.cleanupRunning },
    { command: "/compact", sub: "compact", code: "session-timeout", message: "The turn did not end in time", shows: "The turn did not end in time", running: en.compactRunning },
  ];
  for (const c of FAILURES) {
    test(`${c.command} with rig's ${c.code} shows rig's words in a loud message and takes the running one away`, async () => {
      const gated = gatedAnswer([], rigRefused(c.code, c.message));
      rig.answer(c.sub, gated.answer);
      await start();
      await enabled(SID);
      fake.pushUpdate(msg(c.command));
      await startedAs(c.running);
      const runningId = fake.lastMessageId;
      gated.release();
      const failure = await startedAs(c.shows);
      expect(failure.disable_notification).toBe(false);
      await waitFor(() => fake.callsOf("deleteMessage").length === 1, WAIT_MS, "running message deleted");
      expect(fake.callsOf("deleteMessage")).toEqual([{ chat_id: GROUP, message_id: runningId }]);
      expect(fake.callsOf("editMessageText")).toEqual([]);
    });
  }

  const AUTOCOMPACT = [
    { arg: "333k", window: "333000", answer: { text: "Autocompact window set to 333000" }, done: "Autocompact window set to 333000" },
    { arg: "1.5m", window: "1500000", answer: {}, done: "✅ Autocompact window: 1500000" },
    { arg: "auto", window: "auto", answer: {}, done: "✅ Autocompact window: auto" },
  ];
  for (const c of AUTOCOMPACT) {
    test(`/compact ${c.arg} is one rig session autocompact ${c.window} call and shows rig's text or the window`, async () => {
      rig.answer("autocompact", rigOk({ session: SID, window: c.window === "auto" ? "auto" : Number(c.window), ...c.answer }));
      await start();
      await enabled(SID);
      fake.pushUpdate(msg(`/compact ${c.arg}`));
      await waitFor(() => edits().includes(c.done), WAIT_MS, "result");
      expect(callsOf("autocompact")).toEqual([{ sub: "autocompact", sid: SID, args: [c.window] }]);
      expect(callsOf("compact")).toEqual([]);
      expect(sent(en.autocompactRunning)?.disable_notification).toBe(true);
    });
  }

  test("/compact with a rig error on the autocompact shows rig's words verbatim", async () => {
    rig.answer("autocompact", rigRefused("usage", "bad window value"));
    await start();
    await enabled(SID);
    fake.pushUpdate(msg("/compact 333k"));
    const failure = await startedAs("bad window value");
    expect(failure.disable_notification).toBe(false);
  });

  for (const arg of ["0", "0k", "0.3"]) {
    test(`/compact ${arg} is refused with a notice and calls no rig`, async () => {
      await start();
      await enabled(SID);
      fake.pushUpdate(msg(`/compact ${arg}`));
      await startedAs(en.autocompactInvalid);
      await settle();
      expect(callsOf("compact")).toEqual([]);
      expect(callsOf("autocompact")).toEqual([]);
    });
  }

  test("/compact with instructions that only start like a window still compacts", async () => {
    await start();
    await enabled(SID);
    fake.pushUpdate(msg("/compact keep the plan"));
    await waitFor(() => edits().includes("✅ Compaction done: 120k → 30k tokens."), WAIT_MS, "result");
    expect(callsOf("compact")).toEqual([{ sub: "compact", sid: SID, args: ["--instructions", "keep the plan"] }]);
    expect(callsOf("autocompact")).toEqual([]);
  });

  test("a compaction rig skipped is a warning with its reason", async () => {
    rig.answer("compact", rigOk({ session: SID, skip: "a hook vetoed it" }));
    await start();
    await enabled(SID);
    fake.pushUpdate(msg("/compact"));
    const warning = await startedAs("⚠️ Compaction skipped: a hook vetoed it");
    expect(warning.disable_notification).toBe(false);
  });

  test("a stop that ended the session but not its compaction says how the compaction ended", async () => {
    rig.answer("stop", rigOk({ session: SID, stopped: true, compacted: { skip: "nothing to compact" } }));
    await start();
    await enabled(SID);
    fake.pushUpdate(msg("/stop"));
    await startedAs("⏹ Session ended\n⚠️ Compaction skipped: nothing to compact");
    rig.answer("stop", rigOk({ session: SID, stopped: true, compacted: { error: "the model refused" } }));
    fake.pushUpdate(msg("/stop"));
    await startedAs("⏹ Session ended\n⚠️ Compaction failed: the model refused");
    rig.answer("stop", rigOk({ session: SID, stopped: true, compacted: null }));
    fake.pushUpdate(msg("/stop"));
    await waitFor(() => edits().includes(en.sessionEnded), WAIT_MS, "a stop without compaction");
  });

  test("a stop that found nothing running says so", async () => {
    rig.answer("stop", rigOk({ session: SID, stopped: false, reason: "not-running" }));
    await start();
    await enabled(SID);
    fake.pushUpdate(msg("/stop"));
    await waitFor(() => edits().includes(en.sessionNotRunning), WAIT_MS, "the notice");
  });

  test("a cleanup that removed skills says how many", async () => {
    rig.answer("cleanup", rigOk({ session: SID, compacted: { tokensBefore: TOKENS_BEFORE, tokensAfter: TOKENS_AFTER }, backup: "backup.jsonl", skillsRemoved: 3 }));
    await start();
    await enabled(SID);
    fake.pushUpdate(msg("/cleanup"));
    await waitFor(() => edits().includes(en.cleanupDoneSkills({ before: "120k", after: "30k", skills: 3 })), WAIT_MS, "the result");
  });

  test("a rig that is not installed says so and no call is made", async () => {
    await startHub();
    await enabled(SID);
    fake.pushUpdate(msg("/compact"));
    await startedAs(en.rigMissing);
    expect(rig.calls).toEqual([]);
  });

  test("a rig call that outlasts its limit is aborted and reported", async () => {
    const clock = newClock();
    let seen: AbortSignal | undefined;
    rig.answer("compact", gate => {
      seen = gate.signal;
      return new Promise<RigOutput>(() => {});
    });
    await start({ timers: clock });
    await enabled(SID);
    fake.pushUpdate(msg("/compact"));
    await waitFor(() => callsOf("compact").length === 1, WAIT_MS, "the call");
    expect(seen?.aborted).toBe(false);
    await clock.advance(RIG_SESSION_LIMIT_MS - 1);
    expect(seen?.aborted).toBe(false);
    await clock.advance(1);
    await startedAs(en.rigTimeout({ seconds: RIG_SESSION_LIMIT_MS / MS_PER_S }));
    expect(seen?.aborted).toBe(true);
  });

  test("while rig waits for the turn to end the running message says so, once", async () => {
    const gated = gatedAnswer([WAITING_LINE, "not json at all", WAITING_LINE], rigOk({ session: SID, ...{ tokensBefore: TOKENS_BEFORE, tokensAfter: TOKENS_AFTER } }));
    rig.answer("compact", gated.answer);
    await start();
    await enabled(SID);
    fake.pushUpdate(msg("/compact"));
    await waitFor(() => edits().includes(en.sessionWaiting), WAIT_MS, "the waiting text");
    const startId = fake.lastMessageId;
    gated.release();
    await waitFor(() => edits().includes("✅ Compaction done: 120k → 30k tokens."), WAIT_MS, "result");
    expect(fake.callsOf("editMessageText")).toEqual([
      { chat_id: GROUP, message_id: startId, text: en.sessionWaiting },
      { chat_id: GROUP, message_id: startId, text: "✅ Compaction done: 120k → 30k tokens." },
    ]);
  });

  test("an unrelated line on rig's stderr shows nothing", async () => {
    const gated = gatedAnswer(["warming up", JSON.stringify({ progress: { code: "something-else" } })], rigOk({ session: SID, name: "N" }));
    rig.answer("rename", gated.answer);
    await start();
    await enabled(SID);
    fake.pushUpdate(msg("/rename N"));
    await startedAs(en.renameRunning);
    await waitFor(() => callsOf("rename").length === 1, WAIT_MS, "the call");
    gated.release();
    await waitFor(() => edits().includes("✅ Renamed: N"), WAIT_MS, "result");
    expect(edits()).toEqual(["✅ Renamed: N"]);
  });

  test("/rename without a name asks for one and calls nothing", async () => {
    await start();
    await enabled(SID);
    fake.pushUpdate(msg("/rename"));
    await startedAs(en.renameHint);
    expect(rig.calls).toEqual([]);
  });

  // What an outbox item keeps while its result is awaited.
  const storedIds = async () => {
    const read = () => JSON.parse(readFileSync(join(dir, "outbox.json"), "utf8"));
    await waitFor(() => arr(field(read(), "items")).length === 0);
    return Object.entries(z.record(z.string(), z.number()).parse(field(read(), "messageIds"))).map(([, id]) => id);
  };

  test("an ordinary message leaves no message id in the outbox", async () => {
    await start();
    const a = await enabled(SID);
    a.send({ type: "send", id: "x1", text: "plain text", notify: false });
    await waitFor(() => sent("plain text"));
    expect(await storedIds()).toEqual([]);
  });

  test("a failed progress edit leaves its id for the result and does not stop delivery", async () => {
    const gated = gatedAnswer([WAITING_LINE], rigOk({ session: SID, name: "N" }));
    rig.answer("rename", gated.answer);
    await start();
    await enabled(SID);
    fake.failNext("editMessageText", { code: 400, description: "Bad Request: message to edit not found" });
    fake.pushUpdate(msg("/rename N"));
    await waitFor(() => callsOf("rename").length === 1);
    await waitFor(() => fake.callsOf("editMessageText").length === 1, WAIT_MS, "the progress edit");
    const startId = fake.lastMessageId;
    gated.release();
    await waitFor(() => edits().includes("✅ Renamed: N"), WAIT_MS, "result");
    expect(fake.callsOf("editMessageText").map(c => c.message_id)).toEqual([startId, startId]);
  });

  test("a queued message keeps its id until the result arrives, then the id is gone", async () => {
    const gated = gatedAnswer([], rigOk({ session: SID, name: "N" }));
    rig.answer("rename", gated.answer);
    await start();
    await enabled(SID);
    fake.pushUpdate(msg("/rename N"));
    await startedAs(en.renameRunning);
    const startId = fake.lastMessageId;
    await waitFor(async () => (await storedIds()).includes(startId));
    gated.release();
    await waitFor(() => edits().includes("✅ Renamed: N"), WAIT_MS, "result");
    expect(await storedIds()).toEqual([]);
  });

  test("a result that comes while its running message is being sent edits that message", async () => {
    await start();
    await enabled(SID);
    fake.delayNext("sendMessage", SLOW_SEND_MS / 2);
    fake.pushUpdate(msg("/rename N"));
    await waitFor(() => edits().includes("✅ Renamed: N"), WAIT_MS, "result");
    expect(fake.texts().filter(t => t.message_thread_id === TOPIC_ID && t.text === en.renameRunning)).toHaveLength(1);
    expect(fake.callsOf("editMessageText")).toHaveLength(1);
  });

  test("/info draws rig's answer for the session", async () => {
    await start();
    await enabled(SID);
    fake.pushUpdate(msg("/info"));
    const info = await waitFor(() => fake.texts().find(t => t.text.includes("Context")), WAIT_MS, "the info text");
    expect(info.text).toContain("120/300k");
    expect(rig.infos).toEqual([SID]);
  });

  test("/run starts a closed session through rig on the account given", async () => {
    closedSession();
    await start();
    fake.pushUpdate(msg("/run 3"));
    await waitFor(() => callsOf("run").length === 1, WAIT_MS, "the run call");
    expect(callsOf("run")).toEqual([{ sub: "run", sid: SID, args: ["--account", "3"] }]);
    await startedAs(en.launching({ account: "3" }));
  });

  test("/run without a number takes the account the session ran on", async () => {
    closedSession();
    await start();
    fake.pushUpdate(msg("/run"));
    await waitFor(() => callsOf("run").length === 1, WAIT_MS, "the run call");
    expect(callsOf("run")[0]?.args).toEqual(["--account", ACCOUNT]);
  });

  test("a started session's window turns the start notice into a success", async () => {
    closedSession();
    await start();
    fake.pushUpdate(msg("/run"));
    await startedAs(en.launching({ account: ACCOUNT }));
    await waitFor(() => callsOf("run").length === 1);
    await settle();
    await plugin(SID);
    await waitFor(() => shown().includes(en.sessionLaunched), WAIT_MS, "the started text");
  });

  test("a second /run while one starts, or a window is open, starts nothing", async () => {
    const gated = gatedAnswer([], rigOk({ session: SID, pid: RIG_PID, mode: null, account: null }));
    rig.answer("run", gated.answer);
    closedSession();
    await start();
    fake.pushUpdate(msg("/run"));
    await waitFor(() => callsOf("run").length === 1, WAIT_MS, "the run call");
    fake.pushUpdate(msg("/run"));
    await startedAs(en.sessionAlreadyStarting);
    gated.release();
    await settle();
    await plugin(SID);
    fake.pushUpdate(msg("/run"));
    await startedAs(en.sessionAlreadyRunning);
    expect(callsOf("run")).toHaveLength(1);
  });

  test("/run with a number on a machine without accounts is refused", async () => {
    closedSession();
    await start({ accountsAvailable: () => false });
    fake.pushUpdate(msg("/run 3"));
    await startedAs(en.noAccounts);
    expect(callsOf("run")).toEqual([]);
  });

  test("a launch rig refuses shows rig's words and takes the start notice away", async () => {
    const gated = gatedAnswer([], rigRefused("launch-unavailable", "No terminal to start the session in"));
    rig.answer("run", gated.answer);
    closedSession();
    await start();
    fake.pushUpdate(msg("/run"));
    await startedAs(en.launching({ account: ACCOUNT }));
    const noticeId = fake.lastMessageId;
    gated.release();
    const failure = await startedAs("No terminal to start the session in");
    expect(failure.disable_notification).toBe(false);
    await waitFor(() => fake.callsOf("deleteMessage").length === 1, WAIT_MS, "start notice deleted");
    expect(fake.callsOf("deleteMessage")).toEqual([{ chat_id: GROUP, message_id: noticeId }]);
  });

  test("a start that waits for the turn of a running session says so", async () => {
    const gated = gatedAnswer([WAITING_LINE], rigOk({ session: SID, pid: RIG_PID, mode: null, account: null }));
    rig.answer("run", gated.answer);
    closedSession();
    await start();
    fake.pushUpdate(msg("/run"));
    await startedAs(en.sessionWaiting);
    gated.release();
  });

  test("a start whose window never comes is reported once the wait ends", async () => {
    const clock = newClock();
    closedSession();
    // The service runs the hub with --always-on (idleMs 0); the default idle exit would stop it inside the 90 s wait.
    await start({ timers: clock, idleMs: 0 });
    fake.pushUpdate(msg("/run"));
    await waitFor(() => callsOf("run").length === 1, WAIT_MS, "the run call");
    await settle();
    await clock.advance(CONNECT_WAIT_MS - 1);
    expect(texts()).not.toContain(en.sessionDidNotStart({ seconds: CONNECT_WAIT_MS / MS_PER_S }));
    await clock.advance(1);
    await startedAs(en.sessionDidNotStart({ seconds: CONNECT_WAIT_MS / MS_PER_S }));
  });

  test("a message for a session without a window starts it through rig and reaches it once", async () => {
    closedSession();
    await start();
    fake.pushUpdate(msg("hello there"));
    await waitFor(() => callsOf("run").length === 1, WAIT_MS, "the run call");
    expect(callsOf("run")).toEqual([{ sub: "run", sid: SID, args: ["--account", ACCOUNT] }]);
    const w = await plugin(SID);
    const inbound = await w.next("inbound", m => m.content === "hello there", WAIT_MS);
    expect(inbound.content).toBe("hello there");
    await settle();
    expect(w.messages.filter(m => m.type === "inbound")).toHaveLength(1);
    await waitFor(() => shown().includes(en.sessionLaunched), WAIT_MS, "the started text");
  });

  test("/cleanup on a session without a window starts it first", async () => {
    closedSession();
    await start();
    fake.pushUpdate(msg("/cleanup"));
    await waitFor(() => callsOf("run").length === 1, WAIT_MS, "the run call");
    expect(callsOf("run")).toEqual([{ sub: "run", sid: SID, args: ["--account", ACCOUNT] }]);
    await plugin(SID);
    await waitFor(() => callsOf("cleanup").length === 1, WAIT_MS, "the cleanup call");
    expect(callsOf("cleanup")).toEqual([{ sub: "cleanup", sid: SID, args: [] }]);
    await waitFor(() => edits().includes("🧹 Cleanup done: 120k → 30k tokens."), WAIT_MS, "the result");
  });

  test("a command result for a session without a window starts it through rig and reaches the agent once", async () => {
    closedSession();
    const x = new FakeExec();
    await start({ execClient: x });
    fake.pushUpdate(msg(PLATFORM.windows ? "/cmd echo hi" : "/bash echo hi"));
    await waitFor(() => x.starts.length === 1, WAIT_MS, "the exec start");
    x.write(x.last(), "hi\n");
    x.finish(x.last(), { kind: "exit", code: 0 });
    await waitFor(() => callsOf("run").length === 1, WAIT_MS, "the run call");
    expect(callsOf("run")).toEqual([{ sub: "run", sid: SID, args: ["--account", ACCOUNT] }]);
    const w = await plugin(SID);
    const inbound = await w.next("inbound", m => m.meta.source === "exec", WAIT_MS);
    expect(inbound.meta.exit_code).toBe("0");
    await settle();
    expect(w.messages.filter(m => m.type === "inbound")).toHaveLength(1);
  });

  test("/mode lists the modes as buttons without calling rig", async () => {
    await start();
    await enabled(SID);
    fake.pushUpdate(msg("/mode"));
    const card = await waitFor(() => fake.callsOf("sendMessage").find(c => buttonsOf(c).length > 0), WAIT_MS, "the mode buttons");
    expect(buttonsOf(card)).toEqual(["manual", "auto", "acceptEdits", "plan", "dontAsk"].map(mode => `m:${SID}:${mode}`));
    expect(rig.calls).toEqual([]);
  });

  test("/mode with an unknown name lists the modes", async () => {
    await start();
    await enabled(SID);
    fake.pushUpdate(msg("/mode nonsense"));
    await startedAs(en.modeList({ modes: "manual, auto, acceptEdits, plan, dontAsk" }));
    expect(rig.calls).toEqual([]);
  });

  test("a mode button is one rig session mode call; the new window is the session's, and the same mode again changes nothing", async () => {
    await start();
    const old = await enabled(SID);
    fake.pushUpdate(msg("/mode"));
    const card = await waitFor(() => fake.callsOf("sendMessage").find(c => buttonsOf(c).length > 0), WAIT_MS, "the mode buttons");
    const data = `m:${SID}:plan`;
    expect(buttonsOf(card)).toContain(data);
    fake.pushUpdate(buttonPress({ chatId: GROUP, fromId: ME, messageId: fake.lastMessageId, data }));
    await waitFor(() => callsOf("mode").length === 1, WAIT_MS, "the mode call");
    expect(callsOf("mode")).toEqual([{ sub: "mode", sid: SID, args: ["plan"] }]);
    await waitFor(() => fake.callsOf("editMessageReplyMarkup").length === 1, WAIT_MS, "the keyboard removed");
    await waitFor(() => fake.callsOf("answerCallbackQuery").length === 1, WAIT_MS, "the button answered");
    await startedAs(en.restartingInMode({ mode: "plan" }));
    old.close();
    await waitFor(() => !hub.isConnected(SID));
    await plugin(SID, "win2");
    await waitFor(() => shown().includes(en.sessionLaunched), WAIT_MS, "the started text");
    fake.pushUpdate(msg("/mode plan"));
    await startedAs(en.modeAlready({ mode: "plan" }));
    expect(callsOf("mode")).toHaveLength(1);
  });

  test("a mode rig reports as unchanged says so and starts no wait", async () => {
    rig.answer("mode", rigOk({ session: SID, mode: "plan", changed: false }));
    await start();
    await enabled(SID);
    fake.pushUpdate(msg("/mode plan"));
    await startedAs(en.modeAlready({ mode: "plan" }));
    await waitFor(() => fake.callsOf("deleteMessage").length === 1, WAIT_MS, "the restart notice deleted");
  });

  test("a mode rig refuses shows rig's words and takes the restart notice away", async () => {
    rig.answer("mode", rigRefused("session-timeout", "The turn did not end in time"));
    await start();
    await enabled(SID);
    fake.pushUpdate(msg("/mode plan"));
    const failure = await startedAs("The turn did not end in time");
    expect(failure.disable_notification).toBe(false);
    await waitFor(() => fake.callsOf("deleteMessage").length === 1, WAIT_MS, "the restart notice deleted");
  });

  test("a mode button nobody knows only answers the press", async () => {
    await start();
    await enabled(SID);
    fake.pushUpdate(buttonPress({ chatId: GROUP, fromId: ME, messageId: 1, data: "m:99999999-bbbb-cccc-dddd-eeeeeeeeeeee:plan" }));
    await waitFor(() => fake.callsOf("answerCallbackQuery").length === 1, WAIT_MS, "the answer");
    expect(rig.calls).toEqual([]);
  });
});

// While a session is stopped, cleaned, switched to another mode or started, whatever arrives for it is held and goes, in arrival order, to the next window once it connects.
describe("holding across session actions", () => {
  const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const ACCOUNT = "2";
  const TRANSCRIPT_ID = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
  const STRANGER = "999";
  type Win = Awaited<ReturnType<typeof plugin>>;
  const msg = (text: string) => topicMsg({ chatId: GROUP, threadId: TOPIC_ID, fromId: ME, text });
  let rig: ReturnType<typeof sessionRig>;
  beforeEach(() => {
    rig = sessionRig();
  });
  const start = async (extra: StartOptions = {}) => {
    await startHub({ findRig: () => "rig-file", runRig: rig.run, ...extra });
    await settle();
  };
  const texts = () => fake.texts().map(t => t.text);
  const edits = () => fake.callsOf("editMessageText").map(c => String(c.text));
  const shown = () => [...texts(), ...edits()];
  const callsOf = (sub: string) => rig.calls.filter(c => c.sub === sub);
  const closedSession = () => new SessionStore(join(dir, "sessions.json")).set(SID, { topicId: TOPIC_ID, title: "T", project: "p", enabled: true, cwd: CWD, account: ACCOUNT });
  const contentsOf = (w: Win) => w.messages.flatMap(m => (m.type === "inbound" ? [m.content] : []));
  const pressMode = (mode: string, fromId = ME) => fake.pushUpdate(buttonPress({ chatId: GROUP, fromId, messageId: TOPIC_ID, data: `m:${SID}:${mode}` }));
  const inbound = (content: string, onSent = () => {}) => ({ content, meta: { exec_id: content }, onSent });
  // The mode call is out, so the hub has begun the switch and holds what comes.
  const modeStarted = () => waitFor(() => callsOf("mode").length === 1, WAIT_MS, "the mode call");
  const stopStarted = () => waitFor(() => callsOf("stop").length === 1, WAIT_MS, "the stop call");
  const windowGone = () => waitFor(() => !hub.isConnected(SID), WAIT_MS, "the window gone");
  // Lets the continuations of work the test just released run (event-loop turns, not wall-clock time).
  const turns = async () => {
    for (let i = 0; i < EVENT_LOOP_TURNS; i++) await new Promise<void>(resolve => setImmediate(resolve));
  };
  const reopen = async (old: Win) => {
    old.close();
    await windowGone();
    return plugin(SID, "win2");
  };
  // What a window got once Claude Code is ready for it and the hub has handled everything.
  const arrived = async (clock: Clock, w: Win, count: number) => {
    await passReadyDelay(clock);
    await waitFor(() => contentsOf(w).length >= count, WAIT_MS, "the items");
    await settle();
    return contentsOf(w);
  };

  test("/stop holds what arrives until the window is gone; the next window gets it in order", async () => {
    const clock = newClock();
    const gated = gatedAnswer([], rigOk({ session: SID, stopped: true, compacted: null }));
    rig.answer("stop", gated.answer);
    await start({ timers: clock, idleMs: 0 });
    const old = await enabled(SID);
    fake.pushUpdate(msg("/stop"));
    await stopStarted();
    fake.pushUpdate(msg("held one"));
    fake.pushUpdate(msg("held two"));
    await updatesHandled();
    gated.release();
    await settle();
    await waitFor(() => edits().includes(en.sessionEnded), WAIT_MS, "the stop result");
    await clock.advance(BATCH_QUIET_MS + READY_DELAY_MS);
    await settle();
    expect(callsOf("run")).toEqual([]);
    expect(contentsOf(old)).toEqual([]);
    old.close();
    await waitFor(() => callsOf("run").length === 1, WAIT_MS, "the start");
    const next = await plugin(SID, "win2");
    expect(await arrived(clock, next, 1)).toEqual(["held one\n\nheld two"]);
    expect(contentsOf(old)).toEqual([]);
  });

  test("a window that closes before rig answers the stop hands the items over at the answer", async () => {
    const clock = newClock();
    const gated = gatedAnswer([], rigOk({ session: SID, stopped: true, compacted: null }));
    rig.answer("stop", gated.answer);
    await start({ timers: clock, idleMs: 0 });
    const old = await enabled(SID);
    fake.pushUpdate(msg("/stop"));
    await stopStarted();
    fake.pushUpdate(msg("held while closing"));
    await updatesHandled();
    old.close();
    await windowGone();
    await updatesHandled();
    expect(callsOf("run")).toEqual([]);
    gated.release();
    await waitFor(() => callsOf("run").length === 1, WAIT_MS, "the start");
    const next = await plugin(SID, "win2");
    expect(await arrived(clock, next, 1)).toEqual(["held while closing"]);
  });

  test("a window that stays open after a successful stop never gets the items, however long it stays", async () => {
    const clock = newClock();
    rig.answer("stop", rigOk({ session: SID, stopped: true, compacted: null }));
    await start({ timers: clock, idleMs: 0 });
    const old = await enabled(SID);
    fake.pushUpdate(msg("/stop"));
    await waitFor(() => edits().includes(en.sessionEnded), WAIT_MS, "the stop result");
    fake.pushUpdate(msg("held for a lingering window"));
    await updatesHandled();
    await clock.advance(LINGERING_WINDOW_MS);
    await settle();
    expect(contentsOf(old)).toEqual([]);
    expect(callsOf("run")).toEqual([]);
    // A different window connecting ends the hold and gets the items, while the old one is still open.
    const next = await plugin(SID, "win2");
    expect(await arrived(clock, next, 1)).toEqual(["held for a lingering window"]);
    expect(contentsOf(old)).toEqual([]);
  });

  test("a late hello from the window being ended gets nothing; the items go on when its connection closes", async () => {
    const clock = newClock();
    rig.answer("stop", rigOk({ session: SID, stopped: true, compacted: null }));
    await start({ timers: clock, idleMs: 0 });
    const old = await enabled(SID);
    // A connection that has not said hello when the stop begins could be the window being ended.
    const late = await wsClient(port);
    clients.push(late);
    fake.pushUpdate(msg("/stop"));
    await waitFor(() => edits().includes(en.sessionEnded), WAIT_MS, "the stop result");
    fake.pushUpdate(msg("held for the next window"));
    await updatesHandled();
    old.close();
    await windowGone();
    late.send(hello(SID, "late"));
    await late.next("state");
    await settle();
    await passReadyDelay(clock);
    await settle();
    expect(contentsOf(late)).toEqual([]);
    expect(callsOf("run")).toEqual([]);
    late.close();
    await waitFor(() => callsOf("run").length === 1, WAIT_MS, "the start");
    const next = await plugin(SID, "win2");
    expect(await arrived(clock, next, 1)).toEqual(["held for the next window"]);
    expect(contentsOf(late)).toEqual([]);
  });

  test("/stop takes the waiting batch with it, and what comes after, until the window is gone", async () => {
    const clock = newClock();
    const gated = gatedAnswer([], rigOk({ session: SID, stopped: true, compacted: null }));
    rig.answer("stop", gated.answer);
    await start({ timers: clock, idleMs: 0 });
    const old = await enabled(SID);
    fake.pushUpdate(msg("before stop"));
    await waitFor(() => hub.busy().includes("message batches"), WAIT_MS, "the batch opened");
    fake.pushUpdate(msg("/stop"));
    await stopStarted();
    fake.pushUpdate(msg("after stop"));
    await updatesHandled();
    await clock.advance(BATCH_QUIET_MS);
    gated.release();
    await waitFor(() => edits().includes(en.sessionEnded), WAIT_MS, "the stop result");
    await settle();
    expect(contentsOf(old)).toEqual([]);
    old.close();
    await waitFor(() => callsOf("run").length === 1, WAIT_MS, "the start");
    const next = await plugin(SID, "win2");
    expect(await arrived(clock, next, 1)).toEqual(["before stop\n\nafter stop"]);
  });

  test("/cleanup sends the waiting batch to the window first, then holds what arrives until the window is gone", async () => {
    const clock = newClock();
    const gated = gatedAnswer([], rigOk({ session: SID, compacted: { tokensBefore: TOKENS_BEFORE, tokensAfter: TOKENS_AFTER }, backup: "backup.jsonl", skillsRemoved: 0 }));
    rig.answer("cleanup", gated.answer);
    await start({ timers: clock, idleMs: 0 });
    const old = await enabled(SID);
    fake.pushUpdate(msg("before cleanup"));
    await waitFor(() => hub.busy().includes("message batches"), WAIT_MS, "the batch opened");
    fake.pushUpdate(msg("/cleanup"));
    await waitFor(() => callsOf("cleanup").length === 1, WAIT_MS, "the cleanup call");
    fake.pushUpdate(msg("during cleanup"));
    await updatesHandled();
    await clock.advance(BATCH_QUIET_MS);
    await waitFor(() => contentsOf(old).length === 1, WAIT_MS, "the batch before the command");
    gated.release();
    await waitFor(() => edits().includes("🧹 Cleanup done: 120k → 30k tokens."), WAIT_MS, "the cleanup result");
    await settle();
    expect(callsOf("run")).toEqual([]);
    expect(contentsOf(old)).toEqual(["before cleanup"]);
    old.close();
    await waitFor(() => callsOf("run").length === 1, WAIT_MS, "the start");
    const next = await plugin(SID, "win2");
    expect(await arrived(clock, next, 1)).toEqual(["during cleanup"]);
  });

  test("a /run, /mode or mode button while a stop is under way says the session is being stopped", async () => {
    const clock = newClock();
    const gated = gatedAnswer([], rigOk({ session: SID, stopped: true, compacted: null }));
    rig.answer("stop", gated.answer);
    await start({ timers: clock, idleMs: 0 });
    await enabled(SID);
    fake.pushUpdate(msg("/stop"));
    await stopStarted();
    fake.pushUpdate(msg("/run"));
    fake.pushUpdate(msg("/mode plan"));
    pressMode("auto");
    await waitFor(() => texts().filter(t => t === en.sessionEnding).length === 3, WAIT_MS, "three refusals");
    expect(texts()).not.toContain(en.sessionAlreadyStarting);
    expect(callsOf("run")).toEqual([]);
    expect(callsOf("mode")).toEqual([]);
    gated.release();
    await settle();
  });

  test("a second mode press while the switch is under way starts nothing more", async () => {
    const clock = newClock();
    await start({ timers: clock, idleMs: 0 });
    await enabled(SID);
    pressMode("plan");
    await modeStarted();
    pressMode("auto");
    await waitFor(() => texts().includes(en.sessionAlreadyStarting), WAIT_MS, "the refusal");
    expect(callsOf("mode")).toEqual([{ sub: "mode", sid: SID, args: ["plan"] }]);
  });

  test("a mode press takes a waiting batch and an open replay before the window can get them", async () => {
    const clock = newClock();
    await start({ timers: clock, idleMs: 0 });
    const old = await enabled(SID);
    fake.pushUpdate(msg("waiting batch"));
    await waitFor(() => hub.busy().includes("message batches"), WAIT_MS, "the batch opened");
    hub["replay"](SID, [{ message: must(msg("open replay").message) }]);
    pressMode("plan");
    await modeStarted();
    await clock.advance(BATCH_QUIET_MS + READY_DELAY_MS);
    await settle();
    expect(contentsOf(old)).toEqual([]);
    const next = await reopen(old);
    expect(await arrived(clock, next, 1)).toEqual(["waiting batch\n\nopen replay"]);
    expect(contentsOf(old)).toEqual([]);
  });

  test("attachment preparation that finishes after the switch began cannot send to the ending window", async () => {
    const clock = newClock();
    await start({ timers: clock, idleMs: 0 });
    const old = await enabled(SID);
    let release = () => {};
    const prepared = new Promise<void>(resolve => {
      release = resolve;
    });
    let reached = false;
    const original = hub["inboundOf"].bind(hub);
    hub["inboundOf"] = async (api, message) => {
      reached = true;
      await prepared;
      return original(api, message);
    };
    const sending = hub["queueBatch"](SID, hub["requireApi"](), [must(msg("slow attachment").message)]);
    await waitFor(() => reached, WAIT_MS, "the preparation started");
    pressMode("plan");
    await modeStarted();
    fake.pushUpdate(msg("after the attachment"));
    await updatesHandled();
    expect(contentsOf(old)).toEqual([]);
    // The preparation ends while the old window is still open: it must not send there.
    release();
    await sending;
    await turns();
    expect(contentsOf(old)).toEqual([]);
    const next = await reopen(old);
    expect(await arrived(clock, next, 1)).toEqual(["slow attachment\n\nafter the attachment"]);
    expect(contentsOf(old)).toEqual([]);
  });

  test("attachment preparation that finishes after a failed switch with no window does not start a second launch", async () => {
    const clock = newClock();
    const gated = gatedAnswer([], rigRefused("session-timeout", "The turn did not end in time"));
    rig.answer("mode", gated.answer);
    await start({ timers: clock, idleMs: 0 });
    const old = await enabled(SID);
    let release = () => {};
    const prepared = new Promise<void>(resolve => {
      release = resolve;
    });
    let reached = false;
    const original = hub["inboundOf"].bind(hub);
    hub["inboundOf"] = async (api, message) => {
      reached = true;
      await prepared;
      return original(api, message);
    };
    const sending = hub["queueBatch"](SID, hub["requireApi"](), [must(msg("slow attachment").message)]);
    await waitFor(() => reached, WAIT_MS, "the preparation started");
    pressMode("plan");
    await modeStarted();
    old.close();
    await windowGone();
    // Rig fails with no window: the held message is kept for the next start.
    gated.release();
    await waitFor(() => texts().some(t => t.includes(en.pendingDelivery({ count: 1 }))), WAIT_MS, "the kept notice");
    // The preparation ends only now: the kept message must not start a launch of its own.
    release();
    await sending;
    await turns();
    await settle();
    expect(callsOf("run")).toEqual([]);
    fake.pushUpdate(msg("/run"));
    await waitFor(() => callsOf("run").length === 1, WAIT_MS, "the start");
    const next = await plugin(SID, "win2");
    expect(await arrived(clock, next, 1)).toEqual(["slow attachment"]);
    expect(callsOf("run").length).toBe(1);
  });

  test("an open poll ends when the session is stopped, and the next typed answer is not swallowed", async () => {
    const clock = newClock();
    const gated = gatedAnswer([], rigOk({ session: SID, stopped: true, compacted: null }));
    rig.answer("stop", gated.answer);
    await start({ timers: clock, idleMs: 0 });
    const old = await enabled(SID);
    let decided: unknown;
    hub["polls"].set("poll", {
      key: "poll",
      sessionId: SID,
      questions: [],
      answers: {},
      index: 0,
      checked: new Set(),
      messageIds: [],
      outcomes: [],
      taken: [],
      done: false,
      resolve: decision => {
        decided = decision;
      },
    });
    fake.pushUpdate(msg("/stop"));
    await stopStarted();
    await waitFor(() => decided !== undefined, WAIT_MS, "the poll ended");
    expect(decided).toEqual({ decision: "none" });
    fake.pushUpdate(msg("typed answer"));
    await updatesHandled();
    gated.release();
    await waitFor(() => edits().includes(en.sessionEnded), WAIT_MS, "the stop result");
    const next = await reopen(old);
    expect(await arrived(clock, next, 1)).toEqual(["typed answer"]);
    expect(contentsOf(old)).toEqual([]);
  });

  test("an in-flight replay is taken with its result and cannot overtake what comes after", async () => {
    const clock = newClock();
    await start({ timers: clock, idleMs: 0 });
    const old = await enabled(SID);
    let release = () => {};
    const preparation = new Promise<void>(resolve => {
      release = resolve;
    });
    let reached = false;
    const original = hub["inboundOf"].bind(hub);
    hub["inboundOf"] = async (api, message) => {
      reached = true;
      await preparation;
      return original(api, message);
    };
    let acknowledged = 0;
    hub["replay"](SID, [
      { message: must(msg("replay attachment").message) },
      { inbound: inbound("replay result", () => void acknowledged++) },
    ]);
    await passReadyDelay(clock);
    await waitFor(() => reached, WAIT_MS, "the replay is preparing its first message");
    pressMode("plan");
    await modeStarted();
    fake.pushUpdate(msg("after the replay"));
    await updatesHandled();
    // The preparation ends while the old window is still open: the replay must not send there.
    release();
    await turns();
    expect(contentsOf(old)).toEqual([]);
    expect(acknowledged).toBe(0);
    const next = await reopen(old);
    expect(await arrived(clock, next, 3)).toEqual(["replay attachment", "replay result", "after the replay"]);
    expect(contentsOf(old)).toEqual([]);
    expect(acknowledged).toBe(1);
  });

  test("exec results during the switch and during readiness join one ordered replay", async () => {
    const clock = newClock();
    await start({ timers: clock, idleMs: 0 });
    const old = await enabled(SID);
    let delivered = 0;
    pressMode("plan");
    await modeStarted();
    fake.pushUpdate(msg("first"));
    await updatesHandled();
    hub["reportExec"](SID, inbound("during restart", () => void delivered++));
    fake.pushUpdate(msg("last held message"));
    await updatesHandled();
    const next = await reopen(old);
    hub["reportExec"](SID, inbound("during readiness", () => void delivered++));
    expect(contentsOf(next)).toEqual([]);
    expect(await arrived(clock, next, 4)).toEqual(["first", "during restart", "last held message", "during readiness"]);
    expect(delivered).toBe(2);
    expect(contentsOf(old)).toEqual([]);
    expect(shown()).not.toContain(en.sessionEnded);
  });

  test("a malformed, a stale and an unauthorised mode button never reach rig", async () => {
    await start();
    await enabled(SID);
    pressMode("not-a-mode");
    fake.pushUpdate(buttonPress({ chatId: GROUP, fromId: ME, messageId: TOPIC_ID, data: "m:not-a-session:plan" }));
    fake.pushUpdate(buttonPress({ chatId: GROUP, fromId: ME, messageId: TOPIC_ID, data: "m:99999999-bbbb-cccc-dddd-eeeeeeeeeeee:plan" }));
    pressMode("plan", STRANGER);
    await settle();
    expect(rig.calls).toEqual([]);
    expect(hub.isConnected(SID)).toBe(true);
  });

  test("a mode rig refuses keeps messages and exec results for the next start", async () => {
    const clock = newClock();
    const gated = gatedAnswer([], rigRefused("session-timeout", "The turn did not end in time"));
    rig.answer("mode", gated.answer);
    await start({ timers: clock, idleMs: 0 });
    const old = await enabled(SID);
    let delivered = false;
    pressMode("plan");
    await modeStarted();
    fake.pushUpdate(msg("kept message"));
    await updatesHandled();
    hub["reportExec"](SID, inbound("kept result", () => {
      delivered = true;
    }));
    old.close();
    await windowGone();
    gated.release();
    await waitFor(() => texts().some(t => t.includes(en.pendingDelivery({ count: 2 }))), WAIT_MS, "the kept notice");
    expect(delivered).toBe(false);
    expect(callsOf("run")).toEqual([]);
    fake.pushUpdate(msg("/run"));
    await waitFor(() => callsOf("run").length === 1, WAIT_MS, "the start");
    const next = await plugin(SID, "win2");
    expect(await arrived(clock, next, 2)).toEqual(["kept message", "kept result"]);
    expect(delivered).toBe(true);
  });

  test("a start whose window never connects keeps messages and exec results for the next start", async () => {
    const clock = newClock();
    await start({ timers: clock, idleMs: 0 });
    const old = await enabled(SID);
    let delivered = false;
    pressMode("plan");
    await modeStarted();
    fake.pushUpdate(msg("kept message"));
    await updatesHandled();
    hub["reportExec"](SID, inbound("kept result", () => {
      delivered = true;
    }));
    old.close();
    await windowGone();
    await settle();
    await clock.advance(CONNECT_WAIT_MS);
    await waitFor(() => texts().some(t => t.includes(en.pendingDelivery({ count: 2 }))), WAIT_MS, "the kept notice");
    expect(delivered).toBe(false);
    fake.pushUpdate(msg("/run"));
    await waitFor(() => callsOf("run").length === 1, WAIT_MS, "the start");
    const next = await plugin(SID, "win2");
    expect(await arrived(clock, next, 2)).toEqual(["kept message", "kept result"]);
    expect(delivered).toBe(true);
  });

  test("a mode rig says is unchanged lets the held items go to the window that stayed", async () => {
    const clock = newClock();
    const gated = gatedAnswer([], rigOk({ session: SID, mode: "plan", changed: false }));
    rig.answer("mode", gated.answer);
    await start({ timers: clock, idleMs: 0 });
    const old = await enabled(SID);
    pressMode("plan");
    await modeStarted();
    fake.pushUpdate(msg("while changing"));
    await updatesHandled();
    expect(contentsOf(old)).toEqual([]);
    gated.release();
    await waitFor(() => texts().includes(en.modeAlready({ mode: "plan" })), WAIT_MS, "the notice");
    expect(await arrived(clock, old, 1)).toEqual(["while changing"]);
    expect(callsOf("run")).toEqual([]);
  });

  test("a stop rig refuses while the window is open gives the held items back to that window", async () => {
    const clock = newClock();
    const gated = gatedAnswer([], rigRefused("session-unknown", "No such session"));
    rig.answer("stop", gated.answer);
    await start({ timers: clock, idleMs: 0 });
    const old = await enabled(SID);
    fake.pushUpdate(msg("/stop"));
    await stopStarted();
    fake.pushUpdate(msg("held while stopping"));
    await updatesHandled();
    expect(contentsOf(old)).toEqual([]);
    gated.release();
    await waitFor(() => shown().includes("No such session"), WAIT_MS, "the refusal");
    expect(await arrived(clock, old, 1)).toEqual(["held while stopping"]);
    expect(callsOf("run")).toEqual([]);
  });

  test("a stop that found nothing running lets the held items go the way a new message would", async () => {
    const clock = newClock();
    const gated = gatedAnswer([], rigOk({ session: SID, stopped: false, reason: "not-running" }));
    rig.answer("stop", gated.answer);
    await start({ timers: clock, idleMs: 0 });
    const old = await enabled(SID);
    fake.pushUpdate(msg("/stop"));
    await stopStarted();
    fake.pushUpdate(msg("held while stopping"));
    await updatesHandled();
    gated.release();
    await waitFor(() => edits().includes(en.sessionNotRunning), WAIT_MS, "the notice");
    expect(await arrived(clock, old, 1)).toEqual(["held while stopping"]);
  });

  for (const command of ["/run", "/mode plan"]) {
    test(`a /stop of a ${command} that has not connected keeps what it held for the next start`, async () => {
      const clock = newClock();
      const gated = gatedAnswer([], rigOk({ session: SID, pid: RIG_PID, mode: null, account: null }));
      rig.answer("run", gated.answer);
      rig.answer("mode", gated.answer);
      closedSession();
      await start({ timers: clock, idleMs: 0 });
      fake.pushUpdate(msg(command));
      await waitFor(() => callsOf(command === "/run" ? "run" : "mode").length === 1, WAIT_MS, "the start call");
      fake.pushUpdate(msg("held until the cancelled start ends"));
      await updatesHandled();
      fake.pushUpdate(msg("/stop"));
      await stopStarted();
      await waitFor(() => texts().some(t => t.includes(en.pendingDelivery({ count: 1 }))), WAIT_MS, "the kept notice");
      gated.release();
      await settle();
      fake.pushUpdate(msg("/run"));
      await waitFor(() => callsOf("run").length === (command === "/run" ? 2 : 1), WAIT_MS, "the next start");
      const next = await plugin(SID);
      expect(await arrived(clock, next, 1)).toEqual(["held until the cancelled start ends"]);
    });
  }

  test("a message that starts a session is held with what arrives during the start, in arrival order", async () => {
    const clock = newClock();
    const gated = gatedAnswer([], rigOk({ session: SID, pid: RIG_PID, mode: null, account: null }));
    rig.answer("run", gated.answer);
    closedSession();
    await start({ timers: clock, idleMs: 0 });
    fake.pushUpdate(msg("first"));
    await waitFor(() => callsOf("run").length === 1, WAIT_MS, "the start call");
    fake.pushUpdate(msg("second"));
    await updatesHandled();
    gated.release();
    await settle();
    const w = await plugin(SID);
    expect(await arrived(clock, w, 1)).toEqual(["first\n\nsecond"]);
  });

  test("a /cleanup that starts a session holds what arrives during the start and, after it, during the cleanup", async () => {
    const clock = newClock();
    const gated = gatedAnswer([], rigOk({ session: SID, compacted: { tokensBefore: TOKENS_BEFORE, tokensAfter: TOKENS_AFTER }, backup: "backup.jsonl", skillsRemoved: 0 }));
    rig.answer("cleanup", gated.answer);
    closedSession();
    await start({ timers: clock, idleMs: 0 });
    fake.pushUpdate(msg("/cleanup"));
    await waitFor(() => callsOf("run").length === 1, WAIT_MS, "the start call");
    fake.pushUpdate(msg("while starting"));
    await updatesHandled();
    const w = await plugin(SID);
    await passReadyDelay(clock);
    await waitFor(() => callsOf("cleanup").length === 1, WAIT_MS, "the cleanup call");
    await updatesHandled();
    expect(contentsOf(w)).toEqual([]);
    gated.release();
    await waitFor(() => edits().includes("🧹 Cleanup done: 120k → 30k tokens."), WAIT_MS, "the cleanup result");
    const next = await reopen(w);
    expect(await arrived(clock, next, 1)).toEqual(["while starting"]);
    expect(callsOf("run")).toHaveLength(2);
    expect(contentsOf(w)).toEqual([]);
  });

  test("a command result that starts a session is held with what arrives during the start, in arrival order", async () => {
    const clock = newClock();
    const gated = gatedAnswer([], rigOk({ session: SID, pid: RIG_PID, mode: null, account: null }));
    rig.answer("run", gated.answer);
    closedSession();
    await start({ timers: clock, idleMs: 0 });
    let delivered = 0;
    hub["reportExec"](SID, inbound("the result", () => void delivered++));
    await waitFor(() => callsOf("run").length === 1, WAIT_MS, "the start call");
    fake.pushUpdate(msg("after the result"));
    await updatesHandled();
    gated.release();
    await settle();
    const w = await plugin(SID);
    expect(await arrived(clock, w, 2)).toEqual(["the result", "after the result"]);
    expect(delivered).toBe(1);
  });

  describe("mode belongs to the current run", () => {
    const record = (mode: string) => `${JSON.stringify({ type: "permission-mode", permissionMode: mode })}\n`;
    const transcriptPath = () => join(dir, `${TRANSCRIPT_ID}.jsonl`);
    // The session's record names its transcript before the hub starts.
    const withTranscript = (content: string) => {
      const path = transcriptPath();
      writeFileSync(path, content);
      closedSession();
      new SessionStore(join(dir, "sessions.json")).setTranscript(SID, path);
      return path;
    };

    test("an older record is last known, and the same-mode request still restarts", async () => {
      withTranscript(record("plan"));
      await start();
      await plugin(SID);
      expect(hub["knownMode"](SID)).toBeUndefined();
      expect(hub["currentMode"](SID)).toBe("plan");
      fake.pushUpdate(msg("/mode"));
      await waitFor(() => texts().some(t => t.includes(en.modeLastKnown({ mode: "plan" }))), WAIT_MS, "the mode card");
      fake.pushUpdate(msg("/mode plan"));
      await modeStarted();
    });

    test("a record after attachment makes the same mode a no-op", async () => {
      const path = withTranscript("");
      await start();
      await plugin(SID);
      appendFileSync(path, record("plan"));
      fake.pushUpdate(msg("/mode plan"));
      await waitFor(() => texts().includes(en.modeAlready({ mode: "plan" })), WAIT_MS, "the notice");
      expect(callsOf("mode")).toEqual([]);
    });

    test("a closed session always starts, and later records override the launched mode", async () => {
      const path = withTranscript(record("plan"));
      await start();
      fake.pushUpdate(msg("/mode plan"));
      await modeStarted();
      await plugin(SID);
      expect(hub["knownMode"](SID)).toBe("plan");
      appendFileSync(path, record("auto"));
      expect(hub["knownMode"](SID)).toBe("auto");
    });

    test("no transcript at the switch does not let old records override the launched mode", async () => {
      closedSession();
      await start();
      fake.pushUpdate(msg("/mode plan"));
      await modeStarted();
      const path = transcriptPath();
      writeFileSync(path, record("auto"));
      hub["store"].setTranscript(SID, path);
      await plugin(SID);
      expect(hub["currentMode"](SID)).toBe("plan");
      expect(hub["knownMode"](SID)).toBe("plan");
    });
  });
});

describe("idle exit", () => {
  test("the hub exits after the last plugin disconnects", async () => {
    const clock = newClock();
    await startHub({ idleMs: IDLE_MS, timers: clock });
    const a = await plugin("a");
    await clock.advance(IDLE_MS * 2);
    expect(exited).toBe(false);
    a.close();
    await waitFor(() => !hub.isConnected("a"));
    await settle();
    await clock.advance(IDLE_MS);
    await waitFor(() => exited, WAIT_MS, "idle exit");
  });

  test("a hub nobody connects to exits too", async () => {
    const clock = newClock();
    await startHub({ idleMs: IDLE_MS, timers: clock });
    await settle();
    await clock.advance(IDLE_MS);
    await waitFor(() => exited, WAIT_MS, "idle exit");
  });

  test("with idleMs 0 the hub stays up", async () => {
    const clock = newClock();
    await startHub({ idleMs: 0, timers: clock });
    const a = await plugin("a");
    a.close();
    await waitFor(() => !hub.isConnected("a"));
    await settle();
    await clock.advance(IDLE_MS);
    expect(exited).toBe(false);
  });
});

describe("topic commands", () => {
  const SID = "11111111-2222-3333-4444-555555555555";
  let rig: ReturnType<typeof sessionRig>;
  const runCalls = () => rig.calls.filter(c => c.sub === "run");
  const withRig = { findRig: () => "rig-file" };
  const msg = (text: string, extra?: Record<string, unknown>) => topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text, ...(extra ? { extra } : {}) });
  const texts = () => fake.texts().map(t => t.text);
  // What the topic has shown: messages sent and their edits.
  const shown = () => [...fake.callsOf("sendMessage"), ...fake.callsOf("editMessageText")].map(c => String(c.text));
  const buttonsOf = (call: object) =>
    arr(field(field(call, "reply_markup"), "inline_keyboard"))
      .flatMap(row => arr(row))
      .map(b => String(field(b, "callback_data")));
  beforeEach(() => {
    rig = sessionRig();
  });
  // The hub on the fake rig, its start-up questions answered.
  const startWithRig = async (extra: StartOptions = {}) => {
    await startHub({ ...withRig, runRig: rig.run, ...extra });
    await settle();
  };

  // A session with a topic and no window, as the hub finds it on disk.
  const closedSession = () => new SessionStore(join(dir, "sessions.json")).set(SID, { topicId: 100, title: "T", project: "p", enabled: true, cwd: CWD, account: "2" });
  const stopButton = (calls: Record<string, unknown>[]) => calls.find(c => buttonsOf(c).some(d => d.endsWith(":stop")));

  test("/cmd starts a rig run in the session folder, shows a card and wakes the agent", async () => {
    const x = new FakeExec();
    await startHub({ execClient: x });
    const a = await enabled(SID);
    fake.pushUpdate(msg("/cmd echo café && cd && exit /b 3"));
    await waitFor(() => x.starts.length === 1, WAIT_MS, "the start");
    expect(x.starts).toEqual([{ shell: "cmd", cwd: CWD, text: "echo café && cd && exit /b 3" }]);
    const id = x.last();
    await waitFor(() => shown().find(t => t.startsWith("▶ cmd")), WAIT_MS, "running card");
    const inbound = a.nextNew("inbound", m => m.meta.source === "exec", WAIT_MS);
    x.write(id, `café\n${CWD}\n`);
    x.finish(id, { kind: "exit", code: 3 });
    const report = await inbound;
    expect(report.meta.exit_code).toBe("3");
    expect(report.content).toContain("❌ code 3");
    expect(report.content).toContain("café");
    expect(report.content).toContain(CWD);
    expect(report.content).toContain(`Full log: rig exec status ${id} --from 0`);
    await waitFor(() => shown().find(t => t.startsWith("❌ code 3") && t.includes("café")), WAIT_MS, "final card");
  });

  test("a start rig refuses shows rig's own message", async () => {
    const x = new FakeExec();
    x.startError = { kind: "rig", code: "exec-unavailable", message: "no shell of that name here" };
    await startHub({ execClient: x });
    await enabled(SID);
    fake.pushUpdate(msg("/bash ls"));
    await waitFor(() => shown().find(t => t.includes("no shell of that name here")), WAIT_MS, "rig's message");
  });

  test("a /pwsh goes to rig even when the feature list failed to load: whether it may run is rig's answer", async () => {
    const x = new FakeExec();
    await startHub({ execClient: x, findRig: () => "rig-file", runRig: async () => ({ code: 1, stdout: "", stderr: "features are broken" }) });
    await enabled(SID);
    fake.pushUpdate(msg("/pwsh ls"));
    await waitFor(() => x.starts.length > 0 || undefined, WAIT_MS, "the start reaches rig");
    expect(x.starts).toEqual([{ shell: "pwsh", cwd: CWD, text: "ls" }]);
    expect(shown().some(t => t.includes("features are broken"))).toBe(false);
  });

  test("a stop button stops the rig run and ends the card", async () => {
    const x = new FakeExec();
    await startHub({ execClient: x });
    await enabled(SID);
    fake.pushUpdate(msg("/cmd ping -n 30 127.0.0.1"));
    const card = await waitFor(() => stopButton(fake.callsOf("sendMessage")), WAIT_MS, "card with a stop button");
    const data = must(buttonsOf(card).find(d => d.endsWith(":stop")), "stop button");
    fake.pushUpdate(buttonPress({ chatId: GROUP, fromId: ME, messageId: fake.lastMessageId, data }));
    await waitFor(() => fake.callsOf("answerCallbackQuery").find(c => c.text === "Stopping"), WAIT_MS, "answer");
    expect(x.stops).toEqual([x.last()]);
    x.finish(x.last(), { kind: "stopped" });
    const end = await waitFor(() => fake.callsOf("editMessageText").find(c => String(c.text).startsWith("⏹ stopped")), WAIT_MS, "stopped card");
    expect(field(end, "reply_markup")).toBeUndefined();
    fake.pushUpdate(buttonPress({ chatId: GROUP, fromId: ME, messageId: fake.lastMessageId, data }));
    await waitFor(() => fake.callsOf("answerCallbackQuery").find(c => c.text === "The command has already ended"), WAIT_MS, "second answer");
  });

  test("a button of a command the hub does not know answers not found", async () => {
    await startHub();
    await enabled(SID);
    fake.pushUpdate(buttonPress({ chatId: GROUP, fromId: ME, messageId: 1, data: "x:abcd1234:stop" }));
    await waitFor(() => fake.callsOf("answerCallbackQuery").find(c => c.text === "Run not found"), WAIT_MS, "answer");
  });

  test("an old /pwsh waits for the run button", async () => {
    const x = new FakeExec();
    await startHub({ execClient: x });
    await enabled(SID);
    fake.pushUpdate(msg("/pwsh npm run migrate", { date: Math.floor(Date.now() / MS_PER_S) - OLD_COMMAND_S }));
    const card = await waitFor(() => fake.callsOf("sendMessage").find(c => String(c.text).startsWith("⏸ The command arrived 5 min ago while the hub was off")), WAIT_MS, "pending card");
    expect(buttonsOf(card).some(d => d.endsWith(":run"))).toBe(true);
    await settle();
    expect(x.starts).toEqual([]);
  });

  test("the run button starts an old command", async () => {
    const x = new FakeExec();
    await startHub({ execClient: x });
    await enabled(SID);
    fake.pushUpdate(msg("/pwsh npm run migrate", { date: Math.floor(Date.now() / MS_PER_S) - OLD_COMMAND_S }));
    const card = await waitFor(() => fake.callsOf("sendMessage").find(c => buttonsOf(c).some(d => d.endsWith(":run"))), WAIT_MS, "pending card");
    const data = must(buttonsOf(card).find(d => d.endsWith(":run")), "run button");
    fake.pushUpdate(buttonPress({ chatId: GROUP, fromId: ME, messageId: fake.lastMessageId, data }));
    await waitFor(() => fake.callsOf("answerCallbackQuery").find(c => c.text === "Starting"), WAIT_MS, "answer");
    await settle();
    expect(x.starts).toEqual([{ shell: "pwsh", cwd: CWD, text: "npm run migrate" }]);
    const running = await waitFor(() => fake.callsOf("editMessageText").find(c => String(c.text).startsWith("▶ PowerShell")), WAIT_MS, "running card");
    expect(buttonsOf(running).some(d => d.endsWith(":stop"))).toBe(true);
  });

  test("the run button of a disabled shell reaches rig and shows rig's refusal, not a hub-side one", async () => {
    const x = new FakeExec();
    await startHub({ execClient: x, findRig: () => "rig-file", runRig: async () => ({ code: 1, stdout: "", stderr: "features are broken" }) });
    await enabled(SID);
    fake.pushUpdate(msg("/pwsh npm run migrate", { date: Math.floor(Date.now() / MS_PER_S) - OLD_COMMAND_S }));
    const card = await waitFor(() => fake.callsOf("sendMessage").find(c => buttonsOf(c).some(d => d.endsWith(":run"))), WAIT_MS, "pending card");
    const data = must(buttonsOf(card).find(d => d.endsWith(":run")), "run button");
    x.startError = { kind: "rig", code: "exec-unavailable", message: "The pwsh feature is off; run: rig feature pwsh enable" };
    fake.pushUpdate(buttonPress({ chatId: GROUP, fromId: ME, messageId: fake.lastMessageId, data }));
    await waitFor(() => fake.callsOf("answerCallbackQuery").find(c => c.text === "Starting"), WAIT_MS, "answer");
    await waitFor(() => shown().find(t => t.includes("The pwsh feature is off; run: rig feature pwsh enable")), WAIT_MS, "rig's message");
    expect(x.starts).toHaveLength(1);
  });

  test("multi-line /cmd is refused", async () => {
    await startHub();
    await enabled(SID);
    fake.pushUpdate(msg("/cmd echo a\necho b"));
    await waitFor(() => texts().includes("/cmd runs one line. For several use /pwsh or /bash"), WAIT_MS, "refusal");
  });

  test("empty /pwsh asks for a command", async () => {
    await startHub();
    await enabled(SID);
    fake.pushUpdate(msg("/pwsh"));
    await waitFor(() => texts().includes("Write the command: /pwsh npm run migrate"), WAIT_MS, "hint");
  });

  // A run that ended while no hub watched: the hub's file has it running, rig has it ended.
  const endedWhileOff = async (x: FakeExec, ended: boolean) => {
    const started = await x.start("cmd", CWD, "echo hi");
    if (!started.ok) throw new Error("the fake start failed");
    const runId = started.value.id;
    x.write(runId, "hi\n");
    if (ended) x.finish(runId, { kind: "exit", code: 0 });
    saveRuns(join(dir, "exec-runs.json"), [{ id: "abcd1234", runId, sessionId: SID, messageId: 1, shell: "cmd", text: "echo hi", cwd: CWD, state: "running", startedAt: 0, offset: 0, reported: false }]);
    return runId;
  };

  test("a result that came while the hub was off goes once to the window that reconnects", async () => {
    closedSession();
    const x = new FakeExec();
    await endedWhileOff(x, true);
    const clock = newClock();
    await startWithRig({ timers: clock, execClient: x });
    const w = await plugin(SID);
    await passReadyDelay(clock);
    const inbound = await w.next("inbound", m => m.meta.source === "exec", WAIT_MS);
    expect(inbound.meta.exec_id).toBe("abcd1234");
    await settle();
    // The grace ends: the sweep finds the result reported and sends nothing more.
    await clock.advance(EXEC_GRACE_MS * 2);
    await settle();
    expect(w.messages.filter(m => m.type === "inbound").length).toBe(1);
    expect(runCalls()).toEqual([]);
  });

  test("a run that ends during the start's grace waits for the reconnecting window", async () => {
    closedSession();
    const x = new FakeExec();
    const runId = await endedWhileOff(x, false);
    const clock = newClock();
    await startWithRig({ execGraceMs: LONG_GRACE_MS, timers: clock, execClient: x });
    await clock.advance(EXEC_CARD_MS);
    await waitFor(() => shown().some(t => t.startsWith("▶ cmd")), WAIT_MS, "running card");
    x.finish(runId, { kind: "exit", code: 0 });
    await clock.advance(EXEC_CHECK_MS);
    await settle();
    await clock.advance(CARD_EDIT_MS);
    await waitFor(() => shown().some(t => t.startsWith("✅ code 0")), WAIT_MS, "final card");
    const w = await plugin(SID);
    await passReadyDelay(clock);
    const inbound = await w.next("inbound", m => m.meta.source === "exec", WAIT_MS);
    expect(inbound.meta.exec_id).toBe("abcd1234");
    await settle();
    // The grace ends: the sweep finds the result reported and sends nothing more.
    await clock.advance(LONG_GRACE_MS);
    await settle();
    expect(w.messages.filter(m => m.type === "inbound").length).toBe(1);
    expect(runCalls()).toEqual([]);
  });

  test("a result that came while the hub was off starts the session through rig once no window came", async () => {
    closedSession();
    const x = new FakeExec();
    await endedWhileOff(x, true);
    const clock = newClock();
    await startWithRig({ timers: clock, execClient: x });
    await clock.advance(EXEC_GRACE_MS - 1);
    await settle();
    expect(runCalls()).toEqual([]);
    await clock.advance(1);
    await waitFor(() => runCalls().length === 1, WAIT_MS, "session start");
    expect(runCalls()).toEqual([{ sub: "run", sid: SID, args: ["--account", "2"] }]);
  });

  test("a result that came while the hub was off and no rig to start the session says so once no window came", async () => {
    closedSession();
    const x = new FakeExec();
    await endedWhileOff(x, true);
    const clock = newClock();
    await startHub({ timers: clock, execClient: x });
    await settle();
    await clock.advance(EXEC_GRACE_MS - 1);
    await settle();
    expect(texts()).not.toContain(en.rigMissing);
    await clock.advance(1);
    await waitFor(() => texts().includes(en.rigMissing), WAIT_MS, "notice");
    expect(texts()).toContain(en.pendingDelivery({ count: 1 }));
  });

  test("a result for a session without a window and without rig says it waits for the next start", async () => {
    closedSession();
    const x = new FakeExec();
    await startHub({ execClient: x });
    fake.pushUpdate(msg("/cmd echo hi"));
    await waitFor(() => x.starts.length === 1, WAIT_MS, "the start");
    x.write(x.last(), "hi\n");
    x.finish(x.last(), { kind: "exit", code: 0 });
    await waitFor(() => texts().includes(en.rigMissing), WAIT_MS, "notice");
    expect(texts()).toContain(en.pendingDelivery({ count: 1 }));
    await waitFor(() => shown().some(t => t.startsWith("✅ code 0")), WAIT_MS, "final card");
  });

  test("a result for a closed session starts it through rig and reaches the agent once", async () => {
    closedSession();
    const x = new FakeExec();
    await startWithRig({ execClient: x });
    fake.pushUpdate(msg("/cmd echo hi"));
    await waitFor(() => x.starts.length === 1, WAIT_MS, "the start");
    x.write(x.last(), "hi\n");
    x.finish(x.last(), { kind: "exit", code: 0 });
    await waitFor(() => runCalls().length === 1, WAIT_MS, "session start");
    expect(runCalls()).toEqual([{ sub: "run", sid: SID, args: ["--account", "2"] }]);
    const w = await plugin(SID);
    const inbound = await w.next("inbound", m => m.meta.source === "exec", WAIT_MS);
    expect(inbound.meta.exit_code).toBe("0");
    await settle();
    expect(w.messages.filter(m => m.type === "inbound").length).toBe(1);
    expect(texts()).not.toContain(en.rigMissing);
  });

  test("the hub does not exit idle while a command runs", async () => {
    closedSession();
    const x = new FakeExec();
    const clock = newClock();
    fake.pushUpdate(msg("/cmd sleep 3"));
    await startHub({ idleMs: IDLE_MS, timers: clock, execClient: x });
    await waitFor(() => x.starts.length === 1, WAIT_MS, "the start");
    await clock.advance(IDLE_MS * 2);
    expect(exited).toBe(false);
    x.finish(x.last(), { kind: "exit", code: 0 });
    await clock.advance(EXEC_CHECK_MS);
    await settle();
    await clock.advance(CARD_EDIT_MS);
    await waitFor(() => shown().some(t => t.startsWith("✅ code 0")), WAIT_MS, "final card");
    await clock.advance(IDLE_MS);
    await waitFor(() => exited, WAIT_MS, "idle exit once the command ended");
  });

  test("a log over the Telegram limit goes as its last part, made from rig's whole log", async () => {
    const x = new FakeExec();
    await startHub({ execClient: x, execFileLimit: FILE_LIMIT });
    await enabled(SID);
    fake.pushUpdate(msg("/cmd for /l %i in (1,1,40) do @echo line %i"));
    await waitFor(() => x.starts.length === 1, WAIT_MS, "the start");
    const id = x.last();
    x.write(id, Array.from({ length: LOG_LINES }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
    x.finish(id, { kind: "exit", code: 0 });
    const doc = await waitFor(() => fake.callsOf("sendDocument")[0], WAIT_MS, "log file");
    const file = field(doc, "document");
    expect(String(field(file, "file"))).toEndWith(".log");
    const body = String(field(file, "body"));
    expect(body).toStartWith("[log trimmed");
    expect(body).toContain(`line ${LOG_LINES}`);
    expect(Number(field(file, "size"))).toBeLessThanOrEqual(FILE_LIMIT);
  });
});

describe("questions", () => {
  const Q1 = {
    question: "Which color?",
    header: "Color",
    options: [
      { label: "Red", description: "warm" },
      { label: "Blue", description: "" },
    ],
    multiSelect: false,
  };
  const Q1_TEXT = "Color\nWhich color?\n\n1. Red — warm\n2. Blue";
  const Q2 = {
    question: "What to add?",
    header: "Extras",
    options: [
      { label: "Cheese", description: "" },
      { label: "Onion", description: "" },
      { label: "Pepper", description: "" },
    ],
    multiSelect: true,
  };
  const ask = (questions: object[], signal?: AbortSignal): Promise<unknown> =>
    fetch(`http://127.0.0.1:${port}/question`, {
      method: "POST",
      body: JSON.stringify({ messagingSocket: "win-a", session_id: "a", tool_input: { questions } }),
      ...(signal ? { signal } : {}),
    })
      .then(r => r.json())
      .catch((e: unknown) => String(e));
  const rows = (params: unknown) => arr(field(field(params, "reply_markup"), "inline_keyboard")).map(arr);
  const keys = (params: unknown) => rows(params).map(r => r.map(b => field(b, "text")));
  const dataOf = (params: unknown, row: number, col = 0) => String(field(rows(params)[row][col], "callback_data"));
  const press = (data: string, messageId: number) => fake.pushUpdate(buttonPress({ chatId: GROUP, fromId: ME, messageId, data }));
  const say = (text?: string, extra?: Record<string, unknown>) => fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text, extra }));
  const polled = (n = 1) => waitFor(() => fake.callsOf("sendMessage")[n - 1]);
  const shown = async (n = 1) => {
    const msg = await polled(n);
    // The hub takes in the sent question's message id; only messages after it answer the question.
    await settle();
    return msg;
  };
  const edits = () => fake.callsOf("editMessageText");

  test("a single choice is answered by its button, and the message shows the answer instead of the buttons", async () => {
    await startHub();
    await enabled("a");
    const answer = ask([Q1]);
    const msg = await polled();
    const id = fake.lastMessageId;
    expect(msg.text).toBe(Q1_TEXT);
    expect(fake.texts()[0].disable_notification).toBe(false);
    expect(keys(msg)).toEqual([["1. Red"], ["2. Blue"], ["✏️ Own option", "✖️ Cancel"]]);
    press(dataOf(msg, 1), id);
    expect(await answer).toEqual({ decision: "allow", answers: { "Which color?": "Blue" } });
    const edit = await waitFor(() => edits()[0]);
    expect(edit).toMatchObject({ message_id: id, text: `${Q1_TEXT}\n\n✅ Blue` });
    expect(edit.reply_markup).toBeUndefined();
    await waitFor(() => fake.callsOf("answerCallbackQuery").length === 1);
  });

  test("the window relays the text written before the call first, and the poll goes after it", async () => {
    const clock = newClock();
    await startHub({ catchUpMs: LONG_CATCH_UP_MS, timers: clock });
    const a = await enabled("a");
    const answer = ask([Q1]);
    const m = await a.next("catchUp");
    // The wait for the window has not run out, so only its answer lets the poll go.
    await clock.advance(LONG_CATCH_UP_MS - 1);
    expect(fake.callsOf("sendMessage")).toEqual([]);
    a.send({ type: "send", id: "s1", sessionId: "a", text: "Asking about color", notify: false });
    a.send({ type: "caughtUp", id: m.id });
    const msg = await polled(2);
    expect(fake.texts().map(t => t.text)).toEqual(["Asking about color", Q1_TEXT]);
    press(dataOf(msg, 0), fake.lastMessageId);
    expect(await answer).toEqual({ decision: "allow", answers: { "Which color?": "Red" } });
  });

  test("a window that does not answer the catch-up still gets the poll after a short wait", async () => {
    const clock = newClock();
    await startHub({ catchUpMs: SHORT_CATCH_UP_MS, timers: clock });
    const a = await enabled("a");
    const answer = ask([Q1]);
    await a.next("catchUp");
    await clock.advance(SHORT_CATCH_UP_MS - 1);
    expect(fake.callsOf("sendMessage")).toEqual([]);
    await clock.advance(1);
    expect((await polled()).text).toBe(Q1_TEXT);
    press(dataOf(await polled(), 1), fake.lastMessageId);
    expect(await answer).toEqual({ decision: "allow", answers: { "Which color?": "Blue" } });
  });

  test("a poll ended while the window catches up is never shown", async () => {
    await startHub({ catchUpMs: LONG_CATCH_UP_MS });
    const a = await enabled("a");
    const abort = new AbortController();
    const answer = ask([Q1], abort.signal);
    const m = await a.next("catchUp");
    abort.abort();
    await answer;
    a.send({ type: "caughtUp", id: m.id });
    await settle();
    expect(fake.callsOf("sendMessage")).toEqual([]);
  });

  test("a question too long for one message is cut, and so is the message with its answer", async () => {
    await startHub();
    await enabled("a");
    const question = "\u041e\u0447\u0435\u043d\u044c \u0434\u043b\u0438\u043d\u043d\u044b\u0439 \u0432\u043e\u043f\u0440\u043e\u0441 ".repeat(300);
    const options = [
      { label: "\u0414\u0430", description: "\u0434".repeat(1500), preview: "\u043f".repeat(5000) },
      { label: "\u041d\u0435\u0442", description: "\u043d".repeat(1500) },
    ];
    const answer = ask([{ question, header: "\u0414\u043b\u0438\u043d\u043d\u044b\u0439", options, multiSelect: false }]);
    const msg = await shown();
    const id = fake.lastMessageId;
    expect(fake.callsOf("sendMessage")).toHaveLength(1);
    expect(String(msg.text).length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
    expect(String(msg.text).startsWith("\u0414\u043b\u0438\u043d\u043d\u044b\u0439\n\u041e\u0447\u0435\u043d\u044c \u0434\u043b\u0438\u043d\u043d\u044b\u0439 \u0432\u043e\u043f\u0440\u043e\u0441")).toBe(true);
    expect(keys(msg)[0]).toEqual(["1. \u0414\u0430"]);
    press(dataOf(msg, 0), id);
    expect(await answer).toEqual({ decision: "allow", answers: { [question]: "\u0414\u0430" } });
    const edit = await waitFor(() => edits()[0]);
    expect(String(edit.text).length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
    expect(String(edit.text).endsWith("\n\n✅ \u0414\u0430")).toBe(true);
  });

  test("a multiple choice toggles options and is answered by «Done» with the labels joined", async () => {
    await startHub();
    await enabled("a");
    const answer = ask([Q2]);
    const msg = await polled();
    const id = fake.lastMessageId;
    expect(keys(msg)).toEqual([["1. Cheese"], ["2. Onion"], ["3. Pepper"], ["✅ Done"], ["✏️ Own option", "✖️ Cancel"]]);
    press(dataOf(msg, 3), id);
    await waitFor(() => fake.callsOf("answerCallbackQuery").some(c => c.text === en.pollPickOne));
    expect(edits()).toEqual([]);
    press(dataOf(msg, 0), id);
    press(dataOf(msg, 2), id);
    const toggled = await waitFor(() => edits()[1]);
    expect(toggled.text).toBe("Extras\nWhat to add?\n\n1. Cheese\n2. Onion\n3. Pepper");
    expect(keys(toggled).slice(0, 3)).toEqual([["☑️ 1. Cheese"], ["2. Onion"], ["☑️ 3. Pepper"]]);
    press(dataOf(msg, 3), id);
    expect(await answer).toEqual({ decision: "allow", answers: { "What to add?": "Cheese, Pepper" } });
    const last = await waitFor(() => edits()[2]);
    expect(String(last.text).endsWith("\n\n✅ Cheese, Pepper")).toBe(true);
    expect(last.reply_markup).toBeUndefined();
  });

  test("«Own option» asks for a message, and the next message is the answer, not an inbound", async () => {
    await startHub();
    const a = await enabled("a");
    const answer = ask([Q1]);
    const msg = await polled();
    press(dataOf(msg, 2), fake.lastMessageId);
    const hint = await shown(2);
    expect(hint.text).toBe(en.pollCustomHint);
    expect(hint.disable_notification).toBe(true);
    say("Green");
    expect(await answer).toEqual({ decision: "allow", answers: { "Which color?": "Green" } });
    await waitFor(() => edits().some(e => e.text === `${Q1_TEXT}\n\n✅ Green`));
    await settle();
    expect(a.messages.filter(m => m.type === "inbound")).toEqual([]);
  });

  test("a message sent without the button answers too", async () => {
    await startHub();
    await enabled("a");
    const answer = ask([Q1]);
    await shown();
    say("any");
    expect(await answer).toEqual({ decision: "allow", answers: { "Which color?": "any" } });
  });

  test("a photo answers with its caption and file mark", async () => {
    await startHub();
    await enabled("a");
    const answer = ask([Q1]);
    await shown();
    fake.files.set("P2", { path: "photos/p.jpg", body: new Uint8Array([9]) });
    say(undefined, { caption: "look", photo: [{ file_id: "P1", file_unique_id: "u1" }, { file_id: "P2", file_unique_id: "u2" }] });
    const res = await answer;
    const given = String(field(field(res, "answers"), "Which color?"));
    expect(field(res, "decision")).toBe("allow");
    expect(given.startsWith(`look (photo: ${join(dir, "inbox")}`)).toBe(true);
  });

  test("a message older than the question reaches the agent, and the poll stays open", async () => {
    await startHub();
    const a = await enabled("a");
    const answer = ask([Q1]);
    const msg = await shown();
    const id = fake.lastMessageId;
    say("earlier", { message_id: id - 1 });
    expect(await a.nextNew("inbound")).toMatchObject({ content: "earlier" });
    press(dataOf(msg, 0), id);
    expect(await answer).toEqual({ decision: "allow", answers: { "Which color?": "Red" } });
  });

  test("a message sent while the question is not shown yet reaches the agent", async () => {
    await startHub();
    const a = await enabled("a");
    fake.delayNext("sendMessage", SLOW_SEND_MS);
    const answer = ask([Q1]);
    const msg = await polled();
    say("not yet");
    expect(await a.nextNew("inbound")).toMatchObject({ content: "not yet" });
    press(dataOf(msg, 0), fake.lastMessageId);
    expect(await answer).toEqual({ decision: "allow", answers: { "Which color?": "Red" } });
  });

  test("messages sent together answer once, joined by blank lines", async () => {
    await startHub();
    const a = await enabled("a");
    const answer = ask([Q1]);
    await shown();
    say("one");
    say("two");
    expect(await answer).toEqual({ decision: "allow", answers: { "Which color?": "one\n\ntwo" } });
    await settle();
    expect(a.messages.filter(m => m.type === "inbound")).toEqual([]);
  });

  test("an album answers once, with a file mark for each file", async () => {
    await startHub();
    await enabled("a");
    const answer = ask([Q1]);
    await shown();
    say(undefined, { caption: "look", media_group_id: "G1", document: { file_id: "D1", file_unique_id: "d1", file_name: "a.txt" } });
    say(undefined, { media_group_id: "G1", document: { file_id: "D2", file_unique_id: "d2", file_name: "b.txt" } });
    const given = "look (document: a.txt, file_id: D1)\n\n(document: b.txt, file_id: D2)";
    expect(await answer).toEqual({ decision: "allow", answers: { "Which color?": given } });
  });

  test("a message that answers gets ✍ while the poll waits, and loses it once the agent has the answers", async () => {
    await startHub();
    await enabled("a");
    const answer = ask([Q1, Q2]);
    await shown();
    const id = fake.nextMessageId;
    say("mine");
    const second = await polled(2);
    await waitFor(() => fake.callsOf("setMessageReaction").length === 1);
    expect(fake.callsOf("setMessageReaction")[0]).toEqual({ chat_id: GROUP, message_id: id, reaction: [{ type: "emoji", emoji: "✍" }] });
    press(dataOf(second, 1), fake.lastMessageId);
    press(dataOf(second, 3), fake.lastMessageId);
    expect(await answer).toEqual({ decision: "allow", answers: { "Which color?": "mine", "What to add?": "Onion" } });
    await waitFor(() => fake.callsOf("setMessageReaction").length === 2);
    expect(fake.callsOf("setMessageReaction")[1]).toEqual({ chat_id: GROUP, message_id: id, reaction: [] });
  });

  test("a topic command works as usual and leaves the poll open", async () => {
    const rig = sessionRig();
    await startHub({ findRig: () => "rig-file", runRig: rig.run });
    await enabled("a");
    const answer = ask([Q1]);
    const msg = await polled();
    const id = fake.lastMessageId;
    say("/info");
    await waitFor(() => rig.infos.includes("a"), WAIT_MS, "rig asked for the session's info");
    press(dataOf(msg, 0), id);
    expect(await answer).toEqual({ decision: "allow", answers: { "Which color?": "Red" } });
  });

  test('a "!" message cancels the poll and reaches the agent as an ordinary message', async () => {
    await startHub();
    const a = await enabled("a");
    const answer = ask([Q1]);
    await polled();
    const arrived = a.nextNew("inbound");
    say("!stop");
    expect(await answer).toEqual({ decision: "deny", reason: CANCEL_REASON });
    const inbound = await arrived;
    expect(inbound).toMatchObject({ content: "stop" });
    expect(field(inbound, "interrupt")).toBeUndefined();
    await waitFor(() => edits().some(e => String(e.text).endsWith(`\n\n${en.pollCancelled}`)));
  });

  test('a lone "!" cancels the poll and delivers nothing', async () => {
    await startHub();
    const a = await enabled("a");
    const answer = ask([Q1]);
    await polled();
    say("!");
    expect(await answer).toEqual({ decision: "deny", reason: CANCEL_REASON });
    await settle();
    expect(a.messages.filter(m => m.type === "inbound")).toEqual([]);
  });

  test("«Cancel» denies the question", async () => {
    await startHub();
    await enabled("a");
    const answer = ask([Q1]);
    const msg = await polled();
    press(dataOf(msg, 2, 1), fake.lastMessageId);
    expect(await answer).toEqual({ decision: "deny", reason: CANCEL_REASON });
    const edit = await waitFor(() => edits()[0]);
    expect(edit.text).toBe(`${Q1_TEXT}\n\n${en.pollCancelled}`);
  });

  test("several questions come one at a time and are answered together", async () => {
    await startHub();
    await enabled("a");
    const answer = ask([Q1, Q2]);
    const first = await polled();
    const firstId = fake.lastMessageId;
    expect(String(first.text).startsWith("Question 1 of 2: Color\nWhich color?")).toBe(true);
    press(dataOf(first, 0), firstId);
    const second = await polled(2);
    expect(String(second.text).startsWith("Question 2 of 2: Extras\n")).toBe(true);
    press(dataOf(first, 1), firstId);
    await waitFor(() => fake.callsOf("answerCallbackQuery").some(c => c.text === en.pollStale));
    press(dataOf(second, 1), fake.lastMessageId);
    press(dataOf(second, 3), fake.lastMessageId);
    expect(await answer).toEqual({ decision: "allow", answers: { "Which color?": "Red", "What to add?": "Onion" } });
  });

  test("a button of a poll the hub does not know answers «The poll is outdated» and loses its buttons", async () => {
    await startHub();
    await enabled("a");
    press("q:deadbeef:0:1", 77);
    await waitFor(() => fake.callsOf("editMessageReplyMarkup")[0]);
    expect(fake.callsOf("editMessageReplyMarkup")[0]).toMatchObject({ chat_id: GROUP, message_id: 77 });
    expect(fake.callsOf("answerCallbackQuery")[0]).toMatchObject({ text: en.pollStale });
  });

  test("with the mode off the hub leaves the question to the terminal", async () => {
    await startHub();
    const a = await enabled("a");
    await req(a, { op: "disable" });
    expect(await ask([Q1])).toEqual({ decision: "none" });
    expect(fake.callsOf("sendMessage")).toEqual([]);
  });

  test("a hook that stops waiting moves the poll to the terminal", async () => {
    await startHub();
    await enabled("a");
    const ctl = new AbortController();
    const answer = ask([Q1], ctl.signal);
    await polled();
    ctl.abort();
    await answer;
    await waitFor(() => edits().some(e => e.text === `${Q1_TEXT}\n\n${en.pollMovedToTerminal}`));
  });

  test("a new poll of the session closes the old one", async () => {
    await startHub();
    await enabled("a");
    const old = ask([Q1]);
    await polled();
    const fresh = ask([Q2]);
    expect(await old).toEqual({ decision: "none" });
    await waitFor(() => edits().some(e => e.text === `${Q1_TEXT}\n\n${en.pollMovedToTerminal}`));
    const msg = await polled(2);
    press(dataOf(msg, 0), fake.lastMessageId);
    press(dataOf(msg, 3), fake.lastMessageId);
    expect(await fresh).toEqual({ decision: "allow", answers: { "What to add?": "Cheese" } });
  });

  test("a stopping hub moves the poll to the terminal", async () => {
    await startHub();
    await enabled("a");
    const answer = ask([Q1]);
    await polled();
    await hub.stop();
    expect(await answer).toEqual({ decision: "none" });
    expect(edits().some(e => e.text === `${Q1_TEXT}\n\n${en.pollMovedToTerminal}`)).toBe(true);
  });

  test("a hub that stops while the poll is still being sent has moved it to the terminal when stop returns", async () => {
    await startHub();
    await enabled("a");
    const release = fake.holdNext("sendMessage");
    const answer = ask([Q1]);
    await polled();
    const stopping = hub.stop();
    // stop() runs on microtasks up to the question send it has to wait for; the held response needs network I/O, so it comes later.
    release();
    await stopping;
    expect(edits().some(e => e.text === `${Q1_TEXT}\n\n${en.pollMovedToTerminal}`)).toBe(true);
    expect(await answer).toEqual({ decision: "none" });
  });

  test("a window that goes away moves its poll to the terminal", async () => {
    await startHub();
    const a = await enabled("a");
    const answer = ask([Q1]);
    await polled();
    a.close();
    expect(await answer).toEqual({ decision: "none" });
    await waitFor(() => edits().some(e => e.text === `${Q1_TEXT}\n\n${en.pollMovedToTerminal}`));
  });

  test("turning the mode off moves the poll to the terminal", async () => {
    await startHub();
    const a = await enabled("a");
    const answer = ask([Q1]);
    await polled();
    await req(a, { op: "disable" });
    expect(await answer).toEqual({ decision: "none" });
    await waitFor(() => edits().some(e => e.text === `${Q1_TEXT}\n\n${en.pollMovedToTerminal}`));
  });

  test("a poll message Telegram rejects leaves the question to the terminal", async () => {
    await startHub();
    await enabled("a");
    fake.failNext("sendMessage", { code: 400, description: "Bad Request: message text is empty" });
    fake.failNext("sendMessage", { code: 400, description: "Bad Request: message text is empty" });
    expect(await ask([Q1])).toEqual({ decision: "none" });
  });

  test("a body that is not a question is refused", async () => {
    await startHub();
    const res = await fetch(`http://127.0.0.1:${port}/question`, { method: "POST", body: "{}" });
    expect(res.status).toBe(400);
  });
});
