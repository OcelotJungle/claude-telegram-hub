# claude-telegram-hub — design

The platform layer is described in `rig-integration-design.md`. On Linux, `/bash` runs
`bash` from PATH as a login shell, and `/pwsh` and `/cmd` are hidden and answer that they are unavailable.
There is no turn-end sound in the terminal. The user service `telegram-hub.service` starts
the hub with `--always-on`, `Restart=always`, `KillMode=process` and package installation through
`--frozen-lockfile`; SIGTERM calls the usual `stop()`. Starting a session, its terminal, the account
and the Claude command are rig's work (`rig session run`): the hub has no launch template.

The machine command `/rig` (with its `feature`, `status`, `update` and `language` forms) is accepted by the hub from `allowFrom` in General and in session
topics, without passing it to the agent. Feature state comes from rig's JSON; the hub config is not changed.
Commands that change things use a detached runner, file logs and cards that are separate from
sessions. General replies and Telegram-disable confirmations are saved to disk with retries.
Events are read every 5 seconds by byte offset; the offset is committed after delivery.
A restart for an update waits for all the idle conditions from `rig-integration-design.md`,
writes a marker and exits synchronously with code 75. After a successful getMe, readiness is recorded.
Without rig the hub works as before, and the new commands explain that it is missing.

Texts the hub shows in Telegram are English by default and Russian when rig's language is `ru`, see
`language-design.md` (same folder). The quoted texts below are given in English.

Sound of service messages: informational bot messages, commands and successful results are silent;
warnings and errors have sound. Permission requests and polls that need an answer from the user
also have sound. This rule does not change the sound of agent text or of the end of its turn.

## Goal

One Telegram bot through which any Claude Code session — from any `cswap` account, in any of the
windows open in parallel — can talk to the user in both directions. The user answers
from the phone when away from the computer.

## Requirements

1. **A supergroup with topics.** One topic = one session. Topic name: `<project> · <session name>`,
   nothing else (no account, no time).
2. **The topic is created lazily.** A window started in the terminal gets a topic at the first message
   that has to go to the topic (agent text, question, file, card). The explicit command "write to me in Telegram"
   (`tg_enable`) creates the topic at once if there is none yet.
3. **Session = topic forever.** Sessions are long-lived (one task + all follow-ups, regular compact).
   After `--resume` the session is bound to the same topic. Never close or delete a topic.
4. **Telegram mode:**
   - it is turned on by an explicit user command in the session (`tg_enable`);
   - for a window started in the terminal (`CLAUDE_CODE_ENTRYPOINT=cli`), the hub turns the
     mode on by default on connect, on session change and on reconnect. Windows from other launches (SDK and others) do not
     turn it on by themselves;
   - it is turned off only by an explicit command (`tg_disable`); typing in the terminal does not change the mode;
   - the mode is stored in the session record. `tg_disable` is remembered and is not reset on reconnect or
     when a window moves to this session, until the user turns the mode on (`tg_enable` or a message
     in the topic). When a window moves to another session, the mode of the previous one does not change;
   - on a session change the plugin tells the hub its title and the window's entrypoint. The plugin takes the mode
     from the hub, which applies the same rule as on hello;
   - it turns on automatically when the user writes in the session's topic — without any command
     in the session itself.
5. **What goes to the topic:**
   - intermediate agent text during the work — **without a notification** (`disable_notification`);
   - a question to the user and a task-completion message — **with a notification**, the whole text.
   The "done / ask / nothing" decision is made by the Stop hook (`turn-end-design.md`), not by the agent.
   The sound in the terminal does not depend on the Telegram mode.
6. **Permission requests:** confirming from Telegram is not needed (the user will connect to the machine
   remotely; the agent is almost always in auto mode). A message arrives in the topic saying that
   confirmation is required.
