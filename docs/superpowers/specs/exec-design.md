# telegram-hub: shell commands from a topic (`/pwsh`, `/cmd`, `/bash`)

Basis: `hub-iteration-2-design.md` (hub, autostart, subagent cards).

Sound of service messages: informational bot messages, commands and successful results are silent;
warnings and errors make a sound. Permission requests and polls that need a user's answer also make
a sound. This rule does not change the sound of agent text or of the end of its turn.

## Why

In the session's folder you often need to run a migration, a manual run and the like. When the computer is not
nearby, it looks like this: connect remotely, type the command, disconnect, wait, come back,
check whether it failed, and write the result to the agent. The command should run right from the session's
topic. The user sees how it goes, and the agent learns the result itself and takes it up itself.

## Goals

1. A command from the topic runs in the session's folder: cmd, PowerShell or Git Bash.
2. While the command runs, the topic shows that it is alive and what it prints. No stream of messages.
3. When the command finishes, the agent **wakes up by itself** with the result: the command, exit code, time,
   the tail of the output and the path to the full log.
4. The command can be stopped from the topic.

## Non-goals

- Interactive commands. stdin is closed from the start; a command that waits for input hangs until it is
  stopped.
- Streaming every line to the chat or to the agent.
- Running commands by the agent through this mechanism. The agent has its own Bash for that.

## Anti-goals

- A hub restart kills a running migration. Not acceptable: the process survives a hub restart, and the
  result after the restart arrives the same way as without it.
- The agent gets output line by line or in chunks and reacts to each.
- Anyone outside `allowFrom` can run a command.

## What the user sees

### Commands (handled by the hub, like `/run` and `/stop`)

| Command | Shell |
|---|---|
| `/pwsh <text>` | PowerShell: `pwsh` if it is in PATH, otherwise `powershell.exe` |
| `/cmd <text>` | `cmd.exe /s /c` |
| `/bash <text>` | Git Bash, `bash -lc`. The path is `exec.bash` in `config.json`, by default `C:\Program Files\Git\bin\bash.exe` |

The text after the command is passed to the shell as is. For `/pwsh` and `/bash` it can be multi-line. For
`/cmd` it is a single line only: cmd.exe with `/c` executes the text only up to the first newline, and a
`.cmd` file behaves differently from lines typed in a window. For a multi-line `/cmd` the hub replies with
a refusal and advises `/pwsh` or `/bash`. Empty text → a reply to the topic "`/pwsh npm run migrate`". No Git Bash file → "Git Bash not found: <path>. Set exec.bash in
config.json". All three commands are added to the bot menu next to `/info`.

### Environment — as in a new terminal window

The command must behave the same as if typed in a fresh terminal window. Therefore:

- `PATH` and the other variables are built anew, as at login: machine ones from the registry,
  then `HKCU\Volatile Environment`, then user ones; `Path` is machine plus user.
  From the hub only a fixed list of system variables is taken that are not in these keys
  (`SystemRoot`, `windir`, `USERPROFILE`, `APPDATA`, `ProgramFiles*`, `PROCESSOR_*`, `PATHEXT`,
  `ComSpec` and similar), and nothing else. The hub's environment may be old, from the time of
  login, or carry variables of the Claude Code window: `CLAUDE_CONFIG_DIR`, a redirected `TEMP`/`TMPDIR` and
  similar. If the registry cannot be read, the command gets the hub's environment without the Claude Code and hub variables.
- Profiles are loaded as in an interactive window: `$PROFILE` for PowerShell, the login profile for Git
  Bash, AutoRun for cmd (without `/d`).

### Fail on the first error

A chain of commands stops at the first failed one, and the final exit code is its code. Otherwise
`npm run build; npm run migrate` after a failed build would give "✅ code 0", and the agent would believe in success.

- PowerShell: `$ErrorActionPreference = 'Stop'`. After each external command with a non-zero
  `$LASTEXITCODE`, execution is aborted with that code. Windows PowerShell 5.1 cannot do this by itself, so the
  wrapper rewrites the script: after each statement in any block, nested ones (loops, `if`, functions)
  too, a `$LASTEXITCODE` check is inserted, and the rewritten script runs as a whole, so `using`,
  `param`, functions and scopes work as written. In pwsh 7.3+ the same check replaces
  `$PSNativeCommandUseErrorActionPreference`, which would turn a command's code into an error with code 1.
  If external commands did not fail but a cmdlet did, the code is 1. Output of an external command to stderr is not
  counted as a failure: a statement that redirects stderr (`2>&1`, `2>$null`) runs with
  `'Continue'`, because 5.1 with `'Stop'` aborts it on the first stderr line; for it only the
  exit code counts, and after it the preference value that was before it is restored (including one
  set by the user). The `begin`/`process`/`end` blocks work as written. Statements
  inside `data { }` are not checked: the restricted language of that block does not allow insertions. To get
  past an expected non-zero code (robocopy, `git diff --quiet`), the command is wrapped:
  `cmd /c "… & exit /b 0"`.
