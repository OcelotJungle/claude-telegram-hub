import type { OutFile } from "../src/shared/media.ts";
import type { DownloadHang } from "./fake-telegram.ts";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { DOWNLOAD_TIMEOUT_MS, isThreadNotFound, TelegramApi, TelegramError } from "../src/hub/telegram.ts";
import { field } from "../src/shared/guards.ts";
import { FakeTelegram, topicMsg } from "./fake-telegram.ts";
import { tempDir, waitFor } from "./helpers.ts";
import { manualClock, turn } from "./manual-clock.ts";

const RETRY_AFTER_MS = 1000;
// Loopback I/O settles within a few thousand event-loop turns; the cap only turns a lost wake-up into a failure.
const MAX_SPIN_TURNS = 100_000;

// Waits for a condition by yielding the event loop, with no wall-clock sleep.
async function spin(pred: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < MAX_SPIN_TURNS; i++) {
    if (await pred()) return;
    await turn();
  }
  throw new Error("condition not reached");
}

let fake: FakeTelegram;
let api: TelegramApi;

// An api on a manual clock; `sleeps` lists the waits it has put on that clock so far.
function clockedApi() {
  const clock = manualClock();
  const sleeps: number[] = [];
  const timers = {
    ...clock,
    sleep: (ms: number) => {
      sleeps.push(ms);
      return clock.sleep(ms);
    },
  };
  const clocked = new TelegramApi({ token: fake.token, base: fake.url, baseDelayMs: 1, maxAttempts: 3, timers });
  return { api: clocked, clock, sleeps };
}

beforeEach(() => {
  fake = new FakeTelegram();
  api = new TelegramApi({ token: fake.token, base: fake.url, baseDelayMs: 1, maxAttempts: 3 });
});
afterEach(() => fake.stop());

