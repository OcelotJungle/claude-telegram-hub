# telegram-hub: agent polls in Telegram

Basis: `telegram-hub-design.md` (data flows, permission requests) and
`hub-iteration-2-design.md` (buttons, `callback_query`).

Hub texts quoted below are English by default and Russian when rig's language is ru, see `language-design.md`.

## Why

When an agent calls the built-in `AskUserQuestion` tool, the dialog with options appears only in the
terminal. The user in Telegram does not see it and cannot answer: the session just stands still. The workaround
(a message with "!") interrupts the turn and loses the question itself.

The poll arrives in the topic as a message with buttons: the answer options, "✏️ Own option", "✖️ Cancel".

## How Claude Code lets you answer

Documented (code.claude.com/docs/en/hooks.md, "Tools that require user interaction"): a
`PreToolUse` hook on `AskUserQuestion` can collect the answers itself and return
`permissionDecision: "allow"` together with `updatedInput`. `updatedInput` replaces the tool input
as a whole, so it carries the whole original `tool_input` (the `questions` array and any other fields) and an
added `answers` object: question text → label of the chosen option; with multiple choice the
labels are separated by commas. Then the dialog is not shown in the terminal, and the agent gets the answers as the result of the
tool. `"allow"` without `updatedInput` does not work for this tool.

Claude Code cannot keep a poll alive in the terminal and in Telegram at the same time (relaying channel
permissions does not apply to `AskUserQuestion`). So the poll lives in one place.

If the hook did not finish within its `timeout`, Claude Code discards its output and goes on the usual way,
that is, shows the dialog in the terminal. All the "fallback" cases below rely on this.

## Behavior

**Where the poll is.** Telegram mode is on: the poll is only in the topic; in the terminal, while waiting, the hook's
status line "Waiting for an answer in Telegram" (`statusMessage`). Mode is off: the hook decides nothing, the dialog is in the
terminal, as before. If the mode is switched off while a poll is open (`tg_disable`), the poll is closed as if it timed out: the dialog opens in the terminal, and the message in the topic
is marked "⌛ The poll was moved to the terminal".

**Time limit.** The poll waits for an answer for 24 hours (hook `timeout` 86400 s). When it expires, the poll opens in the
terminal, the message in the topic is marked "⌛ The poll was moved to the terminal", and the buttons are removed. If the window or the
hub restarted while the poll was open, it also ends up in the terminal (the hook ended without an answer);
pressing a button of such a poll answers "The poll is outdated" and removes the buttons, as with permissions.

**Several questions.** One call can have up to 4 questions. They arrive one by one: the next one comes
after the previous one is answered. The agent gets all the answers at once, when all are answered.

**Message.** With sound. Text: the question header (`header`), the question itself, below it the numbered
options with descriptions. If an option has a `preview` (a code sample, a mockup), it goes under the option
as a code block, cut to 700 characters. The message is always one, within the Telegram limit (4096
characters) with room for the result line: if the text is longer than 3700 characters, previews are dropped, and if it is still
longer without them, the text is cut with "…". The edited message with the result line also stays
within 4096. With several questions the header has a number: "Question 2 of 3". Buttons: one per option,
"number. label", each in its own row; then a row "✏️ Own option" and "✖️ Cancel".

**Single choice.** Pressing an option is the answer.

**Multiple choice** (`multiSelect`). Pressing toggles the option; a selected one is shown with "☑️"
at the start of the label. A button "✅ Done" is added; with no options selected it answers with the hint
"Pick at least one option" and sends nothing.

**Custom answer.** The button "✏️ Own option" answers in the topic "Write the answer in the next message".
The user's next message in the topic becomes the answer to the current question. A message
sent without pressing the button while the poll is open counts the same way: the agent will not read it anyway while it
waits for the answer. This is any message, with media too: `answers` gets the text or caption and the same
file marks as in incoming batches ("(photo: path)", "(kind: name, file_id: X)"). Only a message sent after the question message
counts as an answer (its `message_id` is greater);
a message older than the question or sent while the question is not yet shown goes to the agent as an ordinary
incoming message. Several messages sent together (an album, a couple of lines in a row) are one answer: the hub
collects them with the same quiet window as incoming batches. The answer message gets the same ✍
"not yet read" reaction as an ordinary incoming message; when the agent gets the answers, the hub removes it. If the poll
ended without answers to the agent (cancel, move to the terminal), the ✍ stays: the agent did not read that message.
Commands (`/info`, `/compact`, `/pwsh` and so on) do not count as an answer, work as usual and do not
close the poll; `/stop` ends the session, and its poll becomes outdated.

