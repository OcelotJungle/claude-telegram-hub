// The settle barrier: it must stay pending while the hub still has work under way, and resolve only after it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "path";
import { Hub } from "../src/hub/hub.ts";
import { TelegramApi } from "../src/hub/telegram.ts";
import { PROTOCOL_VERSION } from "../src/shared/protocol.ts";
import { platformFor } from "../src/shared/platform.ts";
import { FakeTelegram, topicMsg } from "./fake-telegram.ts";
import { hubFetch, memLogger, NO_PACE, settled, tempDir, wsClient } from "./helpers.ts";
import { manualClock, turn } from "./manual-clock.ts";

const GROUP = "-1001";
const ME = "123456789";
const BATCH_QUIET_MS = 5;
const SHORT_SETTLE_TIMEOUT_MS = 100;
const IDLE_MS = 60_000;
// Event-loop turns a barrier that wrongly resolved would need to show it: far more than it takes.
const PENDING_TURNS = 50;

let fake: FakeTelegram;
let hub: Hub;
let dir: string;
const clients: { close(): void }[] = [];

function startHub(timers?: ReturnType<typeof manualClock>): void {
  hub = new Hub({
    platform: platformFor("win32"),
    accountsAvailable: () => true,
    port: 0,
    sessionsFile: join(dir, "sessions.json"),
    outboxFile: join(dir, "outbox.json"),
    cardsFile: join(dir, "cards.json"),
    spoolDir: join(dir, "spool"),
    filesDir: join(dir, "outbox-files"),
    inboxDir: join(dir, "inbox"),
    idleMs: IDLE_MS,
    api: new TelegramApi({ token: fake.token, base: fake.url, baseDelayMs: 1, maxAttempts: 2, attemptTimeoutMs: 300, sendAttemptTimeoutMs: 300, networkRetryMs: 5, deadlineMs: 500, groupPace: NO_PACE }),
    config: () => ({ groupId: GROUP, allowFrom: [ME], turnEndChime: "" }),
    pollTimeoutSec: 1,
    pollRetryBaseMs: 10,
    batchQuietMs: BATCH_QUIET_MS,
    defaultAccount: async () => undefined,
    execRunsFile: join(dir, "exec-runs.json"),
    log: memLogger(),
    onExit: () => {},
    ...(timers ? { timers } : {}),
  });
  if (!hub.start()) throw new Error("hub did not start");
}

async function window(sessionId: string) {
  const c = await wsClient(hub.port, { type: "hello", v: PROTOCOL_VERSION, windowKey: `win-${sessionId}`, sessionId, cwd: dir, configDir: "C:\\p\\sessions\\2-me_gmail.com", reportsSeen: true });
  clients.push(c);
  await c.next("state");
  return c;
}

const settle = (timeoutMs?: number) => settled(hub, { fake, ...(timeoutMs ? { timeoutMs } : {}) });

// True while `barrier` has not resolved after many turns of the event loop.
async function staysPending(barrier: Promise<void>): Promise<boolean> {
  let done = false;
  void barrier.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < PENDING_TURNS; i++) await turn();
  return !done;
}

beforeEach(() => {
  fake = new FakeTelegram();
  dir = tempDir();
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await hub?.stop();
  fake.stop();
});

test("it stays pending while a handler waits on Telegram, and resolves once that ends", async () => {
  startHub();
  const c = await window("s1");
  c.send({ type: "req", id: "r1", op: "enable", title: "Old" });
  await c.next("res", m => m.id === "r1");
  const release = fake.holdNext("editForumTopic");
  c.send({ type: "req", id: "r2", op: "enable", title: "New" });
  const barrier = settle();
  expect(await staysPending(barrier)).toBe(true);
  expect(fake.callsOf("editForumTopic").length).toBe(1);
  release();
  await barrier;
  expect(c.messages.some(m => m.type === "res" && m.id === "r2")).toBe(true);
});

test("it waits for a window message that was sent and the hub has not yet taken", async () => {
  startHub();
  const c = await window("s1");
  c.send({ type: "req", id: "r1", op: "enable", title: "T" });
  await settle();
  expect(fake.callsOf("createForumTopic").length).toBe(1);
  expect(c.messages.some(m => m.type === "res" && m.id === "r1")).toBe(true);
});

test("it waits for an update pushed to Telegram until the hub has handled it", async () => {
  startHub();
  const c = await window("s1");
  c.send({ type: "req", id: "r1", op: "enable", title: "T" });
  await c.next("res", m => m.id === "r1");
  fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "hello" }));
  await settle();
  expect(c.messages.filter(m => m.type === "inbound").map(m => m.content)).toEqual(["hello"]);
});

test("it waits for an HTTP request made through hubFetch", async () => {
  startHub();
  await window("s1");
  const answer = hubFetch(hub, "/health");
  await settle();
  expect((await answer).ok).toBe(true);
});

test("a message batch on a manual clock keeps it pending, and it names the reason", async () => {
  const clock = manualClock();
  startHub(clock);
  const c = await window("s1");
  c.send({ type: "req", id: "r1", op: "enable", title: "T" });
  await c.next("res", m => m.id === "r1");
  fake.pushUpdate(topicMsg({ chatId: GROUP, threadId: 100, fromId: ME, text: "hello" }));
  await expect(settle(SHORT_SETTLE_TIMEOUT_MS)).rejects.toThrow("message batches");
  await clock.advance(BATCH_QUIET_MS);
  await settle();
  expect(c.messages.filter(m => m.type === "inbound").map(m => m.content)).toEqual(["hello"]);
  clock.dispose();
});
