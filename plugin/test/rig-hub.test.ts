import type { HubOptions } from "../src/hub/hub.ts";
import type { RigOutput } from "../src/hub/rig.ts";

import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { Hub } from "../src/hub/hub.ts";
import { runnerSpecSchema } from "../src/hub/exec-runner.ts";
import { EXEC_MAX_AGE_MS, HEARTBEAT_STALE_MS } from "../src/hub/exec.ts";
import { buttonPress, topicMsg } from "./fake-telegram.ts";
import { memLogger, must, offlineApi, tempDir } from "./helpers.ts";
import { manualClock, turn } from "./manual-clock.ts";
import { en } from "../src/shared/i18n/en.ts";
import { platformFor } from "../src/shared/platform.ts";

// Synthetic ids. No real rig, child process, Telegram connection or wall clock.
const GROUP = "-1001";
const USER = "1234";
const STRANGER = "5678";
const TOPIC = 12;
const PID = 424242;
const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

// Machine commands run beside the poll loop; a test that reads their answer waits for them here.
async function settled(hub: Hub): Promise<void> {
  while (hub["machineTasks"].size) await Promise.all([...hub["machineTasks"]]);
}

function fixture(extra: Partial<HubOptions> = {}) {
  const dir = tempDir();
  const clock = manualClock();
  const hubs = new Set<Hub>();
  const track = (hub: Hub) => { hubs.add(hub); return hub; };
  disposers.push(() => {
    try {
      for (const hub of hubs) { hub["running"] = false; hub["clearTimer"](hub["rigTimer"]); hub["execs"]?.stop(); }
    } finally { clock.dispose(); rmSync(dir, { recursive: true, force: true }); }
  });
  const api = offlineApi();
  const texts: { text: string; topic?: number; silent?: boolean }[] = [];
  const order: string[] = [];
  const spawned: string[] = [];
  const answers: string[] = [];
  const menus: string[][] = [];
  const removed: number[] = [];
  let offline = false;
  let output: RigOutput = { code: 0, stdout: "[]", stderr: "" };
  api.sendMessage = async (_chat, topic, text, silent) => {
    if (offline) throw new Error("offline");
    texts.push({ text, topic, silent }); order.push(text); return { message_id: texts.length };
  };
  api.editMessageText = async (_chat, _id, text) => { if (offline) throw new Error("offline"); texts.push({ text }); };
  api.setMyCommands = async commands => { menus.push(commands.map(command => command.command)); return true; };
  api.answerCallbackQuery = async (_id, text) => { answers.push(text ?? ""); };
  api.removeKeyboard = async (_chat, id) => { removed.push(id); return true; };
  const options: HubOptions = {
    port: 0, api, idleMs: 0, sessionsFile: join(dir, "sessions.json"), outboxFile: join(dir, "outbox.json"),
    execDir: join(dir, "exec"), execsFile: join(dir, "execs.json"), filesDir: join(dir, "files"), inboxDir: dir,
    repository: dir, findRig: () => "/fake/rig", runRig: async () => output,
    execEnv: () => ({}),
    config: () => ({ groupId: GROUP, allowFrom: [USER], turnEndChime: "" }),
    spawnRunner: file => {
      order.push("spawn"); spawned.push(file);
      const spec = runnerSpecSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      writeFileSync(spec.log, "Waiting for an invented resource\n");
      return PID;
    },
    now: clock.now, setTimer: clock.set, clearTimer: clock.clear, sleep: clock.sleep, isAlive: () => true,
    log: memLogger(), onExit() {}, ...extra,
  };
  const hub = track(new Hub(options));
  hub["running"] = true;
  hub["store"].set("session", { title: "Test", project: "test", topicId: TOPIC, enabled: true, cwd: dir });
  // `intake` is what the poll loop waits for; `update` also waits for the machine command it started.
  const intake = (text: string, from = USER, topic?: number) => hub["handleUpdate"](api, topicMsg({ chatId: GROUP, fromId: from, threadId: topic, text }));
  const update = async (text: string, from = USER, topic?: number) => { await intake(text, from, topic); await settled(hub); };
  return { hub, options, api, dir, clock, texts, order, spawned, answers, menus, removed, update, intake, track,
    offline: (next: boolean) => { offline = next; }, output: (next: RigOutput) => { output = next; } };
}

