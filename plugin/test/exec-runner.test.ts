import type { ExecShell } from "../src/hub/exec-shell.ts";
import type { RunnerSpec } from "../src/hub/exec-runner.ts";

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { exitInfoSchema, isAlive, killTree, spawnRunner } from "../src/hub/exec-runner.ts";
import { findPowershell, shellRun, writeShellFiles } from "../src/hub/exec-shell.ts";
import { tempDir, waitFor } from "./helpers.ts";

const EXIT_WAIT_MS = 5000;
const PING_WAIT_MS = 15_000;
// A test runner's heartbeat period, and a wait of several of them.
const TEST_HEARTBEAT_MS = 100;
const BEATS_MS = 600;
// How long a stopped command's log must stay as it is: over two ping lines.
const QUIET_MS = 2500;

let dirs: string[] = [];
let pids: number[] = [];

afterEach(() => {
  // A failed test may leave its runner and command running.
  for (const pid of pids) if (isAlive(pid)) killTree(pid);
  pids = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function hubEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return { ...env, ...extra };
}

// A spec file for the text in a shell, in a fresh temp folder.
function shellSpec(shell: ExecShell, text: string): { file: string; spec: RunnerSpec } {
  const dir = tempDir("tghub-runner-");
  dirs.push(dir);
  const run = shellRun(shell, text, dir, "abcd1234", { powershell: findPowershell(), bash: "" });
  writeShellFiles(run);
  const spec: RunnerSpec = {
    argv: run.argv,
    verbatim: run.verbatim,
    cwd: dir,
    env: hubEnv(run.env),
    log: join(dir, "abcd1234.log"),
    exit: join(dir, "abcd1234.exit.json"),
    alive: join(dir, "abcd1234.alive"),
    heartbeatMs: TEST_HEARTBEAT_MS,
  };
  const file = join(dir, "abcd1234.spec.json");
  writeFileSync(file, JSON.stringify(spec));
  return { file, spec };
}

const cmdSpec = (text: string) => shellSpec("cmd", text);

function start(file: string): number {
  const pid = spawnRunner(file);
  pids.push(pid);
  return pid;
}

const readExit = (path: string) => exitInfoSchema.parse(JSON.parse(readFileSync(path, "utf8")));
const sizeOf = (path: string) => (existsSync(path) ? statSync(path).size : 0);
const textOf = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");

describe("exec runner", () => {
  test("the runner logs the output and writes the exit code", async () => {
    const { file, spec } = cmdSpec("echo один && echo два 1>&2 && exit /b 5");
    expect(start(file)).toBeGreaterThan(0);
    await waitFor(() => existsSync(spec.exit), EXIT_WAIT_MS, "exit file");
    expect(readExit(spec.exit).code).toBe(5);
    const log = readFileSync(spec.log, "utf8");
    expect(log).toContain("один");
    expect(log).toContain("два");
  });

  test("a command that cannot start leaves an error exit", async () => {
    const { file, spec } = cmdSpec("rem");
    writeFileSync(file, JSON.stringify({ ...spec, argv: ["нет-такой-программы.exe"], verbatim: false }));
    start(file);
    await waitFor(() => existsSync(spec.exit), EXIT_WAIT_MS, "exit file");
    const info = readExit(spec.exit);
    expect(info.code).toBeNull();
    expect(info.error).toBeTruthy();
    expect(readFileSync(spec.log, "utf8")).toContain("не запустилось");
  });

  test("a runner that cannot start throws instead of giving a pid", () => {
    const { file } = cmdSpec("rem");
    expect(() => spawnRunner(file, join(dirs[0] ?? "", "нет-такого-bun.exe"))).toThrow();
  });

  test("the runner outlives a killed parent", async () => {
    const { file, spec } = cmdSpec("ping -n 3 127.0.0.1 >nul");
    const parent = join(tempDir("tghub-parent-"), "parent.ts");
    dirs.push(join(parent, ".."));
    const runner = join(import.meta.dir, "..", "src", "hub", "exec-runner.ts").replaceAll("\\", "/");
    writeFileSync(parent, `import { spawnRunner } from "${runner}";\nspawnRunner(${JSON.stringify(file)});\nprocess.exit(0);\n`);
    const p = Bun.spawn([process.execPath, parent], { stdio: ["ignore", "ignore", "ignore"] });
    expect(await p.exited).toBe(0);
    expect(existsSync(spec.exit)).toBe(false);
    await waitFor(() => existsSync(spec.exit), PING_WAIT_MS, "exit file");
    expect(readExit(spec.exit).code).toBe(0);
  }, PING_WAIT_MS + EXIT_WAIT_MS);

  test("the runner beats while the command runs and exits after it", async () => {
    const { file, spec } = cmdSpec("ping -n 3 127.0.0.1 >nul");
    const pid = start(file);
    await waitFor(() => existsSync(spec.alive), EXIT_WAIT_MS, "heartbeat file");
    const first = statSync(spec.alive).mtimeMs;
    await Bun.sleep(BEATS_MS);
    expect(statSync(spec.alive).mtimeMs).toBeGreaterThan(first);
    await waitFor(() => existsSync(spec.exit), PING_WAIT_MS, "exit file");
    await waitFor(() => !isAlive(pid), EXIT_WAIT_MS, "runner gone");
  }, PING_WAIT_MS + 2 * EXIT_WAIT_MS);

  test("killTree stops the shell's child too", async () => {
    const pidDir = tempDir("tghub-ping-");
    dirs.push(pidDir);
    const pidFile = join(pidDir, "ping.pid");
    // The shell's child tells its pid: the log alone would stop growing with
    // the runner gone even if the child lived on.
    const { file, spec } = shellSpec(
      "powershell",
      `$p = Start-Process ping -ArgumentList '-n','30','127.0.0.1' -PassThru -NoNewWindow\nSet-Content -Path '${pidFile}' -Value $p.Id\n$p.WaitForExit()`,
    );
    const pid = start(file);
    const ping = Number(await waitFor(() => textOf(pidFile).trim(), PING_WAIT_MS, "the ping's pid"));
    pids.push(ping);
    expect(isAlive(ping)).toBe(true);
    killTree(pid);
    await waitFor(() => !isAlive(pid), EXIT_WAIT_MS, "runner gone");
    await waitFor(() => !isAlive(ping), EXIT_WAIT_MS, "ping gone");
    const size = sizeOf(spec.log);
    await Bun.sleep(QUIET_MS);
    expect(sizeOf(spec.log)).toBe(size);
    expect(existsSync(spec.exit)).toBe(false);
  }, PING_WAIT_MS + 2 * EXIT_WAIT_MS + QUIET_MS);

  test("PowerShell Cyrillic reaches the log through the runner", async () => {
    const { file, spec } = shellSpec("powershell", "echo привет; cmd /c echo мир");
    start(file);
    await waitFor(() => existsSync(spec.exit), PING_WAIT_MS, "exit file");
    expect(readExit(spec.exit).code).toBe(0);
    const log = readFileSync(spec.log, "utf8");
    expect(log).toContain("привет");
    expect(log).toContain("мир");
  }, PING_WAIT_MS);
});
