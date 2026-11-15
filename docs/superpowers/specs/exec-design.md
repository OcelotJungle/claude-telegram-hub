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

### Commands (executed by the hub)

| Command | Shell |
|---|---|
| `/pwsh <text>` | PowerShell: `pwsh` if it is in PATH, otherwise `powershell.exe` |
| `/cmd <text>` | `cmd.exe /s /c` |
| `/bash <text>` | Git Bash, `bash -lc` |

The hub does not run a shell itself: it is a thin client of `rig exec` (rig 0.7.1 and newer). rig finds the shell, builds
the environment, wraps the text and runs the process; the hub sends the text on stdin and reads the answers.

The text after the command is passed to rig as is. For `/pwsh` and `/bash` it can be multi-line. For
`/cmd` it is a single line only: cmd.exe with `/c` executes the text only up to the first newline, and a
`.cmd` file behaves differently from lines typed in a window. For a multi-line `/cmd` the hub replies with
a refusal and advises `/pwsh` or `/bash`. Empty text → a reply to the topic "`/pwsh npm run migrate`". If rig is not
found, or is older than the version with `rig exec`, the topic gets the usual "rig is not installed" answer. A shell
that rig cannot find is reported with rig's own message. All three commands are added to the bot menu next to `/info`.

### Environment, fail on the first error, encoding

These are rig's work and are described in rig's `rig-exec-design.md`: the environment as in a new terminal window
(registry variables, profiles), a chain that stops at the first failed command with its exit code, and UTF-8 output.
The hub no longer has its own copy of any of them, and the key `exec.bash` of `config.json` is no longer read.
The hub only chooses the shell and the working folder (`rig exec start <shell> --cwd <folder>`).

### Old and repeated commands

The hub keeps the `getUpdates` offset in `poll-offset.json`, but a command the hub did not manage to mark as handled, and
commands that arrived while it was off, come after start from the Telegram queue, where they stay for up to 24 h. The same
command can arrive twice.

- Every launch is recorded in `exec-runs.json` with the chat and the command's `message_id`. If this message is already
  recorded, the command is not run a second time, and the hub log notes that a repeat was skipped. The record is saved
  before `rig exec start` is asked, not after.
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

If the log is longer than the tail in the card, it follows as a file (`<id>.log`): the run's whole log, read from rig
page by page (see "The log").

The "Stop" button calls `rig exec stop <id>`; rig kills the process tree. Only senders from `allowFrom`
(`routeCallback`) can press it. A command that managed to finish before the press
is not killed and shows its code. "⏹ stopped" is shown when rig reports the end `stopped`; a run that ended with its own
exit code after the press shows that code.

### What the agent gets

When the command finishes, the hub delivers an `inbound` record to the session, the same way as a message from the topic:
the agent wakes up, and if a turn is running, it gets the record in that turn.

```
A command from the topic finished: ❌ code 1 in 4 min 05 s.
Shell: PowerShell, folder: C:\code\app
Command: npm run migrate
Full log: rig exec status <run id> --from 0
Last 30 lines:
‹…›
```

`meta` has `source: "exec"`, `exec_id`, `exit_code`, so that it is not confused with user text. The agent is
not told about the start of a command.

If the session has no window, the result wakes it like a message: the hub calls `rig session run <id>` with the session's account and holds the result until it connects (the `held` mechanism). A rig failure is shown verbatim; the undelivered result remains available for delivery when the session connects. The shell command itself still runs through the hub's detached runner, independently of rig session actions.

## How it works

### The process does not depend on the hub

The hub does not start a shell, does not keep a child process and does not write a run log. `rig exec` (rig 0.7.1 and
newer) owns all of it: `rig exec start <shell> --cwd <folder>` takes the command text on stdin, starts the run detached
from the hub and answers `{id, shell, cwd, pid, startedAt}`. A rig mutation is the same call with
`rig exec start rig -- <arguments>`. Every call is one async rig process, timed out, reported as data and never thrown;
a call in flight counts for `hub.busy()`. The client is `plugin/src/hub/rig-exec.ts`, the run bookkeeping
`plugin/src/hub/exec.ts`.

The hub learns the state **only from `rig exec status <id> --from <offset>`**: `state` (`running` or `ended`), the
`end` (`exit` with a code, `stopped`, or `lost` with a reason), for a rig run the `result` object rig printed, and a page
of the log (`from`, `to`, `size`, `text`; at most 64 KiB, offsets in bytes). The hub polls a running run once a second
(`EXEC_CHECK_MS`, an injected timer) and reads pages until it has all of the log. The usual case and the case "the hub
restarted while the command was running" are the same code.

The hub's own state is `exec-runs.json` in the state folder: for each launch its id, the rig run id, the session, the
message `message_id`, the shell, the text, the folder, the state, the byte offset it has read to, how it ended, and whether
the result was delivered to the agent. Nothing is migrated from the old `execs.json`, `exec/` folder or runner files; the
hub ignores them. A restarted hub reads `exec-runs.json` and goes on with every unfinished run by its run id: it reads
the log again from a little before the saved offset (64 KiB), so the card has a tail at once. A run that ended while the
hub was down gets its final card at the start. "Stop" is `rig exec stop <id>`.

A result that did not reach the agent (the session was starting and the start failed; the hub crashed between the end of
the command and the delivery) is sent again when the session connects.

