// How a topic command's text is handed to its shell. The text never goes into
// a quoted template: PowerShell and bash get it as a script file of its own,
// cmd as the one line after /s /c.
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";

const UTF8_BOM = "\uFEFF";
// Carries a /cmd line to the inner cmd; see shellRun.
const CMD_LINE_VAR = "TG_EXEC_LINE";

export type ExecShell = "powershell" | "cmd" | "bash";

export const SHELL_NAMES: Record<ExecShell, string> = { powershell: "PowerShell", cmd: "cmd", bash: "Git Bash" };

export const DEFAULT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

export type ShellPaths = { powershell: string; bash: string };

export type ShellFile = { path: string; content: string; bom: boolean };

// argv runs as is; verbatim: Windows gets the arguments joined without quoting.
export type ShellRun = { argv: string[]; verbatim: boolean; files: ShellFile[]; env: Record<string, string> };

export function findPowershell(): string {
  return Bun.which("pwsh") ?? "powershell.exe";
}

// Runs the user's file statement by statement, dot-sourced so variables and
// functions live on, and stops at the first native command that exits non-zero
// or the first error. Windows PowerShell 5.1 has no
// $PSNativeCommandUseErrorActionPreference, so the check is done here.
function psWrapper(userFile: string): string {
  const quoted = userFile.replaceAll("'", "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    "$OutputEncoding = [Text.Encoding]::UTF8",
    "$errs = $null",
    `$ast = [Management.Automation.Language.Parser]::ParseFile('${quoted}', [ref]$null, [ref]$errs)`,
    "if ($errs) { $errs | ForEach-Object { [Console]::Error.WriteLine($_.ToString()) }; exit 1 }",
    "try {",
    "  foreach ($st in $ast.EndBlock.Statements) {",
    "    $global:LASTEXITCODE = 0",
    "    . ([scriptblock]::Create($st.Extent.Text))",
    "    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    "  }",
    "} catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }",
    "exit 0",
    "",
  ].join("\r\n");
}

// What runs the text; only describes it, writeShellFiles puts the files down.
export function shellRun(shell: ExecShell, text: string, dir: string, id: string, paths: ShellPaths): ShellRun {
  if (shell === "powershell") {
    const user = join(dir, `${id}.user.ps1`);
    const wrapper = join(dir, `${id}.ps1`);
    return {
      // No -NoProfile: the profile loads as in a new window.
      argv: [paths.powershell, "-NoLogo", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapper],
      verbatim: false,
      // With no BOM, Windows PowerShell 5.1 reads a script in the ANSI code page.
      files: [
        { path: user, content: text, bom: true },
        { path: wrapper, content: psWrapper(user), bom: true },
      ],
      env: {},
    };
  }
  if (shell === "bash") {
    const script = join(dir, `${id}.sh`);
    return {
      argv: [paths.bash, "-l", script.replaceAll("\\", "/")],
      verbatim: false,
      files: [{ path: script, content: `set -eo pipefail\n${text}`, bom: false }],
      // The login profile stays in the start folder instead of going to $HOME.
      env: { CHERE_INVOKING: "1" },
    };
  }
  // cmd reads the code page once per line, so `chcp 65001 & echo привет` in one
  // line still prints "??????" to a hidden console. An outer cmd switches the
  // console to UTF-8 and starts the user's cmd, which then starts in UTF-8.
  // The outer takes the line by delayed expansion (!VAR!), after its own
  // parsing, so none of the text's quotes, & or % ever reach it; the inner gets
  // /s /c "<text>" as typed, and no /d, so AutoRun runs as in a new window.
  return {
    argv: ["cmd.exe", "/d", "/v:on", "/s", "/c", `"chcp 65001>nul 2>nul & cmd /s /c !${CMD_LINE_VAR}!"`],
    verbatim: true,
    files: [],
    env: { [CMD_LINE_VAR]: `"${text}"` },
  };
}

export function writeShellFiles(run: ShellRun): void {
  for (const f of run.files) {
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.bom ? UTF8_BOM + f.content : f.content, "utf8");
  }
}
