import type { HubOptions } from "../src/hub/hub.ts";
import type { Config } from "../src/shared/config.ts";
import type { HubToPlugin } from "../src/shared/protocol.ts";

import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { CLEANUP_SETTLE_MS, Hub } from "../src/hub/hub.ts";
import { LaunchExitError } from "../src/hub/launch.ts";
import { en } from "../src/shared/i18n/en.ts";
import { PROTOCOL_VERSION } from "../src/shared/protocol.ts";
import { MAX_RECONNECT_PAUSE_MS } from "../src/shared/reconnect.ts";
import { buttonPress, topicMsg } from "./fake-telegram.ts";
import { memLogger, must, offlineApi, tempDir } from "./helpers.ts";
import { manualClock, turn } from "./manual-clock.ts";

// Synthetic process/chat identifiers and short deterministic timing units.
const SID = "11111111-2222-3333-4444-555555555555";
const STALE_SID = "22222222-2222-3333-4444-555555555555";
const PID = 4242;
const GROUP = "-1001";
const USER = "123456789";
const TOPIC = 100;
const POLL_MS = 2;
const EXIT_MS = POLL_MS * 3;
const READY_MS = POLL_MS;
const SETTLE_MS = MAX_RECONNECT_PAUSE_MS + POLL_MS;
const MS_PER_SECOND = 1000;
const LAUNCH_SECONDS = 1;
const COMMAND = ["claude", "--resume", "{session}", "{mode}"];
const disposers: (() => Promise<void>)[] = [];

afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });

function fixture(extra: Partial<HubOptions> = {}) {
  const dir = tempDir();
  const clock = manualClock();
  const spawned: string[][] = [];
  const notices: string[] = [];
  const sent: { ws: Parameters<Hub["onClose"]>[0]; msg: HubToPlugin }[] = [];
  const api = offlineApi();
  api.answerCallbackQuery = async () => {};
  api.removeKeyboard = async () => {};
  api.setMessageReaction = async () => {};
  let alive = true;
  let config: Config = { groupId: GROUP, allowFrom: [USER], turnEndChime: "", launch: { command: COMMAND, timeoutSec: LAUNCH_SECONDS } };
  const hub = new Hub({
    port: 0, sessionsFile: join(dir, "sessions.json"), outboxFile: join(dir, "outbox.json"),
    filesDir: join(dir, "files"), inboxDir: join(dir, "inbox"), api, config: () => config,
    idleMs: 0, spawn: command => { spawned.push(command); }, log: memLogger(), onExit: () => {},
    accountsAvailable: () => true,
    now: clock.now, sleep: clock.sleep, setTimer: clock.set, clearTimer: clock.clear,
    cleanupExitMs: EXIT_MS, exitPollMs: POLL_MS, cleanupSettleMs: SETTLE_MS, readyDelayMs: READY_MS,
    isAlive: () => alive, ...extra,
  });
  hub["running"] = true;
  hub["pump"] = async () => {};
  hub["notice"] = (_sid, text) => { notices.push(text); };
  hub["launchNotice"] = (_sid, text) => { notices.push(text); };
  hub["send"] = (ws, msg) => { sent.push({ ws, msg }); };
  hub["store"].set(SID, { title: "Test", project: "test", enabled: true, topicId: TOPIC, cwd: dir, account: "2" });
  const message = (text: string) => must(topicMsg({ chatId: GROUP, fromId: USER, threadId: TOPIC, text }).message);
  const update = (text: string) => hub["handleUpdate"](api, topicMsg({ chatId: GROUP, fromId: USER, threadId: TOPIC, text }));
  const press = (data = `m:${SID}:plan`, fromId = USER) => hub["handleUpdate"](api, buttonPress({ chatId: GROUP, fromId, messageId: TOPIC, data }));
  const connect = () => {
    const ws: Parameters<Hub["onClose"]>[0] = {
      data: {}, remoteAddress: "127.0.0.1", readyState: 1, subscriptions: [],
      send: () => 0, sendText: () => 0, sendBinary: () => 0, close: () => {}, terminate: () => {},
      ping: () => 0, pong: () => 0, publish: () => 0, publishText: () => 0, publishBinary: () => 0,
      subscribe: () => true, unsubscribe: () => true, isSubscribed: () => false, getBufferedAmount: () => 0,
      cork: () => { throw new Error("The hub fixture does not use cork"); },
    };
    hub["onOpen"](ws);
    hub["dispatch"](ws, { type: "hello", v: PROTOCOL_VERSION, windowKey: "test", sessionId: SID, cwd: dir });
    return ws;
  };
  const close = (ws: Parameters<Hub["onClose"]>[0], pid: number | null = PID) => {
    ws.data.exitingPid = pid ?? undefined;
    hub["onClose"](ws);
  };
  const inbound = (content: string, onSent = () => {}) => ({ content, meta: { exec_id: content }, onSent });
  const contents = (ws: Parameters<Hub["onClose"]>[0]) => sent.filter(item => item.ws === ws).flatMap(({ msg }) => msg.type === "inbound" ? [msg.content] : []);
  disposers.push(async () => {
    hub["running"] = false;
    for (const gate of hub["exitGates"].values()) gate.cancel();
    clock.dispose();
    await turn();
    rmSync(dir, { recursive: true, force: true });
  });
  return { hub, api, dir, clock, spawned, notices, sent, connect, close, message, update, press, inbound, contents,
    die: () => { alive = false; }, configure: (next: Config) => { config = next; }, config: () => config };
}

