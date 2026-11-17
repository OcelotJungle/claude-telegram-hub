# telegram-hub: `/cleanup` — compact the context, drop accumulated skills and end the session

Basis: `hub-iteration-2-design.md`, section 4 (autostart, `/run`, `/stop`); `rig-integration-design.md`, section on
session commands. The mechanism itself lives in rig (`agent-rig/docs/superpowers/specs/rig-sessions-design.md`, section
`rig session`); this document is what the topic sees.

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

## Command

`/cleanup [instructions]` in a topic. The instructions are optional and go to the compact, as with `/compact`.

In the bot menu: `cleanup` — "Compact the context, remove accumulated skills and end the session".

## What the hub does

The hub runs `rig session cleanup <id>` and nothing else. Rig compacts the session (always, not only above 120k
tokens), ends the Claude Code process, edits the transcript and leaves a backup; the hub neither touches the process
nor the transcript.

- At once the hub writes the quiet "🧹 Cleanup is running…".
- When rig reports `{"progress":{"code":"session-waiting"}}` on stderr (the request waits behind the current turn or
  an earlier request of the window), the hub edits that message into "⏳ Waiting for the session to be free…"; on
  `{"progress":{"code":"session-running"}}` (the request runs after that wait) it edits it back into "🧹 Cleanup is
  running…". Rig (0.7.6 and later) reports each change once, and nothing for a request that runs at once.
- On success the same message is edited into the result (silent by nature): "🧹 Cleanup done: <before> → <after>
  tokens." and, when skills were removed, "… tokens, skills removed: N.". The ended session gets its usual
  "⏹ Session ended" notification.
- On any rig error the hub deletes the running message and sends the failure as a new loud message with rig's
  `message` verbatim. Rig's codes:
  - `session-cleanup-not-compacted` — the compact did not finish, nothing was changed;
  - `session-timeout` — the turn did not end or the compact did not finish in rig's limit;
  - `session-ended`, `session-unknown` — there is no such running session;
  - `session-no-module` — the window has no rig module (an old window): the message gets the restart hint "Restart
    the session so that it loads the hooks module, then try again.";
  - `launch-unavailable` — rig cannot launch the session.
- Rig missing on the machine: the loud "rig is not available" text, nothing else.
- The call has the deadline `RIG_SESSION_LIMIT_MS`, applied by the hub's `Rig` class with the injected timers; a call
  that outlives it is reported as a timeout.

The hub does not keep its own "cleanup is running" state: a repeated `/cleanup` is another rig call, and whatever rig
answers is shown verbatim. `/stop` of a session rig finds not running replies "Session is not running" (`stopped: false`).

## Messages during and after cleanup

The hub does not hold topic messages while the call runs. A message that arrives for a session with no window
(including right after cleanup) is a normal message to a stopped session: the hub autolaunches it through
`rig session run <id>` with the account it would have used, and the message waits for the window to connect, as after
any launch. If the launch does not produce a window in `CONNECT_WAIT_MS` the loud "⚠️ The session did not start
within 90 s" arrives. Autolaunch is the only launch path left in the hub; with rig missing, the message waits and the
topic is told how many are waiting.

A `/cleanup` for a session with no window is treated like a message to it: the hub launches the session through
`rig session run`, and once the window connects the command runs as `rig session cleanup`.

## Result in the topic

- Skills removed: "🧹 Cleanup done: <before> → <after> tokens, skills removed: N."
- Nothing to remove: "🧹 Cleanup done: <before> → <after> tokens."
- Failure: rig's message, loud, as a new message.

## Not in the hub any more

The command queue and its pickup by a window module, `POST /cleanup`, the `terminate` message, the pid exchange
(`exiting`), the Claude Code exit barrier, the transcript editor and its backup, the hold of messages during cleanup
and the manual check script moved to rig or were removed with the function-hooks module. How rig edits the transcript
(only `invoked_skills` records get `skills: []`, the line count and uuids stay, a backup of the changed lines, a size
recheck before the replace) is specified in rig's `rig-sessions-design.md`.

## Verification

Hub fixtures in `plugin/test/hub.test.ts` (a fake rig process answering JSON): success with and without skills;
failures with `session-cleanup-not-compacted`, `session-no-module`, `session-timeout`, `session-ended`,
`launch-unavailable`; the `session-waiting` progress line; rig missing; autolaunch through `rig session run` for a
message and for `/cleanup` of a session with no window. The transcript edit and the process handling are tested in rig.
