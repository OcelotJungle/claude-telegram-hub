# telegram-hub, iteration 2: rich where it fits, permissions from Telegram, subagents, autostart

Basis: `telegram-hub-design.md`. This document changes its requirements 6
(permissions) and 9 (no permanent services).

Hub texts quoted below are English by default and Russian when rig's language is ru, see `language-design.md`.

## Requirements

1. **Subagents.** See what each subagent is doing without cluttering the topic: one message per
   subagent, with its status and the history of its texts (at least the last ten). When the space in the
   message runs out, a new one starts.
2. **Plain text or rich.** No markup: an ordinary message. With simple markup and no longer than
   five lines: an ordinary message with formatting. Longer than five lines with markup, and any tables:
   rich.
3. **Permissions from Telegram.** A permission request arrives in the topic with the buttons "✅ Allow" and "❌ Deny".
4. **Autostart.** A message to the topic of a session that has no window starts Claude Code on the right
   account (`cswap run N`) in the right folder with `--resume`, and the message reaches the agent. A command
   that needs a window also starts the session and runs after the window connects. The hub runs
   always. A handle to start a topic on any account, and a handle to end a session. The launch is rig's
   work (`rig session run`). Double launch of one session is excluded.

## 1. Plain text or rich (`hub/message-kind.ts`)

The agent's text (Markdown) is classified like this:

- there is a table → rich;
- after `toTelegram` there is not a single entity, and the Markdown has no lists, headings, quotes, rules →
  plain text (split into chunks, as before);
- otherwise the screen lines of the formatted text are counted: each line takes
  `max(1, ceil(length / CHARS_PER_LINE))`, `CHARS_PER_LINE = 40` (the bubble width on a phone);
  no more than `MAX_PLAIN_LINES = 5` → plain text with entities, more → rich.

## 2. Permissions from Telegram

The Claude Code protocol: the request is `notifications/claude/channel/permission_request`
with `request_id`, `tool_name`, `description`, `input_preview`; the answer is the notification
`notifications/claude/channel/permission` with `{request_id, behavior: "allow" | "deny"}`. An answer with a
stale `request_id` is silently ignored by Claude Code. There is no "allow always" option.

- The plugin sends the hub `permission {requestId, toolName, description, inputPreview}` while the mode is on.
- The hub puts a message with sound in the session queue: `🔐 Confirmation needed: <tool>`, then the description of the
  specific call (if there is one), then the arguments without the `description` key as a code block.
  The general characteristic of the tool from `description` is not shown. String arguments are printed
  without JSON quotes, multi-line strings keep their line breaks, other values are compact JSON.
  A preview that cannot be parsed (a truncated one included) is shown as text; a complete string field
  `description` is extracted separately. The preview is limited to `MAX_PREVIEW_CHARS`. The buttons are
  `✅ Allow` / `❌ Deny`. `callback_data` is
  `p:<key>:a|d`, the key is a short id that the hub keeps in memory (key → session, request_id,
  message_id).
- `getUpdates` receives `callback_query`. A press is accepted only from the group `groupId` and only from a
  user in `allowFrom`; otherwise `answerCallbackQuery` with a refusal.
- The hub forwards `permissionReply {requestId, behavior}` to the session's plugin, and the plugin sends the notification to
  Claude Code. The message in the topic is edited: the buttons are removed, "✅ Allowed" or
  "❌ Denied" is appended. No session window: "⚠️ The session is not active, the answer was not delivered", the buttons are removed.
- If the terminal answered earlier, the button breaks nothing: Claude Code ignores the answer.

## 3. Subagents

Claude Code writes a subagent to `<transcript folder>/<sessionId>/subagents/agent-<id>.jsonl`, next to it
`agent-<id>.meta.json` (`agentType`, `description`, `model`, `toolUseId`). All records there are
`isSidechain: true`. The end: for a synchronous and a background one, an `assistant` record with `stop_reason` other than
`tool_use` in its file; for a background one also a `task-notification` in the main transcript with `<status>`
(`completed` / `failed` / `killed`) and `<task-id>` = the agent id.

