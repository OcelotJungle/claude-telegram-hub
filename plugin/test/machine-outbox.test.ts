import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync } from "fs";
import { join } from "path";
import { confirmationPromptId, MachineOutbox } from "../src/hub/machine-outbox.ts";
import { TelegramError } from "../src/hub/telegram.ts";
import { offlineApi, tempDir } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("General omits the thread, retries and resumes durable messages after restart", async () => {
  const dir = tempDir();
  dirs.push(dir);
  const file = join(dir, "machine.json");
  const api = offlineApi();
  let fail = true;
  const sent: { thread?: number; silent: boolean; text: string }[] = [];
  api.sendMessage = async (_chat, thread, text, silent) => {
    if (fail) throw new TelegramError(429, "try again");
    sent.push({ thread, text, silent });
    return { message_id: sent.length };
  };
  const queue = new MachineOutbox(file, () => {});
  queue.post("event", { chatId: "-1001" }, "hello", true);
  await queue.flush(api);
  expect(queue.size).toBe(1);
  fail = false;
  const resumed = new MachineOutbox(file, () => {});
  await resumed.flush(api);
  expect(sent).toEqual([{ thread: undefined, text: "hello", silent: true }]);
  expect(resumed.size).toBe(0);
  resumed.post("event", { chatId: "-1001" }, "hello", true);
  expect(resumed.size).toBe(0);
});

test("updating an in-flight card keeps the latest output and its original topic", async () => {
  const dir = tempDir();
  dirs.push(dir);
  const queue = new MachineOutbox(join(dir, "machine.json"), () => {});
  const api = offlineApi();
  let release = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  const edited: string[] = [];
  api.sendMessage = async (_chat, topic) => { expect(topic).toBe(12); await pending; return { message_id: 99 }; };
  api.editMessageText = async (_chat, id, text) => { expect(id).toBe(99); edited.push(text); };
  queue.post("card", { chatId: "-1001", topicId: 12 }, "waiting", true, undefined, true);
  const sending = queue.flush(api);
  queue.post("card", { chatId: "-1001", topicId: 12 }, "done", true, undefined, true);
  release();
  await sending;
  expect(edited).toEqual(["done"]);
  queue.post("card", { chatId: "-1001", topicId: 12 }, "done", true, undefined, true);
  expect(queue.size).toBe(0);
});

test("an acknowledged edit replayed after a crash cannot block delivery forever", async () => {
  const dir = tempDir();
  dirs.push(dir);
  const queue = new MachineOutbox(join(dir, "machine.json"), () => {});
  const api = offlineApi();
  api.sendMessage = async () => ({ message_id: 1 });
  queue.post("card", { chatId: "-1001" }, "old", true, undefined, true);
  await queue.flush(api);
  queue.post("card", { chatId: "-1001" }, "accepted before crash", true, undefined, true);
  api.editMessageText = async () => { throw new TelegramError(400, "message is not modified"); };
  await queue.flush(api);
  expect(queue.size).toBe(0);
});

const GROUP = "-1001";
const PIECE_CHARS = 4000;
const LONG_PIECES = 3;
const REMEMBERED = 5;

function outbox(warnings: string[] = []) {
  const dir = tempDir();
  dirs.push(dir);
  const file = join(dir, "machine.json");
  const api = offlineApi();
  return { dir, file, api, queue: new MachineOutbox(file, text => { warnings.push(text); }) };
}

test("a card that can no longer be edited is sent again, and the queue goes on", async () => {
  const warnings: string[] = [];
  const { queue, api } = outbox(warnings);
  const sent: string[] = [];
  let id = 0;
  api.sendMessage = async (_chat, _topic, text) => { sent.push(text); return { message_id: ++id }; };
  queue.post("card", { chatId: GROUP }, "first", true, undefined, true);
  await queue.flush(api);
  api.editMessageText = async () => { throw new TelegramError(400, "Bad Request: message to edit not found"); };
  queue.post("card", { chatId: GROUP }, "second", true, undefined, true);
  queue.post("after", { chatId: GROUP }, "behind it");
  await queue.flush(api);
  expect(sent).toEqual(["first", "second", "behind it"]);
  expect(queue.size).toBe(0);
  // The new message is the one the card is edited from now on.
  const edits: number[] = [];
  api.editMessageText = async (_chat, message) => { edits.push(message); };
  queue.post("card", { chatId: GROUP }, "third", true, undefined, true);
  await queue.flush(api);
  expect(edits).toEqual([2]);
});

test("a reply Telegram refuses for good is dropped with a log line and does not hold the queue", async () => {
  const warnings: string[] = [];
  const { queue, api } = outbox(warnings);
  const sent: string[] = [];
  api.sendMessage = async (_chat, _topic, text) => {
    if (text === "to a deleted topic") throw new TelegramError(400, "Bad Request: message thread not found");
    sent.push(text);
    return { message_id: sent.length };
  };
  queue.post("lost", { chatId: GROUP, topicId: 5 }, "to a deleted topic");
  queue.post("next", { chatId: GROUP }, "next");
  await queue.flush(api);
  expect(sent).toEqual(["next"]);
  expect(queue.size).toBe(0);
  expect(warnings.join("\n")).toContain("thread not found");
  // The same reply is not queued again.
  queue.post("lost", { chatId: GROUP, topicId: 5 }, "to a deleted topic");
  expect(queue.size).toBe(0);
});