test("General routes only allowed machine commands and preserves a session topic destination", async () => {
  const f = fixture();
  await f.update("/feature", STRANGER);
  await f.update("/cmd echo forbidden");
  expect(f.texts).toEqual([]);
  await f.update("/feature");
  expect(f.texts[0]).toEqual({ text: en.featuresEmpty, topic: undefined, silent: true });
  await f.update("/feature", USER, 1);
  expect(f.texts.at(-1)?.topic).toBeUndefined();
  await f.update("/rig update", USER, TOPIC);
  expect(f.spawned).toHaveLength(1);
  await f.hub["machineOutbox"].flush(f.api);
  expect(f.texts.some(message => message.topic === TOPIC)).toBe(true);
  expect(f.hub["commands"].size).toBe(0);
});

test("missing rig answers commands, keeps them in the menu and preserves legacy shells", async () => {
  const f = fixture({ findRig: () => undefined });
  await f.update("/feature");
  await f.update("/rig update");
  expect(f.texts.every(message => message.text.includes(en.rigMissing))).toBe(true);
  await f.hub["registerCommands"](f.api);
  expect(f.menus[0]).toContain("feature");
  expect(f.menus[0]).toContain("rig");
});

test("a rig that cannot be launched answers with its own reason, not a fixed text", async () => {
  const f = fixture({ platform: platformFor("win32"), findRig: () => "C:\\50%\\rig.cmd" });
  await f.update("/rig update");
  await f.hub["machineOutbox"].flush(f.api);
  expect(f.texts.map(message => message.text).join("\n")).toContain("\"%\"");
});

test("a slow JSON query neither delays the next update nor escapes the idle gate", async () => {
  let release: () => void = () => {};
  const slow = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ runRig: async () => { await slow; return { code: 0, stdout: "[]", stderr: "" }; } });
  await f.intake("/feature");
  expect(f.hub["machineQueries"]).toBe(1);
  expect(f.hub["rigIdle"]()).toBe(false);
  // The poll loop is free: another command is handled while the query waits.
  await f.intake("/feature");
  expect(f.hub["machineQueries"]).toBe(2);
  release();
  await settled(f.hub);
  expect(f.hub["machineQueries"]).toBe(0);
  expect(f.hub["rigIdle"]()).toBe(true);
});

test("a machine command that fails is logged and does not stop the intake", async () => {
  const log = memLogger();
  const f = fixture({ log });
  f.hub["rig"].refresh = async () => { throw new Error("rig crashed"); };
  await f.update("/feature");
  expect(f.hub["machineQueries"]).toBe(0);
  expect(log.lines.join("\n")).toContain("rig crashed");
});

test("feature refreshes are single-flight: one in flight, one more behind it", async () => {
  let runs = 0;
  const gates: (() => void)[] = [];
  const f = fixture({ runRig: async () => { runs++; await new Promise<void>(resolve => { gates.push(resolve); }); return { code: 0, stdout: "[]", stderr: "" }; } });
  const first = f.hub["refreshFeatures"]();
  const second = f.hub["refreshFeatures"]();
  const third = f.hub["refreshFeatures"]();
  await turn();
  expect(runs).toBe(1);
  gates.shift()?.();
  await turn();
  await turn();
  expect(runs).toBe(2);
  gates.shift()?.();
  await Promise.all([first, second, third]);
  expect(runs).toBe(2);
  expect(f.hub["machineQueries"]).toBe(0);
});

test("rig wait output streams normally, has no timeout, and code 1 is visible after hub restart", async () => {
  const f = fixture();
  await f.update("/rig update");
  const manager = must(f.hub["execs"]);
  manager["check"]();
  await f.hub["machineOutbox"].flush(f.api);
  expect(f.texts.some(message => message.text.includes("Waiting for an invented resource"))).toBe(true);
  expect(manager.running()).toBe(1);
  // Waiting for rig is longer than the shell's stale-message and heartbeat settings.
  await f.clock.advance(EXEC_MAX_AGE_MS + HEARTBEAT_STALE_MS);
  manager["check"]();
  expect(manager.running()).toBe(1);
  const spec = runnerSpecSchema.parse(JSON.parse(readFileSync(must(f.spawned[0]), "utf8")));
  writeFileSync(spec.exit, JSON.stringify({ code: 1, endedAt: f.clock.now() }));
  f.hub["running"] = false;
  const resumed = f.track(new Hub(f.options));
  resumed["running"] = true;
  must(resumed["execs"]).restore();
  await resumed["machineOutbox"].flush(f.api);
  expect(f.texts.some(message => message.text.includes(en.execOutcomeCode({ code: 1 })))).toBe(true);
  expect(must(resumed["execs"]).running()).toBe(0);
  expect(f.spawned).toHaveLength(1);
  resumed["running"] = false;
});