describe("TelegramApi", () => {
  test("sendMessage targets the topic and maps silent to disable_notification", async () => {
    await api.sendMessage("-100", 7, "hi", true);
    await api.sendMessage("-100", 7, "loud", false);
    expect(fake.callsOf("sendMessage")).toEqual([
      { chat_id: "-100", message_thread_id: 7, text: "hi", disable_notification: true },
      { chat_id: "-100", message_thread_id: 7, text: "loud", disable_notification: false },
    ]);
  });

  test("429 is retried after retry_after", async () => {
    fake.failNext("sendMessage", { code: 429, description: "Too Many Requests: retry after 0", retry_after: 0 });
    const res = await api.sendMessage("-100", 7, "hi", true);
    expect(res.message_id).toBeGreaterThan(0);
    expect(fake.callsOf("sendMessage").length).toBe(2);
  });

  test("after a 429 the other calls to chats wait out retry_after too", async () => {
    fake.failNext("sendMessage", { code: 429, description: "Too Many Requests: retry after 1", retry_after: 1 });
    const { api: flooded, clock, sleeps } = clockedApi();
    const send = flooded.sendMessage("-100", 7, "hi", true);
    await waitFor(() => flooded.floodEndsAt() > clock.now());
    const edit = flooded.editMessageText("-100", 1, "edited");
    // Both the send (its retry) and the edit (the flood) are waiting on the clock.
    await waitFor(() => sleeps.length >= 2);
    expect(fake.callsOf("editMessageText")).toEqual([]);
    await clock.advance(RETRY_AFTER_MS);
    await Promise.all([send, edit]);
    expect(fake.callsOf("editMessageText").length).toBe(1);
  });

  test("a call without retries fails during a flood wait without asking Telegram", async () => {
    fake.failNext("sendMessage", { code: 429, description: "Too Many Requests: retry after 1", retry_after: 1 });
    const { api: flooded, clock, sleeps } = clockedApi();
    const send = flooded.sendMessage("-100", 7, "hi", true);
    await waitFor(() => sleeps.length >= 1);
    const err = await flooded.sendTyping("-100", 7).catch(e => e);
    expect(err instanceof TelegramError && err.code).toBe(429);
    expect(fake.callsOf("sendChatAction")).toEqual([]);
    expect(await flooded.getUpdates(0, 0)).toEqual([]);
    await clock.advance(RETRY_AFTER_MS);
    await send;
  });

  test("posts and edits keep to the group's pace; other calls do not wait", async () => {
    const clock = manualClock();
    const paced = new TelegramApi({ token: fake.token, base: fake.url, groupPace: { count: 2, perMs: 300 }, timers: clock });
    const posts = [paced.sendMessage("-100", 7, "1", true), paced.editMessageText("-100", 1, "2"), paced.sendMessage("-100", 7, "3", true)];
    await paced.sendTyping("-100", 7);
    // The typing call went through and the two posts within the pace; the third post waits for the clock.
    await waitFor(() => fake.callsOf("sendMessage").length + fake.callsOf("editMessageText").length >= 2);
    expect(fake.callsOf("sendMessage").length + fake.callsOf("editMessageText").length).toBe(2);
    await clock.advance(300);
    await Promise.all(posts);
    expect(fake.callsOf("sendMessage").length).toBe(2);
  });

  test("failed attempts of a call do not use up the pace", async () => {
    const paced = new TelegramApi({ token: fake.token, base: fake.url, baseDelayMs: 1, groupPace: { count: 2, perMs: 60_000 } });
    fake.failNext("sendMessage", { code: 502, description: "Bad Gateway" });
    fake.failNext("sendMessage", { code: 502, description: "Bad Gateway" });
    await paced.sendMessage("-100", 7, "a", true);
    await paced.sendMessage("-100", 7, "b", true);
    expect(fake.callsOf("sendMessage").length).toBe(4);
  });

  test("a send waiting for the pace goes before a waiting edit", async () => {
    const clock = manualClock();
    const paced = new TelegramApi({ token: fake.token, base: fake.url, groupPace: { count: 1, perMs: 150 }, timers: clock });
    const posts = Promise.all([paced.sendMessage("-100", 7, "a", true), paced.editMessageText("-100", 1, "e"), paced.sendMessage("-100", 7, "b", true)]);
    for (const reached of [1, 2]) {
      await waitFor(() => fake.calls.length >= reached);
      await clock.advance(150);
    }
    await posts;
    expect(fake.calls.map(c => c.method)).toEqual(["sendMessage", "sendMessage", "editMessageText"]);
  });

  test("5xx is retried", async () => {
    fake.failNext("createForumTopic", { code: 502, description: "Bad Gateway" });
    const t = await api.createForumTopic("-100", "proj · title");
    expect(t.message_thread_id).toBe(100);
  });

  test("other 4xx errors are thrown without retry", async () => {
    fake.failNext("sendMessage", { code: 400, description: "Bad Request: chat not found" });
    const err = await api.sendMessage("-100", 7, "hi", true).catch(e => e);
    expect(err).toBeInstanceOf(TelegramError);
    expect(err.code).toBe(400);
    expect(fake.callsOf("sendMessage").length).toBe(1);
  });

  test("gives up after maxAttempts", async () => {
    for (let i = 0; i < 3; i++) fake.failNext("sendMessage", { code: 500, description: "Internal" });
    const err = await api.sendMessage("-100", 7, "hi", true).catch(e => e);
    expect(err).toBeInstanceOf(TelegramError);
    expect(fake.callsOf("sendMessage").length).toBe(3);
  });

  // The Bot API is reachable only now and then from some networks: a connect
  // attempt hangs, the next one may get through, and then the connection is reused.
  describe("flaky network", () => {
    const ATTEMPT_TIMEOUT_MS = 100;
    const NETWORK_RETRY_MS = 5;
    const BEYOND_ATTEMPT_TIMEOUT_MS = 2 * ATTEMPT_TIMEOUT_MS;
    const LONG_SEND_TIMEOUT_MS = 1000;
    const HUNG_ATTEMPTS = 4;

    // An api on a manual clock: attempt timeouts and retry pauses fire only when the test advances it.
    const flaky = (o: object = {}) => {
      const base = manualClock();
      let sleeps = 0;
      const clock = { ...base, sleep: (ms: number) => { sleeps++; return base.sleep(ms); }, sleepsStarted: () => sleeps };
      const flakyApi = new TelegramApi({ token: fake.token, base: fake.url, baseDelayMs: 1, maxAttempts: 2, attemptTimeoutMs: ATTEMPT_TIMEOUT_MS, sendAttemptTimeoutMs: ATTEMPT_TIMEOUT_MS, networkRetryMs: NETWORK_RETRY_MS, timers: clock, ...o });
      return { api: flakyApi, clock };
    };
    const received = (method: string, count: number) => spin(() => fake.callsOf(method).length >= count);
    // The server got `count` calls and the last one hangs: time it out, wait until the api pauses
    // before its retry, pass that pause once, and wait until the next attempt reaches the server.
    // The clock moves only by these two steps, so the next attempt's own timeout stays armed.
    const abandonAttempt = async (clock: ReturnType<typeof flaky>["clock"], method: string, count: number) => {
      await received(method, count);
      const pausesBefore = clock.sleepsStarted();
      await clock.advance(ATTEMPT_TIMEOUT_MS);
      await spin(() => clock.sleepsStarted() > pausesBefore);
      await clock.advance(NETWORK_RETRY_MS);
      await received(method, count + 1);
    };

    test("a hung attempt is abandoned quickly and retried", async () => {
      fake.hangNext("sendMessage");
      const { api: hung, clock } = flaky();
      const sent = hung.sendMessage("-100", 7, "hi", true);
      await abandonAttempt(clock, "sendMessage", 1);
      await sent;
      expect(fake.callsOf("sendMessage").length).toBe(2);
    });

    // An edit is safe to repeat; a send that took long may already be in the chat.
    test("a slow answer to a send is waited for, so the message is not posted twice", async () => {
      const releaseSend = fake.holdNext("sendMessage");
      const releaseEdit = fake.holdNext("editMessageText");
      const { api: slow, clock } = flaky({ sendAttemptTimeoutMs: LONG_SEND_TIMEOUT_MS });
      const sent = slow.sendMessage("-100", 7, "hi", true);
      await received("sendMessage", 1);
      await clock.advance(BEYOND_ATTEMPT_TIMEOUT_MS);
      releaseSend();
      await sent;
      const edited = slow.editMessageText("-100", 1, "edited");
      await abandonAttempt(clock, "editMessageText", 1);
      releaseEdit();
      await edited;
      expect(fake.callsOf("sendMessage").length).toBe(1);
      expect(fake.callsOf("editMessageText").length).toBe(2);
    });

    test("network failures are retried past maxAttempts until the deadline", async () => {
      fake.hangNext("sendMessage", HUNG_ATTEMPTS);
      const { api: hung, clock } = flaky({ deadlineMs: 5000 });
      const sent = hung.sendMessage("-100", 7, "hi", true);
      for (let attempt = 1; attempt <= HUNG_ATTEMPTS; attempt++) {
        await abandonAttempt(clock, "sendMessage", attempt);
      }
      await sent;
      expect(fake.callsOf("sendMessage").length).toBe(HUNG_ATTEMPTS + 1);
    });

    test("network failures give up at the deadline", async () => {
      const { api: dead, clock } = flaky({ token: "x", base: "http://127.0.0.1:1", deadlineMs: 300 });
      let settled = false;
      const outcome = dead.sendMessage("-100", 1, "x", true).then(() => "resolved", () => "rejected").finally(() => { settled = true; });
      // A refused connection fails at once; only the pauses between attempts are on the clock.
      await spin(async () => {
        await clock.advance(NETWORK_RETRY_MS);
        return settled;
      });
      expect(await outcome).toBe("rejected");
    });

    test("getUpdates may wait for the long poll beyond the attempt timeout", async () => {
      const { api: polling, clock } = flaky();
      const polled = polling.getUpdates(0, 1);
      await received("getUpdates", 1);
      await clock.advance(BEYOND_ATTEMPT_TIMEOUT_MS);
      fake.pushUpdate({ update_id: 0 });
      expect((await polled).length).toBe(1);
    });
  });

  test("deleted topic is recognised", async () => {
    fake.deleteTopic(7);
    const err = await api.sendMessage("-100", 7, "hi", true).catch(e => e);
    expect(isThreadNotFound(err)).toBe(true);
    expect(isThreadNotFound(new Error("x"))).toBe(false);
  });

  test("editForumTopic sends the new name", async () => {
    await api.editForumTopic("-100", 7, "new");
    expect(fake.callsOf("editForumTopic")).toEqual([{ chat_id: "-100", message_thread_id: 7, name: "new" }]);
  });

  test("getUpdates long-polls until an update arrives", async () => {
    const p = api.getUpdates(0, 2);
    await waitFor(() => fake.callsOf("getUpdates").length > 0);
    fake.pushUpdate(topicMsg({ chatId: -100, threadId: 7, fromId: 1, text: "yo" }));
    const updates = await p;
    expect(updates.length).toBe(1);
    expect(updates[0].message?.text).toBe("yo");
  });

  test("downloadFile saves into the destination dir with a safe name", async () => {
    fake.files.set("F1", { path: "photos/file_1.jpg", body: new Uint8Array([1, 2, 3]) });
    const dir = tempDir();
    const path = await api.downloadFile("F1", dir);
    expect(path.startsWith(dir)).toBe(true);
    expect(basename(path)).toMatch(/^\d+-uF1\.jpg$/);
    expect(existsSync(path)).toBe(true);
    expect([...readFileSync(path)]).toEqual([1, 2, 3]);
  });
});

