import type { VideoTools } from "../src/hub/video.ts";
import type { Compaction, Usage } from "../src/mod/commands.ts";
import type { Config } from "../src/shared/config.ts";
import type { MessageKind } from "../src/shared/notification.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { z } from "zod";
import { cleanupSummary, Hub, projectName } from "../src/hub/hub.ts";
import { CANCEL_REASON, CANCELLED, CUSTOM_HINT, PICK_ONE, STALE_POLL, TO_TERMINAL } from "../src/hub/questions.ts";
import { SessionStore } from "../src/hub/sessions.ts";
import { cleanTranscript } from "../src/hub/skill-cleanup.ts";
import { saveExecs } from "../src/hub/exec-store.ts";
import { TelegramApi } from "../src/hub/telegram.ts";
import { Runner } from "../src/mod/commands.ts";
import { arr, field } from "../src/shared/guards.ts";
import { PROTOCOL_VERSION } from "../src/shared/protocol.ts";
import { notifies } from "../src/shared/notification.ts";
import { buttonPress, FakeTelegram, topicMsg } from "./fake-telegram.ts";
import { freePort, hasFfmpeg, makeVideo, memLogger, must, NO_PACE, tempDir, waitFor, wsClient } from "./helpers.ts";

const GROUP = "-1001";
const ME = "123456789";
// A session folder that exists: the repository itself.
const CWD = join(import.meta.dir, "..", "..");
// More polls than a compaction is tried with no turn running.
const COMPACT_POLLS = 5;
const DEFAULT_DIR = "C:\\Users\\me\\.claude";
// Topic commands: a real command's run, a wait for what it shows, the idle
// time a test hub exits after, a pause for what must not come, the age of a
// command from while the hub was off, a test file limit, a launch timeout.
const RUN_MS = 15_000;
const WAIT_MS = 5000;
const IDLE_MS = 300;
const SETTLE_MS = 300;
const OLD_COMMAND_S = 5 * 60;
const MS_PER_S = 1000;
const FILE_LIMIT = 200;
const LAUNCH_TIMEOUT_S = 30;
// How long a test hub waits for windows before it delivers results of runs
// that ended while it was off.
const EXEC_GRACE_MS = 300;
// A grace long enough to end a run and connect a window inside it.
const LONG_GRACE_MS = 2000;
// Topic messages that come together go as one; a short quiet window keeps
// the other tests quick.
const BATCH_QUIET_MS = 5;
// Time for the hub to take in a sent question's message id: only messages
// after it answer the question. A slow send keeps a question unsent.
const SHOWN_MS = 50;
const SLOW_SEND_MS = 300;
// Telegram takes at most this many characters in one message.
const TELEGRAM_LIMIT = 4096;
// The test windows do not answer the hub's catch-up before a question, so
// it waits briefly by default; the catch-up tests pick their own wait.
const CATCH_UP_MS = 20;
const SHORT_CATCH_UP_MS = 150;
const LONG_CATCH_UP_MS = 2000;

let fake: FakeTelegram;
let hub: Hub;
let port: number;
let dir: string;
let config: Config;
let log: ReturnType<typeof memLogger>;
let exited: boolean;
const clients: { close(): void }[] = [];

type HubExtras = {
  spawn?(command: string[]): void;
  projectsDir?: string;
  stopTimeoutMs?: number;
  defaultAccount?(): Promise<string | undefined>;
  spawnRunner?(specFile: string): number;
  execFileLimit?: number;
  execGraceMs?: number;
  isAlive?(pid: number): boolean;
  cleanupCompactMs?: number;
  cleanupExitMs?: number;
  cleanupSettleMs?: number;
  cleanTranscript?: typeof cleanTranscript;
  catchUpMs?: number;
  volunteerLimitsScript?: string;
  volunteerLimitsCommand?: string[];
  volunteerLimitsTimeoutMs?: number;
};

async function startHub(o: { port?: number; idleMs?: number; token?: boolean | string; commandPickupMs?: number; videoTools?: VideoTools; cardEditMs?: number; cardGapMs?: number; reactionDelayMs?: number; typingEveryMs?: number; batchQuietMs?: number; batchMaxMs?: number } & HubExtras = {}) {
  port = o.port ?? (await freePort());
  hub = new Hub({
    port,
    codexSessionsDir: join(dir, "codex-sessions"),
    sessionsFile: join(dir, "sessions.json"),
    outboxFile: join(dir, "outbox.json"),
    cardsFile: join(dir, "cards.json"),
    spoolDir: join(dir, "spool"),
    spoolScanMs: 50,
    filesDir: join(dir, "outbox-files"),
    inboxDir: join(dir, "inbox"),
    ...(o.videoTools ? { videoTools: o.videoTools } : {}),
    api: o.token === false ? undefined : new TelegramApi({ token: typeof o.token === "string" ? o.token : fake.token, base: fake.url, baseDelayMs: 1, maxAttempts: 2, attemptTimeoutMs: 300, sendAttemptTimeoutMs: 300, networkRetryMs: 5, deadlineMs: 500, groupPace: NO_PACE }),
    config: () => config,
    idleMs: o.idleMs ?? 60_000,
    commandPickupMs: o.commandPickupMs ?? 3000,
    pollTimeoutSec: 1,
    pollRetryBaseMs: 10,
    sendRetryBaseMs: 10,
    sendRetryMaxMs: 50,
    cardEditMs: o.cardEditMs ?? 50,
    cardGapMs: o.cardGapMs ?? 0,
    typingEveryMs: o.typingEveryMs ?? 50,
    reactionDelayMs: o.reactionDelayMs ?? 50,
    readyDelayMs: 50,
    batchQuietMs: o.batchQuietMs ?? BATCH_QUIET_MS,
    catchUpMs: o.catchUpMs ?? CATCH_UP_MS,
    ...(o.batchMaxMs ? { batchMaxMs: o.batchMaxMs } : {}),
    ...(o.spawn ? { spawn: o.spawn } : {}),
    ...(o.projectsDir ? { projectsDir: o.projectsDir } : {}),
    ...(o.stopTimeoutMs ? { stopTimeoutMs: o.stopTimeoutMs } : {}),
    ...(o.isAlive ? { isAlive: o.isAlive } : {}),
    ...(o.cleanupCompactMs ? { cleanupCompactMs: o.cleanupCompactMs } : {}),
    ...(o.cleanupExitMs ? { cleanupExitMs: o.cleanupExitMs } : {}),
    ...(o.cleanupSettleMs ? { cleanupSettleMs: o.cleanupSettleMs } : {}),
    ...(o.cleanTranscript ? { cleanTranscript: o.cleanTranscript } : {}),
    ...(o.volunteerLimitsScript ? { volunteerLimitsScript: o.volunteerLimitsScript } : {}),
    ...(o.volunteerLimitsCommand ? { volunteerLimitsCommand: o.volunteerLimitsCommand } : {}),
    ...(o.volunteerLimitsTimeoutMs ? { volunteerLimitsTimeoutMs: o.volunteerLimitsTimeoutMs } : {}),
    defaultConfigDir: DEFAULT_DIR,
    defaultAccount: o.defaultAccount ?? (async () => undefined),
    execDir: join(dir, "exec"),
    execsFile: join(dir, "execs.json"),
    execCheckMs: 20,
    execCardMs: 100,
    ...(o.spawnRunner ? { spawnRunner: o.spawnRunner } : {}),
    ...(o.execFileLimit ? { execFileLimit: o.execFileLimit } : {}),
    execGraceMs: o.execGraceMs ?? EXEC_GRACE_MS,
    log,
    onExit: () => {
      exited = true;
    },
  });
  expect(hub.start()).toBe(true);
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
  fake.stop();
});

describe("enable", () => {
  test('creates a topic named "<project> · <title>"', async () => {
    await startHub();
    const c = await plugin("s1");
    const res = await req(c, { op: "enable", title: "Реализация хаба" });
    expect(res).toMatchObject({ ok: true, result: { topicTitle: `${projectName(CWD)} · Реализация хаба`, created: true } });
    expect(fake.callsOf("createForumTopic")).toEqual([{ chat_id: GROUP, name: `${projectName(CWD)} · Реализация хаба` }]);
    await c.next("state", m => m.enabled === true);
    expect(new SessionStore(join(dir, "sessions.json")).get("s1")).toEqual({ topicId: 100, title: "Реализация хаба", project: projectName(CWD), enabled: true, cwd: CWD, account: "2" });
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
    const c = await connect(cliHello("s1", { title: "Фикс входа" }));
    expect(c.messages.filter(m => m.type === "state").at(-1)?.enabled).toBe(true);
    expect(fake.callsOf("createForumTopic")).toEqual([]);
    const rec = new SessionStore(STORE_FILE()).get("s1");
    expect(rec).toMatchObject({ enabled: true, project: basename(CWD) });
    expect(rec?.topicId).toBeUndefined();
  });

  test("the first text of an interactive window creates its topic from the title, later text reuses it", async () => {
    await startHub();
    const c = await connect(cliHello("s1", { title: "Фикс входа" }));
    c.send({ type: "send", id: "x1", text: "первый", notify: false });
    await waitFor(() => fake.texts().length === 1, 3000, "the first message");
    expect(fake.callsOf("createForumTopic")).toEqual([{ chat_id: GROUP, name: `${basename(CWD)} · Фикс входа` }]);
    expect(fake.texts()[0]).toMatchObject({ message_thread_id: 100 });
    c.send({ type: "send", id: "x2", text: "второй", notify: false });
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

  test("a topic message turns a disabled window back on and clears the flag", async () => {
    await startHub();
    const c = await enabled("s1", "T");
    await req(c, { op: "disable" });
    expect(new SessionStore(STORE_FILE()).get("s1")).toMatchObject({ enabled: false, disabledByUser: true });
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "вернись" }));
    await c.next("inbound");
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
    c.send({ type: "send", id: "x1", text: "текст", notify: false });
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
    await Bun.sleep(150);
    expect(fake.callsOf("sendChatAction")).toEqual([]);
    c.send({ type: "send", id: "x1", text: "готово", notify: false });
    await waitFor(() => fake.texts().length === 1, 3000, "the message");
  });
});