test("a rig busy line reaches the topic while the command runs and is not a failure", async () => {
  const busy = "Another rig command is running, waiting for it to end.";
  const f = fixture({
    spawnRunner: file => {
      const spec = runnerSpecSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      writeFileSync(spec.log, "");
      f.spawned.push(file);
      return PID;
    },
  });
  await f.update("/rig update");
  const manager = must(f.hub["execs"]);
  const spec = runnerSpecSchema.parse(JSON.parse(readFileSync(must(f.spawned[0]), "utf8")));
  // The runner prints the line some time after the start; the next check shows it.
  expect(f.texts.some(message => message.text.includes(busy))).toBe(false);
  writeFileSync(spec.log, `${busy}\n`);
  manager["check"]();
  await f.hub["machineOutbox"].flush(f.api);
  const shown = f.texts.filter(message => message.text.includes(busy));
  expect(shown.length).toBeGreaterThan(0);
  // A running card is silent (edits carry no flag): the line is no failure alert.
  expect(f.texts.every(message => message.silent !== false)).toBe(true);
  expect(manager.running()).toBe(1);
  writeFileSync(spec.log, `${busy}\nupdated\n`);
  writeFileSync(spec.exit, JSON.stringify({ code: 0, endedAt: f.clock.now() }));
  await f.clock.advance(1);
  manager["check"]();
  await f.hub["machineOutbox"].flush(f.api);
  expect(manager.running()).toBe(0);
  expect(f.texts.some(message => message.text.startsWith(en.execOutcomeOk))).toBe(true);
  expect(f.texts.some(message => message.text.includes("❌") || message.text.includes("interrupted"))).toBe(false);
});

test("telegram disable rejects a stranger and starts only after recovery instructions arrive", async () => {
  const f = fixture();
  await f.update("/feature telegram disable");
  const key = must([...f.hub["disableConfirmations"].keys()][0]);
  const press = (fromId: string) => f.hub["handleUpdate"](f.api, buttonPress({ chatId: GROUP, fromId, messageId: 1, data: `rig-disable:${key}` }));
  await press(STRANGER);
  expect(f.spawned).toEqual([]);
  f.offline(true);
  await press(USER);
  expect(f.spawned).toEqual([]);
  // Crash window: the accepted intent is durable before its notice was queued.
  f.hub["machineOutbox"]["data"].items = [];
  f.hub["machineOutbox"]["save"]();
  f.offline(false);
  // A new hub recovers the accepted intent and retries its recovery notice.
  f.hub["running"] = false;
  const resumed = f.track(new Hub(f.options));
  resumed["running"] = true;
  // The recovery notice goes out only after the restarted hub passed getMe.
  resumed["botReady"] = true;
  await resumed["rigTick"]();
  expect(f.spawned).toHaveLength(1);
  expect(f.order.findIndex(text => text.includes("rig feature telegram enable"))).toBeLessThan(f.order.indexOf("spawn"));
  resumed["running"] = false;
  resumed["clearTimer"](resumed["rigTimer"]);
});

test("status uses JSON contract fields rather than parsing the human output", async () => {
  const f = fixture();
  f.output({ code: 0, stderr: "", stdout: JSON.stringify({ schemaVersion: 1, mode: "server", versions: { rig: "rig-commit", hub: "hub-commit" }, releases: { rig: null, hub: "1.0.1" }, features: [], lastUpdate: null, pendingHubRestart: null, errors: [] }) });
  await f.update("/rig status");
  expect(f.texts[0]?.text).toContain(en.statusMode({ mode: "server" }));
  expect(f.texts[0]?.text).toContain("hub: 1.0.1 (hub-commit)");
});