describe("all starts share the exit gate", () => {
  // The fixture passes its own settle wait, so the production default is checked here.
  test("the default settle wait outlasts the longest reconnect pause", () => {
    expect(CLEANUP_SETTLE_MS).toBeGreaterThan(MAX_RECONNECT_PAUSE_MS);
  });

  test("an abandoned mode switch with no held items does not start an empty session later", async () => {
    const f = fixture();
    const old = f.connect();
    await f.press();
    f.close(old);
    await f.clock.advance(EXIT_MS);
    f.die();
    await f.clock.advance(POLL_MS);
    expect(f.spawned).toEqual([]);
  });

  test("deadline abandons the mode, keeps a held message, and spawns only after death", async () => {
    const f = fixture();
    const old = f.connect();
    await f.update("/mode plan");
    await f.update("held");
    f.close(old);
    await f.clock.advance(EXIT_MS * 2);
    expect(f.spawned).toEqual([]);
    expect(f.notices.filter(text => text === en.modeNotChangedExit)).toHaveLength(1);
    await f.update("/mode");
    expect(f.notices.at(-1)).toBe(en.sessionAlreadyStarting);
    f.die();
    await f.clock.advance(POLL_MS);
    expect(f.spawned).toHaveLength(1);
    expect(f.spawned[0]).not.toContain("--permission-mode");
    const next = f.connect();
    await f.clock.advance(READY_MS);
    expect(f.contents(old)).toEqual([]);
    expect(f.contents(next)).toEqual(["held"]);
  });

  for (const command of ["/run", "/mode plan", "/cleanup", "new topic message"]) {
    test(`an exiting pid gates ${command} after an ordinary close`, async () => {
      const f = fixture();
      const old = f.connect();
      f.close(old);
      await f.update(command);
      expect(f.spawned).toEqual([]);
      f.die();
      await f.clock.advance(POLL_MS);
      expect(f.spawned).toHaveLength(1);
    });
  }

  test("/stop with an open window holds messages until exit, then follows the normal path", async () => {
    const f = fixture();
    const old = f.connect();
    await f.update("/mode plan");
    await f.update("held before stop");
    await f.update("/stop");
    f.close(old);
    await f.clock.advance(EXIT_MS);
    expect(f.spawned).toEqual([]);
    f.die();
    await f.clock.advance(POLL_MS);
    expect(f.spawned[0]).not.toContain("--permission-mode");
    const next = f.connect();
    await f.clock.advance(READY_MS);
    expect(f.contents(next)).toEqual(["held before stop"]);
  });

  test("/stop then /mode immediately after close still waits for exit", async () => {
    const f = fixture();
    const old = f.connect();
    await f.update("/stop");
    // The module has acknowledged stop and asks for termination.
    f.hub["terminate"](SID);
    f.close(old);
    await f.update("/mode plan");
    expect(f.spawned).toEqual([]);
    f.die();
    await f.clock.advance(POLL_MS);
    expect(f.spawned[0]).toContain("plan");
  });

  test("a plain /stop captures the waiting batch and subsequent messages until exit", async () => {
    const f = fixture();
    const old = f.connect();
    await f.update("before stop");
    await f.update("/stop");
    f.hub["terminate"](SID);
    await f.update("after stop");
    expect(f.contents(old)).toEqual([]);
    f.close(old);
    await f.clock.advance(EXIT_MS);
    expect(f.spawned).toEqual([]);
    f.die();
    await f.clock.advance(POLL_MS);
    const next = f.connect();
    await f.clock.advance(READY_MS);
    expect(f.contents(next)).toEqual(["before stop\n\nafter stop"]);
  });

  test("an unknown-pid reconnect during settle aborts the switch and takes held messages", async () => {
    const f = fixture();
    const old = f.connect();
    await f.update("/mode plan");
    await f.update("held for reconnect");
    f.close(old, null);
    await f.clock.advance(MAX_RECONNECT_PAUSE_MS);
    expect(f.spawned).toEqual([]);
    const returned = f.connect();
    await turn();
    await f.clock.advance(READY_MS);
    expect(f.notices).toContain(en.modeNotChangedReopened);
    expect(f.contents(returned)).toEqual(["held for reconnect"]);
    expect(f.spawned).toEqual([]);
  });

  test("a known-pid reconnect also gives held items to the returning window", async () => {
    const f = fixture();
    const old = f.connect();
    await f.update("/mode plan");
    await f.update("held");
    f.close(old);
    const returned = f.connect();
    await turn();
    await f.clock.advance(READY_MS);
    expect(f.contents(returned)).toEqual(["held"]);
    expect(f.spawned).toEqual([]);
  });

  test("cleanup's deadline leaves its held message behind the same gate", async () => {
    let cleaned = false;
    const f = fixture({ cleanTranscript: async () => { cleaned = true; return { kind: "nothing", skills: [] }; } });
    const old = f.connect();
    await f.update("/cleanup");
    const cleanup = must(f.hub["cleanups"].get(SID));
    f.hub["onCleanupReport"](SID, cleanup.id, undefined, undefined);
    await f.update("held during cleanup");
    f.close(old);
    await f.clock.advance(EXIT_MS);
    expect(cleaned).toBe(false);
    expect(f.spawned).toEqual([]);
    f.die();
    await f.clock.advance(POLL_MS);
    const next = f.connect();
    await f.clock.advance(READY_MS);
    expect(f.contents(next)).toEqual(["held during cleanup"]);
  });
});

