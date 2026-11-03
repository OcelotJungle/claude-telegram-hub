# telegram-hub: `/cleanup` — compact the context, drop accumulated skills and end the session

Basis: `hub-iteration-2-design.md`, section 4 (autostart, `/run`, `/stop`).

Sound of service messages: informational bot messages, commands and successful results are silent;
warnings and errors make a sound. Permission requests and polls that need a user's answer also make
a sound. This rule does not change the sound of agent text or of the end of its turn.

## Why

Claude Code remembers every skill invoked in a session and, after each compact, puts them all back into the
context: from the last invoked to the first, up to 25k tokens for all and up to 5k for one. A skill can be
removed from this list only with `/clear`, but `/clear` starts a new session and a new topic.

In long sessions this is a noticeable token cost: skills invoked at the start of the work are re-read on
every request after each compact until the end of the session.

`/cleanup` in a topic removes these skills and ends the session. The next start is the same session: the same id,
the same topic, the same history.

## How it works in Claude Code (from the binary's code)

- The registry of invoked skills lives in process memory (`invokedSkills`: `record` / `forget` /
  `forgetAll`). `forgetAll` is called only on `/clear`.
- After a compact, Claude Code writes this record to the transcript:
  `{"type":"attachment","attachment":{"type":"invoked_skills","skills":[{"name","path","content"},…]},…}`.
  Its content goes into the model's context.
- On `--resume`, the registry is rebuilt from the `invoked_skills` records in the loaded messages:
  `record(name, path, content)` is called for each element of `skills`.

This gives the method:

1. Compact.
2. Stop the process.
3. In the transcript, empty `skills` in the `invoked_skills` records.
4. The next start (`/run` or a message to the topic) goes with `--resume`.

After this there are no skills in the context or in the registry: in the context they were only in the attachment
after the compact. The next compact will not bring them back. If a skill is needed again, the agent calls it
itself through Skill.

## Behavior

### Command

`/cleanup [instructions]` in a topic. The instructions are optional and go to the compact, as with `/compact`.

In the bot menu: `cleanup` — "Compact the context, remove accumulated skills and end the session".

### Sequence

This is `/stop` with two differences:

- the compact is done **always**, not only when the context is above 120k. Without a compact, the skills stay in
  the context as messages, and editing the transcript will not remove them from there;
- after the stop, the transcript is edited.

The session stays ended after this. Every message that arrives in the topic during cleanup goes, after
any outcome of cleanup, the normal way of a message to the topic of a stopped session: if autostart is
configured, the session is started as with `/run`, with the same account, `launch` template and id. Held
messages are kept in hub memory and are sent in order; while they are being handed over, a new topic message goes
after the old ones. On a delivery failure the standard path applies (`sendHeld`). The number of held messages
is not limited: neither during /cleanup nor at session start is anything dropped.

Step by step:

1. The hub gives the window module the command `cleanup`. Only a module that asks
   `GET /commands?…&cleanup=1` picks it up. A module of an old version does not pick it up, and after `COMMAND_PICKUP_MS` the hub
   writes the usual "⚠️ /cleanup failed: the window did not pick it up within N s." The session is
   not touched.
2. The module quietly writes "🧹 Cleanup is queued." to the topic. When its compact starts, the same message changes to "🧹 Cleanup is running…". If the attempt gave way to a starting turn, the message goes back to "🧹 Cleanup is queued." until the next attempt. Then it waits for compacts already running and does its own, through the same queue as
   `/compact` and `/stop`: between turns, up to 3 attempts.
3. The module reports the result to the hub through `POST /cleanup` with the body `{ sessionId, id, before?, after?, error? }`.
   `before` and `after` are the context tokens before and after the compact. The hub writes `before` to the log; neither
   goes into the result. The module does not write its own "✅ Compaction done." to the topic: the result is written by the
   hub, editing the queued message on success. The hub waits for the compact result no longer than `CLEANUP_COMPACT_MS = 600_000` from the moment the command is queued. If it
   does not arrive: loud "⚠️ Cleanup failed: the compaction did not finish within 10 min", cleanup
   is forgotten. A result that arrives later is skipped by the hub, and it logs this.
