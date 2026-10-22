import type { ExecShell, ShellRun } from "../src/hub/exec-shell.ts";

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, rmSync } from "fs";
import { DEFAULT_BASH, findPowershell, shellRun, writeShellFiles } from "../src/hub/exec-shell.ts";
import { tempDir } from "./helpers.ts";

const SHELL_TIMEOUT_MS = 60_000;
const hasBash = existsSync(DEFAULT_BASH);

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

// Runs the user's text the way the runner would, in a fresh temp folder.
function run(shell: ExecShell, text: string): { code: number | null; out: string; err: string; dir: string } {
  const dir = tempDir("tghub-shell-");
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

describe("powershell", () => {
  test("powershell stops at the first failing native command", () => {
    const r = run("powershell", "cmd /c exit 3\necho дальше");
    expect(r.code).toBe(3);
    expect(r.out).not.toContain("дальше");
  }, SHELL_TIMEOUT_MS);

  test("powershell stops at a failing cmdlet", () => {
    const r = run("powershell", "Get-Item C:\\нет-такого; echo дальше");
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("дальше");
  }, SHELL_TIMEOUT_MS);

  test("powershell keeps variables and functions between statements", () => {
    const r = run("powershell", "$a = 2; function f { $a * 3 }; f");
    expect(r.code).toBe(0);
    expect(lastLine(r.out)).toBe("6");
  }, SHELL_TIMEOUT_MS);

  test("powershell output keeps Cyrillic", () => {
    const r = run("powershell", "echo привет");
    expect(r.code).toBe(0);
    expect(r.out).toContain("привет");
  }, SHELL_TIMEOUT_MS);

  test("powershell keeps Cyrillic from a native command", () => {
    const r = run("powershell", "cmd /c echo привет");
    expect(r.code).toBe(0);
    expect(r.out).toContain("привет");
  }, SHELL_TIMEOUT_MS);

  test("a quote in the user text cannot leave the script", () => {
    const r = run("powershell", "echo 'a''b'; echo \"x\"");
    expect(r.code).toBe(0);
    expect(r.out).toContain("a'b");
    expect(lastLine(r.out)).toBe("x");
  }, SHELL_TIMEOUT_MS);

  test("a native command's stderr under 2>&1 does not stop the run", () => {
    const r = run("powershell", 'cmd /c "echo err 1>&2" 2>&1; echo дальше');
    expect(r.code).toBe(0);
    // 5.1 shows a redirected native stderr line as an error, on its stderr.
    expect(r.out + r.err).toContain("err");
    expect(lastLine(r.out)).toBe("дальше");
  }, SHELL_TIMEOUT_MS);

  test("a native command's stderr under 2>$null does not stop the run", () => {
    const r = run("powershell", '$x = cmd /c "echo err 1>&2" 2>$null; echo дальше');
    expect(r.code).toBe(0);
    expect(r.out + r.err).not.toContain("err");
    expect(lastLine(r.out)).toBe("дальше");
  }, SHELL_TIMEOUT_MS);

  test("powershell stops at a failure inside a loop", () => {
    const r = run("powershell", "foreach ($i in 3,0) { cmd /c exit $i }; echo конец");
    expect(r.code).toBe(3);
    expect(r.out).not.toContain("конец");
  }, SHELL_TIMEOUT_MS);

  test("powershell stops at a failure inside an if block", () => {
    const r = run("powershell", "if ($true) {\n  cmd /c exit 4\n  echo внутри\n}\necho после");
    expect(r.code).toBe(4);
    expect(r.out).not.toContain("внутри");
    expect(r.out).not.toContain("после");
  }, SHELL_TIMEOUT_MS);

  test("powershell stops at a failing native command in an assignment", () => {
    const r = run("powershell", "$x = cmd /c exit 6\necho дальше");
    expect(r.code).toBe(6);
    expect(r.out).not.toContain("дальше");
  }, SHELL_TIMEOUT_MS);

  test("powershell keeps using namespace", () => {
    const r = run("powershell", "using namespace System.IO\n[Path]::GetFileName('a\\b.txt')");
    expect(r.code).toBe(0);
    expect(lastLine(r.out)).toBe("b.txt");
  }, SHELL_TIMEOUT_MS);

  test("powershell exits with the user's own exit code", () => {
    const r = run("powershell", "echo до; exit 5; echo после");
    expect(r.code).toBe(5);
    expect(r.out).not.toContain("после");
  }, SHELL_TIMEOUT_MS);

  test("powershell goes on past an error the user silenced", () => {
    const r = run("powershell", "Get-Item C:\\нет-такого -ErrorAction SilentlyContinue; echo дальше");
    expect(r.code).toBe(0);
    expect(lastLine(r.out)).toBe("дальше");
  }, SHELL_TIMEOUT_MS);
});

describe("bash", () => {
  test.skipIf(!hasBash)("bash stops at the first failure", () => {
    const r = run("bash", "false; echo дальше");
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("дальше");
    const w = run("bash", "pwd -W");
    expect(w.code).toBe(0);
    expect(lastLine(w.out)).toBe(w.dir.replaceAll("\\", "/"));
  }, SHELL_TIMEOUT_MS);

  test.skipIf(!hasBash)("bash pipefail", () => {
    const r = run("bash", "false | cat; echo дальше");
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("дальше");
  }, SHELL_TIMEOUT_MS);
});

describe("cmd", () => {
  test("cmd runs one line and keeps Cyrillic", () => {
    const r = run("cmd", "echo привет && exit /b 4");
    expect(r.code).toBe(4);
    expect(r.out).toContain("привет");
  }, SHELL_TIMEOUT_MS);

  test("cmd gets quotes, & and % as typed", () => {
    const r = run("cmd", "echo \"a & b\" 100%% %OS%");
    expect(r.code).toBe(0);
    expect(lastLine(r.out)).toBe("\"a & b\" 100%% Windows_NT");
  }, SHELL_TIMEOUT_MS);
});
