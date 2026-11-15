import type { ExecShell } from "../src/hub/exec-shell.ts";
import type { RunnerSpec } from "../src/hub/exec-runner.ts";

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { exitInfoSchema, isAlive, killTree, lineSplitter, spawnRunner } from "../src/hub/exec-runner.ts";
import { DEFAULT_BASH, findPowershell, shellRun, writeShellFiles } from "../src/hub/exec-shell.ts";
import { tempDir, waitFor } from "./helpers.ts";
import { PLATFORM } from "../src/shared/platform.ts";

const EXIT_WAIT_MS = 5000;
const PING_WAIT_MS = 15_000;
// A test runner heartbeat period.
const TEST_HEARTBEAT_MS = 100;

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
  const dir = tempDir("telegramhub-runner-");
  dirs.push(dir);
  const run = shellRun(shell, text, dir, "abcd1234", { powershell: findPowershell(), bash: DEFAULT_BASH });
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

// The same command on each system: cmd on Windows, bash elsewhere.
const hostSpec = (cmdText: string, bashText: string) => (PLATFORM.windows ? cmdSpec(cmdText) : shellSpec("bash", bashText));
// A command that takes about three seconds.
const slowSpec = () => hostSpec("ping -n 3 127.0.0.1 >nul", "sleep 3");

function start(file: string): number {
  const pid = spawnRunner(file);
  pids.push(pid);
  return pid;
}

const readExit = (path: string) => exitInfoSchema.parse(JSON.parse(readFileSync(path, "utf8")));
const textOf = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");

describe("line splitter", () => {
  const bytes = (text: string) => Buffer.from(text);

  test("a line split across chunks comes out once, whole, when its end arrives", () => {
    const split = lineSplitter();
    expect(split.push(bytes('{"progress":{"co')).toString()).toBe("");
    expect(split.push(bytes('de":"x"}}\n{"progress"')).toString()).toBe('{"progress":{"code":"x"}}\n');
    expect(split.push(bytes(':{"code":"y"}}\n')).toString()).toBe('{"progress":{"code":"y"}}\n');
    expect(split.flush().toString()).toBe("");
  });

  test("a chunk with several lines comes out whole and the partial tail waits", () => {
    const split = lineSplitter();
    expect(split.push(bytes("a\nb\nc")).toString()).toBe("a\nb\n");
    expect(split.push(bytes("d\n")).toString()).toBe("cd\n");
  });

  test("the tail without a newline is a line at the end of the stream", () => {
    const split = lineSplitter();
    split.push(bytes("last"));
    expect(split.flush().toString()).toBe("last\n");
    expect(split.flush().toString()).toBe("");
  });

  test("a multi-byte character cut between two chunks stays whole", () => {
    const split = lineSplitter();
    const word = bytes("é中\n");
    expect(split.push(word.subarray(0, 1)).length).toBe(0);
    expect(split.push(word.subarray(1, 3)).length).toBe(0);
    expect(split.push(word.subarray(3)).toString()).toBe("é中\n");
  });
});