4. If the compact failed, `error` arrives. The hub loudly writes "⚠️ Cleanup failed: the compaction
   failed: …", forgets cleanup, and does not touch the transcript or the window. A compact that the
   module skipped (for example, the context is empty) also arrives as `error` with the reason for skipping.
5. If the compact succeeded, the hub ends the window as with `/stop`: WS message `terminate`, the same
   `STOP_TIMEOUT_MS`. Before killing claude.exe, the plugin tells the hub its pid:
   `{ type: "exiting", pid }`.
6. Editing can start only when the Claude Code process has exited: it appends to the file.
   The WS closing is not enough for this. The hub waits until the pid from `exiting` no longer exists (polling
   `process.kill(pid, 0)`) through the shared `exit-gate.ts`. `CLEANUP_EXIT_MS = 30_000` limits
   the cleanup's wait, but does not lift the launch barrier on a live process. All launches pass through
   this barrier in `launch()`, whatever the command or the source of the message.
   - No pid arrived, for example from a plugin of an old version: after the WS closes, the hub waits
     `MAX_RECONNECT_PAUSE_MS + EXIT_POLL_MS`. The maximum reconnect pause with jitter is taken from a
     constant shared with the plugin; the window manages to come back before any new launch.
   - The process did not exit within `CLEANUP_EXIT_MS`: loud "⚠️ Cleanup failed: Claude Code did not
     exit". The transcript is not edited; the accumulated messages continue the normal path of a message
     to a stopped session through the shared barrier: they are kept, and there is no launch until the process exits.
   - If the session's window connected again in the meantime, the wait ends at once: loud "⚠️ Cleanup
     failed: the session was reopened". The transcript is not edited, the accumulated messages go to that
     window, as after a launch.
7. The hub edits the transcript (see below) and writes the result: on success it edits the queued message; if the
   session stays ended, "⏹ Session ended" arrives as a separate notification. If the edit failed with an error, the result is
   "⚠️ Cleanup failed: <error>".
8. If messages arrived in the topic, the hub starts the session for them the same way as `/run`, with the same
   messages and the usual launch notification. If the session's window connected while the edit was running, the session is not started a second time: the result
   is written, the accumulated messages go to that window. Any launch acts this way: with a window of the
   session open, the hub does not start a second Claude Code on the same transcript.

During cleanup, the window closing does not by itself send the "⏹ Session ended" notification.

**The compact status edits the queued message. The result replaces it.** At the start the hub edits "🧹 Cleanup is
queued." into "🧹 Cleanup is running…"; on a retry after a failure caused by a starting turn, it returns "🧹 Cleanup is queued." A successful result edits the message into the final summary; the edit is silent by nature. On any refusal, error or cancel (steps 3–8,
including cancel through `/stop`) the hub deletes the queued message and sends the result as a new message,
loud by the `notifies(kind)` rule (a warning and an error are loud, a cancel is not). If the result
arrived while the queued message is still in the outbox, the operations stay in one queue and run in
order; the Telegram `message_id` of the queued message only is saved together with the outbox (`messageIds`) until the result arrives, so the edit or delete
is resolved even after a hub restart. If the message was not sent or its id is unknown, the result
is sent separately. An error editing an intermediate status or an unknown id skips that status without a separate message and does not block the queue; the id stays for the final edit or delete. A delete error does not interrupt delivery of the result. On a successful cleanup, the ended
session gets a separate notification "⏹ Session ended"; on a restart, the usual launch notifications
arrive. "The window did not pick it up" is not included here: the module did not take the command, there was no queued message.

**`/compact` and the compact inside `/stop`.** At the start the compact edits the quiet queued message into
"🗜 Compaction is running…". A successful result edits it into "✅ Compaction done." A skip or an error deletes it and sends a warning as a new loud message. For
`/stop`, the notification "⏳ I will end the session after the compaction. A second /stop ends it right away." turns into "⏹ Session ended"; without it
"⏹ Session ended" stays a separate message.

A launch for messages from the topic is announced with the usual launch notifications. If the session did not start,
the loud "⚠️ The session did not start within N s" arrives as usual.

