# End-of-turn signal

How a session tells the user that a turn has ended: a sound in the terminal or a notification in Telegram.
The code decides from the Stop hook data; the model calls nothing for this.

## Why

Before, at the end of a turn the model called `tg_notify` (in Telegram) or a sound script (in the terminal).
Each such call is an extra model request with the full context (~150–170k tokens), plus loading the
`tg_notify` description through ToolSearch after every compaction. In long sessions there are hundreds of such calls,
and they are a noticeable part of the cost.

## The turn decision

The plugin's Stop hook (`plugin/src/hook/stop.ts`, a command in `hooks.json` next to SessionStart) reads
its input and decides:

- **final `ask`**: the last paragraph of `last_assistant_message` has a question, even if background
  tasks are alive;
- **final `done`**: there is no question, `background_tasks` is empty;
- **intermediate**: there is no question, there are background tasks. The agent waits for an event (a monitor, a background
  command, a subagent) and will continue on its own.

Background subagents (Agent in the background) do not appear in `background_tasks`, so without separate accounting
every intermediate turn would come with a sound. Claude Code writes their number in
`turn_duration` (`pendingBackgroundAgentCount`). When the window plugin closes a turn by the rules below, with
the number above zero it treats a turn without a question as intermediate, whatever the hook decided and even with no
decision (item 2 below closes such a turn silently). The terminal sound is played by the hook itself only without a hub, and there
this number is not available yet; this is a rare case, left as is.

