import type { ExecShell, ShellRun } from "../src/hub/exec-shell.ts";

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { rmSync } from "fs";
import { DEFAULT_BASH, findPowershell, shellRun, writeShellFiles } from "../src/hub/exec-shell.ts";
import { tempDir } from "./helpers.ts";
import { PLATFORM } from "../src/shared/platform.ts";

const SHELL_TIMEOUT_MS = 60_000;
const hasBash = Bun.which(DEFAULT_BASH) !== null;

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

// Runs the user's text the way the runner would, in a fresh temp folder.
function run(shell: ExecShell, text: string): { code: number | null; out: string; err: string; dir: string } {
  const dir = tempDir("telegramhub-shell-");
  dirs.push(dir);
  const r: ShellRun = shellRun(shell, text, dir, "abcd1234", { powershell: findPowershell(), bash: DEFAULT_BASH });
  writeShellFiles(r);
  const [cmd, ...args] = r.argv;
  if (cmd === undefined) throw new Error("empty argv");
  const res = spawnSync(cmd, args, {
    cwd: dir,
    env: { ...process.env, ...r.env },
    windowsVerbatimArguments: r.verbatim,
    windowsHide: true,
    encoding: "utf8",
    timeout: SHELL_TIMEOUT_MS,
  });
  return { code: res.status, out: res.stdout, err: res.stderr, dir };
}

const lastLine = (out: string) => out.trim().split(/\r?\n/).at(-1)?.trim();

