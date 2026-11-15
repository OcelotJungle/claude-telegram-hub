# The hub on two systems and the link with agent-rig

## Why

`agent-rig` is a standalone application: the `rig` command, with no permanent process, manages the Claude Code harness. The hub is its
add-on for Telegram: it passes commands to `rig`, shows its events, and does not duplicate the logic of `rig`. Both work on
Windows and on Ubuntu 24.04: both on one machine, on a working Windows machine or on a server.

The contract between them is the section "Link with the hub" in `agent-rig/docs/superpowers/specs/agent-rig-design.md`. It is shared: it can be changed
only in agreement for both sides. If it differs from this file, the `rig` spec is right.

The hub forwards messages and runs shell commands without `rig`. Session actions and `/info` require `rig`; when it is missing, they answer with the hub's missing-rig text. There is no fallback session implementation in the hub.

## Platform

The hub chooses behavior by platform in one place; the rest of the code gets ready values. On Windows the behavior does not change.

- **`/bash`.** On Windows, Git Bash, as now. On Linux, `bash` from `PATH`, started as a login shell, the label in the card is `bash`. The
  `bash` value in the config works on both systems.
- **`/pwsh`, `/cmd`.** Only on Windows. On Linux they are not shown in the menu, and a call answers that they are not available on this platform.
- **Starting sessions.** The hub calls `rig session run <id>` with the account it would use for that session. Rig owns terminal selection, launch validation, the Claude command and process liveness. There is no hub launch template. Old `launch` and `exec` config keys are ignored with one info log line each (one list of removed keys with reasons in `shared/config.ts`).
- **Terminals.** Rig selects Windows Terminal, Terminal.app or a Linux terminal, falling back to tmux on Linux. The hub shows rig's launch failure message verbatim.
- **Channel confirmation dialog on Linux.** Whether it repeats on every launch or only on the first one is unknown without a logged-in Claude Code
  and goes to the end-to-end check. It can be removed with managed settings (`channelsEnabled`, `allowedChannelPlugins`); on Linux the file
  is at `/etc/claude-code/managed-settings.json` (official Claude Code documentation).
- **`cswap`.** Optional. Rig decides how to launch with or without it. The hub retains default-login account detection because connected windows and session metadata use it beyond `/run`. Account detection does not run `cswap.exe` where it does not exist.
- **Sound.** On Linux there is no end-of-turn sound: no launch, no error, no log entry.
- **Dependencies.** Starting the plugin and the service installs packages with `--frozen-lockfile`. Otherwise `bun install` can change `bun.lock` in
  the clone, and any local edit stops the whole `rig` update.

## Service on Linux

The scripts `scripts/install-hub-service.sh` and `scripts/uninstall-hub-service.sh` install and remove the user systemd service
`telegram-hub.service`:

- `Restart=always`, started with `--always-on`, packages installed with `--frozen-lockfile` before the start;
- `KillMode=process`: the service stops only the hub itself. Otherwise the tmux server with all sessions, the started
  `/bash` commands, and `rig`, which must outlive the hub on `/rig feature telegram disable`, would die with it;
- `PATH` in the service includes `~/.local/bin` and `~/.bun/bin`: the minimal `PATH` of services does not contain them;
- linger is enabled by the installation, so the hub comes up after a reboot without an SSH login; the installation waits for the user bus;
- `RestartSec=2` and `StartLimitIntervalSec=0`: a fast failure at start, for example without network, must not leave the service in `failed` forever.

The hub handles SIGTERM cleanly: the same shutdown as `stop()`.

### The service manages the hub

The service installation scripts on Linux and the scheduler tasks on Windows create the file `service-managed` in the hub's state directory, and the removal scripts
delete it. While the file exists, Claude Code windows do not start the hub themselves, they only wait for it and connect. Otherwise, during a
service restart a window takes the port before the service, and after `/rig feature telegram disable` it brings up the disabled hub. Without the file, windows
start the hub as before. The file is created before the service or task starts: a window opened during installation does not manage to bring up
its own hub. If the start fails, the script removes the file again (otherwise windows would wait for a hub that nobody starts).

## Session actions

The hub is a thin client over rig for every action on a Claude Code session:

