import type { HubOptions } from "../src/hub/hub.ts";
import type { RigOutput } from "../src/hub/rig.ts";
import type { Language } from "../src/shared/i18n/index.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { runnerSpecSchema } from "../src/hub/exec-runner.ts";
import { Hub } from "../src/hub/hub.ts";
import { arr, field } from "../src/shared/guards.ts";
import { en } from "../src/shared/i18n/en.ts";
import { ru } from "../src/shared/i18n/ru.ts";
import { PROTOCOL_VERSION } from "../src/shared/protocol.ts";
import { platformFor } from "../src/shared/platform.ts";
import { FakeTelegram, topicMsg } from "./fake-telegram.ts";
import { freePort, memLogger, must, NO_PACE, offlineApi, tempDir, waitFor, wsClient } from "./helpers.ts";
import { manualClock } from "./manual-clock.ts";
import { TelegramApi } from "../src/hub/telegram.ts";

const GROUP = "-1001";
const ME = "123456789";
const STRANGER = "5678";
const SID = "session-a";
const FEATURES_JSON = "[]";
const PID = 424242;

// What a fake rig answers to a query: the language file's content, or a failure.
type FakeRig = { language: () => RigOutput; calls: string[] };

function languageOutput(language: Language): RigOutput {
  return { code: 0, stdout: JSON.stringify({ language }), stderr: "" };
}

function fakeRig(initial: RigOutput | Language): FakeRig & { set(next: RigOutput | Language): void; run(argv: string[]): RigOutput } {
  let current = initial;
  const calls: string[] = [];
  const asOutput = (value: RigOutput | Language): RigOutput => typeof value === "string" ? languageOutput(value) : value;
  return {
    calls,
    language: () => asOutput(current),
    set: next => { current = next; },
    run: argv => {
      const line = argv.join(" ");
      calls.push(line);
      return line.includes("language --json") ? asOutput(current) : { code: 0, stdout: FEATURES_JSON, stderr: "" };
    },
  };
}

function languageQueries(rig: FakeRig): number {
  return rig.calls.filter(call => call.includes("language --json")).length;
}

function featureQueries(rig: FakeRig): number {
  return rig.calls.filter(call => call.includes("feature --json")).length;
}

let fake: FakeTelegram;
let hub: Hub | undefined;
let dir: string;
const clients: { close(): void }[] = [];