describe("restart delivery races", () => {
  test("a mode press while the old window is still ending says the session is already starting", async () => {
    const f = fixture();
    const old = f.connect();
    await f.press(`m:${SID}:plan`);
    expect(f.sent.some(({ ws, msg }) => ws === old && msg.type === "terminate")).toBe(true);
    await f.press(`m:${SID}:auto`);
    expect(f.notices.at(-1)).toBe(en.sessionAlreadyStarting);
    f.close(old);
    f.die();
  });

  test("a button captures a waiting batch and an open replay before terminating", async () => {
    const f = fixture();
    const old = f.connect();
    await f.update("waiting batch");
    f.hub["replay"](SID, [{ message: f.message("open replay") }]);
    await f.press();
    expect(f.contents(old)).toEqual([]);
    f.close(old);
    f.die();
    await f.clock.advance(POLL_MS);
    const next = f.connect();
    await f.clock.advance(READY_MS);
    expect(f.contents(next).join("\n")).toBe("waiting batch\n\nopen replay");
  });

  test("attachment preparation that finishes after restart cannot send to the ending window", async () => {
    const f = fixture();
    const old = f.connect();
    let release: () => void = () => {};
    const prepared = new Promise<void>(resolve => { release = resolve; });
    const original = f.hub["inboundOf"].bind(f.hub);
    f.hub["inboundOf"] = async (api, message) => { await prepared; return original(api, message); };
    const sending = f.hub["queueBatch"](SID, f.api, [f.message("slow attachment")]);
    await turn();
    await f.press();
    expect(f.contents(old)).toEqual([]);
    await f.update("after the attachment");
    f.close(old);
    f.die();
    await f.clock.advance(POLL_MS);
    const next = f.connect();
    await f.clock.advance(READY_MS);
    expect(f.contents(next)).toEqual([]);
    release();
    await sending;
    await turn();
    expect(f.contents(next)).toEqual(["slow attachment\n\nafter the attachment"]);
  });

  test("an open poll ends before the next typed answer can be swallowed", async () => {
    const f = fixture();
    const old = f.connect();
    let resolved = false;
    f.hub["polls"].set("poll", { key: "poll", sessionId: SID, questions: [], answers: {}, index: 0,
      checked: new Set(), messageIds: [], outcomes: [], taken: [], done: false, resolve: () => { resolved = true; } });
    await f.press();
    expect(resolved).toBe(true);
    await f.update("typed answer");
    f.close(old);
    f.die();
    await f.clock.advance(POLL_MS);
    const next = f.connect();
    await f.clock.advance(READY_MS);
    expect(f.contents(old)).toEqual([]);
    expect(f.contents(next)).toEqual(["typed answer"]);
  });

  test("an in-flight replay is captured with its result and cannot overtake the new queue", async () => {
    const f = fixture();
    const old = f.connect();
    let release: () => void = () => {};
    const preparation = new Promise<void>(resolve => { release = resolve; });
    const original = f.hub["inboundOf"].bind(f.hub);
    f.hub["inboundOf"] = async (api, message) => { await preparation; return original(api, message); };
    let acknowledged = 0;
    f.hub["replay"](SID, [{ message: f.message("replay attachment") }, { inbound: f.inbound("replay result", () => { acknowledged++; }) }]);
    await f.clock.advance(READY_MS);
    await f.press();
    await f.update("after the replay");
    f.close(old);
    f.die();
    await f.clock.advance(POLL_MS);
    const next = f.connect();
    await f.clock.advance(READY_MS);
    expect(f.contents(next)).toEqual([]);
    release();
    await turn();
    expect(f.contents(old)).toEqual([]);
    expect(f.contents(next)).toEqual(["replay attachment", "replay result", "after the replay"]);
    expect(acknowledged).toBe(1);
  });

  test("exec results during restart and during readiness join the same ordered replay", async () => {
    const f = fixture();
    const old = f.connect();
    let delivered = 0;
    await f.press();
    await f.update("first");
    f.hub["reportExec"](SID, f.inbound("during restart", () => { delivered++; }));
    await f.update("last held message");
    f.close(old);
    f.die();
    await f.clock.advance(POLL_MS);
    const next = f.connect();
    f.hub["reportExec"](SID, f.inbound("during readiness", () => { delivered++; }));
    expect(f.contents(next)).toEqual([]);
    await f.clock.advance(READY_MS);
    expect(f.contents(next)).toEqual(["first", "during restart", "last held message", "during readiness"]);
    expect(delivered).toBe(2);
    expect(f.contents(old)).toEqual([]);
    expect(f.notices).not.toContain(en.sessionEnded);
  });

  test("keyboard removal hanging does not delay the switch; refusals retain buttons", async () => {
    const f = fixture();
    const old = f.connect();
    let removed = 0;
    f.api.removeKeyboard = () => { removed++; return new Promise<void>(() => {}); };
    f.configure({ ...f.config(), launch: { command: ["claude"], timeoutSec: LAUNCH_SECONDS } });
    // The presses are not awaited: a press that waits on the hanging removal must fail the checks, not hang the suite.
    void f.press();
    await turn();
    expect(removed).toBe(0);
    expect(f.sent.some(({ msg }) => msg.type === "terminate")).toBe(false);
    f.configure({ ...f.config(), launch: { command: COMMAND, timeoutSec: LAUNCH_SECONDS } });
    void f.press();
    await turn();
    expect(removed).toBe(1);
    expect(f.sent.some(({ ws, msg }) => ws === old && msg.type === "terminate")).toBe(true);
  });

  test("malformed, stale and unauthorized buttons neither spawn nor terminate a live window", async () => {
    const f = fixture();
    f.connect();
    await f.press("m:not-a-session:plan");
    await f.press(`m:${STALE_SID}:plan`);
    await f.press(`m:${SID}:plan`, "999");
    expect(f.spawned).toEqual([]);
    expect(f.sent.some(({ msg }) => msg.type === "terminate")).toBe(false);
  });
});