| Topic command | Rig command |
| --- | --- |
| `/compact [instructions]` | `rig session compact <id> [--instructions <text>]` |
| `/rename <name>` | `rig session rename <id> <name>` |
| `/stop` | `rig session stop <id>` |
| `/cleanup` | `rig session cleanup <id>` |
| `/run [account]` | `rig session run <id> [--account <n>]` |
| `/mode <mode>` | `rig session mode <id> <mode>` |

These calls are asynchronous and tracked by the hub's busy state. Their injected deadline exceeds rig's ten-minute compact/rename limit. JSON success data is validated, then rendered with the existing success texts, including token counts, skip reasons, stop compaction outcomes and cleanup results. `session-waiting` progress on stderr shows the existing waiting-for-the-turn text. Rig errors keep their message verbatim; their codes distinguish missing modules (with restart guidance), ended/unknown sessions, timeouts, cleanup that did not compact, and unavailable launch.

Messages, cleanup requests and exec results for a session without a window retain autolaunch through `rig session run`, using the account the hub would have selected. Mode changes make one rig call: the hub has no process-exit gate or mode restart implementation. The hub remains always on so it can launch stopped sessions.

`/info` calls `rig info --session <id>` and renders its validated data directly into the topic, preserving the former window renderer's layout. The hub has no function-hooks module, module polling routes, Claude process-kill code, launch implementation or transcript editing code. Working-directory lookup remains for `/pwsh`, `/cmd` and `/bash`, which still execute in the hub.

The session mechanism, queue, process checks and transcript cleanup are specified by `agent-rig/docs/superpowers/specs/rig-sessions-design.md`, section `rig session`.

## Machine commands

`/rig status`, `/rig update`, `/rig feature`, `/rig feature <name> enable|disable`, `/rig language` and `/rig language en|ru` are executed by the hub itself, only for users from `allowFrom`,
bypassing the agent (`/rig language` follows the same access and output rules as `/rig status|update`; details in `language-design.md`). They work in the shared topic of the group and in any session topic, and the answer comes to the same place. The other commands stay in session topics.

- `rig` is looked up in `PATH`, then in `~/.local/bin`. On Windows it is `rig.cmd`, started through `cmd.exe`. The feature name is checked against a
  whitelist pattern before the start, and the arguments go separately. Rig mutations need a rig that has `rig exec`
  (0.7.1 and newer).
- The hub reads rig through its JSON API and never with `--json`: success is one JSON line on stdout with exit code 0; a
  failure is `{"error": {"code", "message"}}` on stdout with exit code 1, and the hub shows rig's `message` as it is
  (its own failures, such as rig missing or a time limit, keep the hub's texts); progress is JSON Lines
  `{"progress": {"code", "data"}}` on stderr. No code path parses rig's text output.
- `/rig feature` shows the list from `rig feature` (the `features` field of its answer). A bad form of `/rig` or `/rig feature` answers its usage text, which lists the forms. The fields of the contract are parsed; the text is not parsed.
- `/rig status` takes versions from the `releases` and `versions` fields in `rig status` and shows them as `0.2.0 (<commit>)`. If
  `releases` is `null`, only the commit is shown.
- Changing commands (`rig update`, `rig feature <name> enable|disable`, `rig language <code>`) run as a `rig exec` run:
  `rig exec start rig -- <arguments>`, the same mechanism as `/bash` (see `exec-design.md`). The hub starts no process
  of its own for them and writes no log; it polls `rig exec status <id> --from <offset>` and shows the output as it
  appears. If `rig` is busy updating, it prints a progress line about it, and the hub shows it as normal output. Waiting
  is not a failure, and there is no time limit. A failure is only a non-zero exit code of the run.
  The card shows progress and the result in words, never raw JSON. rig keeps the two streams apart: the progress lines
  are the run's log, and the result or the error is the `result` object that rig reports when the run ends. The hub
  reads the log in whole pages and renders only whole lines, so a line cut by a page boundary or by a refresh in the
  middle of a run is not shown, and a restored run goes on from its saved byte offset. The card text, the final text and
  the log file that is sent all come from one renderer
  (`plugin/src/hub/rig-output.ts`), made when they are drawn, in the language current at that moment: all progress
  first, the result always last. A progress code is shown by its words
  (`lock-waiting`, `service-stopping`, `program-install`; the output line of `update-step-output` as it is); an
  empty code shows nothing; a code the hub has no words for, or a known one without its data, is the catalog line
  `rig: <code>`. A result is shown by its words (a feature switched, an update outcome, the language), an error by
  rig's `message` split into its lines (the cause of a failed child is at its end, so the card keeps the last lines
  and the sent file holds all of them). A line that is not JSON (a traceback, cmd.exe text) stays as text. The end of
  the run, not the text, decides OK or failed in the head line. A run that ended without a usable result (rig's
  reasons `empty-result` and `invalid-result`) shows the hub's own line saying so. A query (`rig status` and the like)
  that fails with a non-zero exit code and no error object shows the hub's own text with the exit code and only the
  stderr lines that are not JSON objects, never raw JSON.
  The card of a running `rig` command is checked once a second, but redrawn at once only when the output changed (the line about
  waiting for the lock appears at the moment the wait starts); without new output the seconds counter updates it once per `EXEC_CARD_MS`.