- The plugin (`transcript/subagents.ts`) looks at the `subagents/` folder of the current session once a second,
  tails new files (from the start: the file appears together with the agent) and builds the agent's **card**:

  ```
  🤖 Explore · sonnet · medium
  Explore code
  ⏳ 2 min · 37 actions
  Read app.ts
  ────
  [17:02] <text 1>
  [18:39] <text 2>
  ```

  The header is four lines: agent, model and effort; the task; the status; the current action. A line with no
  data is absent: without a task there is no second line, and the fourth exists only while the agent works and has already called a
  tool. The model in the first line is the model and effort of the agent's last reply (`message.model` and `effort` of the
  `assistant` record; another name as is, `<synthetic>` is skipped). Before the first reply it is the alias
  from the launch (`model` in meta), if there is one. The codex card: see `codex-card-design.md`.

  **Model version** (`transcript/model-versions.ts`). A Claude name is split into a line and a version:
  `claude-opus-5-5` → `opus` and `5.5`; a Codex name the same way: `gpt-6.1-sol` → `sol` and `6.1`. The plugin remembers
  the newest seen version of each line in `<stateDir>/model-versions.json`, shared by all
  windows (keys `claude:opus`, `codex:sol`). It sees versions in replies of subagents, of the main session and in the
  `state.json` of Codex tasks. The card writes only the line if the version is the newest seen
  (`opus`), and the line with the version if the plugin has already seen a newer one (`haiku 4.5`). The file is re-read
  when another window changed it; the write goes through a temporary file and is merged with what the file
  already has (for each line the greater version is taken). A corrupt file starts over.

  Status: `⏳` running (time, number of tool calls; the last tool on the next line), `✅ <time> · <actions>`,
  `❌ <time> · <actions>` (error), `⏹ <time> · <actions>` (stopped). The texts are its text blocks and narration in order, each up to
  `MAX_CARD_TEXT = 1500` characters. Before each one is the local time of its record in the transcript
  (`timestamp`, `[HH:MM]`), so it is visible how long ago it wrote that; a text that starts with a
  Markdown block (heading, list, quote, code) gets the time on a separate line.
  The card is Markdown; the hub turns it into text with entities.
- A card is no longer than one message (`MAX_CARD = 3800` characters after formatting). If new text does not fit, the current card
  is frozen (status "⬇️ continued below"), and the next one starts
  with the same header.