describe("downloadFile on a manual clock", () => {
  const PATH = "photos/file_9.jpg";
  const BODY = new Uint8Array([4, 5, 6]);
  const HANG_POINTS: readonly DownloadHang[] = ["headers", "body"];
  // Restores the fetch spy of the running test, also when the test is cut off by its timeout.
  let restoreFetch = (): void => {};
  afterEach(() => restoreFetch());

  for (const where of HANG_POINTS) {
    test(`a download whose ${where} never finishes fails with a timeout once the download deadline passes`, async () => {
      fake.files.set("F9", { path: PATH, body: BODY });
      fake.hangDownload(PATH, where);
      const { api: clocked, clock } = clockedApi();
      const fetchSpy = spyOn(globalThis, "fetch");
      restoreFetch = () => fetchSpy.mockRestore();
      let settled = false;
      const outcome = clocked
        .downloadFile("F9", tempDir())
        .then(() => undefined, (e: unknown) => e)
        .finally(() => { settled = true; });
      // The server has the request, so the deadline is armed.
      await spin(() => fake.downloads.includes(PATH));
      // With a hung body, the client must have its response headers before the deadline: fetch has resolved then.
      if (where === "body") {
        const last = fetchSpy.mock.results.at(-1);
        if (last?.type !== "return") throw new Error("the download's fetch did not return");
        await last.value;
      }
      await clock.advance(DOWNLOAD_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await clock.advance(1);
      expect(field(await outcome, "name")).toBe("TimeoutError");
      expect(clock.armed()).toBe(0);
    });
  }

  test("a download that finishes before the deadline succeeds and leaves no timer armed", async () => {
    fake.files.set("F8", { path: "photos/file_8.jpg", body: BODY });
    const { api: clocked, clock } = clockedApi();
    const path = await clocked.downloadFile("F8", tempDir());
    expect([...readFileSync(path)]).toEqual([...BODY]);
    expect(clock.armed()).toBe(0);
  });
});

describe("TelegramApi uploads and formatting", () => {
  const file = (name: string, kind: OutFile["kind"], body = `body of ${name}`) => {
    const path = join(tempDir(), name);
    writeFileSync(path, body);
    return { path, name, size: body.length, kind };
  };

  test("sendMessage passes entities only when there are some", async () => {
    await api.sendMessage("-100", 7, "hi", true, [{ type: "bold", offset: 0, length: 2 }]);
    await api.sendMessage("-100", 7, "plain", true, []);
    expect(fake.callsOf("sendMessage")).toEqual([
      { chat_id: "-100", message_thread_id: 7, text: "hi", disable_notification: true, entities: [{ type: "bold", offset: 0, length: 2 }] },
      { chat_id: "-100", message_thread_id: 7, text: "plain", disable_notification: true },
    ]);
  });

  test("one file is uploaded with the method and field of its kind, caption and entities included", async () => {
    const photo = file("shot.png", "photo");
    await api.sendFiles("-100", 7, [photo], "look", [{ type: "italic", offset: 0, length: 4 }], false);
    expect(fake.callsOf("sendPhoto")).toEqual([
      {
        chat_id: "-100",
        message_thread_id: "7",
        disable_notification: "false",
        photo: { file: "shot.png", size: photo.size, body: "body of shot.png" },
        caption: "look",
        caption_entities: [{ type: "italic", offset: 0, length: 4 }],
      },
    ]);
    for (const kind of ["video", "audio", "animation", "document"] as const) {
      await api.sendFiles("-100", 7, [file(`f.${kind}`, kind)], "", undefined, true);
      const method = `send${kind[0].toUpperCase()}${kind.slice(1)}`;
      expect(fake.callsOf(method)[0]).toMatchObject({ [kind]: { file: `f.${kind}` }, disable_notification: "true" });
      expect(fake.callsOf(method)[0].caption).toBeUndefined();
    }
  });

  test("several files go as one media group, the caption on the first item", async () => {
    const a = file("a.png", "photo");
    const b = file("b.mp4", "video");
    await api.sendFiles("-100", 7, [a, b], "both", [{ type: "bold", offset: 0, length: 4 }], true);
    const [call] = fake.callsOf("sendMediaGroup");
    expect(call.media).toEqual([
      { type: "photo", media: "attach://file0", caption: "both", caption_entities: [{ type: "bold", offset: 0, length: 4 }] },
      { type: "video", media: "attach://file1" },
    ]);
    expect(call.file0).toMatchObject({ file: "a.png", body: "body of a.png" });
    expect(call.file1).toMatchObject({ file: "b.mp4", body: "body of b.mp4" });
    expect(call).toMatchObject({ chat_id: "-100", message_thread_id: "7", disable_notification: "true" });
  });

  test("an upload Telegram fails with 5xx is retried with the whole file", async () => {
    fake.failNext("sendDocument", { code: 502, description: "Bad Gateway" });
    await api.sendFiles("-100", 7, [file("log.txt", "document")], "", undefined, true);
    expect(fake.callsOf("sendDocument").map(c => field(c.document, "body"))).toEqual(["body of log.txt", "body of log.txt"]);
  });
});
