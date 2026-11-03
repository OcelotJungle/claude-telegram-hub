# claude-telegram-hub

### Linux (Ubuntu 24.04)

You need Bun, Git, bash and tmux. Install the plugin dependencies from the lock file:

```bash
cd ~/claude-telegram-hub/plugin
bun install --frozen-lockfile
```

Set up the bot and the group in `~/.claude/channels/telegram-hub/`, as described below. To run the hub
without a window and after a reboot, install the service as your normal user:

```bash
cd ~/claude-telegram-hub
bash scripts/install-hub-service.sh
systemctl --user status telegram-hub.service
journalctl --user -u telegram-hub.service -n 50
```

The install turns on linger with `loginctl enable-linger`. If the server policy requires an
administrator, the administrator runs `sudo loginctl enable-linger "$(id -un)"`.
The service installs dependencies with `--frozen-lockfile`, starts the hub with `--always-on`
and keeps tmux and separate commands alive when it stops (`KillMode=process`).
To remove it, run `bash scripts/uninstall-hub-service.sh`. Linger stays on for the user's other services.
The install puts a `service-managed` file in `~/.claude/channels/telegram-hub/`. While the file exists, Claude Code windows
only wait for the hub and connect to it. They do not start the hub themselves (the service keeps it running and restarts it).
If the service is already installed, reinstall it with the same script. Otherwise the file will not exist.

Example `launch` in `config.json` for plain Claude without cswap:

```json
{
  "launch": {
    "command": ["tmux", "new-session", "-d", "-s", "claude-{session}", "-c", "{cwd}", "--", "claude", "--dangerously-load-development-channels", "plugin:telegram-hub@telegram-hub", "--resume", "{session}", "{mode}"],
    "timeoutSec": 90
  }
}
```

