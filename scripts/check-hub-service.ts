// Real user-systemd integration in a disposable Docker container, driven by OS/API events.
// Run through test-systemd.sh; it supplies the contract's 5-minute external deadline.
import { strict as assert } from "assert";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, watch, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { z } from "zod";
import { HubClient, spawnHubDetached } from "../plugin/src/plugin/hub-client.ts";
import { field } from "../plugin/src/shared/guards.ts";
import { nullLogger } from "../plugin/src/shared/log.ts";
import { DEFAULT_PORT, PROTOCOL_VERSION } from "../plugin/src/shared/protocol.ts";

// Synthetic identities, isolated container only.
const GROUP = -1001;
const USER = 1234;
const REPO = resolve(import.meta.dir, "..");
const SESSION = "11111111-2222-3333-4444-555555555555";
// The stand-in window's session is not in the hub's sessions.json, so no topic traffic is routed to it.
const WINDOW_SESSION = "66666666-7777-8888-9999-000000000000";
const TOPIC = 12;
// Callback data prefix of the hub's rig disable confirmation button (plugin/src/hub/hub.ts).
const CONFIRM_PREFIX = "rig-disable:";
const MS_PER_SECOND = 1000;
// The value of the fake rig's `status --json` (scripts/rig-service-process.ts); the hub shows it as the expected restart.
const PENDING_RESTART = "2026-01-01T00:00:00.000Z";
// The window's reconnect delay; short, because the check waits for attempts, not for time.
const WINDOW_RECONNECT_MS = 50;
const WINDOW_POLL_MS = 50;
// Failed connection attempts a window must make against a stopped hub before the check calls it patient.
const FAILED_ATTEMPTS = 3;
const SMOKE_COMMIT_IDENTITY = ["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "-c", "commit.gpgsign=false"];
// Kills after the first one; the first plus these exceed systemd's default start limit of 5 starts per 10 s.
const EXTRA_KILLS = 6;
// State column of /proc/net/tcp for a listening socket.
const TCP_LISTEN = "0A";
// How often the port is sampled during the restart.
const PORT_SAMPLE_MS = 5;
const childSchema = z.object({ pid: z.number(), port: z.number().optional() });
const buttonSchema = z.object({ inline_keyboard: z.array(z.array(z.object({ callback_data: z.string() }))) });

if (!existsSync("/.dockerenv") || process.env.TELEGRAM_HUB_CONTAINER_TEST !== "1") {
  console.error("Run only inside the disposable systemd test container");
  process.exit(1);
}

async function command(argv: string[], extraEnv: Record<string, string> = {}) {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", cwd: REPO, env: { ...process.env, ...extraEnv } });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}
async function checked(argv: string[], extraEnv: Record<string, string> = {}) {
  const result = await command(argv, extraEnv);
  assert.equal(result.code, 0, `${argv[0]}: ${result.stderr}`);
  return result.stdout.trim();
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const root = mkdtempSync(join(tmpdir(), "telegram-hub-systemd-"));
const state = join(root, "state");
// Where the fake rig and the hub meet in the container: the hub reads events from here and writes its readiness here.
const rigDir = join(homedir(), ".agent-rig");
process.once("exit", () => { rmSync(root, { recursive: true, force: true }); });
const dropin = join(homedir(), ".config", "systemd", "user", "telegram-hub.service.d", "smoke.conf");
const calls: { method: string; params: unknown }[] = [];
const watchers = new Set<() => void>();
const updates: object[] = [];
const pollers = new Set<() => void>();
let updateId = 0;
let messageId = 0;
const push = (update: object) => { updates.push({ ...update, update_id: ++updateId }); for (const wake of pollers) wake(); };
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
  const method = new URL(request.url).pathname.split("/").at(-1) ?? "";
  const params: unknown = await request.json();
  calls.push({ method, params });
  for (const check of watchers) check();
  let result: unknown = true;
  if (method === "getMe") result = { id: 1, username: "fixture_bot" };
  else if (method === "getUpdates") {
    if (!updates.length) await new Promise<void>(resolvePoll => {
      const wake = () => { pollers.delete(wake); request.signal.removeEventListener("abort", wake); resolvePoll(); };
      pollers.add(wake);
      request.signal.addEventListener("abort", wake, { once: true });
      if (updates.length || request.signal.aborted) wake();
    });
    result = updates.splice(0);
  } else if (method === "sendMessage") result = { message_id: ++messageId };
  return Response.json({ ok: true, result });
} });