function fakeWindow(sessionId: string, busy = false): Parameters<Hub["onClose"]>[0] {
  return {
    data: { sessionId, busy }, remoteAddress: "127.0.0.1", readyState: 1, subscriptions: [],
    send: () => 0, sendText: () => 0, sendBinary: () => 0, close() {}, terminate() {},
    ping: () => 0, pong: () => 0, publish: () => 0, publishText: () => 0, publishBinary: () => 0,
    subscribe: () => true, unsubscribe: () => true, isSubscribed: () => false, getBufferedAmount: () => 0,
    cork: () => { throw new Error("unused in this fixture"); },
  };
}

function pollFor(sessionId: string) {
  return { key: "q", sessionId, questions: [], answers: {}, index: 0, checked: new Set<number>(), messageIds: [], outcomes: [], taken: [], done: false, resolve() {} };
}

test("each specified work category blocks update exit, while a pending shell does not", () => {
  const f = fixture();
  const hub = f.hub;
  // Questions and permission requests count only while their window can still answer them.
  hub["conns"].add(fakeWindow("session"));
  const held = { inbound: { content: "held", meta: {}, onSent() {} } };
  const timer = f.clock.set(() => {}, 0);
  const pending = new Promise<void>(() => {});
  const pollOf = () => pollFor("session");
  const blockers: { name: string; add(): void; remove(): void }[] = [
    { name: "permissions", add: () => { hub["permissions"].set("p", { sessionId: "session", requestId: "p", text: "question", entities: [] }); }, remove: () => hub["permissions"].clear() },
    { name: "questions", add: () => { hub["polls"].set("q", pollOf()); }, remove: () => hub["polls"].clear() },
    { name: "running shell or rig", add: () => { must(hub["execs"])["recs"].push({ id: "pending", shell: "bash", sessionId: "session", messageId: 0, text: "work", cwd: f.dir, state: "running", reported: false }); }, remove: () => { must(hub["execs"])["recs"] = []; } },
    { name: "launch", add: () => { hub["launches"].set("session", { account: "", held: [], timer }); }, remove: () => hub["launches"].clear() },
    { name: "window restart", add: () => { hub["modeRestarts"].set("session", { mode: "plan", held: [] }); }, remove: () => hub["modeRestarts"].clear() },
    { name: "exit gate", add: () => { hub["exitGates"].set("session", { expired: false, settled: Promise.resolve("exited"), done: Promise.resolve("exited"), reconnect() {}, cancel() {} }); }, remove: () => hub["exitGates"].clear() },
    { name: "held input", add: () => { hub["retained"].set("session", [held]); }, remove: () => hub["retained"].clear() },
    { name: "dying window input", add: () => { hub["dyingHeld"].set("session", [held]); }, remove: () => hub["dyingHeld"].clear() },
    { name: "replay", add: () => { hub["replays"].set("session", { held: [held], inFlight: [], after: [] }); }, remove: () => hub["replays"].clear() },
    { name: "session outbox", add: () => { hub["outbox"].add("waiting", "session", [{ text: "waiting", silent: true }]); }, remove: () => { for (const item of hub["outbox"].items()) hub["outbox"].remove(item.id); } },
    { name: "General outbox", add: () => hub["machineOutbox"].post("waiting", { chatId: GROUP }, "waiting"), remove: () => { hub["machineOutbox"]["data"].items = []; } },
    { name: "question catching up", add: () => { hub["catchUps"].set("q", () => {}); }, remove: () => hub["catchUps"].clear() },
    { name: "question being sent", add: () => { hub["questionSends"].add(pending); }, remove: () => hub["questionSends"].clear() },
    { name: "queued launch", add: () => { hub["gatedLaunches"].set("session", { account: undefined, held: [], announce: false }); }, remove: () => hub["gatedLaunches"].clear() },
    { name: "cleanup", add: () => { hub["cleanups"].set("session", { id: "c", phase: "compacting", held: [] }); }, remove: () => hub["cleanups"].clear() },
    { name: "stop waiting for the window", add: () => { hub["stops"].set("session", timer); }, remove: () => hub["stops"].clear() },
    { name: "stop waiting for the module", add: () => { hub["stopping"].set("session", "stop"); }, remove: () => hub["stopping"].clear() },
    { name: "ready timer", add: () => { hub["readyTimers"].add(timer); }, remove: () => hub["readyTimers"].clear() },
    { name: "batch of messages", add: () => { hub["batches"].set("session", { api: f.api, messages: [], quietTimer: timer, maxTimer: timer }); }, remove: () => hub["batches"].clear() },
    { name: "batch being sent", add: () => { hub["batchSends"].set("session", pending); }, remove: () => hub["batchSends"].clear() },
    { name: "answer group", add: () => { hub["answerGroups"].set("q", { api: f.api, poll: pollOf(), index: 0, messages: [], parts: [], timer }); }, remove: () => hub["answerGroups"].clear() },
    { name: "pumping a session outbox", add: () => { hub["pumping"].add("session"); }, remove: () => hub["pumping"].clear() },
    { name: "card being edited", add: () => { hub["cards"].set("session:card", { text: "card", final: false, done: false, lastEdit: 0, editing: true }); }, remove: () => hub["cards"].clear() },
    { name: "General flush in flight", add: () => { hub["machineOutbox"]["flushing"] = pending; }, remove: () => { hub["machineOutbox"]["flushing"] = undefined; } },
    { name: "disable awaiting recovery notice", add: () => { hub["disableConfirmations"].set("k", { message: { message_id: 1 }, destination: { chatId: GROUP }, recovery: "recovery" }); }, remove: () => hub["disableConfirmations"].clear() },
    { name: "JSON query", add: () => { hub["machineQueries"]++; }, remove: () => { hub["machineQueries"]--; } },
    { name: "machine command in flight", add: () => { hub["machineTasks"].add(pending); }, remove: () => hub["machineTasks"].clear() },
    { name: "command not yet taken by a window", add: () => { hub["commands"].set("session", [{ cmd: { id: "c", name: "info", args: "" }, timer }]); }, remove: () => hub["commands"].clear() },
    { name: "incoming update", add: () => { hub["updatesInFlight"]++; }, remove: () => { hub["updatesInFlight"]--; } },
  ];
  expect(hub["rigIdle"]()).toBe(true);
  for (const blocker of blockers) {
    blocker.add();
    expect(hub["rigIdle"](), blocker.name).toBe(false);
    blocker.remove();
    expect(hub["rigIdle"](), blocker.name).toBe(true);
  }
  must(hub["execs"])["recs"].push({ id: "pending", shell: "bash", sessionId: "session", messageId: 0, text: "not started", cwd: f.dir, state: "pending", reported: false });
  expect(hub["rigIdle"]()).toBe(true);
});