Add this section to the existing config that has `groupId` and `allowFrom`. One tmux session
matches one Claude window and stays alive after an SSH disconnect or a hub restart.
The name to attach to is `claude-<session id>` (`tmux attach -t claude-<session id>`).
Claude may ask you to confirm the channel right in tmux. It is not verified on Linux whether the question repeats on every start
or only on the first one (this needs a check with a logged-in Claude). While the session
waits for an answer, it does not connect to the hub. After `timeoutSec`, the topic says that the session may be waiting
for confirmation in tmux and names the command `tmux attach -t claude-<session id>`. Answer the question there.
You can remove the question completely with managed settings (see the section "Optional: remove the channel question
at start" below).
If the launch command fails in the first two seconds, the launch counts as failed. The topic gets
"⚠️ Cannot start the session: <reason>" with the command's error text, held messages are kept, and the hub does not wait for
`timeoutSec`. If tmux answers `duplicate session`, the session is already alive in tmux (most likely
it waits for an answer in a dialog), and the topic asks you to attach with `tmux attach -t claude-<session id>`.
cswap accounts are optional. Without cswap, use `/run` without a number.
`/bash` uses `bash` from PATH as a login shell. `/pwsh` and `/cmd` are not available on Linux.
The end-of-turn sound in the terminal is off.

Container files and the remaining checks: [docker/ubuntu-24.04](docker/ubuntu-24.04/README.md).

### rig commands

The hub works fully without rig. `/feature` and `/rig` stay in the menu and answer
that rig is not installed. Windows shells work as before in this case.
The hub looks for `rig` in PATH and `~/.local/bin` (`rig.cmd` on Windows).

- `/feature` — list the features from the rig JSON contract.
- `/feature <name> enable|disable` — switch a feature on or off.
- `/rig status` — machine state from `rig status --json`.
- `/rig update` — update the machine.
- `/rig language` — show the language.
- `/rig language en|ru` — switch the language.

These commands are available only to users in `allowFrom`, in General and in session topics.
The answer goes back to the same topic. They are not passed to the agent. The output of commands that change something
is updated in the card as it arrives. Waiting for a lock is not an error
and has no timeout. A running command survives a hub restart.
`/rig language` and `/rig language en|ru` follow the same access rule as `/rig status` and `/rig update`: only `allowFrom` users.

`/feature telegram disable` needs a button confirmation from a user in `allowFrom`.
Before it runs, the hub delivers the command that turns it back on: `rig feature telegram enable` on the server.
On Windows, `/pwsh` and `/cmd` are shown only when the feature is on and available.
If reading the features fails at start, they are closed. If it fails later, the
last known state is kept. `/bash` does not depend on these two features.

rig events from `~/.agent-rig/events.jsonl` arrive in General after the hub starts,
including those collected while it was stopped. `info` is silent. `warn` and `error` come with a sound.
For an update, the hub waits for full idle and empty queues, writes a marker and exits with code 75.
systemd starts it again. Readiness is recorded only after a successful `getMe`.
The hub does not create `~/.agent-rig` if rig is not installed yet.

One Telegram bot serves all Claude Code windows on this machine. Each session has its own topic in a
supergroup with topics. The agent's text arrives in the topic, and replies from the phone go back to the session.
It works with any `cswap` account. Design: `docs/superpowers/specs/telegram-hub-design.md`.

```
window A ─┐                              ┌─ topic "proj · session A"
window B ─┼─ telegram-hub plugin ─ hub ─ Bot API ─ supergroup
window C ─┘  (one per window)            └─ topic "proj · session B"
```

- The **plugin** (`plugin/`) runs in every window as an MCP server. It reads the session transcript and
  forwards the agent's text. It passes messages from the topic to the session.
- The **hub** is the only process that polls the bot. The first window that finds no running hub
  starts it. Closing any window, including the one that started the hub, does not affect the others. The hub
  exits by itself 5 minutes after the last window closes, but not before it has sent everything
  in its queue. A hub started from a Task Scheduler task (`scripts/install-hub-task.ps1`), with
  `TELEGRAM_HUB_IDLE_MS=0`, or with a `launch` section in `config.json` never exits.
- State lives in `~/.claude/channels/telegram-hub/`, one for all `cswap` profiles.

## How to use

A Claude Code window started in a terminal writes to Telegram by itself. The topic `<project> · <session name>`
appears when the agent first writes to it. Say in the session "write to me in Telegram". The agent calls
`tg_enable` and creates the topic at once. Say that you do not need Telegram: the agent calls `tg_disable`.
After that, the window does not turn the mode on again by itself, even after a restart and `--resume`. You can turn it on again
with "write to me in Telegram" or with a message in the topic. Then:

**Sound of service messages:** the bot's informational messages, commands and successful results come silently.
Warnings and errors come with a sound. Permission requests and polls that need your answer also come with a sound.
This rule does not change the sound of the agent's text or of the end of its turn.

- The agent's text before a tool call arrives in the topic **silently**.
- The last text of a turn arrives in the topic. It comes **with a sound** if the turn is final and silently if the turn
  is intermediate (see "End of turn" below).
- Your message in the topic gets the ✍ reaction if, 3 s after the hub passed it to the
  session, it is still not in the agent's context. The reaction goes away when the message gets there. If ✍ stays, the agent
  is busy and has not seen the message yet.
- Messages sent together (an album, forwarded messages and text for them) reach the agent as one
  notification. The hub waits for one second of silence, but not longer than 10 s after the first message. A message that starts with `!`
  starts a new batch.
- While the agent works, the bot shows "typing…" in the topic. It disappears when the turn ends, the agent waits
  for an answer to a question, or it is interrupted (Esc).
- A message that starts with `!` interrupts a working agent, like Esc in the terminal, and
  arrives instead of its turn, already without the `!`. The hub removes the sign and marks the message as an interruption.
  The plugin puts it into the window's inbox (socket
  `CLAUDE_CODE_MESSAGING_SOCKET`) with priority `now`. In the terminal it looks like a message from
  another session with the telegram-hub label. For an agent that is doing nothing, such a message arrives as a
  normal one. After you update telegram-hub, restart both the hub and the windows. An old window does not know this label.
- Text arrives as a normal message with Telegram formatting (bold, italic, strikethrough, code,
  code blocks, quotes, links), however long it is. It arrives as a Telegram rich message
  only if it has a heading, a list (any list, with checkmarks too), a table or a divider, at any
  nesting depth. Only this way real headings, lists and tables look right. The reason: Telegram does not
  pass the quote to the bot when the user replies to a part of the bot's rich message.