describe("exec runner", () => {
  // A rig-like child: its own script, its progress on stderr (one line much longer than a pipe's
  // buffer, so it reaches the runner in several chunks), its result on stdout, written between the
  // halves of that line, and a last stderr line with no newline at the end.
  function rigLikeSpec(exitCode: number): { file: string; spec: RunnerSpec } {
    const dir = tempDir("telegramhub-runner-rig-");
    dirs.push(dir);
    const script = join(dir, "child.ts");
    const source = [
      `const big = JSON.stringify({ progress: { code: "update-step-output", data: { line: "x".repeat(300_000) } } });`,
      `process.stderr.write(big.slice(0, 150_000));`,
      `process.stdout.write(${JSON.stringify(`{"feature":"pwsh","enabled":true}\n`)});`,
      `process.stderr.write(big.slice(150_000) + "\\n");`,
      `process.stderr.write("Traceback without newline");`,
      `process.exit(${exitCode});`,
    ].join("\n");
    writeFileSync(script, source);
    const spec: RunnerSpec = {
      argv: [process.execPath, script],
      verbatim: false,
      cwd: dir,
      env: hubEnv({}),
      log: join(dir, "abcd1234.log"),
      exit: join(dir, "abcd1234.exit.json"),
      alive: join(dir, "abcd1234.alive"),
      heartbeatMs: TEST_HEARTBEAT_MS,
      result: join(dir, "abcd1234.result"),
    };
    const file = join(dir, "abcd1234.spec.json");
    writeFileSync(file, JSON.stringify(spec));
    return { file, spec };
  }

  test("with a result file the streams are kept apart, each as whole lines", async () => {
    const { file, spec } = rigLikeSpec(0);
    start(file);
    await waitFor(() => existsSync(spec.exit), EXIT_WAIT_MS, "exit file");
    expect(readExit(spec.exit).code).toBe(0);
    const logLines = readFileSync(spec.log, "utf8").split("\n");
    // Whole lines only: the long progress line intact, the tail flushed as a line, nothing after the last newline.
    expect(logLines.pop()).toBe("");
    expect(logLines).toHaveLength(2);
    expect(logLines[0]).toBe(JSON.stringify({ progress: { code: "update-step-output", data: { line: "x".repeat(300_000) } } }));
    expect(logLines[1]).toBe("Traceback without newline");
    expect(readFileSync(spec.result ?? "", "utf8")).toBe('{"feature":"pwsh","enabled":true}\n');
  });

  test("a spec without a result file keeps today's raw log of both streams", async () => {
    const { file, spec } = hostSpec("echo one && echo two 1>&2", "echo one; echo two 1>&2");
    expect(spec.result).toBeUndefined();
    start(file);
    await waitFor(() => existsSync(spec.exit), EXIT_WAIT_MS, "exit file");
    const log = readFileSync(spec.log, "utf8");
    expect(log).toContain("one");
    expect(log).toContain("two");
  });

  test("the runner logs the output and writes the exit code", async () => {
    const { file, spec } = hostSpec("echo one && echo two 1>&2 && exit /b 5", "echo one; echo two 1>&2; exit 5");
    expect(start(file)).toBeGreaterThan(0);
    await waitFor(() => existsSync(spec.exit), EXIT_WAIT_MS, "exit file");
    expect(readExit(spec.exit).code).toBe(5);
    const log = readFileSync(spec.log, "utf8");
    expect(log).toContain("one");
    expect(log).toContain("two");
  });

  test("a command that cannot start leaves an error exit", async () => {
    const { file, spec } = cmdSpec("rem");
    writeFileSync(file, JSON.stringify({ ...spec, argv: ["no-such-program.exe"], verbatim: false }));
    start(file);
    await waitFor(() => existsSync(spec.exit), EXIT_WAIT_MS, "exit file");
    const info = readExit(spec.exit);
    expect(info.code).toBeNull();
    expect(info.error).toBeTruthy();
    // The reason reaches the user through the hub's card, in the language of the moment; the runner writes no text of its own.
    expect(readFileSync(spec.log, "utf8")).not.toContain("did not start");
  });

  test("a runner that cannot start throws instead of giving a pid", () => {
    const { file } = cmdSpec("rem");
    expect(() => spawnRunner(file, join(dirs[0] ?? "", "no-such-bun.exe"))).toThrow();
  });

  test("the runner outlives a killed parent", async () => {
    const { file, spec } = slowSpec();
    const parent = join(tempDir("telegramhub-parent-"), "parent.ts");
    dirs.push(join(parent, ".."));
    const runner = join(import.meta.dir, "..", "src", "hub", "exec-runner.ts").replaceAll("\\", "/");
    writeFileSync(parent, `import { spawnRunner } from "${runner}";\nspawnRunner(${JSON.stringify(file)});\nprocess.exit(0);\n`);
    const p = Bun.spawn([process.execPath, parent], { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
    expect(await p.exited).toBe(0);
    expect(existsSync(spec.exit)).toBe(false);
    await waitFor(() => existsSync(spec.exit), PING_WAIT_MS, "exit file");
    expect(readExit(spec.exit).code).toBe(0);
  }, PING_WAIT_MS + EXIT_WAIT_MS);

  test("the runner beats while the command runs and exits after it", async () => {
    const { file, spec } = slowSpec();
    const pid = start(file);
    await waitFor(() => existsSync(spec.alive), EXIT_WAIT_MS, "heartbeat file");
    const first = statSync(spec.alive).mtimeMs;
    await waitFor(() => statSync(spec.alive).mtimeMs > first, EXIT_WAIT_MS, "a second heartbeat");
    await waitFor(() => existsSync(spec.exit), PING_WAIT_MS, "exit file");
    await waitFor(() => !isAlive(pid), EXIT_WAIT_MS, "runner gone");
  }, PING_WAIT_MS + 2 * EXIT_WAIT_MS);

  test("killTree stops the shell's child too", async () => {
    const pidDir = tempDir("telegramhub-ping-");
    dirs.push(pidDir);
    const pidFile = join(pidDir, "ping.pid");
    // The shell's child tells its pid: the log alone would stop growing with
    // the runner gone even if the child lived on.
    const { file, spec } = PLATFORM.windows
      ? shellSpec(
          "powershell",
          `$p = Start-Process ping -ArgumentList '-n','30','127.0.0.1' -PassThru -NoNewWindow\nSet-Content -Path '${pidFile}' -Value $p.Id\n$p.WaitForExit()`,
        )
      : shellSpec("bash", `sleep 30 &\necho $! > '${pidFile}'\nwait`);
    const pid = start(file);
    const ping = Number(await waitFor(() => textOf(pidFile).trim(), PING_WAIT_MS, "the ping's pid"));
    pids.push(ping);
    expect(isAlive(ping)).toBe(true);
    killTree(pid);
    await waitFor(() => !isAlive(pid), EXIT_WAIT_MS, "runner gone");
    await waitFor(() => !isAlive(ping), EXIT_WAIT_MS, "ping gone");
    // Both processes are confirmed gone above, so nothing can write the log or the exit file any more.
    expect(existsSync(spec.exit)).toBe(false);
  }, PING_WAIT_MS + 2 * EXIT_WAIT_MS);

  // Windows PowerShell and its console code page exist only there.
  test.skipIf(!PLATFORM.windows)("PowerShell Cyrillic reaches the log through the runner", async () => {
    // Russian "hi" and "world", written as \u escapes.
    const HI = "\u043f\u0440\u0438\u0432\u0435\u0442";
    const WORLD = "\u043c\u0438\u0440";
    const { file, spec } = shellSpec("powershell", `echo ${HI}; cmd /c echo ${WORLD}`);
    start(file);
    await waitFor(() => existsSync(spec.exit), PING_WAIT_MS, "exit file");
    expect(readExit(spec.exit).code).toBe(0);
    const log = readFileSync(spec.log, "utf8");
    expect(log).toContain(HI);
    expect(log).toContain(WORLD);
  }, PING_WAIT_MS);
});