test("a log file that is gone is dropped with a log line and does not hold the queue", async () => {
  const warnings: string[] = [];
  const { queue, api, dir } = outbox(warnings);
  const sent: string[] = [];
  api.sendMessage = async (_chat, _topic, text) => { sent.push(text); return { message_id: sent.length }; };
  queue.post("log", { chatId: GROUP }, "", true, undefined, false, join(dir, "missing.log"));
  queue.post("next", { chatId: GROUP }, "next");
  await queue.flush(api);
  expect(sent).toEqual(["next"]);
  expect(queue.size).toBe(0);
  expect(warnings.join("\n")).toContain("missing.log");
});

test("a failure that may pass keeps the item and retries it", async () => {
  const warnings: string[] = [];
  const { queue, api } = outbox(warnings);
  const sent: string[] = [];
  let failure: Error | undefined = new TelegramError(500, "Internal Server Error");
  api.sendMessage = async (_chat, _topic, text) => { if (failure) throw failure; sent.push(text); return { message_id: sent.length }; };
  queue.post("one", { chatId: GROUP }, "one");
  await queue.flush(api);
  expect(queue.size).toBe(1);
  failure = new Error("fetch failed");
  await queue.flush(api);
  expect(queue.size).toBe(1);
  failure = undefined;
  await queue.flush(api);
  expect(sent).toEqual(["one"]);
});

test("pieces already accepted are not sent again when a later piece fails", async () => {
  const { queue, file, api } = outbox();
  const sent: string[] = [];
  let failAt: number | undefined = 1;
  api.sendMessage = async (_chat, _topic, text) => {
    if (failAt === Number(text[0])) throw new TelegramError(429, "try again");
    sent.push(text.slice(0, 1));
    return { message_id: sent.length };
  };
  const paragraphs = Array.from({ length: LONG_PIECES }, (_, index) => `${index}${"x".repeat(PIECE_CHARS - 2)}`);
  queue.post("long", { chatId: GROUP }, paragraphs.join("\n\n"));
  await queue.flush(api);
  expect(sent).toEqual(["0"]);
  failAt = undefined;
  // A new process continues behind the piece that was accepted.
  await new MachineOutbox(file, () => {}).flush(api);
  expect(sent).toEqual(["0", "1", "2"]);
});

test("the messages of a confirmation that waits for a press stay remembered however much is sent after them", async () => {
  const { api, file } = outbox();
  const queue = new MachineOutbox(file, () => {}, REMEMBERED);
  let id = 0;
  api.sendMessage = async () => ({ message_id: ++id });
  const destination = { chatId: GROUP };
  const confirmation = { message: { message_id: 7 }, destination };
  queue.saveConfirmation("key", confirmation);
  queue.post(confirmationPromptId(confirmation), destination, "Выключить Telegram на этой машине?", false);
  await queue.flush(api);
  for (let index = 0; index < REMEMBERED * 2; index++) queue.post(`reply-${index}`, destination, "text");
  await queue.flush(api);
  // The hub posts the prompt again on every tick; it must not reach the chat a second time.
  queue.post(confirmationPromptId(confirmation), destination, "Выключить Telegram на этой машине?", false);
  expect(queue.size).toBe(0);
  expect(id).toBe(REMEMBERED * 2 + 1);
  // Once it is answered, its ids are forgotten like any others.
  queue.deleteConfirmation("key");
  for (let index = 0; index < REMEMBERED; index++) queue.post(`later-${index}`, destination, "text");
  await queue.flush(api);
  expect(queue.delivered(confirmationPromptId(confirmation))).toBe(false);
});

test("what the queue remembers about finished work is bounded", async () => {
  const { api, file } = outbox();
  const queue = new MachineOutbox(file, () => {}, REMEMBERED);
  let id = 0;
  api.sendMessage = async () => ({ message_id: ++id });
  const total = REMEMBERED + 3;
  for (let index = 0; index < total; index++) {
    queue.post(`card-${index}`, { chatId: GROUP }, "text", true, undefined, true);
    queue.post(`reply-${index}`, { chatId: GROUP }, "text");
    queue.markHandled(`handled-${index}`);
  }
  await queue.flush(api);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  for (const list of [saved.delivered, saved.handled, Object.keys(saved.shown), Object.keys(saved.messages)]) expect(list).toHaveLength(REMEMBERED);
  expect(queue.delivered(`reply-${total - 1}`)).toBe(true);
  expect(queue.delivered("reply-0")).toBe(false);
  expect(queue.handled(`handled-${total - 1}`)).toBe(true);
});
