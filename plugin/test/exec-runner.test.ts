import type { RunnerSpec } from "../src/hub/exec-runner.ts";

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { exitInfoSchema, spawnRunner } from "../src/hub/exec-runner.ts";
import { findPowershell, shellRun, writeShellFiles } from "../src/hub/exec-shell.ts";
import { tempDir, waitFor } from "./helpers.ts";

const EXIT_WAIT_MS = 5000;
const PING_WAIT_MS = 15_000;

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function hubEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return { ...env, ...extra };
}

// A spec file for a cmd line, in a fresh temp folder.
function cmdSpec(text: string): { file: string; spec: RunnerSpec } {
  const dir = tempDir("tghub-runner-");
  dirs.push(dir);
  const run = shellRun("cmd", text, dir, "abcd1234", { powershell: findPowershell(), bash: "" });
  writeShellFiles(run);
  const spec: RunnerSpec = {
    argv: run.argv,
    verbatim: run.verbatim,
    cwd: dir,
    env: hubEnv(run.env),
    log: join(dir, "abcd1234.log"),
    exit: join(dir, "abcd1234.exit.json"),
  };
  const file = join(dir, "abcd1234.spec.json");
  writeFileSync(file, JSON.stringify(spec));
  return { file, spec };
}

const readExit = (path: string) => exitInfoSchema.parse(JSON.parse(readFileSync(path, "utf8")));

describe("exec runner", () => {
  test("the runner logs the output and writes the exit code", async () => {
    const { file, spec } = cmdSpec("echo один && echo два 1>&2 && exit /b 5");
    expect(spawnRunner(file)).toBeGreaterThan(0);
    await waitFor(() => existsSync(spec.exit), EXIT_WAIT_MS, "exit file");
    expect(readExit(spec.exit).code).toBe(5);
    const log = readFileSync(spec.log, "utf8");
    expect(log).toContain("один");
    expect(log).toContain("два");
  });

  test("a command that cannot start leaves an error exit", async () => {
    const { file, spec } = cmdSpec("rem");
    writeFileSync(file, JSON.stringify({ ...spec, argv: ["нет-такой-программы.exe"], verbatim: false }));
    spawnRunner(file);
    await waitFor(() => existsSync(spec.exit), EXIT_WAIT_MS, "exit file");
    const info = readExit(spec.exit);
    expect(info.code).toBeNull();
    expect(info.error).toBeTruthy();
    expect(readFileSync(spec.log, "utf8")).toContain("не запустилось");
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
});