7. **A message to the topic of a closed session:** the bot answers "the session is not active right now".
8. **Messages outside topics** (General, the bot's private chat, other chats, strangers) — ignore,
   except the machine command `/rig` from `allowFrom` in General.
9. **No permanent services.** The hub lives while at least one window is open.
10. **Closing any window, including the one that started the hub, does not break the others.** No window
    may lose the bot until the terminal is restarted.
11. Do not require env variables on every start.

## Why not the official plugin `telegram@claude-plugins-official`

- Each `server.ts` instance kills the previous poller (`bot.pid`) at start — parallel windows
  take the bot from each other; the last one started gets the messages.
- No topics, no routing by session.
- It keeps state in `${CLAUDE_CONFIG_DIR}/channels/telegram` — for `cswap run` that is the profile folder
  (`~/.claude-swap-backup/sessions/<N>-<email>`), not `~/.claude`.

We take it as the base (bun + `@modelcontextprotocol/sdk` + `grammy`, capability `claude/channel`,
incoming delivery through `notifications/claude/channel`, accepting `permission_request`); the source is `server.ts` of the official plugin from the Claude Code plugin cache. The official plugin is
disabled in all profiles after the rollout.

## Architecture

```
 window A (acct 1)       window B (acct 2)       window C
 claude --channels       claude --channels       ...
   └─ plugin telegram-hub        └─ plugin telegram-hub
        │  (session A)          │  (session B)
        └──────── localhost IPC ┘
                     │
                 HUB (one per machine, a separate process)
                     │  getUpdates / sendMessage / createForumTopic
                 Telegram Bot API ── supergroup with topics
```

### Components

**Plugin `telegram-hub`** — an MCP server, one instance per window. It knows its session ID from
`CLAUDE_CODE_SESSION_ID`. It does not talk to Telegram directly — only to the hub.
It is responsible for: the link to the hub, watching its session's transcript file, delivering incoming messages to the session,
forwarding permission requests.

Agent tools:
- `tg_enable` — turn the mode on: the hub creates a topic (if there is none yet) or takes the existing one.
- `tg_disable` — turn the mode off; the window does not undo such a switch-off by itself.
- `download_attachment(file_id)` — download a file/photo sent to the topic.
- `tg_send_file(paths, caption?, as_document?)` — send files to the topic (see "Sending files").
- `tg_before_question` — a separator before `AskUserQuestion`: it does nothing, it only separates the step with
  the explanation from the step with the question, so the explanation arrives in the topic above the poll (see
  `questions-design.md`, "Text before a question").

There is no separate "reply" tool: all agent text is delivered by forwarding (see below).

Commands from the topic that act on a session are `rig session` calls made by the hub (see "Commands from the topic").

**Hub** — the only process that polls the bot. It creates topics, routes incoming messages
by `message_thread_id` → session, sends outgoing ones, and keeps the session table.

**State** — in `~/.claude/channels/telegram-hub/` (a shared folder, not a `cswap` profile; the path does not depend on
`CLAUDE_CONFIG_DIR`, so all accounts see the same thing):
- `.env` — `TELEGRAM_BOT_TOKEN` (currently in `~/.claude/channels/telegram/.env`, to be moved);
- `config.json` — `groupId`, `allowFrom` (for example `["123456789"]`);
- `sessions.json` — `sessionId → { topicId, title, project, enabled, disabledByUser }`; only the hub writes it.
  `topicId` is absent until the topic is created; `disabledByUser` is present while the user has turned the mode off explicitly;
- `hub.log`, `inbox/` for downloaded attachments.

### Data flows

**Turning on.** The user asks → the agent calls `tg_enable` → the plugin passes the hub the `sessionId`,
the `cwd` and the path to the transcript file → the hub:
- the session is in `sessions.json` → `enabled = true`, `disabledByUser` is cleared; the topic is the same
  if there is one (`topicId`), otherwise it is created now (`createForumTopic`);
- the session is not there → `createForumTopic("<project> · <name>")`, a record in the table, `enabled = true`.

**Terminal window.** The plugin passes `CLAUDE_CODE_ENTRYPOINT` and the current session name in `hello`.
The hub: `entrypoint = cli` and no record → a record with `enabled = true` and no topic; a record that is off, but
not explicitly (no `disabledByUser`) → `enabled = true`; an explicitly turned-off one, and any other `entrypoint`
→ no change. The topic of such a session appears at the first message into it (see "Forwarding agent text").

The project is the name of the `cwd` folder. The session name comes from the transcript file: the name from `/rename`, if there is one
(a `custom-title` record), otherwise the automatic title
(`{"type":"ai-title","aiTitle":...}` — confirmed). If the session name later changes,
the hub renames the topic (`editForumTopic`). While there is no topic, the new name is only remembered and
goes into the topic name when it is created.

**Incoming to a topic.** The hub gets an update:
- the sender is not in `allowFrom`, the chat is not `groupId` → ignore; in General only `/rig` passes;
- the topic is not found in the table → ignore;
- the session's window is not connected to the hub → reply in the topic "the session is not active right now";
- otherwise → `enabled = true` (if it was off; `disabledByUser` is cleared) and delivery to that session's plugin → the plugin sends
  `notifications/claude/channel` (tag `<channel source="telegram-hub" ...>`). Photos/documents — as
  in the official plugin (`image_path` / `attachment_file_id`).
- a formatted message (Bot API 10.1, field `rich_message`): this is how Telegram sends a pasted
  document, for example a Markdown file — without `text`, as a tree of blocks. The hub turns it into Markdown:
  headings `#`, paragraphs, lists with Telegram's labels and `[x]`/`[ ]`, code in ```` ``` ````, quotes `>`,
  GFM tables, `**bold**`, `*italic*`, `~~strikethrough~~`, `` `code` ``, links `[text](url)`,
  formulas `$…$`. Media stay in their place in the text. The hub downloads photos to `inbox`, like a photo message:
  "(photo: path) caption". Other files, and a photo that failed to download, are named by their `file_id`
  for `download_attachment`: "(document: name, file_id: …)", "(video, file_id: …)". An unknown kind
  of block or text — its text;
- a reply to a message goes before the text, as Telegram shows it: the label `[reply to your message]`
  (a reply to this bot, by its id from `getMe`), `[reply to the user's own message]` or
  `[reply to a message from <name>]` (other bots too), then the original as `> ` lines, then an empty
  line and the text. If there is no text (a lone `!`), only the reply remains. Original text longer than 300 characters (the media
  mark does not count, emoji are not cut) is truncated, and `(message shortened)` stands under it.
  For media in the original there is a mark of its kind ("(photo)", "(document: name)", "(voice message)") and the caption;
  nothing is downloaded. A quote from a message gives `[quote from …]` and goes whole. A reply to a
  message from another chat is `[reply to a message from another chat: <source>]` and the quote.
  The topic's service message (the root that every message of the topic "replies" to) does not
  count as a reply;
- a forwarded message starts with the line `[forwarded from <name>]`: a user, a hidden
  user, a chat or a channel (with the author's signature, if any); an unknown kind of source —
  `[forwarded]`. A forwarded message starting with `!` does not count as an interrupt: it is someone else's text;
- interrupt: a message whose own text or caption starts with `!` (not forwarded)
  interrupts the working agent. `!` is a signal for the hub only: the hub removes it and the spaces after it
  from the text and sends the window a notification with the flag `interrupt: true`. The plugin interrupts the agent
  only if the flag is present and the agent is working. The agent counts as working through its turn, except while it
  waits for the answer to a poll; any tool result in the transcript, the poll's answer included, makes it working
  again. Text starting with `!` without the flag (for example, a pasted document)
  arrives as a normal message. A lone `!` gives an interrupt with an empty message. The hub makes its own checks for
  `!` (straight to the window during `/cleanup`, a new batch) on the original text from Telegram.
  After updating to this scheme, both the hub and the windows must be restarted: an old window does not know the flag and does not
  interrupt;
- messages sent together (an album, several forwarded messages and text for them) arrive to the agent in one
  notification. The hub collects the topic's messages and sends the batch when there have been no new ones for 1 s, but no later than 10 s
  after the first. Messages in the notification are separated by an empty line. Files are named in the text after
  the message text: a photo — "(photo: path)", the rest — "(document: name, file_id: …)" and so on.
  The meta (chat, user, time) is taken from the first message. A batch of one message goes as before, with the attachment in the meta.
  A hub command first sends the waiting batch, then runs (`/mode` and `/stop` do not send it: they capture it into the
  hold of the session action). A message starting with `!`
  sends the waiting batch and starts a new one: only the first message of a batch can interrupt the agent. ✍ is put on
  every message of the batch; the plugin reports the first, and the hub removes ✍ from all. Messages held
  during startup or a mode restart are joined the same way: consecutive ones go as one batch; a batch waiting during that
  time takes its place among them in order of arrival. If the window closed while the batch was waiting, its
  messages go as to an inactive session (hold for launch, launch, or say "not
  active"). On stop, the hub first stops taking updates, then sends all waiting batches;
- a message with no content (a service message) → ignore; the names of its fields go to the log, so a new kind of
  message is visible; every delivered one is a line in the log: number, topic, session, kind, length and formatting types,
  without the text.

**A message from the terminal.** It does not change the mode, including a message typed in the middle of a turn. The plugin
reads such records from the transcript file for two things: a turn that closed right after the input
is closed quietly (the hub gets the decision without anything sent to the topic), and the 30 s for the terminal sound
are counted (`CHIME_MIN_TURN_MS`). A message between turns is a `user` record with `origin.kind:"human"`; one typed in the middle
of a turn is an `attachment` record with `attachment.type:"queued_command"` and `attachment.origin.kind:"human"`.
Turns are also started by Claude Code itself — background tasks and Monitor (`task-notification`), messages from the channel
(`channel`), subagent reports (`peer`); such prompts do not touch the mode either.

The mode is turned off only by the explicit command `tg_disable`. On turn-off the plugin reads the rest of the transcript file and
sends the deferred text: the final text of a finished turn — with sound if the Stop hook decided the turn is final;
an intermediate one — without sound. The hub delivers everything the plugin sent if the session has a topic: the
plugin decides, because only it knows when the text was written.

**Forwarding agent text** (only while `enabled`):
- assistant text means text blocks and narration blocks: a `thinking` block with non-empty text and
  type `narration` in the signature (`signature` is base64 protobuf, with the string `thinking` or
  `narration` at the start). Claude Code shows narration in the terminal as normal text. Ordinary thinking
  blocks in the file are empty. A thinking block with text and an unknown type is written to the log as a warning;
- an assistant text block followed in the turn by a tool call is intermediate →
  straight to the topic without sound;
- the last text block of a turn is sent only after the turn ends: with sound if the turn
  is final, otherwise without. How this is decided is in `turn-end-design.md`. Every text is delivered at least once; a duplicate is possible
  only if Telegram accepted the message and the reply was lost (the Bot API has no idempotency key).
- Only assistant text goes to the topic: no tool calls, their output or hidden reasoning.
  The Claude Code stub "No response requested." (an assistant record with `model: "<synthetic>"` without
  `isApiErrorMessage`) is not agent text: it does not go to the topic, and the turn simply ends on it. There are no other such
  stubs in the transcripts; API error messages are also `<synthetic>`, but follow their own rules.
- The agent's Markdown goes as a rich message only with a heading, list, table or divider, otherwise as a
  normal message with formatting; long text is split into several messages (see "Formatting").

**API connection failure.** When the connection to the API failed, Claude Code writes an assistant record with
`isApiErrorMessage: true`, `error: "server_error"`, `stop_reason: "stop_sequence"`; the text is
one of these:
- "API Error: Connection lost mid-response. The response above may be incomplete." or "API Error:
  The response stopped arriving. …" — the response was cut off, with `truncatedAfterOutput: true` if part of it
  had already arrived;
- "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)", "API Error:
  Connection refused — a firewall or proxy may be blocking it…" — the request did not reach the API.
Such a record is not yet the end of a turn. Claude Code also writes it when only the auto mode classifier's answer
for a tool call was cut off (the call gets the result "classifier gave no verdict" and the turn goes
on), and before it retries the request itself. The turn ended on it only if, right after it, before the
next assistant record, there is a `system` record with `subtype: "turn_duration"` — this is how Claude Code closes
a turn when its attempts have run out (checked against all available transcripts: closed turns and continued ones
are told apart this way without exceptions). The error text is not the agent's and does not go to the topic. If the turn ended on a failure and the mode
is on, the plugin continues for the human:
- to the agent through the channel (`meta`: `user: telegram-hub`, `reason: response_cut`) — in English: "telegram-hub: your
  last turn ended with an API connection error (…), so your last response may be missing or
  incomplete. Continue from where you stopped.";
- no more than 10 times in a row: the counter is reset by any other turn end. Each continuation again
  goes through Claude Code's retries, so 10 times also covers a long network outage. On the 11th failure in a row —
  to the topic with sound "⚠️ The API connection failed 10 times in a row, the agent stopped.",
  nothing to the agent; after that, silent until a normal turn end;
- the mode is off — nothing: a human is at the terminal. Failures recorded before the window started are history.
Other API errors (`rate_limit`, `authentication_failed`, `invalid_request` — for example, safeguards
triggered) are not about the network: a retry will not help, a human decides.

Turn end: the main source is the plugin's `Stop` hook (it gets `session_id` and `transcript_path`),
the fallback is `stop_reason: "end_turn"` in the transcript file.

**Formatting.** The agent writes Markdown (CommonMark + GFM; the terminal shows it the same way). The hub
parses it with the `marked` lexer (`plugin/src/hub/message-kind.ts`). Text with a heading, a list (any kind,
at any depth), a table or a divider goes as a rich message (Bot API 10.1, `sendRichMessage`) as a
tree of blocks, not as a `markdown` string. The rest of the text (bold, italic, strikethrough, code, code blocks,
quotes, links) goes as a normal message with `entities`, however long it is. The reason: Telegram does not
pass the bot a quote when the user replies to part of the bot's rich message. Telegram's own Markdown parsing drops unknown tags
(`<channel>` disappears), joins lines and turns `$…$` into a formula. Blocks carry the text literally.
Mapping:
- heading → heading of the same level, paragraph → paragraph (a single line break stays a
  line break), code block → pre with the language, quote → blockquote, divider → divider;
- list → list: a nested one goes inside the item, a numbered one has `value` from its own start, tasks have
  `has_checkbox`/`is_checked`;
- table → table with a border and stripes; alignment from the separator, by default the header is
  centered and cells are left-aligned;
- `**…**`/`__…__` → bold, `*…*`/`_…_` → italic, `~~…~~` → strikethrough, `` `…` `` → code;
- a link `[text](url)` → url, if the url is `http(s)://` or `tg://`; otherwise "text (url)"; a bare
  link and a link whose text equals the url are plain text (Telegram makes it a link itself);
  an image `![alt](url)` is treated as a link;
- HTML is text; HTML entities (`&amp;` and so on) are expanded.

Length. Telegram documents a limit of 32768 characters (more gives `RICH_MESSAGE_TEXT_TOO_LONG`), but
it silently cuts Cyrillic at about 35000 bytes. So the hub splits the text between top-level blocks into
pieces of no more than 30000 bytes of source Markdown and no more than 500 blocks (nested blocks,
list items and table rows are counted). Footnote links `[x]: url` are resolved over the whole text. One block
above the limit (a huge code block) goes as plain text with `entities` (below), in pieces of ≤ 4096.

The fallback path is plain text and `entities`, not `parse_mode`: there is nothing to escape, and a piece of long
text is a piece of plain text with the entities cut to it. If Telegram rejected the rich message,
the hub sends its source this way (WARN in the log); if it rejected that too — without entities (WARN); if it rejected that too —
a notification, as before. Captions to files also go this way: `sendMediaGroup` has no rich messages.
Mapping on this path:
- inline formatting — as above, code block → pre with the language, quote → blockquote (a nested one gets no
  second entity: Telegram does not nest them), link → text_link;
- heading → a bold line; list → lines with "•" (a nested one indented, "◦"), numbered — "1.", tasks —
  "☐"/"☑"; table → a monospace block (pre) with aligned columns; divider →
  "———";
- pieces of ≤ 4096 characters of plain text are split by paragraphs, lines, words; an entity on the boundary is
  divided between pieces; a surrogate pair is not split; spaces at the edges of a piece are trimmed.

The hub's service texts (confirmations, notices) are not parsed and go as plain text.

**Sending files.** The tool `tg_send_file(paths: string[], caption?: string, as_document?: boolean)`:
- works if the session has a topic, even with the mode off (the agent sends a file on an explicit
  request); with no topic it is an error "run `tg_enable` first";
- before sending, the plugin checks: each path (a relative one is from `cwd`) is a non-empty file of at most
  50 MB and not from the state folder (except `inbox/`); the caption after Markdown parsing is no longer than 1024
  characters. Any error — nothing is sent, and the agent gets the reason;
- type by extension: photo — jpg/jpeg/png/webp (over 10 MB — as a document), video — mp4, audio —
  mp3/m4a, gif — animation, the rest — a document. `as_document: true` — all files as documents, without
  Telegram recompression (screenshots where pixels matter);
- video: before the first send the hub finds out through `ffprobe` the size (accounting for rotation in clips
  from a phone) and the duration, and `ffmpeg` makes a preview — a JPEG up to 320 px on a side and under 200 KB,
  a frame at about the first second, next to the copy. Without them Telegram shows a large video as a black
  square with no duration, and it has to be downloaded to watch. The hub passes `width`, `height`,
  `duration`, `supports_streaming` and `thumbnail` (in an album — `attach://thumb<i>`). The result
  is stored in the queue item and is not recomputed on retry. No `ffprobe`, or the file is not a video —
  the video goes as before, WARN in the log; no `ffmpeg` — no preview. The preview is deleted together with the copy;
- albums: consecutive photos and videos make one album, consecutive documents another, audio a
  third; up to 10 per album and no more than 50 MB for the whole album (Telegram's limit is per whole request,
  more gives a 413 reply); a single item and an animation go as a separate message. The order of files
  is kept. The caption is on the first sent message (for an album — on the first item,
  Telegram shows it under the album);
- order with text: files go through the same hub queue as text. Before that the plugin reads the rest of the
  transcript file and sends the text written before the call — it goes before the files;
- sound: while the mode is on — without sound (the turn summary will come with sound), off — with sound;
- the plugin copies the files into `outbox-files/<id>/` of the state folder (the agent may delete or change
  them right after the call) and passes them to the hub like text: with an id, until confirmed, with a retry after
  reconnect and through `spool/`. The hub accepts paths only from `outbox-files/` and puts them in a queue
  on disk, one item per Telegram send — a retry after a failure does not duplicate an album that already
  went. Copies are deleted when their item leaves the queue;
- the upload is `multipart/form-data`; the attempt timeout grows with the size;
- Telegram rejected a photo (`PHOTO_…`, `IMAGE_PROCESS_FAILED` — for example, unsuitable dimensions) —
  the hub sends those photos as documents. 413 (Request Entity Too Large) is not retried: an album goes
  one file at a time, a single file is a failure. Any other refusal and a missing copy go to the log as ERROR and to the agent
  ("<names>: <reason>"); nothing to the topic: the agent sent the files, so it decides (compress, send
  another way);
- the tool waits until the hub has sent everything (up to 150 s) and reports the result, including a refusal. If it did not
  wait long enough (no network) — it reports that the files are queued and will go when Telegram becomes available.
  The hub sends the result (`filesSent`) to the window that sent the files; if there is none (the hub restarted, the window has not
  reconnected yet), the result waits for this session's `hello`. A retry of files already sent after
  reconnect gets the result at once. A result with a refusal that arrives when the tool has already returned
  is passed by the plugin to the agent through the channel (`meta`: `user: telegram-hub`, `reason: files_rejected`) — in English:
  "telegram-hub: Telegram did not take files you sent earlier with tg_send_file: <names>: <reason>. The
  topic was not told. Deal with it yourself: …".

**Permission request.** The plugin gets `notifications/claude/channel/permission_request` → the hub sends
to the topic with sound: "🔐 Confirmation needed: `<tool>`" followed by the description and the buttons "✅ Allow" and "❌ Deny"; the answer
goes back to Claude Code (details in `hub-iteration-2-design.md`).

**Agent question (`AskUserQuestion`).** With the mode on, the plugin's `PreToolUse` hook
(`src/hook/question.ts`) sends the questions to the hub (`POST /question`) and waits up to 24 hours; the hub asks them in the topic
with buttons and returns the answers, and the hook gives them to Claude Code as `updatedInput`. Mode off — a dialog in the
terminal. Details are in `questions-design.md`.

**Commands from the topic.** `/info`, `/compact`, `/compact <instructions>`, `/rename <name>`, `/stop`, `/cleanup`, `/run`,
`/mode`, and `/pwsh`, `/cmd`, `/bash`. The hub recognizes a command in a topic message: the text `/<command>`, optionally with
`@<bot name>` (with another name it is a normal message) and arguments. The command is not delivered to the agent,
does not enter the context, does not change the mode. Other `/…` are normal messages. Messages before the command reach
the agent first.

The hub is a thin client over rig for every action on a Claude Code session: `/compact`, `/rename`, `/stop`,
`/cleanup`, `/run` and `/mode` are one `rig session …` call each, and nothing else (no fallback to a hub-side path).
The table of the commands, the error codes, the autolaunch and the always-on hub are in `rig-integration-design.md`;
the sound of the results and the `/cleanup` texts are in `cleanup-design.md`. `/pwsh`, `/cmd` and `/bash` run in the hub
(`exec-design.md`).

- Each call is shown as one message the result replaces in place: quiet "🗜 Compaction is running…" (`/compact`),
  "🏷 Renaming…", "⏹ Ending the session…", "🧹 Cleanup is running…". While rig reports
  `{"progress":{"code":"session-waiting"}}` on stderr (it waits for the turn to end) the message shows "⏳ Waiting for
  the turn to end…". Success edits the message into the result ("✅ Compaction done: <before> → <after> tokens.",
  "✅ Renamed: <name>", "⏹ Session ended" with the outcome of the compaction, the cleanup result). A rig error
  deletes the running message and sends rig's own `message` as a new loud one. `session-no-module` (the window has no rig
  module) adds the restart hint; the other codes (`session-ended`, `session-unknown`, `session-timeout`,
  `session-cleanup-not-compacted`, `launch-unavailable`) show rig's message verbatim. Rig missing: the missing-rig text.
- `/compact <text>` passes the text to the compact as its instructions. The former `/compact <N>` and `/compact auto` (autocompact settings of
  the window) have no rig equivalent: such a text is just instructions.
- `/rename <name>`: the name is trimmed and its spaces collapsed; without a name — "Write the name: /rename new name"
  and no call. The topic changes its name when Claude Code writes the new name into the transcript — by the same path
  as any session name change (`retitle`).
- `/stop` of a session rig finds not running: "Session is not running"; what the hub kept for it is released like a
  new message (the session is not being ended).
- **Holding while a session is being stopped, cleaned, switched or started.** One mechanism serves `/stop`, `/cleanup`,
  `/mode` (and the mode buttons) and `/run`, and every autolaunch (a message, `/cleanup`, an exec result), because all of
  them are a `rig session …` call. From the moment the call starts, whatever arrives for the session is held, in order of
  arrival: ordinary messages and attachments, exec results and their acknowledgements, answers to polls and buttons. What
  was already half-way is captured at the same moment, so nothing reaches the window that is going away: the waiting
  message batch (its messages join the held ones; a batch whose attachments are still being prepared is dropped from
  the send and held instead), an open poll (it ends with no decision and the answer typed next is held, not swallowed),
  and a replay in progress (what it had in flight or still held goes back to the hold). A `/cleanup` first sends the
  waiting batch, so what was written before it is cleaned with the session; only later items are held.
- The hold is released into the next window once it connects, in one ordered replay with the messages and exec results
  that came while the window was starting. `/stop` and `/cleanup` (`ended`) wait until the old window is gone: the hold
  is released when it disconnects, or after `WINDOW_CLOSE_WAIT_MS` (30 s) if it stays connected (a safety timer; the
  number is an estimate, not a measurement). With no window at all, a message that arrives later is a normal start.
- Nothing held is dropped. If rig fails (`rig` missing, an error answer, a launch that never connects within
  `CONNECT_WAIT_MS`), the held items are kept for the next start of the session and the topic is told they are kept
  (the delivery notice). They are never sent to the ending window. Exception: when rig refuses the stop or cleanup while the old
  window is still connected, the items go back to that window, because the session is still running; the same for `/mode`
  that changed nothing (`changed: false`) and `/stop` that found nothing running. An open decision: whether a refused stop
  with the window open should keep the items for the next start instead.
- A button press that is stale (its message no longer current), malformed or from a user who is not authorised never
  reaches `rig session stop|run|mode`: it is answered and ignored. A second `/run`, `/mode`, a mode button or `/stop` while
  one of these actions is in progress answers "Session is already starting" and makes no second call. `/compact` and
  `/rename` do not hold.
- `/info` draws what `rig info --session <id>` returns (`InfoData`: `session`, `account`, `claude`, optional `codex`,
  optional `volunteers`, `context`; the type is in `plugin/src/shared/info-data.ts`) through `infoText`
  (`plugin/src/hub/info-text.ts`); the hub collects no limits itself. The id must be a plain id, `[A-Za-z0-9-]`, up to
  100 characters: anything else is refused before rig is run. rig's answer is untrusted: the hub validates it with a
  strict zod schema of rig's contract (`plugin/src/hub/info-schema.ts`). A contract breach (an unknown field, a wrong
  type, a `null` time where rig promises a string) fails the whole answer, not one block: rig is then broken and a
  half-drawn picture would hide it. When rig is missing, the command failed (the text is rig's own `message`), or the
  answer breaks the contract, the topic gets a loud warning with that text.
- Every block of the data is either its data or `{error: {code, message}}`. A block with the code `no-data` is shown
  as "no data" ("Claude limits: no data, they appear after the model's first reply"; for the context: "no data"). A
  block with another code is shown as "<Block> limits: unavailable, <rig's message>" (for the context:
  "unavailable, <message>"). `codex` and `volunteers` are absent when rig does not allow them on this machine: then
  the block is not shown at all. The account is not shown.
- The Claude block shows the percentages of the five-hour and weekly window with the time until reset; no limits yet —
  "Claude limits: no data, they appear after the model's first reply". "Context" shows the current context in
  thousands of tokens (after compact and before the first reply an estimate with the sign "≈"), the autocompact window
  and trigger threshold, and what percent of the threshold is used; autocompact off — it says so.
- A block (the context included) whose `at` is 5 minutes old or more has in its header "(data N min old)". After a reset — 0% without the reset
  suffix. "**Codex limits**" shows windows of 300 and 10080 minutes as "5 hours" and "Week", others as the length
  in minutes. "**Volunteer limits**" shows the age, a line `Day: X% (resets in <duration>)` and the providers, each on
  its own line, in the form `Name: used/cap`; names are mapped (openrouter→OpenRouter, requesty→Requesty, groq→Groq,
  zhipu→Zhipu, not "Z.ai": Telegram makes a link out of it; the others as they are). A provider with `cap: null` is
  dropped: without a limit the number does not say how much is left.
- The hub does not read `usage.json`, `$CODEX_HOME/sessions` or the volunteer script: the readings, their freshness
  and which account they belong to are rig's work.
- `/mode` shows the mode of this launch: the mode of the successful launch and the later transcript records, or a
  record after the window connected (the hub remembers the transcript size on connect). An older mode is labeled "Last
  known mode" and does not forbid switching. The buttons offered are `manual`, `auto`, `acceptEdits`, `plan`,
  `dontAsk`. `default` in the transcript means `manual`; an unknown or forbidden current mode is shown as it is, with no
  button marked. `/mode <mode>` and the buttons accept only these values, case-insensitively; the current mode answers
  "already in this mode". Switching is one `rig session mode <id> <mode>` call: rig restarts the session in the mode
  (or says it is in it already, `changed: false`) and the new window connects like one of a start. The hub has no
  process-exit gate, no launch template and no mode restart of its own. What comes in the meantime is held for the new
  window and delivered in order once it connects; a rig failure keeps the held items for the next start and shows rig's
  message (see "Holding while a session is being stopped, cleaned, switched or started"). `/run` and
  `/mode` during a start or a stop answer "Session is already starting". The mode is saved after a successful call; a normal
  launch clears the mode and the offset. An offset beyond the size of a shortened transcript is not read; the mode
  search reads the transcript backwards in blocks until a record or the offset.
- At start the hub registers the topic commands in the bot menu (`setMyCommands`); a failure is a WARN in the log.

### Hub lifecycle and failures

- At start the plugin connects to the hub on a fixed local port. If it fails, it starts the
  hub as a **detached** process (not a child of the window) and connects again.
- The one who managed to take the port becomes the hub; a second hub in a race exits at once. Two pollers
  at the same time are impossible.
- The hub exits 5 minutes after the last plugin disconnects, but not before it has delivered
  its queue. The exception is delivery blocked by configuration (no token, token rejected, the bot
  is not in the group, no `groupId`): then the hub exits, and the queue stays on disk for the next hub.
- Closing the window that started the hub does not affect the hub.

**Delivery does not lose messages or change their order** — neither without a network nor when the hub crashes:
- the plugin keeps the text in memory until the hub confirms receipt; after reconnect it sends
  the unconfirmed again, in order. Each message carries an id and the `sessionId`;
- the hub, on receiving text, splits it into pieces and first writes them to a queue on disk (`outbox.json`,
  atomic write), then confirms. A retry with the same id is recognized by the hub and not queued a second time;
- a session's queue is sent strictly one at a time: the next piece goes after Telegram
  accepted the previous one. A piece is removed from the queue after Telegram's reply;
- network, 429, 5xx — retry with no time limit, the pause grows up to 30 s; one line in the log per
  series of failures and a line on recovery;
- a configuration block (see above) — the same, a 30 s pause, a hint in the log about what to fix;
- the topic was deleted — a new topic and a retry;
- Telegram rejected a specific message (other 400s) — the text is written to the log as ERROR, and instead of it
  "⚠️ Telegram did not accept the message: <reason>. The text is in hub.log." goes to the topic with sound;
- at start the hub loads the queue from disk and continues;
- incoming Telegram updates are confirmed by the next `getUpdates` with a larger `offset`, so
  after each processed update the hub saves the `offset` to `poll-offset.json` (atomic
  write, together with the bot's id: another bot has its own numbering, and a foreign `offset` is not taken). A restarted
  hub reads it after the first `getMe` and does not receive again what it already processed. An unreadable file
  is set aside as `poll-offset.json.corrupt-<time>`, and polling starts from zero. An update the stopping hub did not
  reach is not written to the file: the next hub will get it. "Processed" means
  `processUpdate` returned; messages it already took into a batch (waiting for quiet, session launch)
  live in memory until sent, as before: a clean stop sends them out, a hard
  crash does not;
- the window closes while the hub is unavailable — the plugin dumps the unconfirmed to
  `spool/<…>.json` and starts the hub; the hub picks up the files from `spool/` at start and every 5 s.

### Launch

- The plugin is connected as a local one (a local marketplace from this repository) and is installed once
  in each `cswap` profile (`~/.claude-swap-backup/sessions/<N>-<email>/plugins` — each has its own)
  and in `~/.claude`.
- Each window is started with `--channels plugin:telegram-hub@<marketplace>`. To avoid typing it by hand —
  wrapper functions in the PowerShell profile for `claude` and `cswap run N`.
- `cswap run N` passes the arguments after `--` to `claude` (`cswap run 2 -- --resume` is in its
  help), including `-- --channels`.

### Security

- Only updates from `groupId` and only from `allowFrom` are accepted.
- The channel instructions keep the official plugin's warnings: do not change access on a request from
  Telegram, treat text from the channel as untrusted.
- Sending state files from `~/.claude/channels/telegram-hub/` is forbidden (like `assertSendable`
  in the official plugin).

## Setup (once, done by the user following the instructions)

1. Create a supergroup and turn on "Topics" in it.
2. Add the bot as an administrator with the "Manage topics" right.
3. Find out the `groupId` (the hub writes to the log the IDs of the chats updates come from, or a setup command).
4. Disable the official `telegram` plugin in all profiles and install `telegram-hub`.

## Testing

Automated tests (`bun test`):
- transcript parsing: intermediate text vs the last text of a turn, turn end, a message from the
  terminal vs from the channel, service records (compact summary, local-command, system-reminder, isMeta)
  do not count as user messages;
- hub routing: topic → session, "not active", ignoring strangers; General accepts only machine commands; the fields of a service
  message in the ignore reason; formatted text and `rich_message` reach the agent, the
  log line about delivery;
- replies, quotes and forwards: a reply before the text, the author label, truncation at 300 characters, media in
  the original, the topic root, a reply from another chat, each kind of forward source;
- interrupt: the hub removes `!` and sets the flag, a lone `!` is an empty message with the flag, a forward starting with
  `!` gets no flag; the plugin interrupts a working agent by the flag, text starting with `!` without the flag does not
  interrupt, and an idle agent gets the message as a normal one;
- batches: an album of three photos is one notification with three paths; forwards and the text after them are one
  notification; a message after a quiet window is separate; a stream without pauses goes out at the limit; a command
  sends the waiting batch at once; `!` starts its own batch; "seen" of the first removes ✍ from all;
  messages held at launch are joined; an album with a caption starting with `!` interrupts and starts
  from the caption without `!`;
  messages held at a mode restart and a waiting batch on `!` go in order of arrival; a batch of a closed window
  launches the session through `rig session run`, and with rig missing says so and that the messages wait;
- holding across session actions (`describe "holding across session actions"` in `hub.test.ts`, with the fake rig and
  the manual clock): `/stop`, `/cleanup`, `/mode` and the mode buttons, `/run` and the three autolaunches hold in arrival
  order and release to the next window; a waiting batch, an open poll, an attachment being prepared and a replay in
  flight are captured; a rig refusal and a start that never connects keep the items; stale, malformed and
  unauthorised presses never reach rig; the old window never receives a held item;
- `rich_message` → Markdown: each kind of block and text, nested lists, a table, media with `file_id`
  and the path of a downloaded photo, unknown kinds; photos to download are the largest size of each,
  wherever it lies; the hub downloads them to `inbox`, and one that failed to download stays with its `file_id`;
- the session table: a repeated `tg_enable`, `--resume` (the same ID → the same topic);
- hub elections: a race of two plugins, hub death, reconnect, auto-exit;
- formatting: each mapping from "Formatting" on both paths; tags, `$` and line breaks
  stay; splitting rich text by bytes and by block count; a block above the limit as plain text;
  splitting with an entity on the boundary; after a refusal — plain text with entities, then without them;
- commands: recognition (`@bot`, another bot, arguments), not reaching the agent; for each of `/compact`, `/rename`,
  `/stop`, `/cleanup`, `/run`, `/mode` the fixture rig answers with success and failure JSON (codes
  `session-no-module`, `session-cleanup-not-compacted`, `launch-unavailable` and the rest, `{skip}`, `stopped: false`,
  the `session-waiting` progress line, rig missing) and the topic shows the matching text; the `/info` text in all
  cases (no limits, no context figure, autocompact off); autolaunch through `rig session run` for a message and for
  a command result of a session with no window;
- sending files: checks before sending, type by extension, albums and their boundaries, caption, order
  with text, sound by mode, retry after reconnect without a duplicate, photos as documents after a refusal,
  a refusal and a missing copy, deleting copies;
- the delivery queue: a long absence of network, a hub restart with a non-empty queue, a retry with the same
  id, Telegram's refusal of a specific message, a configuration block, the hub exiting only after
  delivery, `spool/` from a closed window;
- input in the terminal, including in the middle of a turn, does not turn the mode off and agent text keeps going to the topic;
  `task-notification`, `channel` and `peer` prompts do not change the mode either;
- a cut-off response: recognizing the record, the continuation and the note in the topic after the error text, silence with
  the mode off, the limit of 10 in a row and the reset by a normal turn end, a cut-off before the window started.

Manual check on a real group: two windows on different accounts; closing the window that started the hub;
`--resume`; a reply into the topic of a closed session; input in the terminal does not turn the mode off, a message in the topic turns it on;
silent and sounding messages on the phone; `/info`, `/compact` in the middle of a turn and after, `/compact 333k`.

## Results of the preliminary check

Checked by experiment (a temporary plugin with an MCP server and hooks, `claude -p --plugin-dir`):

1. **The channels flag.** Hidden flags: `--channels <servers...>` (only an approved allowlist) and
   `--dangerously-load-development-channels <servers...>` (unapproved ones; shows a confirmation
   dialog at start). Format: `plugin:<name>@<marketplace>` or `server:<name>`. The allowlist
   can be replaced by the managed setting `allowedChannelPlugins: [{plugin, marketplace}]` (requires
   `channelsEnabled: true` in managed settings). A plugin from `--plugin-dir` gets the marketplace
   `inline`. **Not checked:** loading a channel by real Claude — a launch with the dev flag is blocked
   by the auto mode classifier, to be checked by hand.
2. **Session ID in the MCP server** — yes, `CLAUDE_CODE_SESSION_ID` is set for the plugin's MCP server
   (not inherited). `CLAUDE_CONFIG_DIR` is there too (for `cswap run` — the profile folder).
3. **`--resume <id>`** keeps the ID: both the MCP server and the hooks see the same ID, and records go to the same file.
4. **Transcript file:**
   - an assistant message is split into records, one content block each; all records of one
     message share a `message.id` and the final `stop_reason` (`tool_use` / `end_turn`); records
     are written before the `Stop` hook fires;
   - a message from the terminal: `type:"user"`, `origin:{kind:"human"}`, `promptSource` =
     `typed` | `queued` | `suggestion_accepted`; service ones (`isMeta`, the compact summary
     `isCompactSummary`, local-command, task-notification, peer) have no `origin.kind:"human"`;
   - an incoming message from the channel (from the CLI code): `isMeta:true`, `origin:{kind:"channel", server}`;
   - session name: the records `custom-title` (`customTitle`), `agent-name` (`agentName`, written
     by `/rename` in this version) and `ai-title` (`aiTitle`). Priority: custom-title → agent-name →
     ai-title, in each the last record.
5. **Hooks** get JSON with `session_id`, `transcript_path`, `cwd`; `SessionStart` also gets `source`
   (`startup` | `resume` | `clear` | `compact`), `Stop` gets `last_assistant_message`.
   The MCP server and the hooks of one window get the same `CLAUDE_CODE_MESSAGING_SOCKET`
   (each claude process has its own) — the hub uses it to link a hook to the window.
6. The Bot API (topics) is checked by hand on a real group.
7. **`cswap run N -- <args>`** passes the arguments to claude (checked with `-p`/`--plugin-dir`).

Also: on Windows a second `Bun.serve` on a busy port fails with `EADDRINUSE` (elections through the
port work); a detached process started by the MCP server survives the exit of
claude.

### Decisions after the check

- **Turn end** — the main source is the `Stop` hook, the fallback is the transcript file: an assistant record with
  a `stop_reason` other than `tool_use` and `null`. Records reach the file before the hook fires,
  so there is no "hook before the record" race.
- **Session change in a window** (`/clear`, `/resume` inside a window): the MCP server is not restarted,
  and its `CLAUDE_CODE_SESSION_ID` stays the old one. The plugin installs a `SessionStart` hook, the hook sends
  the hub `{session_id, transcript_path, messagingSocket}`, and the hub forwards it to this window's plugin.
  The plugin switches the transcript file and sends the hub a `session` message with the new session,
  the window's entrypoint and the new session's title. The hub applies the shared connect rule: for `cli` it
  turns the session on if its record has no `disabledByUser`; it tells the plugin the new state. For
  SDK and other entrypoints the new record stays off. The previous session's record does not change;
  the new session's topic is created only at the first text send.
- **Transcript file path** at start: `<CLAUDE_CONFIG_DIR>/projects/<cwd, with every
  non-alphanumeric character replaced by "-">/<sessionId>.jsonl`; if there is none — a search
  of `projects/*/<sessionId>.jsonl`; the file may not exist yet (a new session) — we wait for it to appear.
- **Reading the file** starts at the current end (history on `--resume` is not forwarded); the session
  name for the topic is read by a separate full pass at `tg_enable`.
- **Own tools and the final text.** A call to its own `tg_enable`/`tg_disable` does not make the preceding text
  "intermediate". The sound at the end of a turn is decided by the Stop hook, not by the agent
  (`turn-end-design.md`).
- **Permissions** — the plugin declares `claude/channel/permission` to receive
  `permission_request`, but never sends answers; the message goes only while the mode is on.
- **Hub and Telegram** — the Bot API through `fetch` without grammy (the base URL is configurable —
  tests use a fake Bot API server).
- **IPC** — WebSocket and HTTP on `127.0.0.1`, default port 47613; requests with an
  `Origin` header (a browser) are rejected.
- **Topic deleted by hand** (Telegram answers "thread not found") — the hub creates a new topic for the
  session and repeats the send.

### Observations during the work

- Part of the agent's visible text is written to the file as a `thinking` block of type narration (see "Forwarding
  agent text"): there are many such blocks, while ordinary thinking blocks are empty. Without
  parsing them, most intermediate messages were lost.
- A message typed in the terminal in the middle of a turn is not a `user` record but an `attachment`
  `queued_command` with `origin.kind:"human"`. Notifications about background tasks arrive the same way, but
  with `origin.kind:"task-notification"`.
- The `UserPromptSubmit` hook fires on every prompt that starts a turn, including on
  `<task-notification>` from background tasks and Monitor. Its input has only `session_id`,
  `transcript_path`, `cwd`, `prompt_id`, `permission_mode`, `prompt` and the like — there is no
  `input_source` field, so the prompt's source is not visible. Claude Code writes the prompt record (`promptId`, `origin`)
  to the file after the hook: the hook does not see it yet. The first version turned the mode off from this hook and
  turned it off at every background task completion; the hook was dropped.
- Hooks of type `mcp_tool` substitute the hook input fields into `input` through `${…}`; a missing field
  becomes an empty string (for the main agent `${agent_id}` → `""`).
- Function hooks (`modules` in `hooks.json`, Claude Code's early-access API): the hub plugin does not ship one any
  more; the module that runs `/compact` and `/rename` in a window belongs to rig. `claude plugin test` runs
  all `*.test.ts` in the plugin folder, including bun tests — it is not used.

## Out of scope

- Confirming permissions from Telegram.
- Bot commands other than `/info` and `/compact` (a session list and the like).