- Each subagent is one card. The header has four lines: the type, the model and effort of its
  last answer (`Explore · opus · high`; the version is shown only if the plugin has already seen a
  newer one of that line: `haiku 4.5`; before the first answer, the alias from the launch); the task;
  the status (time, number of actions); and the current action while it works. Under the header are the texts it writes, each with the time it wrote it (`[18:39]`). The card is edited in place at most once per 5 s,
  and all cards together at most once per 6 s, and only when the sessions have no unsent text.
  A Telegram group has a limit of about 20 messages per minute, and edits count too. The hub keeps this pace itself:
  no more than 20 sends and edits in any 60 s, and a new message goes ahead of waiting edits. If Telegram
  still answers 429, the hub holds all requests until the end of `retry_after` and does not hammer it further. The time in the card keeps running even when the subagent thinks for a long time and writes nothing (after the first minute,
  once a minute), so you can see it is alive. When the card is full, it closes with "⬇️ continued below" and the texts go to a new one. At the end the status is
  "✅ <time> · <actions>", "❌ <time> · <actions>" (error) or "⏹ <time> · <actions>" (stopped). If the agent goes on after "✅" (the classifier answer
  was cut off, a stop hook), the same card becomes "⏳" again. The same happens when someone writes to it later
  (SendMessage), even if the card is already closed: one agent is one card, it is edited in place,
  the texts stay, and the actions and work time continue (the pause between runs does not count).
  A coordinator message is shown in the card as a line `↪ first line` with the time. If the agent finished its turn but its background task
  (Bash in the background, Monitor, an agent in the background) is still running, the card is not closed: "⏸ <work time> · <actions> · waiting for a background task <wait time>" (the time
  runs like in "⏳"), even if Claude Code has already told the main session "agent completed, waiting for its
  background work". When it wakes up, the same card becomes "⏳" again. It waits no longer than an hour, then closes
  as usual. A new part after an overflow replies to the previous shown part in the topic.
  A new card appears only when forwarding is on.
  A started card is updated to the end, including after a hub restart.
- `codex` and `volunteer` cards show the worker's activity live: replies, the current command,
  the number of actions, the model and the task state, restarts and errors. `reply` and `attach` with a new worker
  continue the same task card in this session: the texts are kept, the actions and work time
  add up without the pause spent waiting for the reply, and the task description is updated. After a plugin restart, or if the
  new worker has already shown its own card, a separate card is created.