**`/stop` during cleanup.**

- While the compact is running, `/stop` ends the window at once and cancels cleanup. The hub loudly writes "⏹ Cleanup
  cancelled" in place of "🧹 Cleanup is queued.", the transcript is not edited, the session is not started, and on
  close the usual "⏹ Session ended" arrives. The hub does not hand the accumulated messages to this window:
  it is about to end, and they would be lost. They wait for the window to close and then go the normal path
  of a message to the topic of a stopped session; if autostart is not configured, they stay queued for the
  next `/run`, and the topic gets the usual notification about an inactive session. If the window did not
  end within `STOP_TIMEOUT_MS`, they go to it.
- If the window is already ending after the compact, `/stop` changes nothing: the hub already waits for it to close, and
  cleanup goes on.

**Messages during cleanup.** From the moment the command is queued, while the window is still alive and the compact is running, normal
messages to the topic accumulate in the order they arrive. After any outcome of cleanup they leave cleanup and are
handled as a new message to the topic of a stopped session: if the window stayed connected, the
message goes to it; if there is no window and autostart is configured, the session is started and the message waits for
the connection; otherwise the normal path of an inactive session applies. Held messages are written to
disk and survive a hub restart until they are handed to the agent.

- A message whose text or caption, after leading spaces, starts with "!" goes straight to the window while it is alive:
  this is an interrupt of the agent, and it must not wait for the end of the compact.
- Module commands (`/info`, `/compact`…) go into the command queue, as usual.
- The result of the command `/pwsh`, `/cmd`, `/bash` (an inbound with `meta.source` "exec") accumulates the same way, in the same
  list and by the same delivery rules: otherwise it would start an agent turn that would cut off the window's ending.
  The exception for "!" does not apply to it.
- On a compact error, a timeout, the window closing before the end of the compact, a cancel through `/stop`, a transcript
  error, a Claude Code process still alive after the timeout, and a hub shutdown, the messages continue the same
  normal path. On a hub shutdown, the saved queue is handed to this path after the next hub
  start.

**Other commands during cleanup.**

- A repeated `/cleanup` and `/run` reply "⏳ Cleanup is already running".
- `/cleanup` in a session that is not running replies "Session is not running", as `/stop` does.
- `/cleanup` during `/stop` replies "⏳ Session is already ending".

**When cleanup is lost.** The session stays as it is, the transcript is not edited:

- the window closed while the compact was running (the hub loudly writes "⚠️ Cleanup failed: the window closed before the compaction ended");
- the compact did not finish within `CLEANUP_COMPACT_MS` (see step 3);
- the window did not end within `STOP_TIMEOUT_MS` (the hub writes the usual "⚠️ Could not end the session…");
- the hub was restarted in the middle of cleanup.

### Result in the topic

- Skills removed: "🧹 Cleanup done, skills removed: brainstorming, writing-plans, …".
- Nothing to remove: "🧹 Cleanup done.". The same if `invoked_skills` records exist but the lists in
  them are already empty.
- Format not recognized: "⚠️ Cleanup failed: the transcript format changed (Claude Code <version>)".

After a successful result, if the session stays ended, "⏹ Session ended" arrives as a separate notification.
On a launch because of messages from the topic, the usual launch notifications arrive.
The result has no context size or skills.

Where the parts come from:

- The list of names is from the **last** `invoked_skills` record: it was written by the compact just done, and
  it is the one in the context.
- The version is the `version` field of that record, and if it is missing, of any record of the transcript. If there is no version
  anywhere, the parenthesis "(Claude Code …)" is omitted.

## Transcript editing

Module: `plugin/src/hub/skill-cleanup.ts`. Pure functions, file paths are passed as parameters.

- **File.** The main transcript `<id>.jsonl` is edited; subagent transcripts are not touched.
  - The hub remembers the path from the SessionStart hook (`transcript_path` in `onHook`) together with the rest about the
    session in its store. Only the path is remembered, and only if the file name in it is `<id>.jsonl` of this session:
    the hub edits that file and does not trust another.
  - If there is no path or the file is no longer at it, the hub looks for `<projectsDir>/*/<id>.jsonl`, as
    `sessionCwd` does. The session id is first checked to look like a uuid.
  - Not found: "⚠️ Cleanup failed: transcript not found", with the same session line under it.