- The requests `rig feature`, `rig status` and `rig info --session <id>` take no lock, so they have a time limit of 30 seconds and do not delay
  receiving messages. Exceeding it counts as a request failure.
- A running command survives a hub restart: the hub resumes it by its run id from `exec-runs.json`, and its end arrives after
  the start. The card shows the end of the log the hub holds (about 1 MiB), not the whole log.
- A stale command and a stale confirmation button are not executed; the limit is the same as for `/bash` (`EXEC_MAX_AGE_MS`, 2 minutes). The `/pwsh` and `/cmd` launch button
  checks the feature state again at the moment of the press.
- A permanent Telegram error when answering a command does not hold the queue: a card that cannot be edited is sent again, and an answer
  that cannot be delivered is dropped with a log entry.
- `/rig feature telegram disable`: a confirmation button, then a message with the command to enable it back (`rig feature telegram enable`
  on the server), then the `rig` launch. Only a user from `allowFrom` can confirm. While the confirmation waits for a press, the queue
  does not forget the numbers of its messages (the button and the text with the enable command), however many other messages go after them: the hub
  puts them in the queue on every tick, and a forgotten number would give a second identical message with a stale button. After the answer
  the numbers are forgotten as usual.
- If `rig` is not found, the commands answer that `rig` is not installed, and stay in the menu.

### Feature state

The hub takes it from `rig feature` at start and on the `features-changed` event. It does not change its own configuration. The bot menu
is updated when the state changes.

| `rig` state | `/pwsh`, `/cmd` on Windows |
| --- | --- |
| not found | work as before |
| answered | work if the feature is enabled and allowed on the platform; otherwise they answer how to enable it, and are hidden in the menu |
| failure at hub start | closed, answer with the failure reason, hidden in the menu |
| failure on a running hub | the last known state stays, the failure is written to the log |

`/bash` is part of the `telegram` feature and does not depend on this table.

## Events

The hub reads `~/.agent-rig/events.jsonl` from the position in `~/.agent-rig/events.offset` (a decimal number of bytes) and polls the file every 5
seconds: this is a reasonable delay for notifications, and watching a file is unreliable across systems.

- Only a complete line is taken, with a newline at the end. An incomplete one waits for the next poll.
- `text` goes to the shared topic of the group: `info` without a sound, `warn` and `error` with a sound.
- The offset is written after Telegram has accepted the message. A failure between sending and writing gives a repeat, not a loss. Parts
  of a long event already accepted by Telegram are not sent again. An event that Telegram rejects waits until the cause is gone.
- The hub handles `features-changed` and `hub-restart-pending` itself and does not write them to the topic. `language-changed` is delivered as a text event (like any text event, to the shared topic) and is also handled as a service event: the hub re-reads the language, then the features, then the bot command menu; see `language-design.md`. An unknown type with `text` is shown. Service
  events are handled at once, even if delivery is stuck: a stuck message must not delay an update.