**A turn the user started is final.** When the user's own message started the turn or was taken into it (typed in the
terminal, `terminal_input`, or a topic message, `channel_seen`), the window plugin closes the turn as final `done`
even when the hook called it intermediate or background subagents are still running: its end answers the user, and
the sound is how they learn the agent is waiting for them. Only turns that Claude Code started itself (a background
task, a monitor, a subagent's report) stay intermediate while background work is left. With no decision such a turn
closes loud, as any other (item 2 below). An interrupt (Esc) does not count as a message.

A background task is any `background_tasks` entry, of whatever type. A hanging
dev server also makes turns intermediate: this is a rare case, and the agent really does wait for short background commands without
a monitor. `session_crons` do not affect the decision.

**Question.** The last paragraph is the text after the last blank line (line endings `\r\n` and `\n`), with
whitespace trimmed at the edges. Before looking for `?`, code blocks (```` ``` ````…```` ``` ````)
and inline code (`` `…` ``) are removed from the whole text, and links (`http://…`, `https://…` up to a space)
are removed from the last paragraph (a `?` at the very end of a link, before a space or the end of the text, counts as a question, not as part of the link).
An unclosed code block (a truncated answer) is removed up to the end of the text.
There is a question if the remaining text of the last paragraph has a `?`. An empty paragraph after a code block does not
count: the last non-empty one is taken.

The hook passes the decision to the hub: `POST /turn-end` with the body `{ messagingSocket, session_id, final, kind }`
(`kind` only for a final one). The hub gives it to the window with this `messagingSocket` in the WS message
`{ type: "turnEnd", final, kind? }`. The hook never fails and prints nothing. If the hub does not answer
within 1.5 s and the turn is final, the hook plays the terminal sound itself (without the hub Telegram does not work anyway).
The 30 s threshold for `done` does not apply here: only the window plugin knows the input time. The hub runs
all the time, so this is a rare case.

## When the turn has really ended

The hook does not know whether another Stop hook or a classifier will continue the turn. Waiting for silence is not enough: the `/goal`
prompt hook can continue the turn a couple of seconds after the answer ends. The reliable sign of the real
end is the system record `turn_duration` (`turn_closed` in the parser). Claude Code writes it once for
the whole turn, after all Stop hooks and all continuations: in a transcript with continuations there are several `stop_hook_summary`
in a row and one `turn_duration` at the end.

The plugin closes a turn like this:

1. The transcript showed `turn_end`, then `turn_closed`, and a `turnEnd` decision exists: the turn is closed
   at once by the last decision.
2. `turn_closed` exists, there is no decision: wait for it `TURN_DECISION_MS = 5000` ms from `turn_closed`, then
   close as a final `done`. This means the hook failed or the hub restarted: in Telegram an extra sound is better than
   a lost one. The terminal sound is not played here: broken hooks must not chime on every turn.
3. There is no `turn_closed` (old Claude Code, an interrupted turn): close when for `TURN_CLOSE_WAIT_MS =
   30_000` ms there are no new records from the main agent and no new decision has come: by the decision, if there is
   one, otherwise as in item 2. The period is long because a prompt hook can think for more than 5 s and still
   continue the turn, and `turn_closed` always comes in the current Claude Code.

A record of another message after `turn_end` means the turn continued: the text goes out silently, as an
intermediate one, the decision is reset, and the next Stop decides. The decision can arrive earlier than the
records of the turn end are fully read: before accepting a decision, the plugin reads the transcript to the end.

A decision that arrives after the turn is already closed (and there have been no new records since) is late and
is dropped: otherwise it would make the next turn, started by a monitor, loud. On a forced
close (window shutdown, session change, a cut-off answer) the decision is taken into account only if the turn has already
ended (`turn_end`); text in the middle of a turn goes out silently.

Delay: the final text goes out when `turn_duration` is read: after the running time of the Stop hook
(starting bun and the request to the hub) plus up to 300 ms of transcript polling.

## Telegram mode on

The final text of the turn goes to the topic once, as before:

- a final turn: with a sound (`ask` and `done` sound the same in Telegram);
- an intermediate one: without a sound;
- a final turn with no text after the last tool call: nothing. There are no separate messages just for
  a sound. A notification in Telegram exists only together with a message, so such a turn ends
  silently. A separate message "✅ Done" is not sent.

Texts before tool calls still go out at once and without a sound. The terminal sound is never played in this
mode.

## Telegram mode off

For a final turn the window plugin starts the sound:

- `ask`: always;
- `done`: only if at least `CHIME_MIN_TURN_MS = 30_000` ms have passed since the user's last input in the terminal (`terminal_input`). Quick
  answers while the user is at the terminal do not chime.
  Turns started by a monitor or a background task do not reset the count: the result after a long run
  chimes. If there has been no input in this window yet, it chimes.

The sound plays when the turn is closed by the rules above, not when the decision arrives: a continued turn chimes
once, at the real end.

The command is `turnEndChime` in the hub's `config.json`, a string with the substitution `{kind}` (`ask` or `done`),
run through the shell without waiting for it to finish. By default on Windows the system Windows
sound plays. A set command replaces it. An empty string means no sound. A wrong value (not a string) is treated as the default, with a log entry.

## What was removed

The `tg_notify` tool is gone: from the tool list, from the MCP server instructions, and from
`relay.ts` (the `notify` flag is replaced by the Stop hook decision, the marker "🔔 Turn finished — answer above." was removed
with no replacement). The other tools (`tg_enable`, `tg_disable`, `tg_send_file`, `download_attachment`,
`tg_before_question`) do not change.

If the user has their own skill or instruction by which the model plays a sound at the end of a turn itself,
it must be removed: otherwise the sound will be doubled. The end-of-turn signal comes only from the telegram-hub Stop hook.

## Decisions made

Where there was a choice, reliability was preferred. Chosen this way: closing the turn by
`turn_duration` (waiting for silence is unreliable: prompt hooks continue the turn later), `done` with a sound after 5 s with no decision (Telegram only), excluding code and links when looking for
a question, the 30 s threshold since the last input for `done` in the terminal, and any background task making a turn
intermediate unless the user's own message started it (agents nearly always leave a monitor or a subagent running, so
otherwise their answers to the user came without sound).

The texts in Telegram that this signal produces are English by default and Russian when rig's language is `ru`,
see `language-design.md`.