test("work nobody can finish does not hold back the update exit", () => {
  const f = fixture();
  const hub = f.hub;
  // No window for these sessions: nobody can answer a question or a permission request.
  hub["permissions"].set("p", { sessionId: "closed", requestId: "p", text: "question", entities: [] });
  hub["polls"].set("q", pollFor("closed"));
  expect(hub["rigIdle"]()).toBe(true);
  // Pieces of a session whose setup is broken cannot be delivered either.
  hub["outbox"].add("waiting", "session", [{ text: "waiting", silent: true }]);
  hub["blocked"].add("session");
  expect(hub["rigIdle"]()).toBe(true);
  hub["blocked"].delete("session");
  expect(hub["rigIdle"]()).toBe(false);
});

test("a question button of a closed window is stale: the question goes to the terminal", async () => {
  const f = fixture();
  const hub = f.hub;
  const poll = { ...pollFor("closed"), key: "ab12", questions: [{ question: "Pick", header: "Pick", multiSelect: false, options: [{ label: "A", description: "" }] }] };
  hub["polls"].set("ab12", poll);
  const answers: (string | undefined)[] = [];
  f.api.answerCallbackQuery = async (_id, text) => { answers.push(text); return true; };
  await hub["onPollPress"](f.api, GROUP, { id: "1", data: "q:ab12:0:1", messageId: 5, fromId: USER });
  expect(hub["polls"].size).toBe(0);
  expect(answers).toEqual([en.pollStale]);
  expect(f.removed).toEqual([5]);
  expect(hub["rigIdle"]()).toBe(true);
});