A command that finished while the hub was down gets the final card at hub start at once, but its result does not go to
the agent at once: session windows are just reconnecting at that moment, and starting a second copy of the session or
"not delivered" would be a mistake. The window gets the result when it connects. A command that finished in the first
10 s after the hub start waits the same way if its session has no window at that moment; with a window it goes at once.
After 10 s from the start the results of sessions that still have no window go the normal way: `rig session run <id>`, holding the result until the window connects. No hub launch setting is required.

A run rig reports as `lost` (the process disappeared) shows "⚠️ interrupted: <reason>", and the agent gets the same with
the log tail. rig answers "unknown run" for a run it no longer keeps: the hub ends it as lost too. If rig cannot be
reached, the hub never ends the run itself: only rig knows a run is lost (its own `end.kind: "lost"`, from its heartbeat).
The first failure is logged; after a minute (`RIG_SILENT_NOTE_MS`) the card of the running run gets a line saying rig is
not answering, with the failure; the polling goes on and the line goes when rig answers again.

### The log

The hub keeps in memory the end of each running run's log, at most about 1 MiB of text (`LOG_KEEP_CHARS`): the card and
the report to the agent are made from it. The whole log stays with rig (`rig exec status <id> --from 0`).
The file that goes to Telegram is not made from that tail. When a run ends, the hub reads the log from byte 0 to its
size, page by page (`exec-log.ts`, pages of at most 64 KiB), and writes it to a temporary file as it reads, so the
whole log is never in memory; a hub restarted in the middle of the run sends the same file. A file over Telegram's
50 MB limit (`TELEGRAM_FILE_LIMIT`) is cut from its start, begins with a note that says so (`execLogTrimmed`) and
holds whole lines of the log (a rig run) or what is left of the cut (any other, a character cut in half is dropped).
The temporary file is deleted once the hub has copied it. If rig cannot give the pages, the file holds what the hub
keeps in memory instead, and the hub logs a warning. The work runs through `deps.spawn`, so the hub is busy until
the file is sent. Carriage returns (progress bars) are collapsed: of a line, what is after the last `\r` remains.
The run store marks the file (`logFile`): `owed` is saved with the end of a run whose log does not fit the card, `sent` once
the file was handed over. A restarted hub builds and sends the file of every ended run still `owed` (size and result
read from rig again; with rig unreadable it stays owed) and never one marked `sent`: each file goes out once.

### Card

Uses the same message queue and edit logic as subagent cards (outbox, throttling, "not
modified" is not an error, `cards.json`). The tail is the last lines of the log, trimmed by length so that the
card fits in a message.

## Known gaps of the move

- A running run costs one rig process per second (the poll). Fine for a few runs, not for dozens.
- The log the card and the report show is capped in memory (see "The log"); the file is not.
- A hub that dies while `rig exec start` is in flight: the record (chat, message id, `pending`, `starting`, no rig id) is
  saved before every start (shell commands, rig mutations, the Run button) and gets the rig id once start answers; a
  failed start ends the record as `failed` (its own end kind, not `lost`): the card says "did not start" with rig's message. A restarted hub finds a record still `starting`, marks it
  `startUnknown` and does not start it again, nor on redelivery; its card says the outcome is unknown because the hub
  restarted while starting it. Such a run, if rig did start it, stays an orphan in rig. The Run button on that card may
  start it again (an explicit user action).
- A file over Telegram's 50 MB limit is cut from its start with a note, as before the move.
- The `/bash` smoke commands in `scripts/check-hub-service.ts` need a rig that has `rig exec`.

## Security

`/pwsh` is execution of arbitrary commands on the machine, bypassing Claude Code's permission mode. The boundary is
the same as for messages and buttons: the group from the config plus `allowFrom`. This adds no new way around it;
the README says plainly that getting into `allowFrom` now means getting a shell. The command text goes to rig on stdin,
never into an argument or a quoted template. The working folder goes as the argument `--cwd`; a folder with a quote,
`%` or a line break is refused on Windows, where the call is one `cmd /c` line.

## Decisions made

- The hub starts no process itself: `rig exec` runs the command detached from the hub and keeps its log, so a hub or
  plugin reload never kills it, and the hub holds no shell, environment or kill code.
- Three commands instead of a shell-choice flag: each is visible in the menu, and no prefix needs parsing.
- PowerShell is the default shell (`/pwsh`): it also runs what is usually written for cmd.
- No timeout; several commands can run at the same time.
- Card edit once a minute, 10 lines in the card, 30 lines to the agent, 50 logs kept.
- The agent gets only the result, it does not learn about the start.
- A multi-line `/cmd` is not run, the hub advises `/pwsh` or `/bash`.
- Environment as in a new window and fail on the first error are rig's (see its `rig-exec-design.md`); the hub holds no
  copy.
- A command older than 2 minutes does not run by itself, only by the button; a repeat of the same message is not run.

## Implementation details

- Modules: `rig-exec.ts` (the client of `rig exec`), `exec-runs.ts` (the store `exec-runs.json`), `exec.ts` (runs, polling,
  cards, results to the agent), `exec-log.ts` (the log file made from rig's pages), `rig-output.ts` (words of a rig run).
- Shells that rig cannot start are reported with rig's message; `unavailable(shell)` still hides `/pwsh` and `/cmd`
  while their feature is off.