**Cancel.** "✖️ Cancel" closes the poll: the hook answers `permissionDecision: "deny"` with the reason
"The user cancelled the question in Telegram. Do not ask it again; end your turn and wait for their
message." The agent ends the turn.

**A message with "!" while a poll is open.** It closes the poll the same way as cancel, and the message itself
goes to the agent as an ordinary incoming message: without "!" and without an interrupt (the agent is waiting for the answer, there is nothing to interrupt, and
an interrupt would break the turn that starts with the denial). A lone "!" only closes the poll and sends the agent
nothing.

**After the answer.** The question message is edited: the buttons are removed, at the bottom "✅ <answer>" (with
multiple choice, the labels separated by commas; for a custom answer, its text, cut like a quote in the
reply context), "✖️ Poll cancelled" or "⌛ The poll was moved to the terminal".

**One poll per session.** The agent cannot call a second `AskUserQuestion` while it waits for the first. If a
new poll still arrives (the old hook died), the old one is closed as outdated.

## How it works

**Hook.** A `command` hook `PreToolUse` with `matcher: "AskUserQuestion"` (`src/hook/question.ts`, `timeout`
86400, `statusMessage`). The hook reads `session_id` and `tool_input` from stdin (documented), sends
`POST /question` to the hub with `{messagingSocket, session_id, tool_input}` and waits for the answer (`fetch` with
`timeout: false`, otherwise Bun drops an idle request after 5 minutes). The wait ends by itself in two
cases, even if Claude Code never killed the hook: at the hook's own limit, one minute less than `timeout`
(`src/hook/question-limits.ts`), and when the parent process is gone (checked every 2 s with the signal
`kill(pid, 0)`, without starting processes). Then the hook aborts the request and exits silently. The hub answers
`{decision: "allow", answers}`, `{decision: "deny", reason}` or `{decision: "none"}`. The hook prints the
decision only for allow and deny (it waits for the stdout write to finish before exiting, so a long answer is not
cut); on none, an error or an unreachable hub it stays silent, and the dialog opens in the
terminal. An `mcp_tool` hook was not chosen: the wait would run into MCP request timeouts, while a `command` hook
has a single limit, its `timeout`.

**Session.** The hub finds the session by the window with this `messagingSocket`, otherwise by `session_id`. Mode off
or no session: none. The hub removes its idle timeout from the request and keeps it open until the poll
ends.

**Text before the question.** Claude Code writes the agent's step (the text and the `AskUserQuestion` call) to the transcript
only after the PreToolUse hook has finished, that is, after the user's answer. So text
written in the same step as the question reaches the topic only after the poll, and no waiting in the window
can fix that. To make the explanation arrive above the poll, the agent has a separator tool,
`tg_before_question`: no arguments, does nothing and answers "Now call AskUserQuestion.". The agent
writes the explanation, calls `tg_before_question` and only in the next step (not in parallel in the same one)
calls `AskUserQuestion`. Claude Code writes the separator step to the transcript at once, and the relay
sends the text before it, as before any tool call. The MCP server instructions and the description of the tool
itself say so. Before showing the question the hub still sends the session window a `catchUp`: the window
reads the transcript to the end at once, sends the hub the not yet sent text before the call (as before
`tg_send_file`) and answers `caughtUp`. The hub waits for the answer up to 1 s (an old window does not know `catchUp` and
does not answer, then the poll simply goes after the pause) and puts the question in the send queue behind the
messages already there, so the separator text, if the window read it late, still ends up above the
poll. A poll closed during the wait is not shown.

**Answers.** `answers`: question text → option label; with multiple choice the labels in option order
separated by ", "; a custom answer is the message text (or caption) and file marks separated by a space; several messages
of one answer are separated by a blank line, in the order sent.

**End of the wait without an answer.** The hook is killed (`timeout` expired, the window closed, probably Esc, not
verified): the request to the hub is aborted, and the poll is closed with "⌛ The poll was moved to the terminal". The following
are closed the same way: the old poll of a session when a new one comes, polls when the hub stops, polls of a session that has no
connected windows left, polls of a session whose Telegram mode was switched off, and a poll whose message
Telegram did not accept. Pressing a button of a
closed poll answers "The poll is outdated" and removes the buttons.

**Buttons.** Labels are cut to 64 characters; `callback_data` is
`q:<key>:<question number>:<action>`, the key is 8 hex characters, as with permissions. Pressing a button of a
question that is not the current one counts as outdated.

**State.** The hub keeps open polls in memory; when the hub restarts, the request is aborted and the poll
opens in the terminal.