- An API connection failure (the answer was cut off, "Connection lost mid-response", or there is no network, "Can't reach
  the API server (ENOTFOUND)") — the agent continues by itself, without you. After 10 failures in a row it stops
  and calls you with a sound. A failure after which Claude Code itself continued the turn (for example, the
  auto mode classifier answer was cut off) does nothing. Limits and other API errors wait for you.
- The agent can send files to the topic (`tg_send_file`): a screenshot, a chart, a log. Photos, video, audio and
  GIFs are shown as in Telegram, the rest as a document. Several photos go as one album. Up to
  50 MB per file and per album: heavy files are split across several albums. Video goes with a preview and duration if `ffmpeg` and `ffprobe` are installed. On
  request the agent sends files as documents, so that Telegram does not compress screenshots.
  It works even if forwarding is off. It is enough that the session has a topic.
- Commands in the topic (they are in the bot menu; the agent does not see them, and they do not change the mode):
  - `/info` — the block "Claude limits": the percent of the five-hour and weekly limits with the time until reset
    (the freshest from all sessions of the same account). Then "Codex limits", if there are readings
    in the rollout logs in `$CODEX_HOME/sessions` (by default `~/.codex/sessions`): percents are rounded,
    and after a reset it shows 0% without time until reset. Then "Volunteer limits", if the script
    `~/.claude/tools/volunteer-models.py` returned data: the percent of the daily limit, the time until reset
    (after a reset, 0% without a suffix), and the providers with a known limit (OpenRouter, Requesty, Groq and others),
    each on its own line: "Requesty: 182/200". A provider without a limit (Zhipu) is not shown. All three blocks show the age of the data from 5 minutes.
    Then the current context and the autocompact threshold, for example `36/250k`. Without a known threshold, only the size is shown.
  - `/compact` (can take instructions, as in the terminal) — the silent message "🗜 Compaction is queued." changes
    to "🗜 Compaction is running…" at start. On success it is edited to "✅ Compaction done." On skip or error it is
    deleted, and a loud warning arrives as a new message.
  - `/compact 333k` (or a number of tokens, or `auto`) — the same as `/autocompact` in the terminal.
  - `/rename <name>` — rename the session. Spaces, tabs and line breaks in the name are collapsed to one space,
    and leading and trailing spaces are removed. `/rename <name>` runs in its terminal as soon as the turn
    ends. In the topic, first the silent "🏷 Rename is queued.", then it changes to "✅ /rename
    <name> done.", or on refusal to the loud "⚠️ /rename <name> failed: …". The topic gets the
    new title when Claude Code writes it, as with any change of the session title. `/rename` without
    a name answers "Write the name: /rename new name" and runs nothing.
  - `/mode` — show the current Claude Code mode and the mode buttons. `/mode <mode>` restarts
    the session at once with `manual`, `auto`, `acceptEdits`, `plan` or `dontAsk` (the argument is case-insensitive).
    `bypassPermissions` is not available. The restart interrupts the current turn, does not start the module and does not run
    a compact. The mode applies only to this launch. The next normal `/run` uses the configuration of
    the launch command.
  - `/info`, `/compact`, `/rename` and `/cleanup` need the session window. If there is no window and `launch` is
    set in `config.json`, the hub starts the session in the usual way, shows the usual launch notifications and
    runs the command after the window connects. For module commands it waits until the module picks the command up.
    Without `launch`, module commands answer "the session is not active right now", and `/cleanup` answers "Session is not
    running". `/stop` for a closed session answers "Session is not running" and does not start it. `/run` and
    shell commands do not need an open window and keep their behavior.
  The commands are run by the function hooks module of the plugin (an early access API of Claude Code): a new version of Claude Code may break it. A window without the module gets, after 10 s, in the topic
  "⚠️ /<command> failed: the window did not pick it up within 10 s.".
- `/run` — start the session of the topic (see "Starting sessions from a topic"), `/run N` — on `cswap` account N.
  `/stop` — end the session: the hub closes the Claude Code process of this window, and the topic shows "⏹ Session
  ended". First the plugin module waits for a compact started from the topic. The silent message about the
  start of the compact changes to "🗜 Compaction is running…", then it is edited to the success result, or on skip or error it is deleted and replaced by a
  loud warning. The notice "⏳ I will end the session after the compaction. A second /stop ends it right away." turns into "⏹ Session
  ended". Otherwise "⏹ Session ended" comes as a separate message. If the context has
  more than 120k tokens, it compacts it by itself (after the current turn), so that `/run` later does not cache
  the whole context again. A second `/stop` ends it at once. A window without the module ends after 10 s. These two
  commands are run by the hub.
- `/mode [mode]` — show the current mode and the buttons, or immediately close the window and start the same
  session with an allowed Claude Code mode: `manual`, `auto`, `acceptEdits`, `plan`, `dontAsk`.
  The buttons do the same. This interrupts the current turn and does not go through the module. Before closing, the hub
  checks the launch command. It must contain `{mode}`. The new window starts when the old Claude Code
  process has ended. If it does not end, the topic shows "⚠️ Mode not changed". The choice is not saved for
  future `/run` commands.
- `/cleanup [instructions]` — compress the context (the instructions go to the compact, as with `/compact`), remove the
  skills that Claude Code keeps in the context after every compact, and end the session. The next
  start (`/run` or a message to the topic) is the same session: the id, topic and history do not change. The silent message
  "🧹 Cleanup is queued." changes to "🧹 Cleanup is running…" at start. On success it is edited
  to "🧹 Cleanup done, skills removed: …" (or "🧹 Cleanup
  done."). On error or cancel it is deleted and the warning arrives as a new message, loud
  by the kind of the message. The end and restart of the session are announced by the usual separate notices. `/stop` during the compression cancels `/cleanup` and ends the window at once. The hub saves the original transcript lines next to it in `<id>.cleanup-<time>.jsonl`. It needs the
  plugin module of this version. Messages that arrive during `/cleanup` go, after any outcome, the usual
  way of a message to the topic of a stopped session, in order, with no limit on the number. They are kept in the hub's memory. For details see
  `docs/superpowers/specs/cleanup-design.md`.
- `/pwsh <command>` — run a command in the session folder in PowerShell, `/cmd <command>` — in cmd (one
  line), `/bash <command>` — in Git Bash. This does not need the session window. The environment is the same as in a new
  terminal window: variables from the registry, profiles are loaded. A chain stops at the first
  failed command, and its code becomes the result. This means the first non-zero exit code, including
  inside loops and blocks. If a non-zero code is expected (robocopy, `git diff --quiet`), wrap the
  command: `cmd /c "… & exit /b 0"`. One card appears in the topic with the time,
  the command, the last 10 lines of output and the button "⏹ Stop". The hub edits it once a minute. When the
  command finishes, the card shows the result (`✅ code 0`, `❌ code N`, `⏹ stopped`), and a log
  longer than the card arrives as a file. The agent wakes up by itself with the result, the tail of the output and the path to the full
  log (`exec\<id>.log` in the hub folder). If there is no window, the hub starts the session when
  `launch` is configured. Otherwise the topic gets "⚠️ The session is not running: the command result was not delivered to the agent". A hub restart does not interrupt the command.
  A command that arrived more than 2 minutes ago while the hub was off is not started by the hub:
  the card has a "▶ Run" button. A command that waits for input hangs until it is stopped.
  There is no timeout.
- A permission request arrives with a sound: "🔐 Confirmation needed: <tool>", then the description of this
  call (if there is one), then the call arguments in a code block. The general description of the tool is not
  shown. There are the buttons "✅ Allow" / "❌ Deny". The answer goes to the session as if
  you pressed it in the terminal. You can also answer in the terminal, and then the buttons do nothing. The buttons
  obey only users in `allowFrom`. Claude Code does not give channels "Always allow".
- An agent question with options (`AskUserQuestion`), when the mode is on, arrives only in the topic, with
  option buttons, "✏️ Own option" and "✖️ Cancel". In the terminal it shows "Waiting for an answer
  in Telegram" at that time. Any message in the topic while the poll is open is a custom answer (commands work
  as usual). A message with "!" cancels the poll and goes to the agent. With no answer in 24 hours, the poll
  moves to the terminal. Claude Code gives the text written in the same step as the question only after the
  answer. So the agent writes the explanation as a separate step and calls the separator `tg_before_question`,
  and asks the question in the next step. Then the explanation arrives above the poll. For details see
  `docs/superpowers/specs/questions-design.md`.
- Typing in the terminal (including in the middle of a turn) does not change the mode: the agent's text still goes to the
  topic. Forwarding turns off only on a request to stop (`tg_disable`). The end of a background task
  and other messages from Claude Code itself do not affect the mode. If you write in the topic, forwarding
  turns on again.
- A document pasted into Telegram (for example, a Markdown file) arrives to the agent as Markdown text.
  The hub downloads the images from it itself, and the agent downloads other files by their `file_id`.
- For a message in the topic of a session that has no open window, the bot answers "the session is not active right now",
  or, if starting sessions from a topic is configured, it starts the session and passes the message.

Messages are not lost and arrive in order. The hub first puts the text into a queue on disk
(`outbox.json`), then sends it. Without a network it retries as long as needed. A crashed hub
continues from the same place after a restart, both sending and receiving (the hub keeps the position in the Telegram update queue in `poll-offset.json`,
so messages that were already handled do not come again).
If Telegram rejected a specific message, then instead of it the topic gets, with a sound, "⚠️ Telegram did not accept the message: …",
and the text stays in `hub.log`.
Files go through the same queue (copies stay in `outbox-files/` until they are sent).
If a message arrives twice, Telegram accepted it and the answer got lost on the way: the Bot API
does not let you tell this case from a failed send.

## Install (one time)

### 1. Group and bot

Create a supergroup and turn on *Topics* in its settings. Add the bot there as an administrator with
the *Manage topics* right. It is the same bot as in the official telegram plugin.

### 2. Token and config.json

Copy the token of the official plugin:

```powershell
New-Item -ItemType Directory -Force "$HOME\.claude\channels\telegram-hub" | Out-Null
Copy-Item "$HOME\.claude\channels\telegram\.env" "$HOME\.claude\channels\telegram-hub\.env"
```

Create `~/.claude\channels\telegram-hub\config.json` (`allowFrom` is your Telegram user id; only
that user can write to the bot):

```json
{ "allowFrom": ["123456789"] }
```

You do not need `groupId` yet: it is easier to find out after step 4. The hub rereads `config.json` on every
message, so you do not need to restart anything.

**Being in `allowFrom` means having a shell on this machine:** `/pwsh`, `/cmd` and `/bash` run
any command, bypassing the Claude Code permission mode.

The hub looks for Git Bash for `/bash` in `C:\Program Files\Git\bin\bash.exe`. If it is installed somewhere else,
add the key `exec.bash` to `config.json`:

```json
"exec": { "bash": "D:\\Tools\\Git\\bin\\bash.exe" }
```

The terminal sound at the end of a turn is set by the key `turnEndChime`: a shell command in which `{kind}`
is replaced with `ask` or `done`. By default, on Windows the system Windows sound plays. A set
command replaces it, and an empty string turns the sound off. A value that is not a string is treated as an error and
replaced with the default. The path in the example is a placeholder: use your own:

```json
"turnEndChime": "powershell -NoProfile -ExecutionPolicy Bypass -File \"C:/path/to/chime.ps1\" -Kind {kind}"
```

### 3. Plugin in all profiles

Every Claude Code profile (`~/.claude` and every `cswap` folder in
`~/.claude-swap-backup\sessions\`) keeps its own plugin list, so you must install in each one.
The script below goes through all profiles. It adds this repository as a plugin source, installs
telegram-hub and disables the official telegram plugin, so that two plugins do not fight over one bot.

```powershell
$repo = 'C:\code\claude-telegram-hub'
$profiles = @("$HOME\.claude") + (Get-ChildItem "$HOME\.claude-swap-backup\sessions" -Directory).FullName
foreach ($dir in $profiles) {
  $env:CLAUDE_CONFIG_DIR = $dir
  claude.exe plugin marketplace add $repo
  claude.exe plugin install telegram-hub@telegram-hub
  claude.exe plugin disable telegram@claude-plugins-official
}
Remove-Item Env:CLAUDE_CONFIG_DIR
```

### 4. Start with the channel

After step 3 the plugin loads in every window, and the agent's text already goes to Telegram. But **replies from
Telegram will not reach the session**: Claude Code accepts incoming messages only from plugins named
at start. So you must start it like this:

```powershell
claude --dangerously-load-development-channels plugin:telegram-hub@telegram-hub
cswap run 2 -- --dangerously-load-development-channels plugin:telegram-hub@telegram-hub
```

On every start Claude Code asks whether you trust this channel. Answer yes. The word
"dangerously" here only means "the channel is not from the official list".

To avoid typing the flag by hand, add a wrapper to your PowerShell profile. The profile is a script that
PowerShell runs when it opens every tab. The path to it is in the variable `$PROFILE`.
Open it (`notepad $PROFILE`; if the file does not exist, create it: `New-Item -Force $PROFILE`) and add the line:

```powershell
. C:\code\claude-telegram-hub\scripts\telegram-hub-profile.ps1
```

The dot and space at the start are not a typo. Without them, PowerShell runs the script and at once forgets everything
it defined. With the dot, the script's functions stay in the current tab. The script defines the functions
`claude` and `cswap`, which add the flag themselves. Commands like `claude mcp list`, `claude -p "..."`,
`cswap list` pass through unchanged. The real programs are still available as `claude.exe` and
`cswap.exe`. The new functions work in new tabs.

Check: in a new tab, `Get-TelegramHubClaudeArgs` must print two lines: the flag and the plugin name.

### 5. groupId

Open a Claude Code window (already with the flag) and write anything in the group. A line
`ignored update from chat -100… (supergroup "…")` appears in
`~/.claude\channels\telegram-hub\hub.log`. Put this number into `config.json`:

```json
{ "groupId": "-1001234567890", "allowFrom": ["123456789"] }
```

### 6. Optional: hub always on

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-hub-task.ps1
```

This creates the Task Scheduler task `telegram-hub` for the current user (no administrator rights needed). It starts the
hub at login in a hidden window and checks every 5 minutes whether it is alive. If the hub is already running,
the new one exits at once. A crashed hub is started again. For each session the hub remembers its folder and the `cswap`
account it last ran on. To remove it, run `scripts\uninstall-hub-task.ps1`.
The install script puts a `service-managed` file in `~/.claude/channels/telegram-hub/`. While the file exists, Claude Code
windows do not start the hub. They only connect to the one the task keeps running. If the task is already created,
reinstall it with the same script. Otherwise the file will not exist.
To restart the hub, for example after updating its code, run `scripts\restart-hub.ps1` (the message queue
is kept, and the new hub delivers it).

### 7. Optional: starting sessions from a topic

You need a hub that is always on (item 6) and a start without the channel question (the next section). Otherwise
the new window will stop at this question. Add a `launch` section to `config.json`:

```json
"launch": {
  "command": ["cmd.exe", "/c", "start", "", "wt.exe", "-w", "new", "-d", "{cwd}", "cmd.exe", "/c",
              "cswap.exe run {account} --share-history -- --channels plugin:telegram-hub@telegram-hub --resume {session} {mode} & exit /b 0"],
  "timeoutSec": 90
}
```

For Linux, for example with `xterm` and `cswap`, the command is passed as separate arguments:

```json
"launch": {
  "command": ["xterm", "-e", "cswap", "run", "{account}", "--share-history", "--", "--channels", "plugin:telegram-hub@telegram-hub", "--resume", "{session}", "{mode}"],
  "timeoutSec": 90
}
```

A message in the topic of a session without a window: "🚀 Starting the session (account N)…", a new Windows Terminal tab
in the session folder with `cswap run N … --resume`, and when the window has connected, the same message is edited to
"✅ Session started", and the message goes to the agent. Messages that arrived before that wait and go
in order. A second start of the same session is not made. When the agent starts working, the start message
is deleted from the topic. If the window did not connect within `timeoutSec`, the message is also deleted, and the loud
"⚠️ The session did not start within N s" arrives.

After a window with the pid of a finishing Claude Code closes, and after the hub ends a window,
any start waits for a common process-exit barrier. If the pid is unknown, the pause is longer than the maximum
plugin reconnect backoff together with jitter. A process that is still alive after the timeout keeps the barrier closed:
the mode change is canceled with one warning, and messages wait for the exit and then go the usual way.
A returning window lifts the barrier and gets the held items. `/mode` shows the mode of this launch
and marks an older record as "Last known mode". A closed session starts even
with the same mode. Both forms of `/mode` answer "Session is already starting" during a restart.
A restart reports 🔁, without the notice "⏹ Session ended".

From the start of a restart, message queues, attachment preparation and command results wait for the new window
and are delivered in order after it is ready. Open polls end at once. If the checks refuse, the launch fails, or the connection times out,
the held items are kept until the next start,
and the topic gets the number of waiting items. `/stop` cancels the start at any stage. If the process
is already running, its window ends when it connects. Items held after the exit is confirmed go the
usual way of a message to a stopped session.

- Account: from `/run N`, otherwise the one the session last ran on. If it is unknown (the window
  of this session never connected to a hub of this version), the session does not start, and the topic gets
  "⚠️ The session's account is unknown, use /run N.".
- A window in a `cswap` profile names the account by the profile folder. A window on the main login (`~/.claude`:
  plain `claude`, and also `cswap run N` when N is the main login) does not name it. The hub asks `cswap status` for its account, and for a session
  it started it takes the account it started it on.
- `--share-history` in `cswap run` gives all accounts one history. Without it, `--resume` on another
  account will not find the session (`/run 2` for a session started on the first account). On Windows it needs Developer Mode
  (Windows developer mode).
- `{cwd}`, `{account}`, `{session}` are substituted into every element of the command. `{mode}` is replaced with
  `--permission-mode <mode>` for `/mode`, otherwise with an empty string. A separate `{mode}` element then
  expands to two arguments or is removed. The hub accepts only `manual`, `auto`, `acceptEdits`,
  `plan` and `dontAsk`. Before the start it checks the session id (UUID), the account (only letters, digits, `.@-_`),
  that the folder exists and that it has none of the characters
  `"%&|<>^`. The text of messages never goes into the command.
- `cmd.exe /c start "" wt.exe`: Bun cannot start `wt.exe` directly (it is an app alias from
  WindowsApps), but `start` can. `& exit /b 0` closes the tab when Claude Code has ended, including
  by `/stop`.
- The config is reread by itself. A section with an error shows in the topic "⚠️ Autolaunch is not set up" with the reason.

### Optional: remove the channel question at start

You can remove the channel question with **managed settings**. These are administrator-level
settings: in companies, the admin uses them to set a policy for all users of the machine.
Claude Code reads them on Windows from the file `C:\Program Files\ClaudeCode\managed-settings.json`,
and on Linux and WSL from `/etc/claude-code/managed-settings.json` (paths from the official Claude Code
documentation, the section Deploy managed settings). Writing there needs administrator rights
(on Linux `sudo mkdir -p /etc/claude-code`, then write the file with `sudo`). It needs two settings:
turn on channels and allow telegram-hub:

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [{ "plugin": "telegram-hub", "marketplace": "telegram-hub" }]
}
```

After that the flag becomes shorter and needs no confirmation:
`--channels plugin:telegram-hub@telegram-hub`. For the profile wrapper, put this before the line with the dot:

```powershell
$global:TelegramHubChannelArgs = @('--channels', 'plugin:telegram-hub@telegram-hub')
```

The downside: the file applies to the whole machine and all profiles, and only an administrator can edit it.

## Language

The hub's texts in Telegram (bot messages, buttons, card labels) are in English by default.
They switch to Russian when the shared rig language is `ru`. To set it, run `rig language ru` on the machine,
or send `/rig language ru` in Telegram. To go back, use `rig language en` or `/rig language en`.
Without rig, the texts are always in English.
This setting changes only the hub's own texts. Agents answer in the user's language regardless.

## If it does not work

Everything the hub sees is written to `~/.claude\channels\telegram-hub\hub.log`. Right after the start there must
be a line `polling Telegram as @bot_name`. If it is not there:

- `no TELEGRAM_BOT_TOKEN` — there is no `.env`, or it has no line `TELEGRAM_BOT_TOKEN=...`.
- `bot token rejected` — the token is wrong.
- `getMe failed (Unable to connect...)` — `api.telegram.org` does not open from this machine. You need a
  system-wide VPN or a proxy: `$env:HTTPS_PROXY = 'http://127.0.0.1:port'` in `$PROFILE` before
  starting `claude` (the hub gets variables from the window that started it; not verified). The hub
  retries by itself. When the network is back, the log will show `Telegram polling works again`.
- `getUpdates 409 Conflict` — someone else uses the same bot, usually the official telegram plugin
  in some window.

After you edit `.env`, restart the hub: close all windows and wait 5 minutes, or kill the process
`bun ...\src\hub\main.ts`. Open windows start a new hub by themselves. The queue is not lost.
`config.json` is reread by itself.

If the log has `delivery to session … is blocked`, the bot cannot write to the group: it was removed,
its rights were taken away, or `config.json` has the wrong `groupId`. The hub waits until this is fixed and retries every
30 s. Messages wait in `outbox.json`.

If the bot is polling but messages from the group do not appear in the log at all, Telegram does not
give them to the bot. In the group card you can see this by the label "has no access to messages" at the bot. This happens
when the bot has privacy mode on and is not an administrator. Fix it in one of two ways:

- make the bot an administrator of the group;
- in @BotFather: `/setprivacy` → the bot → `Disable`, then remove the bot from the group and add it again
  (Telegram applies this setting only when the bot is added).

In General the hub accepts only `/feature` and `/rig` from `allowFrom`. It ignores other messages
(it writes `ignored update ...` to the log): each session has its own topic.

## End of turn

The sound and the notification are decided by the plugin's Stop hook, not by the model. `tg_notify` no longer exists. The hook looks at the
last paragraph of the last text and at `background_tasks`:

- **final `ask`** — the last paragraph has a `?` (code blocks, inline code and links do not count),
  even if background tasks are alive;
- **final `done`** — there is no question and no background tasks;
- **intermediate** — there is no question, but there are background tasks: the agent waits for a monitor, a command or
  a subagent and will continue by itself.

Background subagents are not in `background_tasks`. Their number comes in `turn_duration`
(`pendingBackgroundAgentCount`). While it is greater than zero, the plugin closes a turn without a question as
intermediate, whatever the hook decision is.

The plugin holds the last text of the turn until the turn really closes. The end sign is the
`turn_duration` record in the transcript: Claude Code writes one per turn, after all Stop hooks and
continuations. The turn closes when both `turn_duration` and the hook decision exist. If there is only
`turn_duration`, the turn closes 5 s after it. If there is only a decision, it closes after 30 s of silence: that is how long
a prompt hook, which will still continue the turn, may think. If another Stop hook continued the turn, the text goes silently, and the
next Stop decides. If there is no decision within 5 s, the turn closes as a final `done` (only for Telegram,
with no terminal sound). A decision that arrives after the turn closed is dropped.

- Telegram mode on: the final text arrives with a sound, the intermediate one without. A final turn
  without text after the last tool sends nothing. The terminal sound does not play.
- Mode off: the terminal sound plays when the turn is closed, not when the decision arrived, so a
  continued turn rings once. On `ask` always, on `done` only if at least 30 s have passed since the last input in the
  terminal (or there has been no input in this window yet). The sound is set by `turnEndChime` in
  `config.json`.

## Development

Without installing packages in a worktree, you can check types through an existing dependency tree:
`bash scripts/typecheck-reference.sh /path/to/plugin/node_modules`. It is used read-only.
Container check scripts: `scripts/test-linux.sh`, `scripts/test-systemd.sh`,
`scripts/test-claude-linux.sh`. Helper processes are described in `docker/ubuntu-24.04/README.md`.

```powershell
cd plugin
bun install
bun test          # unit and integration tests on a fake Bot API, without a real Telegram
bun run typecheck
```

To check one commit apart from the working tree, run `bun scripts/test-commit.ts <commit>` (from the root of the
repository). The script unpacks the commit into a temporary copy named like the repository, installs
the dependencies from the lock file there, runs the type check and all tests, and deletes the copy. The full output stays
in `.tmp/test-commit-<sha>.txt`. Do not link the main tree's `node_modules` into the copy:
deleting the copy would follow the link and empty the real folder.

Run a working copy without installing:

```powershell
claude.exe --plugin-dir .\plugin --dangerously-load-development-channels plugin:telegram-hub@inline
```

Variables for tests: `TELEGRAM_HUB_STATE_DIR`, `TELEGRAM_HUB_PORT` (47613 by default), `TELEGRAM_HUB_API_BASE`,
`TELEGRAM_HUB_IDLE_MS`, `TELEGRAM_HUB_POLL_TIMEOUT`, `TELEGRAM_BOT_TOKEN`.