describe("inbound", () => {
  test("a topic message reaches the right one of two sessions and enables it", async () => {
    await startHub();
    const a = await enabled("a", "A");
    const b = await enabled("b", "B");
    await req(b, { op: "disable" });
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 101, fromId: ME, text: "привет B" }));
    const msg = await b.next("inbound");
    expect(msg.content).toBe("привет B");
    expect(msg.meta).toMatchObject({ chat_id: GROUP, user_id: ME, user: "user" });
    await waitFor(() => b.messages.filter(m => m.type === "state").at(-1)?.enabled === true, 3000, "enabled state");
    expect(new SessionStore(join(dir, "sessions.json")).get("b")?.enabled).toBe(true);
    expect(a.messages.some(m => m.type === "inbound")).toBe(false);
  });

  test("a reply carries what it answers before the text, a forward its origin before it", async () => {
    await startHub();
    const a = await enabled("a");
    const original = { message_id: 50, date: 0, chat: { id: Number(GROUP), type: "supergroup" }, from: { id: 1, is_bot: true, first_name: "Hub" }, text: "готово" };
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "!стоп", extra: { reply_to_message: original } }));
    const stop = await a.next("inbound");
    expect(stop.content).toBe("[reply to your message]\n> готово\n\nстоп");
    expect(stop.interrupt).toBe(true);
    const origin = { type: "hidden_user", date: 0, sender_user_name: "Аноним" };
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "смотри", extra: { forward_origin: origin } }));
    expect((await a.next("inbound", m => m.content.endsWith("смотри"))).content).toBe("[forwarded from Аноним]\nсмотри");
  });

  test("a message the agent has at once never wears ✍", async () => {
    await startHub({ reactionDelayMs: 300 });
    const a = await enabled("a");
    const u = topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "привет" });
    fake.pushUpdate(u);
    await a.next("inbound");
    a.send({ type: "seen", messageIds: [u.message?.message_id] });
    await Bun.sleep(500);
    expect(fake.callsOf("setMessageReaction")).toEqual([]);
  });

  test("a message taken for the agent wears ✍ until the window says the agent has it", async () => {
    await startHub();
    const a = await enabled("a");
    const u = topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "привет" });
    const id = u.message?.message_id;
    fake.pushUpdate(u);
    await a.next("inbound");
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
    const u = topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "привет" });
    fake.pushUpdate(u);
    await a.next("inbound");
    await waitFor(() => fake.callsOf("setMessageReaction").length === 1);
    a.send({ type: "seen", messageIds: [u.message?.message_id] });
    await waitFor(() => fake.callsOf("setMessageReaction").length === 3, 3000);
    expect(fake.callsOf("setMessageReaction").map(c => arr(c.reaction).length)).toEqual([1, 1, 0]);
  });

  test("the topic of a busy agent shows typing until its turn ends", async () => {
    await startHub();
    const a = await enabled("a");
    a.send({ type: "busy", busy: true });
    await waitFor(() => fake.callsOf("sendChatAction").length >= 2);
    expect(fake.callsOf("sendChatAction")[0]).toEqual({ chat_id: GROUP, message_thread_id: 100, action: "typing" });
    a.send({ type: "busy", busy: false });
    await Bun.sleep(100);
    const shown = fake.callsOf("sendChatAction").length;
    await Bun.sleep(200);
    expect(fake.callsOf("sendChatAction").length).toBe(shown);
  });

  // Some networks let few new connections through: parallel requests hang,
  // while one connection, reused, takes them in turn.
  test("typing in several topics goes one request at a time", async () => {
    await startHub({ typingEveryMs: 60_000 });
    const a = await enabled("a");
    const b = await enabled("b");
    fake.delayNext("sendChatAction", 300);
    a.send({ type: "busy", busy: true });
    b.send({ type: "busy", busy: true });
    await Bun.sleep(150);
    expect(fake.callsOf("sendChatAction").length).toBe(1);
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
    await Bun.sleep(200);
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
    await startHub();
    const old = await wsClient(port, { ...hello("a"), reportsSeen: undefined });
    clients.push(old);
    await old.next("state");
    expect((await req(old, { op: "enable", title: "T" })).ok).toBe(true);
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "привет" }));
    await old.next("inbound");
    await Bun.sleep(100);
    expect(fake.callsOf("setMessageReaction")).toEqual([]);
  });

  test("a command for the plugin wears no ✍", async () => {
    await startHub();
    await enabled("a");
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "/info" }));
    await Bun.sleep(200);
    expect(fake.callsOf("setMessageReaction")).toEqual([]);
  });

  // Rich text pasted into Telegram arrives as text plus entities.
  test("a formatted message is delivered as its text, and the log names it without the text", async () => {
    await startHub();
    const a = await enabled("a");
    const text = "# План\n\nСначала **v2g1**, потом `cleanup`.";
    const entities = [
      { type: "bold", offset: 0, length: 6 },
      { type: "bold", offset: 17, length: 4 },
      { type: "code", offset: 29, length: 7 },
    ];
    const u = topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text, extra: { entities } });
    fake.pushUpdate(u);
    expect((await a.next("inbound")).content).toBe(text);
    const line = log.lines.find(l => l.includes(`message ${u.message?.message_id}`));
    expect(line).toBe(`INFO message ${u.message?.message_id} in topic 100 → session a: text, ${text.length} chars, entities bold, code`);
  });

  // What Telegram makes of a Markdown file pasted into the chat.
  test("a rich message reaches the session as Markdown", async () => {
    await startHub();
    const a = await enabled("a");
    const rich_message = { blocks: [{ type: "heading", size: 2, text: "План" }, { type: "paragraph", text: ["Сначала ", { type: "bold", text: "v2g1" }] }] };
    const u = topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, extra: { rich_message } });
    fake.pushUpdate(u);
    const msg = await a.next("inbound");
    expect(msg.content).toBe("## План\n\nСначала **v2g1**");
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
    const msg = await a.next("inbound");
    const [photo, gone, doc] = msg.content.split("\n\n");
    expect(photo.startsWith(`(photo: ${join(dir, "inbox")}`)).toBe(true);
    expect(gone).toBe("(photo, file_id: GONE)");
    expect(doc).toBe("(document: plan.pdf, file_id: D1)");
    expect(msg.meta.image_path).toBeUndefined();
    expect(log.lines.some(l => l.startsWith("WARN photo download failed"))).toBe(true);
  });

  test('a topic of a session without a window gets "сессия сейчас не активна"', async () => {
    await startHub();
    const a = await enabled("a");
    a.close();
    await waitFor(() => !hub.isConnected("a"), 3000, "disconnect");
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "hello?" }));
    const sent = await waitFor(() => fake.texts().find(p => p.text === "сессия сейчас не активна"));
    expect(sent).toMatchObject({ chat_id: GROUP, message_thread_id: 100, disable_notification: false });
  });

  test("General, other chats and other users are ignored and the chat id is logged", async () => {
    await startHub();
    const a = await enabled("a");
    fake.pushUpdate(topicMsg({ chatId: GROUP, fromId: ME, text: "general" }));
    fake.pushUpdate(topicMsg({ chatId: "-555", threadId: 100, fromId: ME, text: "other chat" }));
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: "42", text: "stranger" }));
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "mine" }));
    const msg = await a.next("inbound");
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
    const msg = await a.next("inbound");
    expect(msg.content).toBe("look");
    expect(msg.meta.image_path.startsWith(join(dir, "inbox"))).toBe(true);
  });

  test("a document is passed as attachment meta with a sanitized name", async () => {
    await startHub();
    const a = await enabled("a");
    fake.pushUpdate(
      topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, extra: { document: { file_id: "D1", file_unique_id: "d", file_name: "a<b>.txt", file_size: 5, mime_type: "text/plain" } } }),
    );
    const msg = await a.next("inbound");
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
    const inbound = await a.next("inbound");
    const parts = inbound.content.split("\n\n");
    expect(parts.length).toBe(3);
    expect(parts[0].startsWith(`look (photo: ${join(dir, "inbox")}`)).toBe(true);
    for (const p of parts.slice(1)) expect(p.startsWith(`(photo: ${join(dir, "inbox")}`)).toBe(true);
    expect(inbound.meta.image_path).toBeUndefined();
    await Bun.sleep(100);
    expect(inbounds(a).length).toBe(1);
  });

  test('an album captioned "!x" while the agent works interrupts and starts with "x"', async () => {
    await startHub();
    const a = await enabled("a");
    a.send({ type: "busy", busy: true });
    await Bun.sleep(50);
    for (const id of ["B1", "B2"]) fake.files.set(id, { path: `photos/${id}.jpg`, body: new Uint8Array([1]) });
    const photo = (id: string) => [{ file_id: id, file_unique_id: id }];
    fake.pushUpdate(msg(undefined, { caption: "!x", photo: photo("B1") }));
    fake.pushUpdate(msg(undefined, { photo: photo("B2") }));
    const inbound = await a.next("inbound");
    expect(inbound.content.startsWith("x (photo: ")).toBe(true);
    expect(inbound.interrupt).toBe(true);
  });

  test("forwards and the text sent after them come as one notification", async () => {
    await startHub();
    const a = await enabled("a");
    const forward_origin = { type: "hidden_user", date: 0, sender_user_name: "Аноним" };
    fake.pushUpdate(msg("раз", { forward_origin }));
    fake.pushUpdate(msg("два", { forward_origin }));
    fake.pushUpdate(msg("что скажешь?"));
    expect((await a.next("inbound")).content).toBe("[forwarded from Аноним]\nраз\n\n[forwarded from Аноним]\nдва\n\nчто скажешь?");
  });

  test("a message after the quiet window is a notification of its own", async () => {
    await startHub({ batchQuietMs: 30 });
    const a = await enabled("a");
    fake.pushUpdate(msg("one"));
    await Bun.sleep(150);
    fake.pushUpdate(msg("two"));
    await waitFor(() => inbounds(a).length === 2);
    expect(inbounds(a)).toEqual(["one", "two"]);
  });

  test("a steady stream is sent once the batch is old enough", async () => {
    // The quiet window outlasts the whole stream, so only the cap can send a
    // part of it before the stream ends.
    await startHub({ batchQuietMs: 1000, batchMaxMs: 300 });
    const a = await enabled("a");
    const texts = Array.from({ length: 8 }, (_, i) => `m${i}`);
    let sentAfter: number | undefined;
    for (const [i, t] of texts.entries()) {
      fake.pushUpdate(msg(t));
      await Bun.sleep(100);
      if (sentAfter === undefined && inbounds(a).length > 0) sentAfter = i;
    }
    expect(sentAfter).toBeDefined();
    expect(String(inbounds(a)[0])).not.toContain("m7");
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
    const inbound = await a.next("inbound");
    expect(inbound.content).toBe("");
    expect(inbound.interrupt).toBe(true);
  });

  test('a lone "!" leaves no blank line before the messages after it', async () => {
    await startHub();
    const a = await enabled("a");
    fake.pushUpdate(msg("!"));
    fake.pushUpdate(msg("c"));
    const inbound = await a.next("inbound");
    expect(inbound.content).toBe("c");
    expect(inbound.interrupt).toBe(true);
  });

  test('a forward whose text starts with "!" is no interrupt and joins the batch', async () => {
    await startHub();
    const a = await enabled("a");
    fake.pushUpdate(msg("a"));
    fake.pushUpdate(msg("!b", { forward_origin: { type: "hidden_user", date: 0, sender_user_name: "X" } }));
    await waitFor(() => inbounds(a).length === 1);
    await Bun.sleep(50);
    expect(inbounds(a)).toEqual(["a\n\n[forwarded from X]\n!b"]);
    expect(flags(a)).toEqual([undefined]);
  });

  test("seeing the first message of a batch takes ✍ off all of its messages", async () => {
    await startHub();
    const a = await enabled("a");
    const us = [msg("one"), msg("two"), msg("three")];
    const ids = us.map(u => u.message?.message_id);
    for (const u of us) fake.pushUpdate(u);
    await a.next("inbound");
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
    await enabled("a");
    const cases: { text: string; kind: MessageKind; loud: boolean }[] = [
      { text: "/info reply", kind: "info", loud: false },
      { text: "✅ /autocompact 80 выполнена.", kind: "info", loud: false },
      { text: "🗜 Компакт запущен…", kind: "info", loud: false },
      { text: "✅ Компакт выполнен.", kind: "info", loud: false },
      { text: "🧹 Очистка выполнена", kind: "info", loud: false },
      { text: "✅ Сессия запущена", kind: "info", loud: false },
      { text: "🚀 Запускаю сессию…", kind: "info", loud: false },
      { text: "⏹ Сессия завершена", kind: "info", loud: false },
      { text: "⏳ Сессия уже завершается", kind: "info", loud: false },
      { text: "✅ код 0", kind: "info", loud: false },
      { text: "⏹ остановлена", kind: "info", loud: false },
      { text: "❌ код 2", kind: "error", loud: true },
      { text: "⚠️ прервана: процесс исчез", kind: "warning", loud: true },
      { text: "🔐 Нужно подтверждение", kind: "action", loud: true },
      { text: "Выбери вариант ответа", kind: "action", loud: true },
      { text: "⚠️ Компакт не выполнен", kind: "error", loud: true },
    ];
    for (const [index, item] of cases.entries()) {
      const response = await fetch(`http://127.0.0.1:${port}/reply`, {
        method: "POST",
        body: JSON.stringify({ sessionId: "a", id: `kind-${index}`, text: item.text, notify: notifies(item.kind) }),
      });
      expect(response.status).toBe(200);
    }
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

  test("a title change renames the topic", async () => {
    await startHub();
    const a = await enabled("a", "Old");
    a.send({ type: "title", title: "New" });
    await waitFor(() => fake.callsOf("editForumTopic").length === 1);
    expect(fake.callsOf("editForumTopic")[0]).toMatchObject({ name: `${projectName(CWD)} · New` });
    a.send({ type: "title", title: "New" });
    await Bun.sleep(100);
    expect(fake.callsOf("editForumTopic").length).toBe(1);
  });

  test("a permission request is sent with sound only while enabled", async () => {
    await startHub();
    const a = await enabled("a");
    a.send({ type: "permission", toolName: "Bash", description: "rm -rf build" });
    await waitFor(() => fake.texts().length === 1);
    expect(fake.texts()[0]).toMatchObject({ text: "🔐 Нужно подтверждение: Bash", disable_notification: false });
    await req(a, { op: "disable" });
    a.send({ type: "permission", toolName: "Bash", description: "again" });
    await Bun.sleep(100);
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
    expect(fake.callsOf("editMessageText")[0].text).toBe("🔐 Нужно подтверждение: Bash\nRemove build output\n\ncommand: rm -rf build\n\n❌ Отклонено");
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
    expect(fake.callsOf("answerCallbackQuery")[0]).toMatchObject({ text: "Запрос устарел" });
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
    expect(fake.callsOf("editMessageText")[0].text).toEndWith("⚠️ Сессия не активна, ответ не доставлен");
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
    await Bun.sleep(100);
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
    await Bun.sleep(100);
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
    expect(sent.map(p => p.text)).toEqual(["odd words", "⚠️ Telegram не принял сообщение: Bad Request: message text is empty. Текст в hub.log.", "after"]);
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
    await startHub({ idleMs: 100 });
    const a = await enabled("a");
    fake.hangNext("sendMessage", 4);
    a.send({ type: "send", id: "x1", text: "last words", notify: true });
    await a.next("ack", m => m.id === "x1");
    a.close();
    await Bun.sleep(400);
    expect(exited).toBe(false);
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
    a.send({ type: "send", id: "x1", text: "**Итог**\n\n**готово**", notify: false });
    await waitFor(() => fake.texts().length === 1);
    expect(fake.callsOf("sendRichMessage")).toEqual([]);
    expect(fake.callsOf("sendMessage")[0]).toMatchObject({
      text: "Итог\n\nготово",
      entities: [
        { type: "bold", offset: 0, length: 4 },
        { type: "bold", offset: 6, length: 6 },
      ],
    });
  });

  test("agent markdown with a table goes as a rich message in blocks", async () => {
    await startHub();
    const a = await enabled("a");
    a.send({ type: "send", id: "x1", text: "## Итог\n\n**готово**, см. `hub.ts`\n\n| a | b |\n|---|---|\n| 1 | 2 |", notify: false });
    await waitFor(() => fake.texts().length === 1);
    expect(fake.callsOf("sendMessage")).toEqual([]);
    expect(field(fake.callsOf("sendRichMessage")[0].rich_message, "blocks")).toEqual([
      { type: "heading", size: 2, text: "Итог" },
      { type: "paragraph", text: [{ type: "bold", text: "готово" }, ", см. ", { type: "code", text: "hub.ts" }] },
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
    a.send({ type: "send", id: "x1", text: "## до\n\n```\n" + "z".repeat(31000) + "\n```", notify: true });
    await waitFor(() => fake.texts().length === 9);
    const [first, ...rest] = fake.texts();
    expect(first).toMatchObject({ text: "до", disable_notification: false });
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
    expect(fake.texts()[0].text).toBe("🔐 Нужно подтверждение: Bash\nrm *.tmp and *.log");
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
  const card = (id: string, text: string, final = false) => ({ type: "card", id, sessionId: "a", text, final });

  test("a card is sent silently once, then edited in place", async () => {
    await startHub();
    const a = await enabled("a");
    a.send(card("x-0", "🤖 **Explore**\n⏳ 1 действие"));
    await waitFor(() => fake.texts().length === 1);
    expect(fake.texts()[0]).toMatchObject({ text: "🤖 Explore\n⏳ 1 действие", disable_notification: true, entities: [{ type: "bold", offset: 3, length: 7 }] });
    const id = fake.lastMessageId;
    a.send(card("x-0", "🤖 **Explore**\n✅ готово", true));
    await waitFor(() => fake.callsOf("editMessageText").length === 1);
    expect(fake.callsOf("editMessageText")[0]).toMatchObject({ chat_id: GROUP, message_id: id, text: "🤖 Explore\n✅ готово" });
    a.send(card("x-0", "🤖 **Explore**\n✅ готово", true));
    await Bun.sleep(150);
    expect(fake.texts().length).toBe(1);
    expect(fake.callsOf("editMessageText").length).toBe(1);
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
    fake.hangNext("sendMessage");
    a.send({ type: "send", id: "blocker", sessionId: "a", text: "wait", notify: false });
    await Bun.sleep(50);
    a.send({ ...card("x-1", "continued"), replyTo: "x-0" });
    await Bun.sleep(50);
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
    await hub.stop();
    await startHub();
    const b = await enabled("a");
    b.send(card("x-0", "v2"));
    await waitFor(() => fake.callsOf("editMessageText").length === 1);
    expect(fake.callsOf("editMessageText")[0]).toMatchObject({ message_id: x, text: "v2" });
    // A finished card stays finished.
    b.send(card("y-0", "late", true));
    await Bun.sleep(150);
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
    await Bun.sleep(SHOWN_MS);
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
    await Bun.sleep(SHOWN_MS);
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
    await startHub({ cardEditMs: 400 });
    const a = await enabled("a");
    a.send(card("x-0", "v1"));
    await waitFor(() => fake.texts().length === 1);
    a.send(card("x-0", "v2"));
    a.send(card("x-0", "v3"));
    a.send(card("x-0", "v4"));
    await Bun.sleep(150);
    expect(fake.callsOf("editMessageText")).toEqual([]);
    await waitFor(() => fake.callsOf("editMessageText").length === 1, 2000);
    await Bun.sleep(100);
    expect(fake.callsOf("editMessageText").map(c => c.text)).toEqual(["v4"]);
  });

  test("edits of many cards share one pace", async () => {
    await startHub({ cardGapMs: 300 });
    const a = await enabled("a");
    for (const id of ["x-0", "y-0", "z-0"]) a.send(card(id, `${id} v1`));
    await waitFor(() => fake.texts().length === 3);
    for (const id of ["x-0", "y-0", "z-0"]) a.send(card(id, `${id} v2`));
    await Bun.sleep(400);
    expect(fake.callsOf("editMessageText").length).toBeLessThanOrEqual(2);
    await waitFor(() => fake.callsOf("editMessageText").length === 3, 3000);
  });

  test("card edits wait while the session's text is being delivered", async () => {
    await startHub();
    const a = await enabled("a");
    a.send(card("x-0", "v1"));
    await waitFor(() => fake.texts().length === 1);
    fake.hangNext("sendMessage", 3);
    a.send({ type: "send", id: "t1", sessionId: "a", text: "urgent", notify: false });
    await Bun.sleep(100);
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
    await Bun.sleep(150);
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
    await Bun.sleep(150);
    expect(fake.texts()).toEqual([]);
  });
});

describe("starting and stopping sessions", () => {
  const SID = "11111111-2222-3333-4444-555555555555";
  const COMMAND = ["wt.exe", "-d", "{cwd}", "cswap.exe", "run", "{account}", "--", "--resume", "{session}"];
  const msg = (text: string) => topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text });
  const texts = () => fake.texts().map(t => t.text);

  // A session with a topic and no window; started commands are recorded.
  async function closedSession(o: { timeoutSec?: number } & HubExtras = {}) {
    const spawned: string[][] = [];
    config = { ...config, launch: { command: COMMAND, timeoutSec: o.timeoutSec ?? 30 } };
    await startHub({ spawn: c => void spawned.push(c), ...o });
    const a = await enabled(SID);
    a.close();
    await waitFor(() => !hub.isConnected(SID));
    return spawned;
  }

  test("a message to a closed session starts it and reaches it once it connects", async () => {
    const spawned = await closedSession();
    fake.pushUpdate(msg("first"));
    await waitFor(() => texts().includes("🚀 Запускаю сессию (аккаунт 2)…"));
    fake.pushUpdate(msg("second"));
    await Bun.sleep(150);
    expect(spawned).toEqual([["wt.exe", "-d", CWD, "cswap.exe", "run", "2", "--", "--resume", SID]]);
    const w = await plugin(SID);
    // Held messages go together as one notification.
    expect((await w.next("inbound")).content).toBe("first\n\nsecond");
    await waitFor(() => fake.callsOf("editMessageText").some(c => c.text === "✅ Сессия запущена"));
    expect(spawned.length).toBe(1);
  });

  test("the start notice is one message: edited once the session starts, gone once the agent works", async () => {
    await closedSession();
    fake.pushUpdate(msg("first"));
    await waitFor(() => texts().includes("🚀 Запускаю сессию (аккаунт 2)…"));
    const notice = fake.lastMessageId;
    const w = await plugin(SID);
    await waitFor(() => fake.callsOf("editMessageText").length === 1);
    expect(fake.callsOf("editMessageText")).toEqual([{ chat_id: GROUP, message_id: notice, text: "✅ Сессия запущена" }]);
    await w.next("inbound");
    await Bun.sleep(100);
    expect(texts().filter(t => /[Сс]есси/.test(t))).toEqual(["🚀 Запускаю сессию (аккаунт 2)…"]);
    expect(fake.callsOf("deleteMessage")).toEqual([]);
    w.send({ type: "busy", busy: true });
    await waitFor(() => fake.callsOf("deleteMessage").length === 1);
    expect(fake.callsOf("deleteMessage")).toEqual([{ chat_id: GROUP, message_id: notice }]);
    // Only once.
    w.send({ type: "busy", busy: false });
    w.send({ type: "busy", busy: true });
    await Bun.sleep(100);
    expect(fake.callsOf("deleteMessage").length).toBe(1);
  });

  test("a start notice still on its way is edited as soon as it is in the topic", async () => {
    await closedSession();
    fake.delayNext("sendMessage", 300);
    fake.pushUpdate(msg("first"));
    await waitFor(() => fake.callsOf("sendMessage").length === 1);
    await plugin(SID);
    await waitFor(() => fake.callsOf("editMessageText").length === 1);
    expect(fake.callsOf("editMessageText")).toEqual([{ chat_id: GROUP, message_id: fake.lastMessageId, text: "✅ Сессия запущена" }]);
  });

  test("a start notice still queued goes already saying the session started", async () => {
    await closedSession();
    for (let i = 0; i < 8; i++) fake.failNext("sendMessage", { code: 403, description: "Forbidden: bot is not a member" });
    fake.pushUpdate(msg("first"));
    await waitFor(() => fake.callsOf("sendMessage").length === 1);
    await plugin(SID);
    // Failed attempts are among the calls too: the first said "starting".
    await waitFor(() => fake.callsOf("sendMessage").length === 9, 3000);
    await Bun.sleep(100);
    const notices = texts().filter(t => /[Сс]есси/.test(t));
    expect(notices[0]).toBe("🚀 Запускаю сессию (аккаунт 2)…");
    expect(notices.at(-1)).toBe("✅ Сессия запущена");
    expect(fake.callsOf("editMessageText")).toEqual([]);
  });

  test("a session that does not connect in time is reported, and the start notice goes", async () => {
    await closedSession({ timeoutSec: 0.2 });
    fake.pushUpdate(msg("hello?"));
    await waitFor(() => texts().includes("🚀 Запускаю сессию (аккаунт 2)…"));
    const notice = fake.lastMessageId;
    await waitFor(() => texts().includes("⚠️ Сессия не запустилась за 0.2 с"), 3000);
    expect(fake.texts().at(-1)).toMatchObject({ disable_notification: false });
    await waitFor(() => fake.callsOf("deleteMessage").length === 1);
    expect(fake.callsOf("deleteMessage")).toEqual([{ chat_id: GROUP, message_id: notice }]);
  });

  test("/run starts on the account given, and not twice", async () => {
    const spawned = await closedSession();
    fake.pushUpdate(msg("/run 1"));
    await waitFor(() => spawned.length === 1);
    expect(spawned[0]?.[5]).toBe("1");
    fake.pushUpdate(msg("/run"));
    await waitFor(() => texts().includes("Сессия уже запускается"));
    await plugin(SID);
    fake.pushUpdate(msg("/run"));
    await waitFor(() => texts().includes("Сессия уже работает"));
    expect(spawned.length).toBe(1);
  });

  test("a bad account is refused before anything runs", async () => {
    const spawned = await closedSession();
    fake.pushUpdate(msg("/run 1&calc"));
    await waitFor(() => texts().some(t => t.startsWith("⚠️ Не могу запустить сессию: странный аккаунт")));
    expect(spawned).toEqual([]);
  });

  test("without a recorded cwd the session's transcript tells it", async () => {
    const projects = tempDir();
    mkdirSync(join(projects, "C--x"), { recursive: true });
    writeFileSync(join(projects, "C--x", `${SID}.jsonl`), JSON.stringify({ type: "user", cwd: dir }) + "\n");
    const spawned = await closedSession({ projectsDir: projects });
    const store = new SessionStore(join(dir, "sessions.json"));
    const rec = must(store.get(SID));
    await hub.stop();
    store.set(SID, { topicId: rec.topicId, title: rec.title, project: rec.project, enabled: rec.enabled, account: "1" });
    await startHub({ spawn: c => void spawned.push(c), projectsDir: projects });
    fake.pushUpdate(msg("/run"));
    await waitFor(() => spawned.length === 1);
    expect(spawned[0]?.[2]).toBe(dir);
  });

  test("a session whose account is not known is not started until /run N", async () => {
    const spawned = await closedSession();
    const store = new SessionStore(join(dir, "sessions.json"));
    const rec = must(store.get(SID));
    await hub.stop();
    store.set(SID, { topicId: rec.topicId, title: rec.title, project: rec.project, enabled: rec.enabled, cwd: CWD });
    await startHub({ spawn: c => void spawned.push(c) });
    fake.pushUpdate(msg("hi"));
    await waitFor(() => texts().includes("⚠️ Аккаунт сессии неизвестен, используй /run N."));
    expect(spawned).toEqual([]);
    fake.pushUpdate(msg("/run 2"));
    await waitFor(() => spawned.length === 1);
    expect(spawned[0]?.[5]).toBe("2");
    const w = await wsClient(port, { type: "hello", v: PROTOCOL_VERSION, windowKey: "w-started", sessionId: SID, cwd: CWD });
    clients.push(w);
    await waitFor(() => [...texts(), ...fake.callsOf("editMessageText").map(c => c.text)].includes("✅ Сессия запущена"));
    expect(new SessionStore(join(dir, "sessions.json")).get(SID)?.account).toBe("2");
  });

  // The window closes while its messages wait in a batch: none is lost.
  test("a batch whose window closed starts the session", async () => {
    const spawned: string[][] = [];
    config = { ...config, launch: { command: COMMAND, timeoutSec: LAUNCH_TIMEOUT_S } };
    await startHub({ spawn: c => void spawned.push(c), batchQuietMs: 400 });
    const a = await enabled(SID);
    fake.pushUpdate(msg("one"));
    fake.pushUpdate(msg("two"));
    await Bun.sleep(100);
    a.close();
    await waitFor(() => spawned.length === 1, WAIT_MS, "session start");
    const w = await plugin(SID);
    expect((await w.next("inbound")).content).toBe("one\n\ntwo");
  });

  test("a batch whose window closed starts no session while the hub stops", async () => {
    const spawned: string[][] = [];
    config = { ...config, launch: { command: COMMAND, timeoutSec: LAUNCH_TIMEOUT_S } };
    await startHub({ spawn: c => void spawned.push(c), batchQuietMs: 5000 });
    const a = await enabled(SID);
    fake.pushUpdate(msg("one"));
    await Bun.sleep(100);
    a.close();
    await waitFor(() => !hub.isConnected(SID));
    await hub.stop();
    expect(spawned).toEqual([]);
  });

  test("a batch whose window closed, without launch, says the session is inactive", async () => {
    await startHub({ batchQuietMs: 400 });
    const a = await enabled(SID);
    fake.pushUpdate(msg("one"));
    await Bun.sleep(100);
    a.close();
    await waitFor(() => texts().includes("сессия сейчас не активна"), WAIT_MS);
  });

  test("without launch in the config a closed session is just inactive", async () => {
    await startHub();
    const a = await enabled(SID);
    a.close();
    await waitFor(() => !hub.isConnected(SID));
    fake.pushUpdate(msg("hi"));
    await waitFor(() => texts().includes("сессия сейчас не активна"));
    fake.pushUpdate(msg("/run"));
    await waitFor(() => texts().some(t => t.startsWith("⚠️ Автозапуск не настроен")));
  });

  // These windows have no module: /stop ends them once nobody takes it.
  test("/stop ends the session's window", async () => {
    await startHub({ commandPickupMs: 50 });
    const a = await enabled(SID);
    fake.pushUpdate(msg("/stop"));
    await a.next("terminate");
    a.close();
    await waitFor(() => texts().includes("⏹ Сессия завершена"));
  });

  test("/stop that does not end the window is reported", async () => {
    await startHub({ stopTimeoutMs: 200, commandPickupMs: 50 });
    const a = await enabled(SID);
    fake.pushUpdate(msg("/stop"));
    await a.next("terminate");
    await waitFor(() => texts().includes("⚠️ Не удалось завершить сессию за 0.2 с"), 3000);
    fake.pushUpdate(msg("/stop"));
    await a.next("terminate");
  });

  test("/stop of a closed session says so", async () => {
    await closedSession();
    fake.pushUpdate(msg("/stop"));
    await waitFor(() => texts().includes("Сессия не запущена"));
  });
});

describe("idle exit", () => {
  test("the hub exits after the last plugin disconnects", async () => {
    await startHub({ idleMs: 200 });
    const a = await plugin("a");
    await Bun.sleep(350);
    expect(exited).toBe(false);
    a.close();
    await waitFor(() => exited, 2000, "idle exit");
  });

  test("a hub nobody connects to exits too", async () => {
    await startHub({ idleMs: 150 });
    await waitFor(() => exited, 2000, "idle exit");
  });

  test("with idleMs 0 or a launch command the hub stays up", async () => {
    await startHub({ idleMs: 0 });
    const a = await plugin("a");
    a.close();
    await Bun.sleep(200);
    expect(exited).toBe(false);
    await hub.stop();
    config = { ...config, launch: { command: ["x"], timeoutSec: 90 } };
    await startHub({ idleMs: 50 });
    await Bun.sleep(200);
    expect(exited).toBe(false);
  });
});

describe("commands", () => {
  const USAGE: Usage = {
    context: { tokens: 128_400, window: 1_000_000, breakdown: { totalTokens: 130_000, rawMaxTokens: 333_000, autoCompactThreshold: 300_000, isAutoCompactEnabled: true } },
    rateLimits: [{ kind: "five_hour", percentUsed: 30 }],
  };

  const COMPACTED: Compaction = { tokensBefore: 180_000, tokensAfter: 24_000 };

  // The mod of one window, with the engine faked: the commands it ran and
  // the compactions it asked for, and what `run` and `compact` answer.
  function mod(
    sessionId: string,
    answer: (command: string, args: string) => Promise<{ text?: string }> = async () => ({}),
    usage = () => USAGE,
    compaction: () => Promise<Compaction> = async () => COMPACTED,
  ) {
    const ran: [string, string][] = [];
    const compacted: (string | undefined)[] = [];
    const runner = new Runner(`http://127.0.0.1:${port}`, {
      sessionId: async () => sessionId,
      usage: async () => usage(),
      run: (command, args) => {
        ran.push([command, args]);
        return answer(command, args);
      },
      compact: instructions => {
        compacted.push(instructions);
        return compaction();
      },
      http: async (url, init) => {
        const r = await fetch(url, init);
        return { status: r.status, text: await r.text() };
      },
      now: () => Date.now(),
    });
    return { runner, ran, compacted };
  }

  const command = (text: string, threadId = 100) => fake.pushUpdate(topicMsg({ chatId: GROUP, threadId, fromId: ME, text }));
  const sentText = (pred: (t: string) => boolean) => fake.texts().find(p => pred(p.text));
  // The text a queued notice was edited into (success outcomes edit it in place).
  const editedText = (pred: (t: string) => boolean) => fake.callsOf("editMessageText").find(c => typeof c.text === "string" && pred(c.text));
  // Polls like the mod's timer until the topic gets the text.
  const reply = (runner: Runner, pred: (t: string) => boolean) =>
    waitFor(
      async () => {
        await runner.poll();
        return sentText(pred);
      },
      3000,
      "command reply",
    );

  test("/info is answered by the mod silently, never reaches the agent and leaves the mode as it was", async () => {
    await startHub();
    const a = await enabled("a");
    await req(a, { op: "disable" });
    const { runner } = mod("a");
    command("/info");
    const sent = await reply(runner, t => t.startsWith("Лимиты"));
    expect(sent).toMatchObject({ message_thread_id: 100, disable_notification: true });
    expect(sent.text).toContain("128/300k");
    expect(arr(sent.entities)[0]).toEqual({ type: "bold", offset: 0, length: "Лимиты Claude".length });
    expect(a.messages.some(m => m.type === "inbound")).toBe(false);
    expect(new SessionStore(join(dir, "sessions.json")).get("a")?.enabled).toBe(false);
  });

  test("a command goes to the mod of its own session only", async () => {
    await startHub();
    await enabled("a");
    await enabled("b");
    const a = mod("a");
    const b = mod("b");
    command("/compact 200k", 101);
    await waitFor(async () => {
      await a.runner.poll();
      await b.runner.poll();
      return b.ran.length;
    });
    expect(b.ran).toEqual([["autocompact", "200000"]]);
    expect(a.ran).toEqual([]);
  });

  test("a command sends the messages waiting before it without waiting for the quiet window", async () => {
    await startHub({ batchQuietMs: 5000 });
    const a = await enabled("a");
    const { runner, ran } = mod("a");
    const start = Date.now();
    fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "hello" }));
    command("/compact 200k");
    expect((await a.next("inbound")).content).toBe("hello");
    expect(Date.now() - start).toBeLessThan(3000);
    await waitFor(async () => {
      await runner.poll();
      return ran.length;
    });
    expect(ran).toEqual([["autocompact", "200000"]]);
  });

  test("a command for another bot and unknown commands reach the agent as text", async () => {
    await startHub();
    const a = await enabled("a");
    command("/info@other_bot");
    command("/start");
    // Sent together, they come as one notification.
    expect((await a.next("inbound")).content).toBe("/info@other_bot\n\n/start");
  });

  test("a command nobody picks up is reported in the topic", async () => {
    await startHub({ commandPickupMs: 150 });
    await enabled("a");
    command("/info");
    const sent = await waitFor(() => sentText(t => t.startsWith("⚠️")));
    expect(sent.text).toBe("⚠️ /info не выполнена: окно не забрало её за 0.15 с.");
    expect(sent.disable_notification).toBe(false);
    // Picked up too late, it is not run.
    const { runner, ran } = mod("a");
    await runner.poll();
    expect(ran).toEqual([]);
  });

  test("/compact edits its queued notice into the successful result", async () => {
    await startHub();
    await enabled("a");
    const { runner, ran, compacted } = mod("a");
    runner.turn(true);
    command("/compact keep the plan");
    const started = await reply(runner, t => t.startsWith("🗜"));
    expect(started.text).toBe("🗜 Компакт на очереди.");
    expect(started.disable_notification).toBe(true);
    const startedId = fake.lastMessageId;
    await runner.poll();
    await Bun.sleep(50);
    expect(compacted).toStrictEqual([]);
    runner.turn(false);
    await waitFor(async () => {
      await runner.poll();
      return fake.callsOf("editMessageText").length === 1;
    });
    expect(fake.callsOf("editMessageText")).toEqual([{ chat_id: GROUP, message_id: startedId, text: "✅ Компакт выполнен." }]);
    expect(fake.texts().filter(t => t.message_thread_id === 100)).toHaveLength(1);
    expect(compacted).toStrictEqual(["keep the plan"]);
    expect(ran).toEqual([]);
  });

  // The message ids the outbox file keeps once its queue is empty.
  const storedIds = async () => {
    const read = () => JSON.parse(readFileSync(join(dir, "outbox.json"), "utf8"));
    await waitFor(() => arr(field(read(), "items")).length === 0);
    return Object.entries(z.record(z.string(), z.number()).parse(field(read(), "messageIds"))).map(([, id]) => id);
  };

  test("an ordinary message leaves no message id in the outbox", async () => {
    await startHub();
    const a = await enabled("a");
    a.send({ type: "send", id: "x1", text: "plain text", notify: false });
    await waitFor(() => sentText(t => t === "plain text"));
    expect(await storedIds()).toEqual([]);
  });

  test("a queued notice keeps its id until the result arrives, then the id is gone", async () => {
    await startHub();
    await enabled("a");
    const { runner } = mod("a");
    runner.turn(true);
    command("/compact");
    await reply(runner, t => t.startsWith("🗜"));
    expect(await storedIds()).toEqual([fake.lastMessageId]);
    runner.turn(false);
    await waitFor(async () => {
      await runner.poll();
      return fake.callsOf("editMessageText").length === 1;
    });
    expect(await storedIds()).toEqual([]);
  });

  test("a compact result arriving while its queued notice is being sent edits that notice", async () => {
    await startHub();
    await enabled("a");
    const { runner } = mod("a");
    fake.delayNext("sendMessage", SLOW_SEND_MS / 2);
    command("/compact");
    await waitFor(async () => {
      await runner.poll();
      return fake.callsOf("sendMessage").length > 0;
    });
    await waitFor(async () => {
      await runner.poll();
      return fake.callsOf("editMessageText").length === 1;
    });
    expect(fake.callsOf("editMessageText")[0]?.text).toBe("✅ Компакт выполнен.");
    expect(fake.texts().filter(t => t.message_thread_id === 100)).toHaveLength(1);
  });

  test("a compact result after hub restart resolves the persisted Telegram message id", async () => {
    await startHub();
    await enabled("a");
    const h = held();
    const { runner } = mod("a", undefined, undefined, h.answer);
    command("/compact");
    await reply(runner, t => t.startsWith("🗜"));
    const startedId = fake.lastMessageId;
    const oldPort = port;
    await hub.stop();
    await startHub({ port: oldPort });
    h.release();
    await waitFor(async () => {
      await runner.poll();
      return fake.callsOf("editMessageText").length === 1;
    });
    expect(fake.callsOf("editMessageText")).toEqual([{ chat_id: GROUP, message_id: startedId, text: "✅ Компакт выполнен." }]);
  });

  test("a skipped compaction gives the reason", async () => {
    await startHub();
    await enabled("a");
    const { runner } = mod("a", undefined, undefined, async () => ({ skip: "a hook vetoed it" }));
    command("/compact");
    const started = await reply(runner, t => t.startsWith("🗜"));
    const startedId = fake.lastMessageId;
    const warning = await reply(runner, t => t.startsWith("⚠️"));
    expect(warning.text).toBe("⚠️ Компакт пропущен: a hook vetoed it");
    expect(warning.disable_notification).toBe(false);
    await waitFor(() => fake.callsOf("deleteMessage").length === 1);
    expect(fake.callsOf("deleteMessage")).toEqual([{ chat_id: GROUP, message_id: startedId }]);
    expect(started.disable_notification).toBe(true);
  });

  test("a compaction that keeps failing with no turn running gives the reason", async () => {
    await startHub();
    await enabled("a");
    const { runner, compacted } = mod("a", undefined, undefined, async () => {
      throw new Error("Not enough messages to compact.");
    });
    command("/compact");
    const started = await reply(runner, t => t.startsWith("🗜"));
    const startedId = fake.lastMessageId;
    expect((await reply(runner, t => t.startsWith("⚠️"))).text).toBe("⚠️ Компакт не выполнен: Not enough messages to compact.");
    await waitFor(() => fake.callsOf("deleteMessage").length === 1);
    expect(fake.callsOf("deleteMessage")).toEqual([{ chat_id: GROUP, message_id: startedId }]);
    expect(started.disable_notification).toBe(true);
    expect(compacted).toStrictEqual([undefined, undefined, undefined]);
  });

  test("a compaction refused as turns start runs once they end, however many times", async () => {
    await startHub();
    await enabled("a");
    const { runner, compacted } = mod("a", undefined, undefined, async () => {
      if (compacted.length > COMPACT_POLLS) return COMPACTED;
      runner.turn(true);
      throw new Error("a turn is running");
    });
    command("/compact");
    await reply(runner, t => t.startsWith("🗜"));
    for (let i = 1; i <= COMPACT_POLLS; i++) {
      await waitFor(async () => {
        await runner.poll();
        return compacted.length === i;
      });
      // No retry while the turn runs.
      await runner.poll();
      expect(compacted.length).toBe(i);
      runner.turn(false);
    }
    await waitFor(async () => {
      await runner.poll();
      return fake.callsOf("editMessageText").length === 1;
    });
    expect(sentText(t => t.startsWith("⚠️"))).toBeUndefined();
  });

  test("/compact N sets the autocompact window and answers with the text of the command", async () => {
    await startHub();
    await enabled("a");
    const { runner, ran } = mod("a", async () => ({ text: "Auto-compact window set to 333k tokens" }));
    command("/compact 333k");
    const sent = await reply(runner, t => t.startsWith("Auto-compact"));
    expect(ran).toEqual([["autocompact", "333000"]]);
    expect(sent.disable_notification).toBe(true);
  });

  test("/rename goes to the mod, which runs the session's rename and edits its queued notice into the result", async () => {
    await startHub();
    await enabled("a");
    const { runner, ran } = mod("a");
    command("/rename Спринт 3");
    const started = await reply(runner, t => t.startsWith("🏷"));
    expect(started.text).toBe("🏷 Переименование на очереди.");
    const edited = await waitFor(async () => {
      await runner.poll();
      return editedText(t => t.startsWith("✅ /rename"));
    });
    expect(edited.text).toBe("✅ /rename Спринт 3 выполнена.");
    expect(ran).toEqual([["rename", "Спринт 3"]]);
  });

  test("a reply the mod could not deliver goes with the next poll, once", async () => {
    await startHub();
    await enabled("a");
    let down = true;
    const ran: string[] = [];
    const runner = new Runner(`http://127.0.0.1:${port}`, {
      sessionId: async () => "a",
      usage: async () => USAGE,
      run: async () => ({}),
      compact: async () => COMPACTED,
      http: async (url, init) => {
        ran.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
        if (init?.method === "POST" && down) throw new Error("connection refused");
        const r = await fetch(url, init);
        return { status: r.status, text: await r.text() };
      },
      now: () => Date.now(),
    });
    command("/info");
    await waitFor(async () => {
      await runner.poll();
      return ran.includes("POST /reply");
    });
    down = false;
    await reply(runner, t => t.startsWith("Лимиты"));
    await runner.poll();
    await runner.poll();
    expect(fake.texts().filter(p => p.text.startsWith("Лимиты")).length).toBe(1);
  });

  test("/limits answers the freshest reading of the sessions on the account", async () => {
    await startHub();
    await plugin("a");
    await plugin("b");
    const other = await wsClient(port, { ...hello("c"), configDir: "C:\\p\\sessions\\1-other_mail.com" });
    clients.push(other);
    await other.next("state");
    const reading = (at: number, percentUsed: number) => ({ at, rateLimits: [{ kind: "five_hour", percentUsed }] });
    const post = (sessionId: string, at: number, percent: number) =>
      fetch(`http://127.0.0.1:${port}/limits`, { method: "POST", body: JSON.stringify({ sessionId, ...reading(at, percent) }) });
    const get = async (sessionId: string): Promise<unknown> => (await fetch(`http://127.0.0.1:${port}/limits?session=${sessionId}`)).json();
    await post("a", 1000, 10);
    await post("b", 5000, 50);
    await post("c", 9000, 90);
    expect(await get("a")).toEqual(reading(5000, 50));
    expect(await get("b")).toEqual(reading(5000, 50));
    expect(await get("c")).toEqual(reading(9000, 90));
    expect(await get("nobody")).toBeNull();
    expect((await fetch(`http://127.0.0.1:${port}/limits`, { method: "POST", body: "{}" })).status).toBe(400);
  });

  test("/codex-limits returns null or a rollout reading", async () => {
    await startHub();
    const get = () => fetch(`http://127.0.0.1:${port}/codex-limits`);
    expect(await (await get()).json()).toBeNull();
    const day = join(dir, "codex-sessions", "2026", "10", "26");
    mkdirSync(day, { recursive: true });
    const timestamp = "2026-01-01T12:56:47.467Z";
    writeFileSync(join(day, "rollout-test.jsonl"), JSON.stringify({ timestamp, type: "event_msg", payload: { type: "token_count", rate_limits: {
      limit_id: "codex", primary: { used_percent: 41, window_minutes: 300 },
    } } }));
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ at: Date.parse(timestamp), rateLimits: [{ kind: "five_hour", percentUsed: 41 }] });
  });

  test("/volunteer-limits returns none when script missing", async () => {
    await startHub({ volunteerLimitsScript: join(dir, "missing.py") });
    const res = await fetch(`http://127.0.0.1:${port}/volunteer-limits`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: "none" });
  });

  test("/volunteer-limits returns ok with parsed data", async () => {
    const scriptPath = join(dir, "volunteer-models.py");
    writeFileSync(scriptPath, `#!/usr/bin/env python3
import sys, json
print(json.dumps({
  "checked_at": "2026-01-01T08:19:04Z",
  "source": "proxy",
  "day_percent": 6,
  "used": 240,
  "cap": 4200,
  "reset_in_s": 56455,
  "providers": { "openrouter": { "used": 39, "cap": 1000 }, "requesty": { "used": 7, "cap": 200 }, "groq": { "used": 194, "cap": 3000 }, "zhipu": { "used": 4, "cap": None } },
  "error": None
}))
`);
    await startHub({ volunteerLimitsScript: scriptPath });
    const res = await fetch(`http://127.0.0.1:${port}/volunteer-limits`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.kind).toBe("ok");
    if (data.kind === "ok") {
      expect(data.dayPercent).toBe(6);
      expect(data.providers).toEqual([
        { name: "OpenRouter", used: 39, cap: 1000 },
        { name: "Requesty", used: 7, cap: 200 },
        { name: "Groq", used: 194, cap: 3000 },
      ]);
    }
  });

  test("/volunteer-limits returns error for source none", async () => {
    const scriptPath = join(dir, "volunteer-models.py");
    writeFileSync(scriptPath, `#!/usr/bin/env python3
import sys, json
print(json.dumps({
  "checked_at": "2026-01-01T08:19:04Z",
  "source": "none",
  "day_percent": None,
  "used": None,
  "cap": None,
  "reset_in_s": None,
  "providers": None,
  "error": "no proxy configured"
}))
`);
    await startHub({ volunteerLimitsScript: scriptPath });
    const res = await fetch(`http://127.0.0.1:${port}/volunteer-limits`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: "error", reason: "no proxy configured" });
  });

  test("/volunteer-limits returns error for bad JSON", async () => {
    const scriptPath = join(dir, "volunteer-models.py");
    writeFileSync(scriptPath, `#!/usr/bin/env python3
print("not json")
`);
    await startHub({ volunteerLimitsScript: scriptPath });
    const res = await fetch(`http://127.0.0.1:${port}/volunteer-limits`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.kind).toBe("error");
    if (data.kind === "error") {
      expect(data.reason).toContain("JSON");
    }
  });

  test("/volunteer-limits returns error for script crash", async () => {
    const scriptPath = join(dir, "volunteer-models.py");
    writeFileSync(scriptPath, `#!/usr/bin/env python3
import sys
sys.exit(1)
`);
    await startHub({ volunteerLimitsScript: scriptPath });
    const res = await fetch(`http://127.0.0.1:${port}/volunteer-limits`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.kind).toBe("error");
    if (data.kind === "error") {
      expect(data.reason).toContain("script exited with code 1");
    }
  });

  test("the same reply posted twice is sent once", async () => {
    await startHub();
    await enabled("a");
    const post = () => fetch(`http://127.0.0.1:${port}/reply`, { method: "POST", body: JSON.stringify({ sessionId: "a", id: "c1.0", text: "once", notify: true }) });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    await waitFor(() => sentText(t => t === "once"));
    await Bun.sleep(100);
    expect(fake.texts().filter(p => p.text === "once").length).toBe(1);
  });

  const SMALL: Usage = { context: { tokens: 50_000, window: 1_000_000 }, rateLimits: [] };
  const terminated = (c: { messages: { type: string }[] }) => c.messages.some(m => m.type === "terminate");

  // A compaction that ends when the test lets it.
  function held(result: Compaction = COMPACTED) {
    let release = () => {};
    const done = new Promise<void>(r => (release = r));
    return {
      release: () => release(),
      answer: async () => {
        await done;
        return result;
      },
    };
  }

  test("/stop of a session with little context ends it with no compaction", async () => {
    await startHub();
    const a = await enabled("a");
    const { runner, compacted } = mod("a", undefined, () => SMALL);
    command("/stop");
    await waitFor(async () => {
      await runner.poll();
      return terminated(a);
    });
    expect(compacted).toStrictEqual([]);
  });

  test("/stop of a session with more than 120k compacts it first, reports it, then ends it", async () => {
    await startHub();
    const a = await enabled("a");
    const h = held({ tokensBefore: 128_000, tokensAfter: 20_000 });
    const { runner, compacted } = mod("a", undefined, undefined, h.answer);
    command("/stop");
    const started = await reply(runner, t => t.startsWith("🗜"));
    const startedId = fake.lastMessageId;
    expect(started.text).toBe("🗜 Сожму контекст и завершу сессию. Повторный /stop завершит сразу.");
    expect(started.disable_notification).toBe(true);
    await waitFor(async () => {
      await runner.poll();
      return compacted.length;
    });
    expect(compacted).toStrictEqual([undefined]);
    await Bun.sleep(100);
    expect(terminated(a)).toBe(false);
    h.release();
    await a.next("terminate");
    await waitFor(async () => {
      await runner.poll();
      return fake.callsOf("editMessageText").length === 1;
    });
    expect(fake.callsOf("editMessageText")).toEqual([{ chat_id: GROUP, message_id: startedId, text: "✅ Компакт выполнен." }]);
    a.close();
    await waitFor(() => sentText(t => t === "⏹ Сессия завершена"));
  });

  test("/stop deletes its compaction notice and sends a skipped result loudly", async () => {
    await startHub();
    const a = await enabled("a");
    const { runner } = mod("a", undefined, undefined, async () => ({ skip: "nothing to compact" }));
    command("/stop");
    const started = await reply(runner, t => t.startsWith("🗜 Сожму контекст"));
    const startedId = fake.lastMessageId;
    expect(started.disable_notification).toBe(true);
    const warning = await reply(runner, t => t.startsWith("⚠️ Компакт пропущен"));
    expect(warning.disable_notification).toBe(false);
    expect(warning.text).toBe("⚠️ Компакт пропущен: nothing to compact");
    await waitFor(() => fake.callsOf("deleteMessage").length === 1);
    expect(fake.callsOf("deleteMessage")).toEqual([{ chat_id: GROUP, message_id: startedId }]);
    await a.next("terminate");
    a.close();
    await waitFor(() => sentText(t => t === "⏹ Сессия завершена"));
  });

  test("/stop waits for a /compact from the topic", async () => {
    await startHub();
    const a = await enabled("a");
    const h = held();
    let usage = USAGE;
    const { runner, compacted } = mod("a", undefined, () => usage, h.answer);
    command("/compact");
    await reply(runner, t => t.startsWith("🗜"));
    command("/stop");
    const waiting = await reply(runner, t => t.startsWith("⏳"));
    expect(waiting.text).toBe("⏳ После компакта завершу сессию. Повторный /stop завершит сразу.");
    await Bun.sleep(100);
    expect(terminated(a)).toBe(false);
    usage = SMALL;
    h.release();
    await a.next("terminate");
    expect(compacted).toStrictEqual([undefined]);
  });

  test("the notice of a /stop waiting for a compact turns into the ended notice", async () => {
    await startHub();
    const a = await enabled("a");
    const h = held();
    let usage = USAGE;
    const { runner } = mod("a", undefined, () => usage, h.answer);
    command("/compact");
    await reply(runner, t => t.startsWith("🗜"));
    command("/stop");
    await reply(runner, t => t.startsWith("⏳"));
    const waitingId = fake.lastMessageId;
    usage = SMALL;
    h.release();
    await a.next("terminate");
    a.close();
    await waitFor(() => fake.callsOf("editMessageText").some(c => c.text === "⏹ Сессия завершена"));
    expect(fake.callsOf("editMessageText").filter(c => c.message_id === waitingId)).toEqual([{ chat_id: GROUP, message_id: waitingId, text: "⏹ Сессия завершена" }]);
    expect(fake.callsOf("sendMessage").filter(c => c.text === "⏹ Сессия завершена")).toEqual([]);
  });

  test("/stop with no compaction running sends the ended notice as a new message", async () => {
    await startHub();
    const a = await enabled("a");
    const { runner } = mod("a", undefined, () => SMALL);
    command("/stop");
    await waitFor(async () => {
      await runner.poll();
      return terminated(a);
    });
    a.close();
    await waitFor(() => sentText(t => t === "⏹ Сессия завершена"));
    expect(fake.callsOf("editMessageText")).toEqual([]);
  });

  test("a second /stop ends the window without waiting", async () => {
    await startHub();
    const a = await enabled("a");
    const { runner } = mod("a", undefined, undefined, held().answer);
    command("/stop");
    await reply(runner, t => t.startsWith("🗜"));
    command("/stop");
    await a.next("terminate");
  });

  test("an older module never gets /stop, and the window ends once nobody takes it", async () => {
    await startHub({ commandPickupMs: 150 });
    const a = await enabled("a");
    command("/stop");
    const answers = new Set<string>();
    await waitFor(async () => {
      answers.add(await (await fetch(`http://127.0.0.1:${port}/commands?session=a`)).text());
      return terminated(a);
    }, 3000);
    expect([...answers]).toEqual(["[]"]);
  });

  test("the hub puts the commands into the bot menu", async () => {
    await startHub();
    const call = await waitFor(() => fake.callsOf("setMyCommands")[0]);
    expect(arr(call.commands).map(c => field(c, "command"))).toEqual(["info", "compact", "rename", "run", "stop", "cleanup", "pwsh", "cmd", "bash"]);
    expect(field(arr(call.commands).find(c => field(c, "command") === "compact"), "description")).toBe("Сжать контекст; /compact <указания> — с указаниями; /compact N — окно автокомпакта");
    expect(field(arr(call.commands).find(c => field(c, "command") === "rename"), "description")).toBe("Переименовать сессию и её тему; /rename <имя> — новое имя");
    expect(field(arr(call.commands).find(c => field(c, "command") === "pwsh"), "description")).toBe("Команда в PowerShell в папке сессии");
  });

  describe("/cleanup", () => {
    const SID = "11111111-2222-3333-4444-555555555555";
    const COMMAND = ["wt.exe", "-d", "{cwd}", "cswap.exe", "run", "{account}", "--", "--resume", "{session}"];
    const STARTED = ["wt.exe", "-d", CWD, "cswap.exe", "run", "2", "--", "--resume", SID];
    const PID = 4242;
    const VERSION = "1.0.0";
    // Skill sizes in characters: 1k and 18k tokens.
    const SMALL_SKILL = 4000;
    const BIG_SKILL = 72_000;
    // How long a Claude Code that does not exit is waited for.
    const EXIT_MS = 300;
    // How long a compact that does not end is waited for: 0.02 min.
    const COMPACT_MS = 1200;
    // How long a window that does not end is waited for: 0.4 s.
    const STOP_MS = 400;
    // A slow send, still under the test API's 300 ms attempt timeout so it
    // is not sent twice.
    const SLOW_SEND_MS = 200;

    const skill = (name: string, chars: number) => ({ name, content: "x".repeat(chars) });
    const record = (uuid: string, skills: { name: string; content: string }[]) =>
      JSON.stringify({ parentUuid: "p", type: "attachment", attachment: { type: "invoked_skills", skills }, uuid, version: VERSION });
    const SKILLS = [record("u1", [skill("a", SMALL_SKILL)]), record("u2", [skill("a", SMALL_SKILL), skill("b", BIG_SKILL)])];

    // A session with a window, a topic and a transcript in its own projects
    // folder; Claude Code exits at once unless told otherwise, started
    // commands are recorded.
    async function liveSession(lines: string[], o: Parameters<typeof startHub>[0] = {}) {
      const projects = tempDir();
      const folder = join(projects, "C--x");
      mkdirSync(folder, { recursive: true });
      const transcript = join(folder, `${SID}.jsonl`);
      writeFileSync(transcript, [JSON.stringify({ type: "user", cwd: CWD }), ...lines].map(l => `${l}\n`).join(""));
      const spawned: string[][] = [];
      config = { ...config, launch: { command: COMMAND, timeoutSec: LAUNCH_TIMEOUT_S } };
      await startHub({ spawn: c => void spawned.push(c), projectsDir: projects, isAlive: () => false, ...o });
      const a = await enabled(SID);
      return { a, spawned, transcript, folder, original: readFileSync(transcript, "utf8") };
    }

    // The window ends the way the plugin ends it on terminate.
    async function windowEnds(a: Awaited<ReturnType<typeof plugin>>) {
      await a.next("terminate");
      a.send({ type: "exiting", pid: PID });
      a.close();
    }

    const pollUntil = (runner: Runner, done: () => boolean) =>
      waitFor(async () => {
        await runner.poll();
        return done();
      });

    const backups = (folder: string) => readdirSync(folder).filter(f => f.startsWith(`${SID}.cleanup-`));

    test("/cleanup compacts, ends the window, empties the skills and leaves the session ended", async () => {
      const { a, spawned, transcript, folder } = await liveSession(SKILLS);
      const { runner, compacted } = mod(SID);
      command("/cleanup keep the plan");
      const started = await reply(runner, t => t.startsWith("🧹 Уборка"));
      expect(started.text).toBe("🧹 Уборка на очереди.");
      expect(started.disable_notification).toBe(true);
      const startedId = fake.lastMessageId;
      await pollUntil(runner, () => terminated(a));
      expect(compacted).toStrictEqual(["keep the plan"]);
      await windowEnds(a);
      // The summary edits the "will compact" message in place.
      await waitFor(() => fake.callsOf("editMessageText").length);
      expect(fake.callsOf("editMessageText")).toEqual([{ chat_id: GROUP, message_id: startedId, text: "🧹 Уборка выполнена, убраны скиллы: a, b." }]);
      expect(sentText(t => t.startsWith("🧹") && !t.startsWith("🧹 Уборка на очереди"))).toBeUndefined();
      await waitFor(() => sentText(t => t === "⏹ Сессия завершена"));
      await Bun.sleep(SETTLE_MS);
      expect(spawned).toEqual([]);
      expect(fake.callsOf("deleteMessage")).toEqual([]);
      expect(readFileSync(transcript, "utf8").match(/"skills":\[\]/g)?.length).toBe(2);
      expect(backups(folder).length).toBe(1);
    });

    test("a message during /cleanup waits and reaches the session started again", async () => {
      let alive = true;
      const { a, spawned } = await liveSession(SKILLS, { isAlive: () => alive });
      const { runner } = mod(SID);
      command("/cleanup");
      await pollUntil(runner, () => terminated(a));
      await windowEnds(a);
      await waitFor(() => !hub.isConnected(SID));
      command("meanwhile");
      await Bun.sleep(SETTLE_MS);
      alive = false;
      const summary = await waitFor(() => editedText(t => t.startsWith("🧹") && !t.startsWith("🧹 Уборка на очереди")));
      expect(summary.text).toBe("🧹 Уборка выполнена, убраны скиллы: a, b.");
      await waitFor(() => spawned.length);
      expect(spawned).toEqual([STARTED]);
      const w = await plugin(SID);
      expect((await w.next("inbound")).content).toBe("meanwhile");
      await Bun.sleep(SETTLE_MS);
      expect(sentText(t => t.startsWith("🚀"))).toBeDefined();
    });

    test("a failed compact leaves the window and the transcript alone", async () => {
      const { a, spawned, transcript, original } = await liveSession(SKILLS);
      const { runner } = mod(SID, undefined, undefined, async () => {
        throw new Error("boom");
      });
      // The "will compact" message is still being sent when the failure comes.
      fake.delayNext("sendMessage", SLOW_SEND_MS);
      command("/cleanup");
      const startedId = fake.nextMessageId;
      const failed = await reply(runner, t => t.startsWith("⚠️"));
      expect(failed.text).toBe("⚠️ Уборка не выполнена: компакт не удался: boom");
      expect(failed.disable_notification).toBe(false);
      await waitFor(() => fake.callsOf("deleteMessage").length);
      expect(fake.callsOf("deleteMessage")).toEqual([{ chat_id: GROUP, message_id: startedId }]);
      await Bun.sleep(SETTLE_MS);
      expect(terminated(a)).toBe(false);
      expect(readFileSync(transcript, "utf8")).toBe(original);
      expect(spawned).toEqual([]);
    });

    test("an older module that does not take /cleanup gets the lost notice and keeps running", async () => {
      const { a } = await liveSession(SKILLS, { commandPickupMs: 150 });
      command("/cleanup");
      const answers = new Set<string>();
      const lost = await waitFor(async () => {
        answers.add(await (await fetch(`http://127.0.0.1:${port}/commands?session=${SID}&stop=1`)).text());
        return sentText(t => t.startsWith("⚠️"));
      }, 3000);
      expect(lost.text).toBe("⚠️ /cleanup не выполнена: окно не забрало её за 0.15 с.");
      expect([...answers]).toEqual(["[]"]);
      expect(terminated(a)).toBe(false);
      // The cleanup is over: /run answers for a working session.
      command("/run");
      await waitFor(() => sentText(t => t === "Сессия уже работает"));
    });

    test("a Claude Code that does not exit keeps the transcript and does not relaunch", async () => {
      const { a, spawned, transcript, original } = await liveSession(SKILLS, { isAlive: () => true, cleanupExitMs: EXIT_MS });
      const { runner } = mod(SID);
      command("/cleanup");
      await pollUntil(runner, () => terminated(a));
      await windowEnds(a);
      const warning = await waitFor(() => sentText(t => t.startsWith("⚠️")));
      expect(warning.text).toBe("⚠️ Уборка не выполнена: Claude Code не завершился");
      expect(warning.disable_notification).toBe(false);
      expect(readFileSync(transcript, "utf8")).toBe(original);
      expect(spawned).toEqual([]);
    });

    test("/stop during the compact ends the window at once, the transcript untouched", async () => {
      const { a, spawned, transcript, original, folder } = await liveSession(SKILLS);
      const h = held();
      const { runner } = mod(SID, undefined, undefined, h.answer);
      command("/cleanup");
      await reply(runner, t => t.startsWith("🧹 Уборка"));
      const startedId = fake.lastMessageId;
      command("/stop");
      const cancelled = await waitFor(() => sentText(t => t === "⏹ Уборка отменена"));
      expect(cancelled.disable_notification).toBe(true);
      await waitFor(() => fake.callsOf("deleteMessage").length);
      expect(fake.callsOf("deleteMessage")).toEqual([{ chat_id: GROUP, message_id: startedId }]);
      await windowEnds(a);
      await waitFor(() => sentText(t => t === "⏹ Сессия завершена"));
      await Bun.sleep(SETTLE_MS);
      expect(readFileSync(transcript, "utf8")).toBe(original);
      expect(backups(folder)).toEqual([]);
      expect(spawned).toEqual([]);
      h.release();
    });

    test("/stop during the compact does not hand held messages to the dying window", async () => {
      const { a, spawned } = await liveSession(SKILLS);
      const h = held();
      const { runner } = mod(SID, undefined, undefined, h.answer);
      command("/cleanup");
      await reply(runner, t => t.startsWith("🧹 Уборка"));
      command("meanwhile");
      await heldForCleanup();
      command("/stop");
      await windowEnds(a);
      await waitFor(() => spawned.length);
      expect(spawned).toEqual([STARTED]);
      expect(inbound(a)).toBe(false);
      const w = await plugin(SID);
      expect((await w.next("inbound")).content).toBe("meanwhile");
      h.release();
    });

    test("a Claude Code that does not exit routes held messages through the inactive-session flow", async () => {
      const { a, spawned } = await liveSession(SKILLS, { isAlive: () => true, cleanupExitMs: EXIT_MS });
      const { runner } = mod(SID);
      command("/cleanup");
      await pollUntil(runner, () => terminated(a));
      command("meanwhile");
      await heldForCleanup();
      await windowEnds(a);
      const warning = await waitFor(() => sentText(t => t.startsWith("⚠️")));
      expect(warning.text).toBe("⚠️ Уборка не выполнена: Claude Code не завершился");
      await waitFor(() => spawned.length);
      expect(spawned).toEqual([STARTED]);
      const w = await plugin(SID);
      expect((await w.next("inbound")).content).toBe("meanwhile");
    });

    test("an exec result during /cleanup waits for the relaunched session", async () => {
      const { a, spawned } = await liveSession(SKILLS);
      const h = held();
      const { runner } = mod(SID, undefined, undefined, h.answer);
      command("/cleanup");
      await reply(runner, t => t.startsWith("🧹 Уборка"));
      command("/cmd echo hi");
      await waitFor(() => log.lines.some(l => l.includes("a command result for session") && l.includes("held until /cleanup ends")), RUN_MS);
      expect(a.messages.some(m => m.type === "inbound")).toBe(false);
      h.release();
      await pollUntil(runner, () => terminated(a));
      await windowEnds(a);
      await waitFor(() => spawned.length);
      expect(spawned).toEqual([STARTED]);
      const w = await plugin(SID);
      expect((await w.next("inbound", m => m.meta.source === "exec", WAIT_MS)).content).toContain("hi");
      expect(a.messages.some(m => m.type === "inbound")).toBe(false);
    }, RUN_MS + WAIT_MS);

    test("an unknown transcript format leaves the session ended with the warning", async () => {
      const odd = JSON.stringify({ parentUuid: "p", type: "attachment", attachment: { type: "invoked_skills", names: ["x"] }, uuid: "u1", version: VERSION });
      const { a, spawned, transcript, original } = await liveSession([odd]);
      const { runner } = mod(SID);
      command("/cleanup");
      const startedId = (await reply(runner, t => t.startsWith("🧹 Уборка на очереди")), fake.lastMessageId);
      command("format held");
      await heldForCleanup();
      await pollUntil(runner, () => terminated(a));
      await windowEnds(a);
      const summary = await waitFor(() => sentText(t => t.startsWith("⚠️ Уборка не выполнена")));
      // A failure deletes the queued notice and arrives as a new loud message.
      expect(summary.disable_notification).toBe(false);
      expect(fake.callsOf("deleteMessage")).toEqual([{ chat_id: GROUP, message_id: startedId }]);
      expect(fake.callsOf("editMessageText")).toEqual([]);
      expect(summary.text).toBe(`⚠️ Уборка не выполнена: формат транскрипта изменился (Claude Code ${VERSION})`);
      await waitFor(() => spawned.length);
      expect(spawned).toEqual([STARTED]);
      const w = await plugin(SID);
      expect((await w.next("inbound")).content).toBe("format held");
      expect(readFileSync(transcript, "utf8")).toBe(original);
    });

    test("a missing transcript still routes held messages through the normal flow", async () => {
      const { a, spawned, transcript } = await liveSession(SKILLS);
      const { runner } = mod(SID);
      unlinkSync(transcript);
      command("/cleanup");
      command("missing transcript held");
      await heldForCleanup();
      await pollUntil(runner, () => terminated(a));
      await windowEnds(a);
      const warning = await waitFor(() => sentText(t => t.startsWith("⚠️ Уборка не выполнена")));
      expect(warning.text).toBe("⚠️ Уборка не выполнена: транскрипт не найден");
      await waitFor(() => spawned.length);
      expect(spawned).toEqual([STARTED]);
      const w = await plugin(SID);
      expect((await w.next("inbound")).content).toBe("missing transcript held");
      expect(existsSync(transcript)).toBe(false);
    });

    test("nothing to remove reports completion and leaves the session ended", async () => {
      const { a, spawned } = await liveSession([]);
      const { runner } = mod(SID);
      command("/cleanup");
      await pollUntil(runner, () => terminated(a));
      await windowEnds(a);
      const summary = await waitFor(() => editedText(t => t.startsWith("🧹") && !t.startsWith("🧹 Уборка на очереди")));
      expect(summary.text).toBe("🧹 Уборка выполнена.");
      await waitFor(() => sentText(t => t === "⏹ Сессия завершена"));
      await Bun.sleep(SETTLE_MS);
      expect(spawned).toEqual([]);
    });

    test("a second /cleanup and /run wait for the first", async () => {
      const { a } = await liveSession(SKILLS);
      const h = held();
      const { runner } = mod(SID, undefined, undefined, h.answer);
      command("/cleanup");
      await reply(runner, t => t.startsWith("🧹 Уборка"));
      command("/cleanup");
      command("/run");
      await waitFor(() => fake.texts().filter(p => p.text === "⏳ Уборка уже идёт").length === 2);
      expect(terminated(a)).toBe(false);
      h.release();
    });

    test("a window back while Claude Code is waited for gets the held messages and the transcript stays", async () => {
      const { a, spawned, transcript, original, folder } = await liveSession(SKILLS, { isAlive: () => true });
      const { runner } = mod(SID);
      command("/cleanup");
      await pollUntil(runner, () => terminated(a));
      await windowEnds(a);
      await waitFor(() => !hub.isConnected(SID));
      command("meanwhile");
      await Bun.sleep(SETTLE_MS);
      const w = await plugin(SID);
      expect((await w.next("inbound")).content).toBe("meanwhile");
      const warning = await waitFor(() => sentText(t => t.startsWith("⚠️")));
      expect(warning.text).toBe("⚠️ Уборка не выполнена: сессия снова открыта");
      expect(readFileSync(transcript, "utf8")).toBe(original);
      expect(backups(folder)).toEqual([]);
      expect(spawned).toEqual([]);
    });

    test("a window back during the edit is not started a second time and gets the held messages", async () => {
      let alive = true;
      let w: Awaited<ReturnType<typeof plugin>> | undefined;
      const { a, spawned, transcript } = await liveSession(SKILLS, {
        isAlive: () => alive,
        cleanTranscript: async (path, now) => {
          w = await plugin(SID);
          return cleanTranscript(path, now);
        },
      });
      const { runner } = mod(SID);
      command("/cleanup");
      await pollUntil(runner, () => terminated(a));
      await windowEnds(a);
      await waitFor(() => !hub.isConnected(SID));
      command("meanwhile");
      await Bun.sleep(SETTLE_MS);
      alive = false;
      const summary = await waitFor(() => editedText(t => t.startsWith("🧹") && !t.startsWith("🧹 Уборка на очереди")));
      expect(summary.text).toBe("🧹 Уборка выполнена, убраны скиллы: a, b.");
      const window = must(w, "window");
      expect((await window.next("inbound")).content).toBe("meanwhile");
      expect(readFileSync(transcript, "utf8").match(/"skills":\[\]/g)?.length).toBe(2);
      await Bun.sleep(SETTLE_MS);
      expect(spawned).toEqual([]);
    });

    const heldForCleanup = () => waitFor(() => log.lines.some(l => l.includes("held until /cleanup ends")));
    const inbound = (c: { messages: { type: string }[] }) => c.messages.some(m => m.type === "inbound");

    test("a message during the compact does not reach the window and goes to the session started again", async () => {
      const { a, spawned } = await liveSession(SKILLS);
      const h = held();
      const { runner } = mod(SID, undefined, undefined, h.answer);
      command("/cleanup");
      await reply(runner, t => t.startsWith("🧹 Уборка"));
      command("meanwhile");
      await heldForCleanup();
      await Bun.sleep(SETTLE_MS);
      expect(inbound(a)).toBe(false);
      h.release();
      await pollUntil(runner, () => terminated(a));
      await windowEnds(a);
      await waitFor(() => spawned.length);
      expect(spawned).toEqual([STARTED]);
      const w = await plugin(SID);
      expect((await w.next("inbound")).content).toBe("meanwhile");
      expect(inbound(a)).toBe(false);
    });

    test("a message starting with ! during the compact reaches the window at once", async () => {
      const { a } = await liveSession(SKILLS);
      const h = held();
      const { runner } = mod(SID, undefined, undefined, h.answer);
      command("/cleanup");
      await reply(runner, t => t.startsWith("🧹 Уборка"));
      command(" !stop now");
      const stop = await a.next("inbound");
      expect(stop.content).toBe("stop now");
      expect(stop.interrupt).toBe(true);
      h.release();
    });

    test("a failed compact hands the held messages to the window", async () => {
      const { a, spawned } = await liveSession(SKILLS);
      let release = () => {};
      const gate = new Promise<void>(r => (release = r));
      const { runner } = mod(SID, undefined, undefined, async () => {
        await gate;
        throw new Error("boom");
      });
      command("/cleanup");
      await reply(runner, t => t.startsWith("🧹 Уборка"));
      command("meanwhile");
      await heldForCleanup();
      expect(inbound(a)).toBe(false);
      release();
      await reply(runner, t => t.startsWith("⚠️ Уборка не выполнена"));
      expect((await a.next("inbound")).content).toBe("meanwhile");
      expect(terminated(a)).toBe(false);
      expect(spawned).toEqual([]);
    });

    test('held messages and a waiting "!" batch reach the window in the order they came', async () => {
      const { a } = await liveSession(SKILLS, { batchQuietMs: 2000, batchMaxMs: 5000 });
      let release = () => {};
      const gate = new Promise<void>(r => (release = r));
      const { runner } = mod(SID, undefined, undefined, async () => {
        await gate;
        throw new Error("boom");
      });
      const inbounds = (c: { messages: { type: string; content?: unknown }[] }) => c.messages.filter(m => m.type === "inbound").map(m => m.content);
      const contents = () => inbounds(a);
      const heldCount = () => log.lines.filter(l => l.includes("held until /cleanup ends")).length;
      command("/cleanup");
      await reply(runner, t => t.startsWith("🧹 Уборка"));
      command("before");
      await waitFor(() => heldCount() === 1);
      // Goes live, and waits in its batch for the quiet window.
      command("!stop");
      await Bun.sleep(SETTLE_MS);
      command("after");
      await waitFor(() => heldCount() === 2);
      expect(inbound(a)).toBe(false);
      release();
      await reply(runner, t => t.startsWith("⚠️ Уборка не выполнена"));
      await waitFor(() => contents().length === 2, 1000, "both batches before the quiet window ends");
      expect(contents()).toEqual(["before", "stop\n\nafter"]);
    });

    test("a compact that does not end in time drops /cleanup loudly, hands the held messages to the window and ignores the late report", async () => {
      const { a, spawned, transcript, original } = await liveSession(SKILLS, { cleanupCompactMs: COMPACT_MS });
      const h = held();
      const { runner } = mod(SID, undefined, undefined, h.answer);
      command("/cleanup");
      await reply(runner, t => t.startsWith("🧹 Уборка"));
      command("meanwhile");
      await heldForCleanup();
      const late = await waitFor(() => sentText(t => t.startsWith("⚠️")), COMPACT_MS * 3);
      expect(late.text).toBe("⚠️ Уборка не выполнена: компакт не закончился за 0.02 мин");
      expect(late.disable_notification).toBe(false);
      expect((await a.next("inbound")).content).toBe("meanwhile");
      h.release();
      await pollUntil(runner, () => log.lines.some(l => l.includes("ignored: that /cleanup was dropped or is unknown")));
      await Bun.sleep(SETTLE_MS);
      expect(terminated(a)).toBe(false);
      expect(readFileSync(transcript, "utf8")).toBe(original);
      expect(spawned).toEqual([]);
    });

    test("a window closed during the compact drops /cleanup loudly and its held messages start the session", async () => {
      const { a, spawned, transcript, original } = await liveSession(SKILLS);
      const h = held();
      const { runner } = mod(SID, undefined, undefined, h.answer);
      command("/cleanup");
      await reply(runner, t => t.startsWith("🧹 Уборка"));
      command("meanwhile");
      await heldForCleanup();
      a.close();
      const closed = await waitFor(() => sentText(t => t.startsWith("⚠️ Уборка не выполнена")));
      expect(closed.text).toBe("⚠️ Уборка не выполнена: окно закрылось до конца компакта");
      expect(closed.disable_notification).toBe(false);
      await waitFor(() => spawned.length);
      expect(spawned).toEqual([STARTED]);
      const w = await plugin(SID);
      expect((await w.next("inbound")).content).toBe("meanwhile");
      expect(readFileSync(transcript, "utf8")).toBe(original);
      h.release();
    });

    test("/stop while the window ends after the compact changes nothing", async () => {
      const { a, spawned, transcript } = await liveSession(SKILLS);
      const { runner } = mod(SID);
      command("/cleanup");
      await pollUntil(runner, () => terminated(a));
      command("/stop");
      await Bun.sleep(SETTLE_MS);
      expect(a.messages.filter(m => m.type === "terminate").length).toBe(1);
      await windowEnds(a);
      const summary = await waitFor(() => editedText(t => t.startsWith("🧹") && !t.startsWith("🧹 Уборка на очереди")));
      expect(summary.text).toBe("🧹 Уборка выполнена, убраны скиллы: a, b.");
      await waitFor(() => sentText(t => t === "⏹ Сессия завершена"));
      expect(readFileSync(transcript, "utf8").match(/"skills":\[\]/g)?.length).toBe(2);
      await Bun.sleep(SETTLE_MS);
      expect(spawned).toEqual([]);
    });

    test("a window that does not end after the compact drops /cleanup loudly and gets the held messages", async () => {
      const { a, spawned, transcript, original } = await liveSession(SKILLS, { stopTimeoutMs: STOP_MS });
      const { runner } = mod(SID);
      command("/cleanup");
      await pollUntil(runner, () => terminated(a));
      command("meanwhile");
      await heldForCleanup();
      const failed = await waitFor(() => sentText(t => t.startsWith("⚠️")), STOP_MS * 3);
      expect(failed.text).toBe("⚠️ Не удалось завершить сессию за 0.4 с");
      expect(failed.disable_notification).toBe(false);
      expect((await a.next("inbound")).content).toBe("meanwhile");
      // The cleanup is over: /run answers for a working session.
      command("/run");
      await waitFor(() => sentText(t => t === "Сессия уже работает"));
      expect(readFileSync(transcript, "utf8")).toBe(original);
      expect(spawned).toEqual([]);
    });

    test("a window that ends without naming its process is waited out, then cleaned and left ended", async () => {
      // A pid would be waited for and found alive; without one the hub only waits a moment.
      const { a, spawned, transcript } = await liveSession(SKILLS, { isAlive: () => true, cleanupSettleMs: SETTLE_MS });
      const { runner } = mod(SID);
      command("/cleanup");
      await pollUntil(runner, () => terminated(a));
      await a.next("terminate");
      a.close();
      const summary = await waitFor(() => editedText(t => t.startsWith("🧹") && !t.startsWith("🧹 Уборка на очереди")));
      expect(summary.text).toBe("🧹 Уборка выполнена, убраны скиллы: a, b.");
      await waitFor(() => sentText(t => t === "⏹ Сессия завершена"));
      expect(log.lines.some(l => l.includes("the Claude Code process is unknown"))).toBe(true);
      expect(readFileSync(transcript, "utf8").match(/"skills":\[\]/g)?.length).toBe(2);
      await Bun.sleep(SETTLE_MS);
      expect(spawned).toEqual([]);
    });

    test("a failed transcript edit says so loudly and leaves the session ended", async () => {
      const { a, spawned, transcript, original } = await liveSession(SKILLS, {
        cleanTranscript: async () => {
          throw new Error("disk");
        },
      });
      const { runner } = mod(SID);
      command("/cleanup");
      command("edit failed held");
      await heldForCleanup();
      await pollUntil(runner, () => terminated(a));
      await windowEnds(a);
      const warning = await waitFor(() => sentText(t => t.startsWith("⚠️ Уборка не выполнена")));
      expect(warning.text).toBe("⚠️ Уборка не выполнена: disk");
      expect(warning.disable_notification).toBe(false);
      await waitFor(() => spawned.length);
      expect(spawned).toEqual([STARTED]);
      const w = await plugin(SID);
      expect((await w.next("inbound")).content).toBe("edit failed held");
      expect(readFileSync(transcript, "utf8")).toBe(original);
    });

    test("a successful cleanup starts the session and hands it the held messages the standard way", async () => {
      const { a, spawned, transcript } = await liveSession(SKILLS);
      const { runner } = mod(SID);
      command("/cleanup");
      command("success held");
      await heldForCleanup();
      await pollUntil(runner, () => terminated(a));
      await windowEnds(a);
      const summary = await waitFor(() => editedText(t => t.startsWith("🧹 Уборка выполнена")));
      expect(summary.text).toBe("🧹 Уборка выполнена, убраны скиллы: a, b.");
      await waitFor(() => spawned.length);
      expect(spawned).toEqual([STARTED]);
      const w = await plugin(SID);
      expect((await w.next("inbound")).content).toBe("success held");
      expect(readFileSync(transcript, "utf8").match(/"skills":\[\]/g)?.length).toBe(2);
    });

    test("a message sent before the window is ready arrives after the held ones", async () => {
      const { a, spawned } = await liveSession(SKILLS);
      const { runner } = mod(SID);
      command("/cleanup");
      command("older");
      command("older too");
      await heldForCleanup();
      await pollUntil(runner, () => terminated(a));
      await windowEnds(a);
      await waitFor(() => spawned.length);
      // The hand-over starts after readyDelayMs; the batch of "newer" is
      // flushed after BATCH_QUIET_MS, well before that.
      const w = await plugin(SID);
      command("newer");
      await w.next("inbound", m => m.content.includes("newer"));
      const text = w.messages.filter(m => m.type === "inbound").map(m => m.content).join(" | ");
      expect(text.indexOf("older too")).toBeGreaterThan(text.indexOf("older"));
      expect(text.indexOf("newer")).toBeGreaterThan(text.indexOf("older too"));
    });

    test("messages written during /cleanup are all delivered in order, however many", async () => {
      const { a, spawned } = await liveSession(SKILLS);
      const { runner } = mod(SID);
      const COUNT = 60;
      command("/cleanup");
      for (let i = 1; i <= COUNT; i++) command(`m${i}`);
      await waitFor(() => log.lines.filter(l => l.includes("held until /cleanup ends")).length >= COUNT);
      await pollUntil(runner, () => terminated(a));
      await windowEnds(a);
      await waitFor(() => spawned.length);
      const w = await plugin(SID);
      let got = "";
      while (!got.includes(`m${COUNT}`)) got += `${got ? "\n\n" : ""}${(await w.next("inbound")).content}`;
      expect(got).toBe(Array.from({ length: COUNT }, (_, i) => `m${i + 1}`).join("\n\n"));
    });
  });
});

