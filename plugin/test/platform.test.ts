import type { Message } from "../src/hub/telegram.ts";

import { afterEach, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { Hub } from "../src/hub/hub.ts";
import { defaultTurnEndChime, playChime } from "../src/shared/chime.ts";
import { platformFor } from "../src/shared/platform.ts";
import { playConfiguredChime } from "../src/plugin/plugin.ts";
import { memLogger, tempDir } from "./helpers.ts";

// Synthetic Telegram identifiers; no network or running hub is needed.
const CHAT = 100;
const USER = 200;
const MESSAGE = 300;
const dirs: string[] = [];

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("platform values keep Windows defaults and select Linux bash", () => {
  const windows = platformFor("win32");
  const linux = platformFor("linux");
  expect(windows.bash).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
  expect(windows.shellNames.bash).toBe("Git Bash");
  expect(windows.sound).toBe(true);
  expect(linux.bash).toBe("bash");
  expect(linux.shellNames.bash).toBe("bash");
  expect(linux.sound).toBe(false);
});

test("Linux never starts or logs even an explicitly configured chime", () => {
  const linux = platformFor("linux");
  const log = memLogger();
  const ran: string[] = [];
  expect(defaultTurnEndChime(linux)).toBe("");
  playChime("broken {kind}", "done", command => { ran.push(command); }, linux);
  playConfiguredChime("ask", log, command => { ran.push(command); }, linux);
  expect(ran).toEqual([]);
  expect(log.lines).toEqual([]);
});

test("without cswap /run uses plain launch and /run 2 explains missing accounts", () => {
  const dir = tempDir();
  dirs.push(dir);
  const notices: string[] = [];
  const hub = new Hub({
    port: 0, sessionsFile: join(dir, "sessions.json"), outboxFile: join(dir, "outbox.json"),
    api: undefined, idleMs: 0,
    filesDir: join(dir, "files"), inboxDir: dir, platform: platformFor("linux"),
    accountsAvailable: () => false, config: () => ({ allowFrom: [], turnEndChime: "" }),
    log: memLogger(), onExit() {},
  });
  hub["store"].set("session", { title: "Test", project: "test", enabled: true, cwd: dir });
  hub["notice"] = (_sid, text) => { notices.push(text); };
  const message: Message = { message_id: MESSAGE, date: 0, chat: { id: CHAT, type: "supergroup", title: "Test" }, from: { id: USER, is_bot: false, first_name: "Tester" } };
  hub["onHubCommand"]("session", { name: "run", args: "2" }, message);
  expect(notices).toEqual(["На этой машине нет аккаунтов cswap. Используй /run без номера."]);
  expect(hub["launchLocation"]("session", undefined)).toEqual({ account: "", cwd: dir });
});

test("Linux shell commands stay unavailable even with no exec manager", () => {
  const dir = tempDir();
  dirs.push(dir);
  const notices: string[] = [];
  const hub = new Hub({
    port: 0, sessionsFile: join(dir, "sessions.json"), outboxFile: join(dir, "outbox.json"),
    api: undefined, idleMs: 0,
    filesDir: dir, inboxDir: dir, platform: platformFor("linux"),
    config: () => ({ allowFrom: [], turnEndChime: "" }), log: memLogger(), onExit() {},
  });
  hub["notice"] = (_sid, text) => { notices.push(text); };
  const message: Message = { message_id: MESSAGE, date: 0, chat: { id: CHAT, type: "supergroup", title: "Test" } };
  hub["onExecCommand"]("session", "pwsh", "echo hello", message);
  hub["onExecCommand"]("session", "cmd", "echo hello", message);
  expect(notices).toEqual(["/pwsh недоступна на этой платформе", "/cmd недоступна на этой платформе"]);
});