test("an event poll in flight keeps the update idle gate closed", async () => {
  const f = fixture();
  const hub = f.track(new Hub({ ...f.options, rigDir: f.dir, hubCommit: () => "e".repeat(40) }));
  hub["running"] = true;
  hub["botReady"] = true;
  let release: () => void = () => {};
  const sending = new Promise<void>(resolve => { release = resolve; });
  const event = { id: "one", time: "2026-01-01T00:00:00Z", type: "future", level: "info", text: "one" };
  writeFileSync(join(f.dir, "events.jsonl"), JSON.stringify(event) + "\n");
  const send = f.api.sendMessage;
  f.api.sendMessage = async (...args) => { await sending; return send(...args); };
  const polling = must(hub["rigEvents"]).poll();
  await turn();
  expect(hub["rigIdle"]()).toBe(false);
  release();
  await polling;
  expect(f.texts.map(message => message.text)).toEqual(["one"]);
  expect(hub["rigIdle"]()).toBe(true);
});

test("rig ticks are single-flight: a tick that starts while one runs does not poll events again", async () => {
  const f = fixture();
  const hub = f.track(new Hub({ ...f.options, rigDir: f.dir, hubCommit: () => "e".repeat(40) }));
  hub["running"] = true;
  hub["botReady"] = true;
  let release: () => void = () => {};
  const sending = new Promise<void>(resolve => { release = resolve; });
  const event = { id: "tick", time: "2026-01-01T00:00:00Z", type: "future", level: "info", text: "tick" };
  writeFileSync(join(f.dir, "events.jsonl"), JSON.stringify(event) + "\n");
  const send = f.api.sendMessage;
  f.api.sendMessage = async (...args) => { await sending; return send(...args); };
  const events = must(hub["rigEvents"]);
  const pollEvents = events.poll.bind(events);
  let polls = 0;
  events.poll = async () => { polls++; await pollEvents(); };
  const first = hub["rigTick"]();
  await turn();
  expect(polls).toBe(1);
  // The first tick is held in the Telegram send; a second tick must return without starting its stages.
  await hub["rigTick"]();
  expect(polls).toBe(1);
  release();
  await first;
  expect(polls).toBe(1);
  expect(f.texts.map(message => message.text)).toEqual(["tick"]);
});

test("the hub writes readiness only after its first successful getMe", async () => {
  const f = fixture({ pollRetryBaseMs: 1 });
  const hub = f.track(new Hub({ ...f.options, rigDir: f.dir, hubCommit: () => "c".repeat(40) }));
  hub["running"] = true;
  let failures = 1;
  f.api.getMe = async () => { if (failures--) throw new Error("offline"); return { id: 1, username: "fake" }; };
  f.api.getUpdates = async () => { hub["running"] = false; return []; };
  const polling = hub["pollLoop"](f.api);
  await turn();
  expect(existsSync(join(f.dir, "hub-ready.json"))).toBe(false);
  await f.clock.advance(1);
  await polling;
  expect(existsSync(join(f.dir, "hub-ready.json"))).toBe(true);
});

test("events use General sound levels and features-changed updates the menu", async () => {
  const f = fixture({ platform: platformFor("win32") });
  const hub = f.track(new Hub({ ...f.options, rigDir: f.dir, hubCommit: () => "d".repeat(40) }));
  hub["running"] = true;
  hub["botReady"] = true;
  f.output({ code: 0, stderr: "", stdout: JSON.stringify([{ name: "pwsh", description: "PowerShell", enabled: true, platformAllowed: true }]) });
  const events = ["info", "warn", "error"].map(level => ({ id: level, time: "2026-01-01T00:00:00Z", type: "future", level, text: level }));
  events.push({ id: "features", time: "2026-01-01T00:00:00Z", type: "features-changed", level: "info", text: "service" });
  writeFileSync(join(f.dir, "events.jsonl"), events.map(event => JSON.stringify(event) + "\n").join(""));
  await hub["rigEvents"]?.poll();
  expect(f.texts).toEqual([{ text: "info", topic: undefined, silent: true }, { text: "warn", topic: undefined, silent: false }, { text: "error", topic: undefined, silent: false }]);
  expect(f.menus.at(-1)).toContain("pwsh");
  hub["running"] = false;
});