describe.skipIf(!PLATFORM.windows)("powershell", () => {
  test("powershell stops at the first failing native command", () => {
    const r = run("powershell", "cmd /c exit 3\necho next-step");
    expect(r.code).toBe(3);
    expect(r.out).not.toContain("next-step");
  }, SHELL_TIMEOUT_MS);

  test("powershell stops at a failing cmdlet", () => {
    const r = run("powershell", "Get-Item C:\\no-such-thing; echo next-step");
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("next-step");
  }, SHELL_TIMEOUT_MS);

  test("powershell keeps variables and functions between statements", () => {
    const r = run("powershell", "$a = 2; function f { $a * 3 }; f");
    expect(r.code).toBe(0);
    expect(lastLine(r.out)).toBe("6");
  }, SHELL_TIMEOUT_MS);

  test("powershell output keeps Cyrillic", () => {
    const r = run("powershell", "echo \u043f\u0440\u0438\u0432\u0435\u0442");
    expect(r.code).toBe(0);
    expect(r.out).toContain("\u043f\u0440\u0438\u0432\u0435\u0442");
  }, SHELL_TIMEOUT_MS);

  test("powershell keeps Cyrillic from a native command", () => {
    const r = run("powershell", "cmd /c echo \u043f\u0440\u0438\u0432\u0435\u0442");
    expect(r.code).toBe(0);
    expect(r.out).toContain("\u043f\u0440\u0438\u0432\u0435\u0442");
  }, SHELL_TIMEOUT_MS);

  test("a quote in the user text cannot leave the script", () => {
    const r = run("powershell", "echo 'a''b'; echo \"x\"");
    expect(r.code).toBe(0);
    expect(r.out).toContain("a'b");
    expect(lastLine(r.out)).toBe("x");
  }, SHELL_TIMEOUT_MS);

  test("a native command's stderr under 2>&1 does not stop the run", () => {
    const r = run("powershell", 'cmd /c "echo err 1>&2" 2>&1; echo next-step');
    expect(r.code).toBe(0);
    // 5.1 shows a redirected native stderr line as an error, on its stderr.
    expect(r.out + r.err).toContain("err");
    expect(lastLine(r.out)).toBe("next-step");
  }, SHELL_TIMEOUT_MS);

  test("a native command's stderr under 2>$null does not stop the run", () => {
    const r = run("powershell", '$x = cmd /c "echo err 1>&2" 2>$null; echo next-step');
    expect(r.code).toBe(0);
    expect(r.out + r.err).not.toContain("err");
    expect(lastLine(r.out)).toBe("next-step");
  }, SHELL_TIMEOUT_MS);

  test("powershell stops at a failure inside a loop", () => {
    const r = run("powershell", "foreach ($i in 3,0) { cmd /c exit $i }; echo loop-done");
    expect(r.code).toBe(3);
    expect(r.out).not.toContain("loop-done");
  }, SHELL_TIMEOUT_MS);

  test("powershell stops at a failure inside an if block", () => {
    const r = run("powershell", "if ($true) {\n  cmd /c exit 4\n  echo inside\n}\necho after");
    expect(r.code).toBe(4);
    expect(r.out).not.toContain("inside");
    expect(r.out).not.toContain("after");
  }, SHELL_TIMEOUT_MS);

  test("powershell stops at a failing native command in an assignment", () => {
    const r = run("powershell", "$x = cmd /c exit 6\necho next-step");
    expect(r.code).toBe(6);
    expect(r.out).not.toContain("next-step");
  }, SHELL_TIMEOUT_MS);

  test("powershell keeps using namespace", () => {
    const r = run("powershell", "using namespace System.IO\n[Path]::GetFileName('a\\b.txt')");
    expect(r.code).toBe(0);
    expect(lastLine(r.out)).toBe("b.txt");
  }, SHELL_TIMEOUT_MS);

  test("powershell exits with the user's own exit code", () => {
    const r = run("powershell", "echo before; exit 5; echo after");
    expect(r.code).toBe(5);
    expect(r.out).not.toContain("after");
  }, SHELL_TIMEOUT_MS);

  test("a stderr redirect keeps the user's own error preference", () => {
    const r = run("powershell", "$ErrorActionPreference = 'Continue'; cmd /c \"echo e 1>&2\" 2>&1 | Out-Null; Get-Item C:\\no-such-thing; echo next-step");
    expect(r.code).toBe(0);
    expect(lastLine(r.out)).toBe("next-step");
  }, SHELL_TIMEOUT_MS);

  test("powershell runs begin, process and end blocks", () => {
    const r = run("powershell", "begin { echo b } process { echo p } end { echo e }");
    expect(r.code).toBe(0);
    expect(r.out.trim().split(/\r?\n/).map(l => l.trim())).toEqual(["b", "p", "e"]);
  }, SHELL_TIMEOUT_MS);

  test("powershell stops in an end block whose last statement touches its brace", () => {
    const r = run("powershell", "end { echo e; cmd /c exit 7}");
    expect(r.code).toBe(7);
  }, SHELL_TIMEOUT_MS);

  test("powershell runs begin and process blocks without an end block", () => {
    const r = run("powershell", "begin { echo b } process { echo p }");
    expect(r.code).toBe(0);
    expect(r.out.trim().split(/\r?\n/).map(l => l.trim())).toEqual(["b", "p"]);
  }, SHELL_TIMEOUT_MS);

  test("powershell leaves data sections as written", () => {
    const r = run("powershell", '$d = data { "x" }; $d');
    expect(r.code).toBe(0);
    expect(lastLine(r.out)).toBe("x");
  }, SHELL_TIMEOUT_MS);

  test("powershell goes on past an error the user silenced", () => {
    const r = run("powershell", "Get-Item C:\\no-such-thing -ErrorAction SilentlyContinue; echo next-step");
    expect(r.code).toBe(0);
    expect(lastLine(r.out)).toBe("next-step");
  }, SHELL_TIMEOUT_MS);
});

describe("bash", () => {
  test.skipIf(!hasBash)("bash stops at the first failure", () => {
    const r = run("bash", "false; echo next-step");
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("next-step");
    const w = run("bash", PLATFORM.windows ? "pwd -W" : "pwd");
    expect(w.code).toBe(0);
    expect(lastLine(w.out)).toBe(w.dir.replaceAll("\\", "/"));
  }, SHELL_TIMEOUT_MS);

  test.skipIf(!hasBash)("bash pipefail", () => {
    const r = run("bash", "false | cat; echo next-step");
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("next-step");
  }, SHELL_TIMEOUT_MS);
});

describe.skipIf(!PLATFORM.windows)("cmd", () => {
  test("cmd runs one line and keeps Cyrillic", () => {
    const r = run("cmd", "echo \u043f\u0440\u0438\u0432\u0435\u0442 && exit /b 4");
    expect(r.code).toBe(4);
    expect(r.out).toContain("\u043f\u0440\u0438\u0432\u0435\u0442");
  }, SHELL_TIMEOUT_MS);

  test("cmd gets quotes, & and % as typed", () => {
    const r = run("cmd", "echo \"a & b\" 100%% %OS%");
    expect(r.code).toBe(0);
    expect(lastLine(r.out)).toBe("\"a & b\" 100%% Windows_NT");
  }, SHELL_TIMEOUT_MS);
});