describe("cleanupSummary", () => {
  const BACKUP = "x.cleanup-1.jsonl";

  test("removed skills are listed without sizes", () => {
    const r = { kind: "cleaned" as const, skills: [{ name: "a", chars: 4000 }, { name: "b", chars: 72_000 }], records: 2, backup: BACKUP };
    expect(cleanupSummary(r)).toBe("🧹 Уборка выполнена, убраны скиллы: a, b.");
  });

  test("nothing to remove and empty skills both report completion", () => {
    expect(cleanupSummary({ kind: "nothing" })).toBe("🧹 Уборка выполнена.");
    expect(cleanupSummary({ kind: "cleaned", skills: [], records: 1, backup: BACKUP })).toBe("🧹 Уборка выполнена.");
  });

  test("an unknown format names the Claude Code version when it is known", () => {
    expect(cleanupSummary({ kind: "format", version: "1.0.0" })).toBe("⚠️ Уборка не выполнена: формат транскрипта изменился (Claude Code)");
    expect(cleanupSummary({ kind: "format" })).toBe("⚠️ Уборка не выполнена: формат транскрипта изменился");
  });
});

describe("topic commands", () => {
  const SID = "11111111-2222-3333-4444-555555555555";
  const msg = (text: string, extra?: Record<string, unknown>) => topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text, ...(extra ? { extra } : {}) });
  const texts = () => fake.texts().map(t => t.text);
  // What the topic has shown: messages sent and their edits.
  const shown = () => [...fake.callsOf("sendMessage"), ...fake.callsOf("editMessageText")].map(c => String(c.text));
  const buttonsOf = (call: object) =>
    arr(field(field(call, "reply_markup"), "inline_keyboard"))
      .flatMap(row => arr(row))
      .map(b => String(field(b, "callback_data")));

  // A session with a topic and no window, as the hub finds it on disk.
  const closedSession = () => new SessionStore(join(dir, "sessions.json")).set(SID, { topicId: 100, title: "T", project: "p", enabled: true, cwd: CWD, account: "2" });

  test("/cmd runs in the session folder, shows a card and wakes the agent", async () => {
    await startHub();
    const a = await enabled(SID);
    fake.pushUpdate(msg("/cmd echo привет && cd && exit /b 3"));
    const inbound = await a.next("inbound", m => m.meta.source === "exec", RUN_MS);
    expect(inbound.meta.exit_code).toBe("3");
    expect(inbound.content).toContain("❌ код 3");
    expect(inbound.content).toContain("привет");
    expect(inbound.content).toContain(CWD);
    expect(inbound.content).toContain(join(dir, "exec", `${inbound.meta.exec_id}.log`));
    await waitFor(() => shown().find(t => t.startsWith("❌ код 3") && t.includes("привет")), WAIT_MS, "final card");
  }, RUN_MS + WAIT_MS);

  test("a stop button ends a running command", async () => {
    await startHub();
    await enabled(SID);
    fake.pushUpdate(msg("/cmd ping -n 30 127.0.0.1"));
    const card = await waitFor(() => fake.callsOf("sendMessage").find(c => buttonsOf(c).some(d => d.startsWith("x:"))), WAIT_MS, "card with a stop button");
    const data = must(buttonsOf(card).find(d => d.endsWith(":stop")), "stop button");
    fake.pushUpdate(buttonPress({ chatId: GROUP, fromId: ME, messageId: fake.lastMessageId, data }));
    await waitFor(() => fake.callsOf("answerCallbackQuery").find(c => c.text === "Останавливаю"), WAIT_MS, "answer");
    const end = await waitFor(() => fake.callsOf("editMessageText").find(c => String(c.text).startsWith("⏹ остановлена")), WAIT_MS, "stopped card");
    expect(field(end, "reply_markup")).toBeUndefined();
    fake.pushUpdate(buttonPress({ chatId: GROUP, fromId: ME, messageId: fake.lastMessageId, data }));
    await waitFor(() => fake.callsOf("answerCallbackQuery").find(c => c.text === "Команда уже закончилась"), WAIT_MS, "second answer");
  }, RUN_MS);

  test("an old /pwsh waits for the run button", async () => {
    let spawned = 0;
    await startHub({
      spawnRunner: () => {
        spawned++;
        return 1;
      },
    });
    await enabled(SID);
    fake.pushUpdate(msg("/pwsh npm run migrate", { date: Math.floor(Date.now() / MS_PER_S) - OLD_COMMAND_S }));
    const card = await waitFor(() => fake.callsOf("sendMessage").find(c => String(c.text).startsWith("⏸ Команда пришла 5 мин назад, пока хаб был выключен")), WAIT_MS, "pending card");
    expect(buttonsOf(card).some(d => d.endsWith(":run"))).toBe(true);
    expect(spawned).toBe(0);
  });

  test("the run button starts an old command", async () => {
    const specs: string[] = [];
    await startHub({
      spawnRunner: file => {
        specs.push(file);
        return process.pid;
      },
    });
    await enabled(SID);
    fake.pushUpdate(msg("/pwsh npm run migrate", { date: Math.floor(Date.now() / MS_PER_S) - OLD_COMMAND_S }));
    const card = await waitFor(() => fake.callsOf("sendMessage").find(c => buttonsOf(c).some(d => d.endsWith(":run"))), WAIT_MS, "pending card");
    const data = must(buttonsOf(card).find(d => d.endsWith(":run")), "run button");
    fake.pushUpdate(buttonPress({ chatId: GROUP, fromId: ME, messageId: fake.lastMessageId, data }));
    await waitFor(() => fake.callsOf("answerCallbackQuery").find(c => c.text === "Запускаю"), WAIT_MS, "answer");
    expect(specs).toHaveLength(1);
    const running = await waitFor(() => fake.callsOf("editMessageText").find(c => String(c.text).startsWith("▶ PowerShell")), WAIT_MS, "running card");
    expect(buttonsOf(running).some(d => d.endsWith(":stop"))).toBe(true);
  }, 3 * WAIT_MS);

  test("multi-line /cmd is refused", async () => {
    await startHub();
    await enabled(SID);
    fake.pushUpdate(msg("/cmd echo a\necho b"));
    await waitFor(() => texts().includes("/cmd выполняет одну строку. Для нескольких — /pwsh или /bash"), WAIT_MS, "refusal");
  });

  test("empty /pwsh asks for a command", async () => {
    await startHub();
    await enabled(SID);
    fake.pushUpdate(msg("/pwsh"));
    await waitFor(() => texts().includes("Напиши команду: /pwsh npm run migrate"), WAIT_MS, "hint");
  });

  test("/bash without Git Bash says where it looked", async () => {
    config = { ...config, exec: { bash: join(dir, "no-bash.exe") } };
    await startHub();
    await enabled(SID);
    fake.pushUpdate(msg("/bash ls"));
    await waitFor(() => texts().includes(`Git Bash не найден: ${join(dir, "no-bash.exe")}. Укажи exec.bash в config.json`), WAIT_MS, "notice");
  });

  // A run that ended while no hub watched: running on disk, its exit file there.
  const endedWhileOff = () => {
    const id = "abcd1234";
    const execDir = join(dir, "exec");
    mkdirSync(execDir, { recursive: true });
    writeFileSync(join(execDir, `${id}.log`), "hi\n");
    writeFileSync(join(execDir, `${id}.exit.json`), JSON.stringify({ code: 0, endedAt: Date.now() }));
    saveExecs(join(dir, "execs.json"), [{ id, sessionId: SID, messageId: 1, shell: "cmd", text: "echo hi", cwd: CWD, state: "running", startedAt: Date.now(), pid: 1, reported: false }]);
  };

  test("a result that came while the hub was off goes once to the window that reconnects", async () => {
    closedSession();
    endedWhileOff();
    const spawned: string[][] = [];
    config = { ...config, launch: { command: ["wt.exe", "{session}"], timeoutSec: LAUNCH_TIMEOUT_S } };
    await startHub({ spawn: c => void spawned.push(c) });
    const w = await plugin(SID);
    const inbound = await w.next("inbound", m => m.meta.source === "exec", WAIT_MS);
    expect(inbound.meta.exec_id).toBe("abcd1234");
    await Bun.sleep(EXEC_GRACE_MS * 2);
    expect(w.messages.filter(m => m.type === "inbound").length).toBe(1);
    expect(spawned).toEqual([]);
    expect(texts()).not.toContain("⚠️ Сессия не запущена: результат команды агенту не доставлен");
  });

  test("a run that ends during the start's grace waits for the reconnecting window", async () => {
    closedSession();
    const id = "abcd1234";
    const execDir = join(dir, "exec");
    mkdirSync(execDir, { recursive: true });
    writeFileSync(join(execDir, `${id}.log`), "hi\n");
    // A live runner: our own pid, a fresh heartbeat.
    writeFileSync(join(execDir, `${id}.alive`), "");
    saveExecs(join(dir, "execs.json"), [{ id, sessionId: SID, messageId: 1, shell: "cmd", text: "echo hi", cwd: CWD, state: "running", startedAt: Date.now(), pid: process.pid, reported: false }]);
    const spawned: string[][] = [];
    config = { ...config, launch: { command: ["wt.exe", "{session}"], timeoutSec: LAUNCH_TIMEOUT_S } };
    await startHub({ spawn: c => void spawned.push(c), execGraceMs: LONG_GRACE_MS });
    await Bun.sleep(SETTLE_MS);
    expect(shown().some(t => t.startsWith("▶ cmd"))).toBe(true);
    writeFileSync(join(execDir, `${id}.exit.json`), JSON.stringify({ code: 0, endedAt: Date.now() }));
    await waitFor(() => shown().some(t => t.startsWith("✅ код 0")), WAIT_MS, "final card");
    const w = await plugin(SID);
    const inbound = await w.next("inbound", m => m.meta.source === "exec", WAIT_MS);
    expect(inbound.meta.exec_id).toBe(id);
    await Bun.sleep(LONG_GRACE_MS);
    expect(w.messages.filter(m => m.type === "inbound").length).toBe(1);
    expect(spawned).toEqual([]);
  }, LONG_GRACE_MS + 3 * WAIT_MS);

  test("a result that came while the hub was off starts the session once no window came", async () => {
    closedSession();
    endedWhileOff();
    const spawned: string[][] = [];
    config = { ...config, launch: { command: ["wt.exe", "{session}"], timeoutSec: LAUNCH_TIMEOUT_S } };
    await startHub({ spawn: c => void spawned.push(c) });
    await Bun.sleep(EXEC_GRACE_MS / 2);
    expect(spawned).toEqual([]);
    await waitFor(() => spawned.length === 1, WAIT_MS, "session start");
  });

  test("a result that came while the hub was off says it was not delivered once no window came", async () => {
    closedSession();
    endedWhileOff();
    await startHub();
    await Bun.sleep(EXEC_GRACE_MS / 2);
    expect(texts()).not.toContain("⚠️ Сессия не запущена: результат команды агенту не доставлен");
    await waitFor(() => texts().includes("⚠️ Сессия не запущена: результат команды агенту не доставлен"), WAIT_MS, "notice");
  });

  test("a result for a session without a window and without launch says it was not delivered", async () => {
    closedSession();
    await startHub();
    fake.pushUpdate(msg("/cmd echo hi"));
    await waitFor(() => texts().includes("⚠️ Сессия не запущена: результат команды агенту не доставлен"), RUN_MS, "notice");
    // The final card is an edit, cardEditMs after the end.
    await waitFor(() => shown().some(t => t.startsWith("✅ код 0")), WAIT_MS, "final card");
  }, RUN_MS + WAIT_MS);

  test("a result for a closed session with launch starts it and reaches the agent once", async () => {
    closedSession();
    const spawned: string[][] = [];
    config = { ...config, launch: { command: ["wt.exe", "{session}"], timeoutSec: LAUNCH_TIMEOUT_S } };
    await startHub({ spawn: c => void spawned.push(c) });
    fake.pushUpdate(msg("/cmd echo hi"));
    await waitFor(() => spawned.length === 1, RUN_MS, "session start");
    const w = await plugin(SID);
    const inbound = await w.next("inbound", m => m.meta.source === "exec", WAIT_MS);
    expect(inbound.meta.exit_code).toBe("0");
    await Bun.sleep(SETTLE_MS);
    expect(w.messages.filter(m => m.type === "inbound").length).toBe(1);
    expect(texts()).not.toContain("⚠️ Сессия не запущена: результат команды агенту не доставлен");
  }, RUN_MS + 2 * WAIT_MS);

  test("the hub does not exit idle while a command runs", async () => {
    closedSession();
    fake.pushUpdate(msg("/cmd ping -n 3 127.0.0.1"));
    await startHub({ idleMs: IDLE_MS });
    await waitFor(() => shown().some(t => t.startsWith("▶ cmd")), WAIT_MS, "running card");
    await Bun.sleep(IDLE_MS * 2);
    expect(exited).toBe(false);
    await waitFor(() => shown().some(t => t.startsWith("✅ код 0")), RUN_MS, "final card");
    await waitFor(() => exited, WAIT_MS, "idle exit once the command ended");
  }, RUN_MS + WAIT_MS);

  test("a log over the Telegram limit goes as its last 50 MB", async () => {
    await startHub({ execFileLimit: FILE_LIMIT });
    await enabled(SID);
    fake.pushUpdate(msg("/cmd for /l %i in (1,1,40) do @echo line %i"));
    const doc = await waitFor(() => fake.callsOf("sendDocument")[0], RUN_MS, "log file");
    const file = field(doc, "document");
    expect(String(field(file, "file"))).toEndWith(".log");
    const body = String(field(file, "body"));
    expect(body).toStartWith("[лог обрезан");
    expect(body).toContain("line 40");
    expect(Number(field(file, "size"))).toBeLessThanOrEqual(FILE_LIMIT);
  }, RUN_MS + WAIT_MS);
});