- Git Bash: `set -eo pipefail` before the user's text.
- cmd: one line, so the code is the code of that line; `&&` and `||` are written by the user.

Test requirement: `false-command; echo next` (its own in each shell) does not print "next" and
ends with the code of the failed command.

### Old and repeated commands

The hub keeps the `getUpdates` offset in `poll-offset.json`, but a command the hub did not manage to mark as handled, and
commands that arrived while it was off, come after start from the Telegram queue, where they stay for up to 24 h. The same
command can arrive twice.

- Every launch is recorded in `execs.json` with the chat and the command's `message_id`. If this message is already
  recorded, the command is not run a second time, and the hub log notes that a repeat was skipped.
- A command older than `EXEC_MAX_AGE = 2 min` (by the message's `date`) does not run by itself. A card
  "⏸ The command arrived N min ago while the hub was off" with a "▶ Run" button arrives in the topic. Pressing it
  runs it as usual.

The rules are the same as for the other topic commands: only the group from the config, only senders from
`allowFrom` (`router.ts`), only a topic that has a session. The folder is `cwd` from the session record; if
it is missing, then from the transcript, as at autostart; if it is missing there too, a refusal to the topic. A session window is
not needed to run: the command runs even when the session is stopped.

Several commands can run at the same time, each with its own card. There is no timeout.

### Card in the topic

One message per launch. The hub edits it no more than once a minute and only when something
changed:

```
▶ PowerShell · 3 min 12 s
`npm run migrate`
‹last 10 lines of output, as a code block›
[⏹ Stop]
```

When the command finishes, the card is edited at once, the button is removed:

```
✅ code 0 · 4 min 05 s          (❌ code 1 …; ⏹ stopped …; ⚠️ interrupted: <reason>)
`npm run migrate`
‹last 10 lines›
```

If the log is longer than the tail in the card, it follows as a file (`<id>.log`). Telegram does not accept files over 50 MB, so from such a log the last 50 MB are sent, with a
note about it.

The "Stop" button kills the process tree (`taskkill /T /F /PID` on Windows). Only senders from `allowFrom`
(`routeCallback`) can press it. A command that managed to finish before the press
is not killed and shows its code. "⏹ stopped" is shown when after the press the runner disappeared without
`.exit.json` or wrote a non-zero code (most likely from the kill itself); code 0 after the press is
shown as "✅ code 0".

### What the agent gets

When the command finishes, the hub delivers an `inbound` record to the session, the same way as a message from the topic:
the agent wakes up, and if a turn is running, it gets the record in that turn.

```
A command from the topic finished: ❌ code 1 in 4 min 05 s.
Shell: PowerShell, folder: C:\code\app
Command: npm run migrate
Full log: <home folder>\.claude\channels\telegram-hub\exec\<id>.log
Last 30 lines:
‹…›
```

`meta` has `source: "exec"`, `exec_id`, `exit_code`, so that it is not confused with user text. The agent is
not told about the start of a command.

If the session has no window, the result wakes it like a message: with `launch` configured, the hub starts the
session and holds the result until it connects (the `held` mechanism). Without `launch`, the result stays
only in the card, plus a notification to the topic "⚠️ The session is not running: the command result was not delivered to the agent".

## How it works

### The process does not depend on the hub

The hub does not keep the child process itself. It starts a detached small runner
(`bun hub/exec-runner.ts <id>`). The runner:

1. starts the shell in the needed folder, stdin closed;
2. writes stdout and stderr to `exec/<id>.log` as they arrive, in arrival order;
3. while alive, every 10 s updates the modification time of the file `exec/<id>.alive` (the heartbeat);
4. on completion, atomically writes `exec/<id>.exit.json`: `{code, endedAt}`.

The hub learns the state **only from files**: the log size and tail, the heartbeat, whether `.exit.json` appeared. So
the usual case and the case "the hub restarted while the command was running" are the same code. The list of launches
the hub keeps in `execs.json` in the state folder (modeled on `cards.json`): `id`, `sessionId`, id of the
message with the command, the shell, the text, `cwd`, the runner's `pid`, `startedAt`, how it ended, whether the
result was delivered to the agent. The launch card lives in `cards.json` together with the buttons. A restarted hub reads
`execs.json` and goes on watching unfinished launches. "Stop" kills the runner's process tree:
in it are the shell and everything it started.

A result that did not reach the agent (the session was starting and the start failed; the hub crashed between the end of the
command and the delivery) is sent again when the session connects.

A command that finished while the hub was down gets the final card and the log at hub start
at once, but its result does not go to the agent at once: session windows are just reconnecting at that moment, and
starting a second copy of the session or "not delivered" would be a mistake. The window gets the result when it
connects. A command that finished in the first 10 s after the hub start waits the same way if
its session has no window at that moment; with a window it goes at once. After 10 s from the start (the window's reconnect pause plus the readiness delay) the results
of sessions that still have no window go the normal way: a session launch if `launch` is configured, otherwise the
"not delivered" notification.

The process vanished and there is no `.exit.json` (the machine was rebooted, the runner was killed) → card "⚠️ interrupted:
the process disappeared", and the agent gets the same with the log tail. The runner counts as alive only while its pid is alive
**and** the heartbeat is fresher than 30 s: after a reboot, a logout or a shutdown with Fast Startup the same pid
may go to a foreign process, and such a launch ends as "the process disappeared" instead of hanging forever.
"⏹ Stop" kills the tree only with a fresh heartbeat; without it, and if `.exit.json` already exists, nothing
is killed. If the hub itself noticed a gap in its checks of more than 10 s (the machine slept together with the
runners), the old heartbeat is forgiven for another 30 s until the runner updates it.

### Encoding

Output to the log and to Telegram is UTF-8. cmd and Windows PowerShell 5.1 on a Russian Windows write
in the OEM encoding (cp866) by default. The runner turns on UTF-8 before the user's command. For PowerShell this is
`[Console]::OutputEncoding = [Text.Encoding]::UTF8` in the wrapper. cmd reads the code page once per
line, so `chcp 65001 & echo <Russian word>` in one line still prints "??????". The outer cmd
switches the console to UTF-8 and starts the user's cmd, and gives it the text through an environment variable
(`!TG_EXEC_LINE!`), so it does not parse it itself. Requirement: Cyrillic in the output of `dotnet ef`, `npm` and
`echo <Russian word>` reads correctly in the card.

### Card

Uses the same message queue and edit logic as subagent cards (outbox, throttling, "not
modified" is not an error, `cards.json`). The tail is the last lines of the log, trimmed by length so that the
card fits in a message. Carriage returns (progress bars) are collapsed: of a line, what is
after the last `\r` remains.

### Logs

`exec/` in the state folder. The last 50 launches are kept; older ones are deleted together with their entry in
`execs.json` when a new one starts.

## Security

`/pwsh` is execution of arbitrary commands on the machine, bypassing Claude Code's permission mode. The boundary is
the same as for messages and buttons: the group from the config plus `allowFrom`. This adds no new way around it;
the README says plainly that getting into `allowFrom` now means getting a shell. The command text is never
substituted into a quoted template: it is passed to the shell as a separate argument.

## Decisions made

- The hub starts the process through a detached runner, not the session module: the module kills its processes
  on reload, and a reload happens on every plugin edit.
- Three commands instead of a shell-choice flag: each is visible in the menu, and no prefix needs parsing.
- PowerShell is the default shell (`/pwsh`): it also runs what is usually written for cmd.
- No timeout; several commands can run at the same time.
- Card edit once a minute, 10 lines in the card, 30 lines to the agent, 50 logs kept.
- The agent gets only the result, it does not learn about the start.
- A multi-line `/cmd` is not run, the hub advises `/pwsh` or `/bash`.
- Environment as in a new window: variables from the registry, profiles are loaded.
- Fail on the first error in PowerShell and Git Bash (more reliable: a false success is more dangerous than a stop).
- A command older than 2 minutes does not run by itself, only by the button; a repeat of the same message is not run.

## Implementation details

- How the runner is built and how it detaches from the hub on Windows.
- How to find `pwsh` and check the path to Git Bash; the error text if the shell is missing.
- Module names.