describe("held items survive failed starts", () => {
  test("an asynchronous spawn error retains held items without recording the mode", async () => {
    const f = fixture({ spawn: async () => { throw new Error("fixture asynchronous spawn error"); } });
    f.hub["launch"](SID, undefined, [{ message: f.message("kept after an asynchronous error") }], true, "plan");
    await turn();
    expect(f.hub["store"].get(SID)?.launchedMode).toBeUndefined();
    expect(f.hub["retained"].get(SID)).toHaveLength(1);
  });

  test("a launch command that exits with a failure is a failed launch: stderr in the topic, no start notice, no wait", async () => {
    const f = fixture({ spawn: async () => { throw new LaunchExitError(2, "no server running"); } });
    f.hub["launch"](SID, undefined, [{ message: f.message("kept after a failed command") }], true, "plan");
    await turn();
    expect(f.notices).toContain(en.cannotLaunch({ why: en.launchExited({ code: 2, stderr: "no server running" }) }));
    expect(f.notices.some(text => text.includes("🚀"))).toBe(false);
    expect(f.hub["retained"].get(SID)).toHaveLength(1);
    expect(f.hub["launches"].has(SID)).toBe(false);
    expect(f.hub["store"].get(SID)?.launchedMode).toBeUndefined();
    const count = f.notices.length;
    await f.clock.advance(LAUNCH_SECONDS * MS_PER_SECOND);
    expect(f.notices).toHaveLength(count);
  });

  test("tmux saying the session exists names the attach command and does not launch again", async () => {
    const f = fixture({ spawn: async () => { throw new LaunchExitError(1, `duplicate session: claude-${SID}`); } });
    f.hub["launch"](SID, undefined, [{ message: f.message("kept for the live session") }], true);
    await turn();
    expect(f.notices).toContain(en.tmuxSessionAlive({ name: `claude-${SID}` }));
    expect(f.notices.some(text => text.includes("🚀"))).toBe(false);
    expect(f.hub["retained"].get(SID)).toHaveLength(1);
  });

  test("a tmux launch that never connects says it may wait for confirmation in tmux", async () => {
    const tmux = ["tmux", "new-session", "-d", "-s", "claude-{session}", "--", "claude", "--resume", "{session}"];
    const f = fixture();
    f.configure({ ...f.config(), launch: { command: tmux, timeoutSec: LAUNCH_SECONDS } });
    f.hub["launch"](SID, undefined, [{ message: f.message("waiting") }]);
    await f.clock.advance(LAUNCH_SECONDS * MS_PER_SECOND);
    expect(f.notices.at(-1)).toBe(en.sessionDidNotStart({ seconds: LAUNCH_SECONDS, tmuxHint: `tmux attach -t claude-${SID}` }));
  });

  test("a launch that never connects through another command gets the plain timeout notice", async () => {
    const f = fixture();
    f.hub["launch"](SID, undefined, [{ message: f.message("waiting") }]);
    await f.clock.advance(LAUNCH_SECONDS * MS_PER_SECOND);
    expect(f.notices.at(-1)).toBe(en.sessionDidNotStart({ seconds: LAUNCH_SECONDS, tmuxHint: undefined }));
  });

  for (const failure of ["spawn", "timeout", "checks", "placeholder"]) {
    test(`${failure} keeps messages and exec acknowledgements for the next start`, async () => {
      let failSpawn = failure === "spawn";
      const commands: string[][] = [];
      const f = fixture({ spawn: command => { if (failSpawn) throw new Error("fixture spawn failed"); commands.push(command); } });
      const old = f.connect();
      let delivered = false;
      await f.press();
      await f.update("kept message");
      f.hub["reportExec"](SID, f.inbound("kept result", () => { delivered = true; }));
      f.close(old);
      if (failure === "checks") f.configure({ ...f.config(), launch: undefined });
      if (failure === "placeholder") f.configure({ ...f.config(), launch: { command: ["claude"], timeoutSec: LAUNCH_SECONDS } });
      f.die();
      await f.clock.advance(POLL_MS);
      if (failure === "timeout") await f.clock.advance(LAUNCH_SECONDS * MS_PER_SECOND);
      expect(delivered).toBe(false);
      expect(f.notices.some(text => text.includes(en.pendingDelivery({ count: 2 })))).toBe(true);
      if (failure !== "timeout") expect(commands).toEqual([]);
      failSpawn = false;
      f.configure({ ...f.config(), launch: { command: COMMAND, timeoutSec: LAUNCH_SECONDS } });
      await f.update("/run");
      const next = f.connect();
      await f.clock.advance(READY_MS);
      expect(f.contents(next)).toEqual(["kept message", "kept result"]);
      expect(delivered).toBe(true);
    });
  }

  for (const command of ["/mode plan", "/run"]) {
    test(`/stop cancels a spawned, unconnected ${command} and terminates it on connection`, async () => {
      const f = fixture();
      await f.update(command);
      await f.update("held until the cancelled launch exits");
      await f.update("/stop");
      const cancelled = f.connect();
      expect(f.sent.some(({ ws, msg }) => ws === cancelled && msg.type === "terminate")).toBe(true);
      expect(f.contents(cancelled)).toEqual([]);
      f.close(cancelled);
      expect(f.spawned).toHaveLength(1);
      f.die();
      await f.clock.advance(POLL_MS);
      expect(f.spawned).toHaveLength(2);
      const next = f.connect();
      await f.clock.advance(READY_MS);
      expect(f.contents(next)).toEqual(["held until the cancelled launch exits"]);
    });
  }
});