- The end of a turn in the agent's file is not yet the end of the agent. Claude Code writes an "API Error: The
  response stopped arriving" record there with `stop_reason: stop_sequence` when only the auto mode classifier's
  answer on a tool call broke off, and the agent goes on; a stop hook can also send
  it on. So the card shows "✅ …" at once, but is closed (`final`) only after
  `SETTLE_MS = 120000` without new records. If the agent went on earlier, the same card is `⏳` again,
  and time and actions keep counting. The same for an agent whose card is already closed and who was written to
  (SendMessage): one agent, one card, and it is edited in place (`reopen`, without `replyTo`),
  the previous texts stay, time and actions continue with no gap between runs. A coordinator
  message (a record with `origin.kind = coordinator`: `user` for an idle agent, `attachment`
  `queued_command` for a working one; the agent's first request is not it) adds to the card an entry
  `↪ first line` with the time, cut to `MAX_COORDINATOR_TEXT`, and wakes the card at once.
  An overflowing card is split as usual. A `task-notification` closes the card at once: such an
  agent will not go on. The exception is a notification with `<note>This agent stopped with background work
  of its own still running…</note>`: Claude Code sends it with `<status>completed</status>` every time
  a background agent ends a turn while its own task is alive; the agent will go on, so such a notification is not
  the end.
- A plugin restart does not lose the cards of agents that were already in the transcript at start. Such an agent
  "sleeps": the plugin remembers only the size of its file and sends nothing until the file has grown. Then the history
  up to the remembered size is re-read silently, without sending, and the card is restored as it was: texts
  (`shown`, the same parts on overflow), time (start is the time of the first history record, end is the time of the record
  that closed the run) and the number of tools. Parts from before the restart count as shown in the topic, so a new
  part replies to the previous one. If the history ended after a closed run, the agent is sealed, and the next
  record (a coordinator message included) goes through continuation in place (`reopen`, the `↪` line), as in the
  live path. If the history ended in the middle of a run, the card continues in place. After restoring,
  the card is always continuable (`reopen`). For `codex` and `volunteer` executors, after restoring their task
  is polled once, silently. Agents that appeared after the plugin start are read from the start of the file, as
  before.
- An agent that has ended a turn may wait for its own background task: the plugin tracks its id from the agent's records
  (`toolUseResult.backgroundTaskId` for a background Bash, `toolUseResult.taskId` for Monitor, `toolUseResult.agentId` with `isAsync: true` for a background
  agent), and the task
  ends with a `<task-notification>` with `<status>` (any; a Monitor "Monitor event" notification without
  `<status>` is not an end) or with a `TaskStop` result. The end of a turn with a live task does not close the
  card and does not write "✅": the status is `⏸ <run time> · <actions> · waiting for a background task <wait time>` (the wait time is updated like
  `⏳`). A record from the agent (it was woken) makes the same card `⏳` again. It waits no longer than
  `WAIT_MAX_MS = 3600000`, then the card is closed as usual, and the next record opens a new one.
  When the last task ends, the `SETTLE_MS` countdown starts anew. The agent's own `task-notification`
  closes the card at once, task or no task.
- The plugin sends the hub `card {id, sessionId, text, final}` on every change, no more often than once per
  `CARD_EVERY_MS = 3000` per card (the latest state is not lost; `final` as soon as
  the file is read to the end).
- Hub: the first version of the card goes into the session queue as an ordinary chunk (so it stands
  in its place among the texts) and remembers the `message_id`; the next versions are `editMessageText`,
  no more often than once per `CARD_EDIT_MS = 5000`, intermediate ones collapse. While the card is still in the queue,
  a new version replaces the text in the queue. The error "message is not modified" is not an error.
- The hub keeps cards on disk too, in `cards.json` next to `outbox.json` (the last `MAX_CARDS = 200`:
  `text`, `done`, `message_id`), and writes it when a card appeared, went to the topic and finished,
  not on every edit: the plugin will resend the intermediate text anyway. A restarted hub edits the
  same messages further instead of sending the cards again; a finished one stays finished.
- Cards are sent only while the mode is on (like the agent's text).

## 4. Autostart and session control

### The hub runs always

- `TELEGRAM_HUB_IDLE_MS=0` (or `"alwaysOn": true` in `config.json`): the hub does not shut down on idle.
- `scripts/install-hub-task.ps1` registers a Task Scheduler task "at user logon"
  (only in an interactive session, otherwise the session windows are not visible), a hidden window, restart on failure;
  the task runs `bun plugin/src/hub/main.ts` from the repository with `TELEGRAM_HUB_IDLE_MS=0`.
  `scripts/uninstall-hub-task.ps1` removes it. The user installs it himself.
- The windows, as before, start the hub themselves if it is not running.

### What the hub remembers about a session

`SessionRecord` gets `cwd` and `account`. The plugin reports `cwd` and
`configDir` in `hello`/`session`; the account is the number at the start of the cswap profile folder name (`…\sessions\1-user_example.com`
→ `1`), otherwise not set. The last value is remembered. For old records without `cwd` the hub takes
`cwd` from the session transcript (the `cwd` field of the records) in `~/.claude/projects/*/<id>.jsonl`.

### Launch

The hub has no launch command of its own and no `launch` config section (an old one is ignored with an info log
line). A session is started by `rig session run <id> [--account <n>]`; rig owns the terminal, the Claude command, the
checks of the folder and the account, and the process. See `rig-integration-design.md`.

- A message (or file) to the topic of a session without a window: the hub answers "🚀 Starting the session
  (account N)…", calls `rig session run`, and the message waits in memory. When the session connects, the hub
  delivers the waiting messages (after `READY_DELAY_MS = 1500` from hello, so Claude Code has time to register the
  channel) and writes "✅ Session started". If it did not connect within `CONNECT_WAIT_MS = 90000`: "⚠️ The session
  did not start within 90 s", the waiting messages are kept for the next start (the topic gets their count). If rig is
  missing or refuses, the topic gets rig's text and the messages are kept the same way.
- Lock: while a session is starting, no second launch is made, and new messages wait together with the
  first. A session window is connected: no launch.
- Account: `/run N` → N; otherwise the last known one of the session; without accounts none is passed.

### Commands in the topic (handled by the hub)

- `/run [N]` — start the topic's session (on account N). Already running: "Session is already running".
- `/stop`, `/cleanup [instructions]`, `/compact [instructions]`, `/rename <name>`, `/mode [mode]` — one `rig session`
  call each; the hub shows the result and rig's errors. See `telegram-hub-design.md`, "Commands from the topic", and
  `cleanup-design.md`.
- A `/cleanup` for a session without a window starts it as a message would, and runs once the window connects.
  `/stop` of a session rig finds not running answers "Session is not running".

The commands are added to the bot menu.

### Without the channel trust dialog

`--dangerously-load-development-channels` asks for confirmation on every launch, and autostart
would stall on it. The user puts this once into managed settings
(`C:\Program Files\ClaudeCode\managed-settings.json`, administrator rights needed):

```json
{ "channelsEnabled": true, "allowedChannelPlugins": [{ "plugin": "telegram-hub", "marketplace": "telegram-hub" }] }
```

and rig launches with `--channels plugin:telegram-hub@telegram-hub`.

## Security

- Permission buttons, `/run`, `/stop` and autostart are accepted only from `allowFrom` in the group
  `groupId`, the same filter as for messages.
- The launch command is rig's; user text never goes into it, and the hub passes only a session id and an account that
  passed its own checks.
- A permission from Telegram is a deliberate weakening: whoever writes to the topic as the user can
  approve commands. This risk is accepted.