function until(predicate: () => boolean): Promise<void> {
  return new Promise(resolveWait => {
    const check = () => { if (predicate()) { watchers.delete(check); resolveWait(); } };
    watchers.add(check);
    check();
  });
}
function file(path: string): Promise<void> {
  return new Promise(resolveFile => {
    const watcher = watch(dirname(path), check);
    function check() { if (existsSync(path) && readFileSync(path, "utf8")) { watcher.close(); resolveFile(); } }
    check();
  });
}
function send(text: string) {
  push({ message: { message_id: ++messageId, date: Math.floor(Date.now() / MS_PER_SECOND), chat: { id: GROUP, type: "supergroup", title: "Fixture" },
    from: { id: USER, is_bot: false, first_name: "Fixture" }, message_thread_id: TOPIC, is_topic_message: true, text } });
}
const children: number[] = [];
const results: string[] = [];
let cleaning = false;
// A stand-in for a Claude Code window: the real plugin client with the real marker check, counting what it would start.
let hubWindow: HubClient | undefined;
let createdGit = false;
const windowStats = { attempts: 0, spawns: 0 };
function openWindow(env: Record<string, string>, hubMain: string): HubClient {
  const client = new HubClient({
    port: DEFAULT_PORT,
    hello: () => ({ type: "hello", v: PROTOCOL_VERSION, windowKey: "smoke-window", sessionId: WINDOW_SESSION, cwd: REPO }),
    // The client asks this once per failed connection attempt, which makes it the attempt counter.
    serviceManaged: () => { windowStats.attempts++; return existsSync(join(state, "service-managed")); },
    spawnHub: () => { windowStats.spawns++; spawnHubDetached(hubMain, env); },
    onMessage: () => {},
    log: nullLogger,
    minDelayMs: WINDOW_RECONNECT_MS,
    maxDelayMs: WINDOW_RECONNECT_MS,
  });
  client.start();
  return client;
}
function eventually(predicate: () => boolean | Promise<boolean>): Promise<void> {
  return new Promise(resolveWait => {
    const timer = setInterval(() => {
      void Promise.resolve(predicate()).then(done => { if (done) { clearInterval(timer); resolveWait(); } });
    }, WINDOW_POLL_MS);
  });
}
const show = (property: string) => checked(["systemctl", "--user", "show", "telegram-hub.service", "-p", property, "--value"]);
// Reads one /proc file; undefined when the process is gone.
function procFile(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); } catch { return undefined; }
}
function parentOf(pid: number): number | undefined {
  const stat = procFile(`/proc/${pid}/stat`);
  // The fields after the "(comm)" part: state, then ppid.
  const fields = stat?.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ppid = Number(fields?.[1]);
  return fields && Number.isInteger(ppid) ? ppid : undefined;
}
// The pid listening on the hub port, from /proc alone (no ss in the image); undefined when nobody listens.
function listenerPid(port: number): number | undefined {
  const inodes = new Set<string>();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    for (const line of (procFile(table) ?? "").split("\n").slice(1)) {
      const cells = line.trim().split(/\s+/);
      if (cells[3] === TCP_LISTEN && Number.parseInt(cells[1]?.split(":")[1] ?? "", 16) === port && cells[9]) inodes.add(cells[9]);
    }
  }
  if (!inodes.size) return undefined;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let fds: string[];
    try { fds = readdirSync(`/proc/${entry}/fd`); } catch { continue; }
    for (const fd of fds) {
      let target: string;
      try { target = readlinkSync(`/proc/${entry}/fd/${fd}`); } catch { continue; }
      const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
      if (inode && inodes.has(inode)) return Number(entry);
    }
  }
  return undefined;
}
const readyCommit = () => z.object({ commit: z.string() }).parse(JSON.parse(readFileSync(join(rigDir, "hub-ready.json"), "utf8"))).commit;
async function cleanup() {
  if (cleaning) return;
  cleaning = true;
  hubWindow?.stop();
  if (createdGit) rmSync(join(REPO, ".git"), { recursive: true, force: true });
  await command(["bash", "scripts/uninstall-hub-service.sh"], { TELEGRAM_HUB_STATE_DIR: state });
  for (const pid of children) { try { process.kill(pid, "SIGKILL"); } catch {} }
  await command(["tmux", "kill-session", "-t", "telegram-hub-smoke"]);
  rmSync(dropin, { force: true });
  rmSync(rigDir, { recursive: true, force: true });
  await command(["systemctl", "--user", "daemon-reload"]);
  for (const wake of pollers) wake();
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
// The outer deadline sends SIGTERM: print what passed and the last Bot API traffic so a stall is diagnosable.
const TRACE_CALLS = 8;
const TRACE_CHARS = 300;
process.once("SIGTERM", () => {
  console.log("TIMEOUT after:", JSON.stringify(results));
  for (const call of calls.slice(-TRACE_CALLS)) console.log("last call:", call.method, JSON.stringify(call.params).slice(0, TRACE_CHARS));
  void cleanup().then(() => process.exit(1));
});

try {
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(state);
  // The image has no .git (see .dockerignore), yet the hub's restart decision compares git commits.
  if (!existsSync(join(REPO, ".git"))) {
    await checked(["git", "init", "--quiet"]);
    createdGit = true;
  }
  await checked(["git", ...SMOKE_COMMIT_IDENTITY, "commit", "--quiet", "--allow-empty", "-m", "smoke base"]);
  // The hub writes hub-ready.json only into an existing rig directory.
  mkdirSync(rigDir, { recursive: true });
  writeFileSync(join(bin, "rig"), `#!/usr/bin/env bash\nexec ${quote(process.execPath)} ${quote(join(REPO, "scripts", "rig-service-process.ts"))} rig "$@"\n`, { mode: 0o755 });
  writeFileSync(join(state, "config.json"), JSON.stringify({ groupId: String(GROUP), allowFrom: [String(USER)] }));
  writeFileSync(join(state, "sessions.json"), JSON.stringify({ [SESSION]: { topicId: TOPIC, title: "Fixture", project: "fixture", cwd: REPO, enabled: true } }));
  const env = { TELEGRAM_HUB_CONTAINER_TEST: "1", RIG_SMOKE_DIR: root, TELEGRAM_HUB_STATE_DIR: state,
    TELEGRAM_HUB_API_BASE: `http://127.0.0.1:${server.port}`, TELEGRAM_BOT_TOKEN: "fixture-token", PATH: `${bin}:${process.env.PATH ?? ""}` };
  mkdirSync(dirname(dropin), { recursive: true });
  writeFileSync(dropin, "[Service]\n" + Object.entries(env).map(([key, value]) => `Environment=${JSON.stringify(`${key}=${value}`).replaceAll("%", "%%")}\n`).join(""));
  await checked(["bash", "scripts/install-hub-service.sh"], { TELEGRAM_HUB_STATE_DIR: state });
  assert.ok(existsSync(join(state, "service-managed")), "install leaves the service-managed marker");
  await until(() => calls.some(call => call.method === "getMe"));
  assert.equal(await checked(["loginctl", "show-user", "-p", "Linger", "--value", process.env.USER ?? "ubuntu"]), "yes");
  assert.equal(await checked(["systemctl", "--user", "show", "telegram-hub.service", "-p", "KillMode", "--value"]), "process");
  assert.equal(await checked(["systemctl", "--user", "show", "telegram-hub.service", "-p", "Restart", "--value"]), "always");
  results.push("linger, KillMode=process and Restart=always");
  // systemd reports RestartSec= as RestartUSec and StartLimitIntervalSec= as StartLimitIntervalUSec (the value in force, not the unit text).
  assert.equal(await show("RestartUSec"), "2s", "RestartSec=2 is in force");
  assert.equal(await show("StartLimitIntervalUSec"), "0", "StartLimitIntervalSec=0 is in force");
  results.push("RestartSec=2 and StartLimitIntervalSec=0 are in force");
  const oldPid = Number(await show("MainPID"));
  const previousStarts = calls.filter(call => call.method === "getMe").length;
  process.kill(oldPid, "SIGKILL");
  await until(() => calls.filter(call => call.method === "getMe").length > previousStarts);
  assert.notEqual(Number(await show("MainPID")), oldPid);
  results.push("hub restarts automatically after SIGKILL");
  // Without the start limit, kills in a row never leave the service failed.
  for (let kill = 0; kill < EXTRA_KILLS; kill++) {
    const starts = calls.filter(call => call.method === "getMe").length;
    const victim = Number(await show("MainPID"));
    process.kill(victim, "SIGKILL");
    await until(() => calls.filter(call => call.method === "getMe").length > starts);
    assert.notEqual(await show("ActiveState"), "failed", "the service is not failed after repeated kills");
  }
  assert.equal(await show("ActiveState"), "active");
  assert.ok(Number(await show("NRestarts")) >= EXTRA_KILLS + 1, "systemd restarted the hub after every kill");
  results.push(`service is active, not failed, after ${EXTRA_KILLS + 1} kills in a row`);
  // /rig status with the contract's string pendingHubRestart (the hub's schema once rejected anything but a boolean).
  send("/rig status");
  await until(() => calls.some(call => call.method === "sendMessage" && String(field(call.params, "text")).includes(PENDING_RESTART)));
  results.push("/rig status accepts a string pendingHubRestart");
  // Scenario A: a window is connected when the service hub restarts for new code; the service, not the window, brings it back.
  const hubMain = join(REPO, "plugin", "src", "hub", "main.ts");
  hubWindow = openWindow(env, hubMain);
  const client = hubWindow;
  await eventually(() => client.connected);
  await file(join(rigDir, "hub-ready.json"));
  const oldHead = await checked(["git", "rev-parse", "HEAD"]);
  assert.equal(readyCommit(), oldHead, "the service script fixed the commit it started from");
  const pidBeforeUpdate = await show("MainPID");
  // run-hub-service.sh exports the commit it fixed before bun starts; bun is the unit's main process (exec), so its environment is the hub's.
  const environOf = (pid: string) => (procFile(`/proc/${pid}/environ`) ?? "").split("\0");
  assert.ok(environOf(pidBeforeUpdate).includes(`TELEGRAM_HUB_COMMIT=${oldHead}`), "the running hub has TELEGRAM_HUB_COMMIT = HEAD of the container copy");
  const serviceManagerPid = parentOf(Number(pidBeforeUpdate));
  assert.ok(serviceManagerPid, "the hub's parent is the user service manager");
  await checked(["git", ...SMOKE_COMMIT_IDENTITY, "commit", "--quiet", "--allow-empty", "-m", "smoke update"]);
  const newHead = await checked(["git", "rev-parse", "HEAD"]);
  assert.notEqual(newHead, oldHead);
  // From here until the hub is back, every sampled listener on the hub port must belong to the service.
  const samples: { pid: number; ppid: number | undefined; cgroup: string | undefined }[] = [];
  const sampler = setInterval(() => {
    const pid = listenerPid(DEFAULT_PORT);
    if (pid !== undefined) samples.push({ pid, ppid: parentOf(pid), cgroup: procFile(`/proc/${pid}/cgroup`) });
  }, PORT_SAMPLE_MS);
  try {
    appendFileSync(join(rigDir, "events.jsonl"), JSON.stringify({ id: "smoke-1", time: new Date().toISOString(), level: "info", type: "hub-restart-pending", text: "restart" }) + "\n");
    await eventually(() => existsSync(join(rigDir, "hub-ready.json")) && readyCommit() === newHead);
    await eventually(() => client.connected);
  } finally { clearInterval(sampler); }
  const newPid = await show("MainPID");
  assert.notEqual(newPid, pidBeforeUpdate);
  assert.ok(environOf(newPid).includes(`TELEGRAM_HUB_COMMIT=${newHead}`), "the restarted hub has the new commit in TELEGRAM_HUB_COMMIT");
  assert.equal(listenerPid(DEFAULT_PORT), Number(newPid), "the listener on the hub port is the service's new MainPID");
  assert.ok(samples.some(sample => sample.pid === Number(pidBeforeUpdate)), "the port was sampled while the old hub still held it");
  assert.ok(samples.some(sample => sample.pid === Number(newPid)), "the port was sampled with the new hub");
  for (const sample of samples) {
    const owned: boolean = sample.ppid === serviceManagerPid && (sample.cgroup ?? "").includes("telegram-hub.service");
    assert.ok(owned, `listener ${sample.pid} on the hub port is a service process (parent ${sample.ppid}, cgroup ${sample.cgroup?.trim()})`);
  }
  results.push(`port held only by service processes in ${samples.length} samples during the restart; new MainPID listens`);
  assert.equal(await checked(["systemctl", "--user", "is-active", "telegram-hub.service"]), "active");
  await eventually(() => client.connected);
  assert.equal(windowStats.spawns, 0, "the window never started a hub");
  results.push("exit 75 with a connected window: the service restarts the hub on the new commit, the window reconnects and starts nothing");
  const childScript = join(REPO, "scripts", "rig-service-process.ts");
  send(`/bash ${quote(process.execPath)} ${quote(childScript)} bash ${quote(root)}`);
  await file(join(root, "child-bash.json"));
  const bashChild = childSchema.parse(JSON.parse(readFileSync(join(root, "child-bash.json"), "utf8")));
  children.push(bashChild.pid);
  send(`/bash tmux new-session -d -s telegram-hub-smoke -- ${quote(process.execPath)} ${quote(childScript)} tmux ${quote(root)}`);
  await file(join(root, "child-tmux.json"));
  const tmuxChild = childSchema.parse(JSON.parse(readFileSync(join(root, "child-tmux.json"), "utf8")));
  children.push(tmuxChild.pid);
  send("/feature telegram disable");
  // Running /bash cards carry a Stop button too; only the rig confirmation button is the one to press.
  const confirmationData = () => {
    for (const call of calls) {
      if (call.method !== "sendMessage") continue;
      const keyboard = buttonSchema.safeParse(field(call.params, "reply_markup"));
      const data = keyboard.success ? keyboard.data.inline_keyboard.flat().find(button => button.callback_data.startsWith(CONFIRM_PREFIX))?.callback_data : undefined;
      if (data) return data;
    }
    return undefined;
  };
  await until(() => confirmationData() !== undefined);
  const data = confirmationData();
  assert.ok(data);
  push({ callback_query: { id: "fixture-confirm", from: { id: USER, is_bot: false, first_name: "Fixture" }, data,
    message: { message_id: messageId, chat: { id: GROUP, type: "supergroup" } } } });
  await file(join(root, "rig-finished.json"));
  assert.ok(calls.some(call => String(field(call.params, "text")).includes("rig feature telegram enable")));
  const stopped = await command(["systemctl", "--user", "is-active", "telegram-hub.service"]);
  assert.equal(stopped.stdout.trim(), "inactive");
  process.kill(bashChild.pid, 0);
  process.kill(tmuxChild.pid, 0);
  await checked(["tmux", "has-session", "-t", "telegram-hub-smoke"]);
  results.push("tmux and /bash survive stop; detached rig finishes after stopping the hub");
  // Scenario B: the service is stopped on purpose; a connected window must not raise the hub behind its back.
  await eventually(() => !client.connected);
  const attemptsAtStop = windowStats.attempts;
  await eventually(() => windowStats.attempts >= attemptsAtStop + FAILED_ATTEMPTS);
  assert.equal(windowStats.spawns, 0, "the window did not start a hub after the service stopped");
  assert.equal(await fetch(`http://127.0.0.1:${DEFAULT_PORT}`).then(() => true, () => false), false, "nothing listens on the hub port");
  results.push("after service stop a connected window starts no hub");
  // Last on purpose: uninstalling removes the service the scenarios above need.
  // The window goes first: once the marker is gone a window starts a hub itself, which would outlive this check.
  client.stop();
  const marker = join(state, "service-managed");
  assert.ok(existsSync(marker), "the marker is still there before the uninstall");
  await checked(["bash", "scripts/uninstall-hub-service.sh"], { TELEGRAM_HUB_STATE_DIR: state });
  assert.equal(existsSync(marker), false, "uninstall removes the service-managed marker");
  assert.equal(existsSync(join(homedir(), ".config", "systemd", "user", "telegram-hub.service")), false, "uninstall removes the unit file");
  const again = await command(["bash", "scripts/uninstall-hub-service.sh"], { TELEGRAM_HUB_STATE_DIR: state });
  assert.equal(again.code, 0, `the second uninstall exits 0: ${again.stderr}`);
  assert.equal(existsSync(marker), false);
  results.push("uninstall removes the marker and the unit; a second uninstall exits 0");
} catch (error) {
  results.push(`FAIL: ${String(error)}`);
  process.exitCode = 1;
} finally {
  await cleanup();
  mkdirSync(join(REPO, "docs", "reports"), { recursive: true });
  writeFileSync(join(REPO, "docs", "reports", "systemd-smoke.json"), JSON.stringify(results, null, 2));
  for (const result of results) console.log(result);
}
