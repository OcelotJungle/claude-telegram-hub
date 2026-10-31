// How a topic command's text is handed to its shell. The text never goes into
// a quoted template: PowerShell and bash get it as a script file of its own,
// cmd as the one line after /s /c.
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { PLATFORM } from "../shared/platform.ts";

const UTF8_BOM = "\uFEFF";
// Carries a /cmd line to the inner cmd; see shellRun.
const CMD_LINE_VAR = "TG_EXEC_LINE";

export type ExecShell = "powershell" | "cmd" | "bash";

export const SHELL_NAMES: Record<ExecShell, string> = PLATFORM.shellNames;

export const DEFAULT_BASH = PLATFORM.bash;

export type ShellPaths = { powershell: string; bash: string };

export type ShellFile = { path: string; content: string; bom: boolean };

// argv runs as is; verbatim: Windows gets the arguments joined without quoting.
export type ShellRun = { argv: string[]; verbatim: boolean; files: ShellFile[]; env: Record<string, string> };

export function findPowershell(): string {
  return Bun.which("pwsh") ?? "powershell.exe";
}

// Stops the user's script at the first native command that exits non-zero or
// the first cmdlet error. Windows PowerShell 5.1 has no
// $PSNativeCommandUseErrorActionPreference, so the wrapper rewrites the script:
// every statement in a block, nested ones included, gets a LASTEXITCODE check
// after it, and the rewritten script runs once, whole, so using, param,
// functions and scopes work as written. On pwsh 7.3+ the same check covers
// what that preference would do, and keeps the native command's own code,
// which the preference would turn into an error and code 1.
// With 'Stop', 5.1 turns a native command's stderr redirected by 2>&1 or
// 2>$null into an error that ends the run; a statement that redirects stderr
// runs under 'Continue', and only its exit code counts. The preference it had
// comes back after it, whatever the user set it to. Statements in a data
// section are left alone: its restricted language refuses the check.
function psWrapper(userFile: string, runFile: string): string {
  const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    "$OutputEncoding = [Text.Encoding]::UTF8",
    "$tgErrs = $null",
    `$tgAst = [Management.Automation.Language.Parser]::ParseFile(${q(userFile)}, [ref]$null, [ref]$tgErrs)`,
    "if ($tgErrs) { $tgErrs | ForEach-Object { [Console]::Error.WriteLine($_.ToString()) }; exit 1 }",
    "$tgBase = $tgAst.Extent.StartOffset",
    "$tgN = 0",
    "$tgEdits = foreach ($s in $tgAst.FindAll({ param($n)",
    "  if (-not ($n -is [Management.Automation.Language.PipelineBaseAst])) { return $false }",
    "  if (-not ($n.Parent -is [Management.Automation.Language.StatementBlockAst] -or $n.Parent -is [Management.Automation.Language.NamedBlockAst])) { return $false }",
    "  for ($p = $n.Parent; $p; $p = $p.Parent) { if ($p -is [Management.Automation.Language.DataStatementAst]) { return $false } }",
    "  $true",
    "}, $true)) {",
    "  $tgN++",
    "  $redirected = $s.Find({ param($r)",
    "    $r -is [Management.Automation.Language.RedirectionAst] -and ($r.FromStream -eq 'Error' -or $r.FromStream -eq 'All')",
    "  }, $false)",
    "  $before = '$global:LASTEXITCODE = 0; '",
    "  $after = '; if ($LASTEXITCODE) { exit $LASTEXITCODE }'",
    // One variable per statement: a nested one in $( ) shares the scope.
    "  if ($redirected) {",
    "    $before += \"`$tgEap$tgN = `$ErrorActionPreference; `$ErrorActionPreference = 'Continue'; try { \"",
    "    $after = \" } finally { `$ErrorActionPreference = `$tgEap$tgN }\" + $after",
    "  }",
    "  [pscustomobject]@{ At = $s.Extent.StartOffset - $tgBase; Order = 1; Text = $before }",
    "  [pscustomobject]@{ At = $s.Extent.EndOffset - $tgBase; Order = 1; Text = $after }",
    "}",
    // A marker at the end of what runs last tells a script that ran to its
    // end from one that called exit. With named blocks that is the end
    // block's body, or an end block of its own; text after them would not parse.
    "$tgMarker = \"`r`n`$global:TgExecDone = `$true`r`n\"",
    "$tgEnd = $tgAst.EndBlock",
    "$tgNamed = $tgAst.BeginBlock -or $tgAst.ProcessBlock -or $tgAst.DynamicParamBlock -or ($tgEnd -and -not $tgEnd.Unnamed)",
    "$tgTail = ''",
    "if (-not $tgNamed) { $tgTail = $tgMarker }",
    "elseif (-not $tgEnd) { $tgTail = \"`r`nend {$tgMarker}`r`n\" }",
    // Before the closing brace; at a tie the statement's own check goes first.
    "else { $tgEdits = @($tgEdits) + [pscustomobject]@{ At = $tgEnd.Extent.EndOffset - 1 - $tgBase; Order = 0; Text = $tgMarker } }",
    "$tgText = New-Object Text.StringBuilder $tgAst.Extent.Text",
    "$tgSorted = @($tgEdits | Sort-Object @{ Expression = 'At'; Descending = $true }, @{ Expression = 'Order'; Descending = $false })",
    "foreach ($e in $tgSorted) { [void]$tgText.Insert($e.At, $e.Text) }",
    "[void]$tgText.Append($tgTail)",
    `[IO.File]::WriteAllText(${q(runFile)}, $tgText.ToString(), (New-Object Text.UTF8Encoding $true))`,
    "$global:TgExecDone = $false",
    "$global:LASTEXITCODE = 0",
    `try { & ${q(runFile)} } catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }`,
    "if ($global:TgExecDone) { exit 0 }",
    "exit $LASTEXITCODE",
    "",
  ].join("\r\n");
}

// What runs the text; only describes it, writeShellFiles puts the files down.
export function shellRun(shell: ExecShell, text: string, dir: string, id: string, paths: ShellPaths): ShellRun {
  if (shell === "powershell") {
    const user = join(dir, `${id}.user.ps1`);
    const wrapper = join(dir, `${id}.ps1`);
    // The user's script as rewritten by the wrapper.
    const rewritten = join(dir, `${id}.run.ps1`);
    return {
      // No -NoProfile: the profile loads as in a new window.
      argv: [paths.powershell, "-NoLogo", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapper],
      verbatim: false,
      // With no BOM, Windows PowerShell 5.1 reads a script in the ANSI code page.
      files: [
        { path: user, content: text, bom: true },
        { path: wrapper, content: psWrapper(user, rewritten), bom: true },
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