describe("mode belongs to the current run", () => {
  test("an older record is last known, and the same-mode request still restarts", async () => {
    const f = fixture();
    const path = join(f.dir, `${SID}.jsonl`);
    writeFileSync(path, `${JSON.stringify({ type: "permission-mode", permissionMode: "plan" })}\n`);
    f.hub["store"].setTranscript(SID, path);
    const old = f.connect();
    expect(f.hub["knownMode"](SID)).toBeUndefined();
    expect(f.hub["currentMode"](SID)).toBe("plan");
    await f.update("/mode");
    expect(f.hub["outbox"].head(SID)?.text).toContain(en.modeLastKnown({ mode: "plan" }));
    await f.update("/mode plan");
    expect(f.sent.some(({ ws, msg }) => ws === old && msg.type === "terminate")).toBe(true);
  });

  test("a record after attachment makes same-mode a no-op", async () => {
    const f = fixture();
    const path = join(f.dir, `${SID}.jsonl`);
    writeFileSync(path, "");
    f.hub["store"].setTranscript(SID, path);
    f.connect();
    appendFileSync(path, `${JSON.stringify({ type: "permission-mode", permissionMode: "plan" })}\n`);
    await f.update("/mode plan");
    expect(f.notices).toContain(en.modeAlready({ mode: "plan" }));
    expect(f.sent.some(({ msg }) => msg.type === "terminate")).toBe(false);
  });

  test("closed sessions always start, and later records override launched mode", async () => {
    const f = fixture();
    const path = join(f.dir, `${SID}.jsonl`);
    writeFileSync(path, `${JSON.stringify({ type: "permission-mode", permissionMode: "plan" })}\n`);
    f.hub["store"].setTranscript(SID, path);
    await f.update("/mode plan");
    expect(f.spawned).toHaveLength(1);
    const next = f.connect();
    expect(f.hub["knownMode"](SID)).toBe("plan");
    appendFileSync(path, `${JSON.stringify({ type: "permission-mode", permissionMode: "auto" })}\n`);
    expect(f.hub["knownMode"](SID)).toBe("auto");
    f.close(next);
  });

  test("no transcript at launch does not let old records override the launched mode", async () => {
    const f = fixture();
    await f.update("/mode plan");
    const path = join(f.dir, `${SID}.jsonl`);
    writeFileSync(path, `${JSON.stringify({ type: "permission-mode", permissionMode: "auto" })}\n`);
    f.hub["store"].setTranscript(SID, path);
    f.connect();
    expect(f.hub["currentMode"](SID)).toBe("plan");
    expect(f.hub["knownMode"](SID)).toBe("plan");
  });
});