test("a failing queue or lifecycle stage cannot hold back a service event in the same tick", async () => {
  const exits: number[] = [];
  const heads = ["a".repeat(40), "b".repeat(40)];
  const f = fixture();
  const hub = f.track(new Hub({ ...f.options, rigDir: f.dir, hubCommit: () => heads.shift() ?? "b".repeat(40), onExit: code => { exits.push(code ?? 0); } }));
  hub["running"] = true;
  hub["botReady"] = true;
  hub["machineOutbox"].flush = async () => { throw new Error("queue broke"); };
  writeFileSync(join(f.dir, "events.jsonl"), JSON.stringify({ id: "r", time: "2026-01-01T00:00:00Z", type: "hub-restart-pending", level: "info", text: "" }) + "\n");
  await hub["rigTick"]();
  await turn();
  expect(exits).toEqual([75]);
  expect(existsSync(join(f.dir, "hub-restarting.json"))).toBe(true);
  hub["running"] = false;
});

test("the hub stops before it exits for a restart, and exits even if stopping fails", async () => {
  const order: string[] = [];
  const heads = ["a".repeat(40), "b".repeat(40)];
  const f = fixture();
  const hub = f.track(new Hub({ ...f.options, rigDir: f.dir, hubCommit: () => heads.shift() ?? "b".repeat(40), onExit: code => { order.push(`exit ${code ?? 0}`); } }));
  hub["running"] = true;
  hub["botReady"] = true;
  hub.stop = async () => { await turn(); order.push("stop"); throw new Error("stop failed"); };
  writeFileSync(join(f.dir, "events.jsonl"), JSON.stringify({ id: "r", time: "2026-01-01T00:00:00Z", type: "hub-restart-pending", level: "info", text: "" }) + "\n");
  await hub["rigTick"]();
  await turn();
  await turn();
  expect(order).toEqual(["stop", "exit 75"]);
  hub["running"] = false;
});

test("an agent turn keeps the update idle gate closed", () => {
  const f = fixture();
  const ws = fakeWindow("session", true);
  f.hub["conns"].add(ws);
  expect(f.hub["rigIdle"]()).toBe(false);
  ws.data.busy = false;
  expect(f.hub["rigIdle"]()).toBe(true);
  f.hub["permissions"].set("answered-in-terminal", { sessionId: "session", requestId: "permission", text: "cached", entities: [] });
  expect(f.hub["rigIdle"]()).toBe(false);
  f.hub["dispatch"](ws, { type: "busy", busy: false });
  expect(f.hub["permissions"].size).toBe(1);
  expect(f.hub["rigIdle"]()).toBe(true);
});

test("a failed menu registration is retried until Telegram accepts the current state", async () => {
  const f = fixture();
  let attempts = 0;
  f.api.setMyCommands = async commands => {
    if (++attempts === 1) throw new Error("offline");
    f.menus.push(commands.map(command => command.command));
    return true;
  };
  await f.hub["registerCommands"](f.api);
  await f.hub["registerCommands"](f.api);
  await f.hub["registerCommands"](f.api);
  expect(attempts).toBe(2);
  expect(f.menus[0]).toContain("feature");
  expect(f.menus[0]).toContain("rig");
});

test("a rig command that ended while the hub was down delivers its whole log after the restart, once", async () => {
  const f = fixture();
  await f.update("/rig update");
  const spec = runnerSpecSchema.parse(JSON.parse(readFileSync(must(f.spawned[0]), "utf8")));
  const full = Array.from({ length: 40 }, (_, index) => `invented line ${index}`).join("\n") + "\n";
  writeFileSync(spec.log, full);
  // The old hub saved the ended record and died before the log reached the outbox.
  const records: unknown = JSON.parse(readFileSync(must(f.options.execsFile), "utf8"));
  if (!Array.isArray(records)) throw new Error("execs.json is not a list");
  writeFileSync(must(f.options.execsFile), JSON.stringify(records.map(record => ({ ...record, state: "ended", end: { kind: "exit", code: 0, at: f.clock.now() } }))));
  f.hub["running"] = false;
  const sent: string[] = [];
  f.api.sendFiles = async (_chat, _topic, files) => { for (const file of files) sent.push(readFileSync(file.path, "utf8")); return undefined; };
  const resumed = f.track(new Hub(f.options));
  resumed["running"] = true;
  must(resumed["execs"]).restore();
  await resumed["machineOutbox"].flush(f.api);
  expect(sent).toEqual([full]);
  // A later restore of the same record neither copies nor sends the log again.
  must(resumed["execs"]).restore();
  await resumed["machineOutbox"].flush(f.api);
  expect(sent).toHaveLength(1);
  expect(existsSync(join(f.dir, "files", "rig", `${must(records[0]).id}.log`))).toBe(false);
  resumed["running"] = false;
});