describe("questions", () => {
  const Q1 = {
    question: "Какой цвет?",
    header: "Цвет",
    options: [
      { label: "Красный", description: "тёплый" },
      { label: "Синий", description: "" },
    ],
    multiSelect: false,
  };
  const Q1_TEXT = "Цвет\nКакой цвет?\n\n1. Красный — тёплый\n2. Синий";
  const Q2 = {
    question: "Что добавить?",
    header: "Добавки",
    options: [
      { label: "Сыр", description: "" },
      { label: "Лук", description: "" },
      { label: "Перец", description: "" },
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
    await Bun.sleep(SHOWN_MS);
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
    expect(keys(msg)).toEqual([["1. Красный"], ["2. Синий"], ["✏️ Свой вариант", "✖️ Отменить"]]);
    press(dataOf(msg, 1), id);
    expect(await answer).toEqual({ decision: "allow", answers: { "Какой цвет?": "Синий" } });
    const edit = await waitFor(() => edits()[0]);
    expect(edit).toMatchObject({ message_id: id, text: `${Q1_TEXT}\n\n✅ Синий` });
    expect(edit.reply_markup).toBeUndefined();
    await waitFor(() => fake.callsOf("answerCallbackQuery").length === 1);
  });

  test("the window relays the text written before the call first, and the poll goes after it", async () => {
    await startHub({ catchUpMs: LONG_CATCH_UP_MS });
    const a = await enabled("a");
    const started = Date.now();
    const answer = ask([Q1]);
    const m = await a.next("catchUp");
    await Bun.sleep(SHOWN_MS);
    expect(fake.callsOf("sendMessage")).toEqual([]);
    a.send({ type: "send", id: "s1", sessionId: "a", text: "Спрошу про цвет", notify: false });
    a.send({ type: "caughtUp", id: m.id });
    const msg = await polled(2);
    expect(Date.now() - started).toBeLessThan(LONG_CATCH_UP_MS);
    expect(fake.texts().map(t => t.text)).toEqual(["Спрошу про цвет", Q1_TEXT]);
    press(dataOf(msg, 0), fake.lastMessageId);
    expect(await answer).toEqual({ decision: "allow", answers: { "Какой цвет?": "Красный" } });
  });

  test("a window that does not answer the catch-up still gets the poll after a short wait", async () => {
    await startHub({ catchUpMs: SHORT_CATCH_UP_MS });
    const a = await enabled("a");
    const started = Date.now();
    const answer = ask([Q1]);
    await a.next("catchUp");
    expect((await polled()).text).toBe(Q1_TEXT);
    expect(Date.now() - started).toBeGreaterThanOrEqual(SHORT_CATCH_UP_MS);
    press(dataOf(await polled(), 1), fake.lastMessageId);
    expect(await answer).toEqual({ decision: "allow", answers: { "Какой цвет?": "Синий" } });
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
    await Bun.sleep(SHOWN_MS);
    expect(fake.callsOf("sendMessage")).toEqual([]);
  });

  test("a question too long for one message is cut, and so is the message with its answer", async () => {
    await startHub();
    await enabled("a");
    const question = "Очень длинный вопрос ".repeat(300);
    const options = [
      { label: "Да", description: "д".repeat(1500), preview: "п".repeat(5000) },
      { label: "Нет", description: "н".repeat(1500) },
    ];
    const answer = ask([{ question, header: "Длинный", options, multiSelect: false }]);
    const msg = await shown();
    const id = fake.lastMessageId;
    expect(fake.callsOf("sendMessage")).toHaveLength(1);
    expect(String(msg.text).length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
    expect(String(msg.text).startsWith("Длинный\nОчень длинный вопрос")).toBe(true);
    expect(keys(msg)[0]).toEqual(["1. Да"]);
    press(dataOf(msg, 0), id);
    expect(await answer).toEqual({ decision: "allow", answers: { [question]: "Да" } });
    const edit = await waitFor(() => edits()[0]);
    expect(String(edit.text).length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
    expect(String(edit.text).endsWith("\n\n✅ Да")).toBe(true);
  });

  test("a multiple choice toggles options and is answered by «Готово» with the labels joined", async () => {
    await startHub();
    await enabled("a");
    const answer = ask([Q2]);
    const msg = await polled();
    const id = fake.lastMessageId;
    expect(keys(msg)).toEqual([["1. Сыр"], ["2. Лук"], ["3. Перец"], ["✅ Готово"], ["✏️ Свой вариант", "✖️ Отменить"]]);
    press(dataOf(msg, 3), id);
    await waitFor(() => fake.callsOf("answerCallbackQuery").some(c => c.text === PICK_ONE));
    expect(edits()).toEqual([]);
    press(dataOf(msg, 0), id);
    press(dataOf(msg, 2), id);
    const toggled = await waitFor(() => edits()[1]);
    expect(toggled.text).toBe("Добавки\nЧто добавить?\n\n1. Сыр\n2. Лук\n3. Перец");
    expect(keys(toggled).slice(0, 3)).toEqual([["☑️ 1. Сыр"], ["2. Лук"], ["☑️ 3. Перец"]]);
    press(dataOf(msg, 3), id);
    expect(await answer).toEqual({ decision: "allow", answers: { "Что добавить?": "Сыр, Перец" } });
    const last = await waitFor(() => edits()[2]);
    expect(String(last.text).endsWith("\n\n✅ Сыр, Перец")).toBe(true);
    expect(last.reply_markup).toBeUndefined();
  });

  test("«Свой вариант» asks for a message, and the next message is the answer, not an inbound", async () => {
    await startHub();
    const a = await enabled("a");
    const answer = ask([Q1]);
    const msg = await polled();
    press(dataOf(msg, 2), fake.lastMessageId);
    const hint = await shown(2);
    expect(hint.text).toBe(CUSTOM_HINT);
    expect(hint.disable_notification).toBe(true);
    say("Зелёный");
    expect(await answer).toEqual({ decision: "allow", answers: { "Какой цвет?": "Зелёный" } });
    await waitFor(() => edits().some(e => e.text === `${Q1_TEXT}\n\n✅ Зелёный`));
    await Bun.sleep(SETTLE_MS);
    expect(a.messages.filter(m => m.type === "inbound")).toEqual([]);
  });

  test("a message sent without the button answers too", async () => {
    await startHub();
    await enabled("a");
    const answer = ask([Q1]);
    await shown();
    say("любой");
    expect(await answer).toEqual({ decision: "allow", answers: { "Какой цвет?": "любой" } });
  });

  test("a photo answers with its caption and file mark", async () => {
    await startHub();
    await enabled("a");
    const answer = ask([Q1]);
    await shown();
    fake.files.set("P2", { path: "photos/p.jpg", body: new Uint8Array([9]) });
    say(undefined, { caption: "look", photo: [{ file_id: "P1", file_unique_id: "u1" }, { file_id: "P2", file_unique_id: "u2" }] });
    const res = await answer;
    const given = String(field(field(res, "answers"), "Какой цвет?"));
    expect(field(res, "decision")).toBe("allow");
    expect(given.startsWith(`look (photo: ${join(dir, "inbox")}`)).toBe(true);
  });

  test("a message older than the question reaches the agent, and the poll stays open", async () => {
    await startHub();
    const a = await enabled("a");
    const answer = ask([Q1]);
    const msg = await shown();
    const id = fake.lastMessageId;
    say("раньше", { message_id: id - 1 });
    expect(await a.next("inbound")).toMatchObject({ content: "раньше" });
    press(dataOf(msg, 0), id);
    expect(await answer).toEqual({ decision: "allow", answers: { "Какой цвет?": "Красный" } });
  });

  test("a message sent while the question is not shown yet reaches the agent", async () => {
    await startHub();
    const a = await enabled("a");
    fake.delayNext("sendMessage", SLOW_SEND_MS);
    const answer = ask([Q1]);
    const msg = await polled();
    say("пока нет");
    expect(await a.next("inbound")).toMatchObject({ content: "пока нет" });
    press(dataOf(msg, 0), fake.lastMessageId);
    expect(await answer).toEqual({ decision: "allow", answers: { "Какой цвет?": "Красный" } });
  });

  test("messages sent together answer once, joined by blank lines", async () => {
    await startHub();
    const a = await enabled("a");
    const answer = ask([Q1]);
    await shown();
    say("раз");
    say("два");
    expect(await answer).toEqual({ decision: "allow", answers: { "Какой цвет?": "раз\n\nдва" } });
    await Bun.sleep(SETTLE_MS);
    expect(a.messages.filter(m => m.type === "inbound")).toEqual([]);
  });

  test("an album answers once, with a file mark for each file", async () => {
    await startHub();
    await enabled("a");
    const answer = ask([Q1]);
    await shown();
    say(undefined, { caption: "смотри", media_group_id: "G1", document: { file_id: "D1", file_unique_id: "d1", file_name: "a.txt" } });
    say(undefined, { media_group_id: "G1", document: { file_id: "D2", file_unique_id: "d2", file_name: "b.txt" } });
    const given = "смотри (document: a.txt, file_id: D1)\n\n(document: b.txt, file_id: D2)";
    expect(await answer).toEqual({ decision: "allow", answers: { "Какой цвет?": given } });
  });

  test("a message that answers gets ✍ while the poll waits, and loses it once the agent has the answers", async () => {
    await startHub();
    await enabled("a");
    const answer = ask([Q1, Q2]);
    await shown();
    const id = fake.nextMessageId;
    say("мой");
    const second = await polled(2);
    await waitFor(() => fake.callsOf("setMessageReaction").length === 1);
    expect(fake.callsOf("setMessageReaction")[0]).toEqual({ chat_id: GROUP, message_id: id, reaction: [{ type: "emoji", emoji: "✍" }] });
    press(dataOf(second, 1), fake.lastMessageId);
    press(dataOf(second, 3), fake.lastMessageId);
    expect(await answer).toEqual({ decision: "allow", answers: { "Какой цвет?": "мой", "Что добавить?": "Лук" } });
    await waitFor(() => fake.callsOf("setMessageReaction").length === 2);
    expect(fake.callsOf("setMessageReaction")[1]).toEqual({ chat_id: GROUP, message_id: id, reaction: [] });
  });

  test("a topic command works as usual and leaves the poll open", async () => {
    await startHub();
    await enabled("a");
    const answer = ask([Q1]);
    const msg = await polled();
    const id = fake.lastMessageId;
    say("/info");
    await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/commands?session=a`)).text()).includes("info"));
    press(dataOf(msg, 0), id);
    expect(await answer).toEqual({ decision: "allow", answers: { "Какой цвет?": "Красный" } });
  });

  test('a "!" message cancels the poll and reaches the agent as an ordinary message', async () => {
    await startHub();
    const a = await enabled("a");
    const answer = ask([Q1]);
    await polled();
    say("!стоп");
    expect(await answer).toEqual({ decision: "deny", reason: CANCEL_REASON });
    const inbound = await a.next("inbound");
    expect(inbound).toMatchObject({ content: "стоп" });
    expect(field(inbound, "interrupt")).toBeUndefined();
    await waitFor(() => edits().some(e => String(e.text).endsWith(`\n\n${CANCELLED}`)));
  });

  test('a lone "!" cancels the poll and delivers nothing', async () => {
    await startHub();
    const a = await enabled("a");
    const answer = ask([Q1]);
    await polled();
    say("!");
    expect(await answer).toEqual({ decision: "deny", reason: CANCEL_REASON });
    await Bun.sleep(SETTLE_MS);
    expect(a.messages.filter(m => m.type === "inbound")).toEqual([]);
  });

  test("«Отменить» denies the question", async () => {
    await startHub();
    await enabled("a");
    const answer = ask([Q1]);
    const msg = await polled();
    press(dataOf(msg, 2, 1), fake.lastMessageId);
    expect(await answer).toEqual({ decision: "deny", reason: CANCEL_REASON });
    const edit = await waitFor(() => edits()[0]);
    expect(edit.text).toBe(`${Q1_TEXT}\n\n${CANCELLED}`);
  });

  test("several questions come one at a time and are answered together", async () => {
    await startHub();
    await enabled("a");
    const answer = ask([Q1, Q2]);
    const first = await polled();
    const firstId = fake.lastMessageId;
    expect(String(first.text).startsWith("Вопрос 1 из 2: Цвет\nКакой цвет?")).toBe(true);
    press(dataOf(first, 0), firstId);
    const second = await polled(2);
    expect(String(second.text).startsWith("Вопрос 2 из 2: Добавки\n")).toBe(true);
    press(dataOf(first, 1), firstId);
    await waitFor(() => fake.callsOf("answerCallbackQuery").some(c => c.text === STALE_POLL));
    press(dataOf(second, 1), fake.lastMessageId);
    press(dataOf(second, 3), fake.lastMessageId);
    expect(await answer).toEqual({ decision: "allow", answers: { "Какой цвет?": "Красный", "Что добавить?": "Лук" } });
  });

  test("a button of a poll the hub does not know answers «Опрос устарел» and loses its buttons", async () => {
    await startHub();
    await enabled("a");
    press("q:deadbeef:0:1", 77);
    await waitFor(() => fake.callsOf("editMessageReplyMarkup")[0]);
    expect(fake.callsOf("editMessageReplyMarkup")[0]).toMatchObject({ chat_id: GROUP, message_id: 77 });
    expect(fake.callsOf("answerCallbackQuery")[0]).toMatchObject({ text: STALE_POLL });
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
    await waitFor(() => edits().some(e => e.text === `${Q1_TEXT}\n\n${TO_TERMINAL}`));
  });

  test("a new poll of the session closes the old one", async () => {
    await startHub();
    await enabled("a");
    const old = ask([Q1]);
    await polled();
    const fresh = ask([Q2]);
    expect(await old).toEqual({ decision: "none" });
    await waitFor(() => edits().some(e => e.text === `${Q1_TEXT}\n\n${TO_TERMINAL}`));
    const msg = await polled(2);
    press(dataOf(msg, 0), fake.lastMessageId);
    press(dataOf(msg, 3), fake.lastMessageId);
    expect(await fresh).toEqual({ decision: "allow", answers: { "Что добавить?": "Сыр" } });
  });

  test("a stopping hub moves the poll to the terminal", async () => {
    await startHub();
    await enabled("a");
    const answer = ask([Q1]);
    await polled();
    await hub.stop();
    expect(await answer).toEqual({ decision: "none" });
    expect(edits().some(e => e.text === `${Q1_TEXT}\n\n${TO_TERMINAL}`)).toBe(true);
  });

  test("a hub that stops while the poll is still being sent has moved it to the terminal when stop returns", async () => {
    await startHub();
    await enabled("a");
    const release = fake.holdNext("sendMessage");
    const answer = ask([Q1]);
    await polled();
    const stopping = hub.stop();
    // Let stop() run up to the question send it has to wait for.
    await Bun.sleep(SHOWN_MS);
    release();
    await stopping;
    expect(edits().some(e => e.text === `${Q1_TEXT}\n\n${TO_TERMINAL}`)).toBe(true);
    expect(await answer).toEqual({ decision: "none" });
  });

  test("a window that goes away moves its poll to the terminal", async () => {
    await startHub();
    const a = await enabled("a");
    const answer = ask([Q1]);
    await polled();
    a.close();
    expect(await answer).toEqual({ decision: "none" });
    await waitFor(() => edits().some(e => e.text === `${Q1_TEXT}\n\n${TO_TERMINAL}`));
  });

  test("turning the mode off moves the poll to the terminal", async () => {
    await startHub();
    const a = await enabled("a");
    const answer = ask([Q1]);
    await polled();
    await req(a, { op: "disable" });
    expect(await answer).toEqual({ decision: "none" });
    await waitFor(() => edits().some(e => e.text === `${Q1_TEXT}\n\n${TO_TERMINAL}`));
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