- A broken line is skipped with a log entry: one corrupted line must not stop delivery forever.
- No file means nothing to read. An offset larger than the file size means `rig` truncated it: reading starts from the beginning. A truncated and
  regrown file is visible by its first line: the hub remembers its `id` in its state directory, and a different `id` also means reading from the beginning.
- While Telegram does not answer or `groupId` is not set, the offset stays in place.

The hub writes files in `~/.agent-rig` atomically, only `events.offset`, `hub-restarting.json` and `hub-ready.json`, and only if the directory
already exists: on a machine without `rig` the hub does not create it.

## Restart on update

The hub remembers the commit of its code at start (`git rev-parse HEAD` in its own repository). The service script determines it before starting `bun`,
so the commit matches the loaded code exactly. If the commit cannot be found, the event is not considered handled: the hub retries
and writes about the failure once to the shared topic.

1. On `hub-restart-pending` the hub compares its commit with the current `HEAD`. If they match, the code is already new: it writes
   `hub-ready.json` again and does not exit. Otherwise `rig` would wait forever: it does not count a readiness older than the moment of the update.
2. The hub waits for idle with no time limit and interrupts nothing. Idle means all of these at once: no turn is running in any session, there are no
   unanswered questions or permission requests, no running `/bash`, `/pwsh`, `/cmd` and `rig` commands, no pending session action or autolaunch and no held messages, and the send queue is empty. A `/bash` command waiting for a
   press of the launch button does not prevent idle. A question or permission request from a closed window does not count: there is nobody left to answer it.
   The queue is counted by what can be delivered: parts waiting for settings do not prevent idle.
3. At the moment of idle the hub writes `~/.agent-rig/hub-restarting.json` (`{"time":"ISO 8601"}`) and exits with code 75. The idle check and
   the exit go with no pause between them, so that a new turn does not slip into the gap.
4. After the start, when `getMe` has passed, the hub reads the previous `hub-ready.json` and writes a new one (`{"commit":"<full hash>","time":"ISO 8601"}`).
   A failed write is retried. After a restart for an update there is no message of its own: the update is described by the `update-ok` event with
   the versions, a rollback by the `rollback` event.
5. If the commit changed without `rig` taking part (the code was changed by hand), the hub reports once to the shared topic that it runs with different code and windows
   will pick it up on their next launch. The participation of `rig` is seen by two signs: `hub-restarting.json` is newer than the previous `hub-ready.json`
   (`rig` does not delete this file, so an old file means nothing) or an unread `hub-restart-pending` event, which
   arrives right after the start; for it the message waits for the first read of events. A rollback returns the commit from the previous `hub-ready.json`,
   so it gives no message. If there is no previous file, there is no message.

`rig` handles the rollback. If Telegram is unavailable at the moment of the restart, there is no readiness, and `rig` rolls the update back after 5 minutes: this is how
the contract treats a hub that did not come up as a failure.

## Checks

- All hub tests pass on Windows and in an Ubuntu 24.04 container (`docker/ubuntu-24.04`, `scripts/test-linux.sh`). The `/pwsh` and `/cmd` tests
  are not run on Linux: those commands do not exist there.
- Commands, events and restart are checked on a fake Telegram and a fake `rig`, with no real waits.
- Session actions use recorded success and failure JSON for all six commands, including skips, a stopped process, missing modules, cleanup without compaction, unavailable launch and streamed waiting progress. Message and exec-result autolaunch are checked through `rig session run`.
- The service is checked by a container with systemd: after the service stops, tmux and `rig` are alive; after the hub crashes, the service comes up by itself; after
  an exit with code 75 with a connected window, the service keeps the port; after the service stops, a connected window does not bring up the hub.
- Internal mechanisms of Claude Code (the socket, the channels flag, transcript paths, the confirmation dialog on launch in tmux) are checked in a container
  with a real Claude Code without logging in to an account. What cannot be checked without logging in is named explicitly and goes to the end-to-end check.
- The end-to-end check with a real Claude and a test bot is done separately, together with `rig`.

## Out of scope

The logic of `rig`, building settings, and updating repositories.

## Language of hub texts

The texts the hub shows in Telegram are English by default and Russian when rig's language is `ru`, see `language-design.md`.