// A message sent at clock time 0 that the hub meets only after the /bash age limit.
const OLD_MESSAGE = { date: 0 };

test("a stale rig command is not run: its card waits for a button press", async () => {
  const f = fixture();
  await f.clock.advance(EXEC_MAX_AGE_MS + 1);
  await f.hub["handleUpdate"](f.api, topicMsg({ chatId: GROUP, fromId: USER, text: "/rig update", extra: OLD_MESSAGE }));
  await settled(f.hub);
  expect(f.spawned).toEqual([]);
  expect(must(f.hub["execs"])["recs"].map(rec => rec.state)).toEqual(["pending"]);
  await f.hub["machineOutbox"].flush(f.api);
  expect(f.texts.some(message => message.text.includes("rig update"))).toBe(true);
});

test("a stale disable confirmation button does not start rig", async () => {
  const f = fixture();
  await f.hub["handleUpdate"](f.api, topicMsg({ chatId: GROUP, fromId: USER, text: "/feature telegram disable", extra: OLD_MESSAGE }));
  await settled(f.hub);
  const key = must([...f.hub["disableConfirmations"].keys()][0]);
  await f.clock.advance(EXEC_MAX_AGE_MS + 1);
  await f.hub["handleUpdate"](f.api, buttonPress({ chatId: GROUP, fromId: USER, messageId: 1, data: `rig-disable:${key}` }));
  expect(f.answers.at(-1)).toContain(en.rigConfirmOutdated);
  expect(f.spawned).toEqual([]);
  expect(f.hub["disableConfirmations"].size).toBe(0);
  expect(f.hub["machineOutbox"].confirmations()).toEqual([]);
  expect(f.texts.some(message => message.text.includes("rig feature telegram enable"))).toBe(false);
});

test("a fresh disable confirmation press starts rig", async () => {
  const f = fixture();
  await f.update("/feature telegram disable");
  const key = must([...f.hub["disableConfirmations"].keys()][0]);
  await f.hub["handleUpdate"](f.api, buttonPress({ chatId: GROUP, fromId: USER, messageId: 1, data: `rig-disable:${key}` }));
  expect(f.spawned).toHaveLength(1);
});

test("the run button of a disabled /pwsh asks the feature state again at the press", async () => {
  const f = fixture({ platform: platformFor("win32") });
  const features = (enabled: boolean): RigOutput => ({ code: 0, stderr: "",
    stdout: JSON.stringify([{ name: "pwsh", description: "PowerShell", enabled, platformAllowed: true }]) });
  f.output(features(true));
  await f.hub["rig"].refresh();
  await f.clock.advance(EXEC_MAX_AGE_MS + 1);
  await f.hub["handleUpdate"](f.api, topicMsg({ chatId: GROUP, fromId: USER, threadId: TOPIC, text: "/pwsh echo invented", extra: OLD_MESSAGE }));
  const pending = must(must(f.hub["execs"])["recs"][0]);
  expect(pending.state).toBe("pending");
  f.output(features(false));
  await f.hub["rig"].refresh();
  const press = () => f.hub["handleUpdate"](f.api, buttonPress({ chatId: GROUP, fromId: USER, messageId: 1, data: `x:${pending.id}:run` }));
  await press();
  expect(f.answers.at(-1)).toContain("/feature pwsh enable");
  expect(f.spawned).toEqual([]);
  expect(pending.state).toBe("pending");
  f.output(features(true));
  await f.hub["rig"].refresh();
  await press();
  expect(f.spawned).toHaveLength(1);
});

test("pruning old exec records cannot repeat an already handled machine command", async () => {
  const f = fixture();
  await f.update("/rig update");
  const original = must(must(f.hub["execs"])["recs"][0]);
  writeFileSync(must(f.options.execsFile), "[]");
  const resumed = f.track(new Hub(f.options));
  resumed["launchRig"](["update"], { message_id: original.messageId }, { chatId: GROUP });
  expect(f.spawned).toHaveLength(1);
});