beforeEach(() => {
  fake = new FakeTelegram();
  dir = tempDir();
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await hub?.stop();
  hub = undefined;
  fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function startHub(rig: FakeRig & { run(argv: string[]): RigOutput }, options: { findRig?: () => string | undefined; rigDir?: string } = {}) {
  const port = await freePort();
  hub = new Hub({
    platform: platformFor("linux"), accountsAvailable: () => true, port,
    sessionsFile: join(dir, "sessions.json"), outboxFile: join(dir, "outbox.json"), spoolDir: join(dir, "spool"), spoolScanMs: 50,
    filesDir: join(dir, "outbox-files"), inboxDir: join(dir, "inbox"), execDir: join(dir, "exec"), execsFile: join(dir, "execs.json"),
    api: new TelegramApi({ token: fake.token, base: fake.url, baseDelayMs: 1, maxAttempts: 2, attemptTimeoutMs: 300, sendAttemptTimeoutMs: 300, networkRetryMs: 5, deadlineMs: 500, groupPace: NO_PACE }),
    config: () => ({ groupId: GROUP, allowFrom: [ME], turnEndChime: "" }),
    idleMs: 60_000, pollTimeoutSec: 1, pollRetryBaseMs: 10, sendRetryBaseMs: 10, sendRetryMaxMs: 50,
    defaultConfigDir: "/profile", defaultAccount: async () => undefined,
    findRig: options.findRig ?? (() => "/fake/rig"), runRig: async invocation => rig.run(invocation.argv),
    ...(options.rigDir ? { rigDir: options.rigDir, hubCommit: () => "invented-commit", repository: dir } : {}),
    log: memLogger(), onExit: () => {},
  });
  expect(hub.start()).toBe(true);
  return { hub, port };
}

async function connect(port: number) {
  const client = await wsClient(port, { type: "hello", v: PROTOCOL_VERSION, windowKey: `win-${SID}`, sessionId: SID, cwd: dir, reportsSeen: true });
  clients.push(client);
  await client.next("state");
  return client;
}

// The descriptions the hub last put into the bot menu.
function menuDescriptions(): Record<string, string> {
  const calls = fake.callsOf("setMyCommands");
  const last = calls.at(-1);
  const result: Record<string, string> = {};
  if (!last) return result;
  for (const entry of arr(last.commands)) result[String(field(entry, "command"))] = String(field(entry, "description"));
  return result;
}

describe("language at start", () => {
  test("English, and a plugin told so on connect, when rig answers English", async () => {
    const rig = fakeRig("en");
    const { port } = await startHub(rig);
    const client = await connect(port);
    expect((await client.next("language")).language).toBe("en");
    const first = await waitFor(() => fake.callsOf("setMyCommands")[0]);
    expect(first).toBeDefined();
    expect(menuDescriptions().rig).toBe(en.commandRig);
  });

  test("English when rig is missing", async () => {
    const rig = fakeRig("ru");
    const { port } = await startHub(rig, { findRig: () => undefined });
    const client = await connect(port);
    expect((await client.next("language")).language).toBe("en");
    expect(rig.calls).toEqual([]);
  });

  test("English when rig fails or prints bad JSON", async () => {
    for (const output of [{ code: 1, stdout: "", stderr: "broken" }, { code: 0, stdout: "not json", stderr: "" }, { code: 0, stdout: JSON.stringify({ language: "de" }), stderr: "" }]) {
      const rig = fakeRig(output);
      const { port } = await startHub(rig);
      const client = await connect(port);
      expect((await client.next("language")).language).toBe("en");
      client.close();
      await hub?.stop();
    }
  });

  test("Russian, in the plugin message and the bot menu, when rig answers ru", async () => {
    const rig = fakeRig("ru");
    const { port } = await startHub(rig);
    await waitFor(() => fake.callsOf("setMyCommands").length > 0);
    const client = await connect(port);
    expect((await client.next("language")).language).toBe("ru");
    await waitFor(() => menuDescriptions().rig === ru.commandRig);
    // The wait above would pass vacuously if both catalogs said the same.
    expect(ru.commandRig).not.toBe(en.commandRig);
  });
});

describe("language change", () => {
  test("a connected plugin gets the new language, the features are read again and the menu changes", async () => {
    const rig = fakeRig("en");
    const { port, hub: running } = await startHub(rig);
    const client = await connect(port);
    expect((await client.next("language")).language).toBe("en");
    await waitFor(() => menuDescriptions().rig === en.commandRig);
    const featuresBefore = featureQueries(rig);
    rig.set("ru");
    await running["onLanguageChanged"]();
    expect((await client.next("language", message => message.language === "ru")).language).toBe("ru");
    expect(featureQueries(rig)).toBeGreaterThan(featuresBefore);
    await waitFor(() => menuDescriptions().rig === ru.commandRig);
  });

  test("a language-changed event in rig's event file does the same, several events cause one re-read", async () => {
    const rigDir = join(dir, "rig");
    mkdirSync(rigDir, { recursive: true });
    const rig = fakeRig("en");
    const { port, hub: running } = await startHub(rig, { rigDir });
    const client = await connect(port);
    await client.next("language");
    await waitFor(() => running["botReady"]);
    await waitFor(() => running["machineQueries"] === 0);
    const queriesBefore = languageQueries(rig);
    rig.set("ru");
    const event = (id: string) => JSON.stringify({ id, time: "2026-01-01T00:00:00Z", type: "language-changed", text: "invented notice", level: "info" }) + "\n";
    writeFileSync(join(rigDir, "events.jsonl"), event("a") + event("b") + event("c"));
    await must(running["rigEvents"]).poll();
    expect((await client.next("language", message => message.language === "ru")).language).toBe("ru");
    expect(languageQueries(rig) - queriesBefore).toBe(1);
    await waitFor(() => menuDescriptions().rig === ru.commandRig);
  });

  test("an unchanged language sends nothing to the plugin", async () => {
    const rig = fakeRig("en");
    const { port, hub: running } = await startHub(rig);
    const client = await connect(port);
    await client.next("language");
    const before = client.messages.filter(message => message.type === "language").length;
    await running["onLanguageChanged"]();
    // A real change afterwards is the barrier: messages arrive in order, so once it is here, a message the unchanged call sent would be too.
    rig.set("ru");
    await running["onLanguageChanged"]();
    await client.next("language", message => message.language === "ru");
    expect(client.messages.filter(message => message.type === "language")).toHaveLength(before + 1);
  });
});

const USER = "1234";
const OTHER = "5678";

// A hub with its own clock and an offline Telegram, like the rig tests.
function fixture(extra: { runRig?: HubOptions["runRig"]; setMyCommands?: TelegramApi["setMyCommands"] } = {}) {
  const root = tempDir();
  const clock = manualClock();
  const api = offlineApi();
  const texts: string[] = [];
  const spawned: string[] = [];
  api.sendMessage = async (_chat, _topic, text) => { texts.push(text); return { message_id: texts.length }; };
  api.editMessageText = async (_chat, _id, text) => { texts.push(text); };
  api.setMyCommands = extra.setMyCommands ?? (async () => true);
  api.answerCallbackQuery = async () => {};
  api.removeKeyboard = async () => true;
  const options: HubOptions = {
    port: 0, api, idleMs: 0, sessionsFile: join(root, "sessions.json"), outboxFile: join(root, "outbox.json"),
    execDir: join(root, "exec"), execsFile: join(root, "execs.json"), filesDir: join(root, "files"), inboxDir: root,
    repository: root, findRig: () => "/fake/rig", runRig: extra.runRig ?? (async () => ({ code: 0, stdout: FEATURES_JSON, stderr: "" })),
    execEnv: () => ({}), config: () => ({ groupId: GROUP, allowFrom: [USER], turnEndChime: "" }),
    spawnRunner: file => {
      spawned.push(file);
      const spec = runnerSpecSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      writeFileSync(spec.log, "Language is now invented\n");
      return PID;
    },
    now: clock.now, setTimer: clock.set, clearTimer: clock.clear, sleep: clock.sleep, isAlive: () => true,
    log: memLogger(), onExit() {},
  };
  const machine = new Hub(options);
  machine["running"] = true;
  const update = async (text: string, from: string) => {
    await machine["handleUpdate"](api, topicMsg({ chatId: GROUP, fromId: from, text }));
    while (machine["machineTasks"].size) await Promise.all([...machine["machineTasks"]]);
  };
  const stop = () => {
    machine["running"] = false;
    machine["clearTimer"](machine["rigTimer"]);
    machine["execs"]?.stop();
    clock.dispose();
    rmSync(root, { recursive: true, force: true });
  };
  return { machine, api, texts, spawned, update, stop };
}

function languageDeferred() {
  const waiting: ((output: RigOutput) => void)[] = [];
  const run: NonNullable<HubOptions["runRig"]> = invocation => invocation.argv.join(" ").includes("language --json")
    ? new Promise<RigOutput>(resolve => { waiting.push(resolve); })
    : Promise.resolve({ code: 0, stdout: FEATURES_JSON, stderr: "" });
  return { run, waiting };
}

describe("language reads and the bot menu", () => {
  test("an older language read never overwrites a newer one", async () => {
    const gate = languageDeferred();
    const f = fixture({ runRig: gate.run });
    try {
      const older = f.machine["readLanguage"]();
      const newer = f.machine["readLanguage"]();
      await waitFor(() => gate.waiting.length === 2);
      gate.waiting[1]?.(languageOutput("ru"));
      await newer;
      expect(f.machine["lang"]).toBe("ru");
      gate.waiting[0]?.(languageOutput("en"));
      await older;
      expect(f.machine["lang"]).toBe("ru");
    } finally { f.stop(); }
  });

  test("reads that answer in order each apply", async () => {
    const gate = languageDeferred();
    const f = fixture({ runRig: gate.run });
    try {
      const first = f.machine["readLanguage"]();
      await waitFor(() => gate.waiting.length === 1);
      gate.waiting[0]?.(languageOutput("ru"));
      await first;
      const second = f.machine["readLanguage"]();
      await waitFor(() => gate.waiting.length === 2);
      gate.waiting[1]?.(languageOutput("en"));
      await second;
      expect(f.machine["lang"]).toBe("en");
    } finally { f.stop(); }
  });

  test("a language change during a menu registration ends with the menu in the new language, without a later tick", async () => {
    const registered: string[][] = [];
    const releases: (() => void)[] = [];
    const f = fixture({ setMyCommands: commands => {
      registered.push(commands.map(c => c.description));
      return new Promise<true>(resolve => { releases.push(() => resolve(true)); });
    } });
    try {
      const first = f.machine["registerCommands"](f.api);
      await waitFor(() => releases.length === 1);
      f.machine["lang"] = "ru";
      const second = f.machine["registerCommands"](f.api);
      releases[0]?.();
      await waitFor(() => releases.length === 2);
      releases[1]?.();
      await Promise.all([first, second]);
      expect(registered).toHaveLength(2);
      expect(registered[0]).toContain(en.commandRig);
      expect(registered[1]).toContain(ru.commandRig);
      // Nothing is left to register: the same menu is not sent again.
      await f.machine["registerCommands"](f.api);
      expect(registered).toHaveLength(2);
    } finally { f.stop(); }
  });
});

describe("the language for the plugin's module", () => {
  test("GET /language answers the language the hub has now", async () => {
    const f = fixture();
    try {
      expect(f.machine.start()).toBe(true);
      const port = f.machine["server"]?.port;
      const ask = async () => (await fetch(`http://127.0.0.1:${port}/language`)).json();
      expect(await ask()).toEqual({ language: "en" });
      f.machine["lang"] = "ru";
      expect(await ask()).toEqual({ language: "ru" });
    } finally {
      f.machine["server"]?.stop(true);
      f.stop();
    }
  });
});

describe("rig errors in Telegram follow the language", () => {
  test("a failing /rig status is answered in the current language, at the time of the answer", async () => {
    for (const [language, catalog] of [["en", en], ["ru", ru]] as const) {
      const f = fixture({ runRig: async () => ({ code: 5, stdout: "", stderr: "invented failure" }) });
      try {
        f.machine["lang"] = language;
        await f.update("/rig status", USER);
        await f.machine["machineOutbox"].flush(f.api);
        expect(f.texts).toContain(catalog.rigExitCode({ code: 5, output: "invented failure" }));
      } finally { f.stop(); }
    }
  });

  test("a missing rig is answered in the current language for a mutating command", async () => {
    const f = fixture();
    try {
      f.machine["lang"] = "ru";
      f.machine["rig"]["deps"].find = () => undefined;
      await f.update("/rig update", USER);
      await f.machine["machineOutbox"].flush(f.api);
      expect(f.texts).toContain(ru.rigMissing);
    } finally { f.stop(); }
  });
});

// The command path, with the hub's own clock and an offline Telegram, like the rig tests.
describe("/rig language", () => {
  async function spec(file: string | undefined) {
    return runnerSpecSchema.parse(JSON.parse(readFileSync(must(file), "utf8")));
  }

  test("an allowed user runs rig with the language and sees its output", async () => {
    const f = fixture();
    try {
      await f.update("/rig language ru", USER);
      expect(f.spawned).toHaveLength(1);
      expect((await spec(f.spawned[0])).argv.join(" ")).toContain("language ru");
      must(f.machine["execs"])["check"]();
      await f.machine["machineOutbox"].flush(f.api);
      expect(f.texts.some(text => text.includes("Language is now invented"))).toBe(true);
    } finally { f.stop(); }
  });

  test("without an argument it shows the language", async () => {
    const f = fixture();
    try {
      await f.update("/rig language", USER);
      expect(f.spawned).toHaveLength(1);
      const command = (await spec(f.spawned[0])).argv.join(" ");
      expect(command).toContain("language");
      expect(command).not.toContain("language ru");
      expect(command).not.toContain("language en");
    } finally { f.stop(); }
  });

  test("an unknown language gets the usage reply and runs nothing", async () => {
    const f = fixture();
    try {
      await f.update("/rig language de", USER);
      expect(f.spawned).toEqual([]);
      await f.machine["machineOutbox"].flush(f.api);
      expect(f.texts.some(text => text.includes(en.rigUsage))).toBe(true);
    } finally { f.stop(); }
  });

  test("a user outside allowFrom is ignored", async () => {
    const f = fixture();
    try {
      await f.update("/rig language ru", OTHER);
      await f.update("/rig language ru", STRANGER);
      expect(f.spawned).toEqual([]);
      expect(f.texts).toEqual([]);
    } finally { f.stop(); }
  });
});