- **Which records.** Every record with `type == "attachment"` and `attachment.type == "invoked_skills"`
  gets `attachment.skills = []`. All such records in the file are edited, not only the last: this way
  the method does not depend on where `--resume` starts loading the history.
- **The line stays.** Do not delete the line: records have `uuid`/`parentUuid`, and without the line the
  chain breaks.
  - The changed line is `JSON.stringify` of the parsed record with `skills` replaced.
  - All other lines, including line endings and an incomplete last line, stay byte
    for byte.
  - Work is done on bytes, not strings: a line is parsed only if it contains
    `"invoked_skills"`. Otherwise it is copied as is.
- **Stream.** Files can be 1.5+ GB, so the file is read and written as a stream, line by line. The result
  is written to a temporary file next to it (`<id>.jsonl.cleanup-tmp`), then atomically replaces the original.
  If there is nothing to change, the file is not rewritten.
  - The first pass remembers the file size. Exactly that many bytes are copied to the temporary file. Before the
    replace, the size is checked again. If the file grew, a reopened session is appending to it: the edit
    is abandoned, the temporary file and the already written backup are deleted, and the transcript stays as it was. The hub writes
    "⚠️ Cleanup failed: the transcript is still being written: is the session open?".
  - Windows briefly forbids replacing a file held by another process (antivirus,
    indexer). On `EPERM`, `EBUSY` or `EACCES` the replace is retried: up to 10 attempts at 200 ms intervals.
  - If the replace still failed or any other part failed, the temporary file is deleted, the backup
    too, and the original file stays byte for byte.
- **Backup.** The original versions of the changed lines are put into `<id>.cleanup-<time>.jsonl` next to
  the transcript. Each line of this file is `{"line": <number from 1>, "uuid": "…", "text": "<original
  line>"}`.
  - A copy of the whole transcript is not made.
  - The last 3 such files of a session are kept, older ones are deleted.
  - `restoreCleanup(transcript, backup)` returns the file byte for byte. It replaces a line only if the
    number and the `uuid` match. If even one does not match, it writes nothing and throws an error.
- **Foreign format.** If an `invoked_skills` record has no array `attachment.skills`, or it contains
  an element without string `name` and `content`, the file is not edited at all. The session is still started,
  and the result has "⚠️ Cleanup failed: the transcript format changed". The same if an `invoked_skills` record has bytes
  that do not read as UTF-8: a rollback from the `<id>.cleanup-*.jsonl` file would not return them byte for byte.
  A line that does not parse as JSON is not counted as an `invoked_skills` record and stays as it is.

### Do not touch

- Attachments after the compact that are needed for work: `file`, `plan_file_reference`, `skill_listing`,
  `deferred_tools_delta`, `agent_listing_delta`, `mcp_instructions_delta`, `instructions`.
- The output of `SessionStart:compact` hooks, for example context added by a hook: it comes again on every start.

## Verification

1. A test on a copy of a large transcript. After the edit only the `invoked_skills` lines differ,
   with `skills: []`. The number of lines and all `uuid`s are the same, the JSON of every line is valid.
   The transcript is large, so the test is manual, through the script `scripts/cleanup-check.ts <path>` on a copy.
   The script receives an already made copy. It remembers its original bytes, edits, compares the lines,
   rolls back, and checks that the rollback returned the file byte for byte. It does not accept a path inside `~/.claude/projects` or
   a file named `<uuid>.jsonl`, so as not to touch a live transcript. The same checks run as an autotest on a built file.
2. The rollback from `<id>.cleanup-*.jsonl` returns the file byte for byte (autotest).
3. Hub: `/cleanup` goes the whole path on fakes: command to the module, compact, `exiting`, close,
   edit, result, launch. Errors are checked separately: the compact failed, an old module, the process did not
   exit, `/stop` during cleanup, the session window connected while waiting for the process or
   during the edit.
4. README: the command in the list of topic commands.
