# Executor cards: Codex and volunteer

## Why

Claude can hand executor work to Codex or volunteer through a subagent of the same name.
The workers run `~/.claude/tools/codex-run.py` and `~/.claude/tools/volunteer-run.py`, and then
periodically retell a summary. The card reads the job files directly and shows the progress
without waiting for the next retelling.

| Executor | Job directory | Script | Summary prefix | Prompt prefix |
| --- | --- | --- | --- | --- |
| `codex` | `~/.claude/codex-jobs/<JOB>/` | `codex-run.py` | `codex job ` | `reply:` |
| `volunteer` | `~/.claude/volunteer-jobs/<JOB>/` | `volunteer-run.py` | `volunteer job ` | `reply:` |

For both executors JOB has the form `YYYYMMDD-HHMMSS-<hex>`. Tests can replace the job directories
and state files through the `SubagentWatcher` parameters.

## Job files

The JOB directory holds `state.json` and `events.jsonl`. In `volunteer-jobs`, next to the job directories,
there can also be `models.json`, `proxy.log` and `proxy-token`; these are service files, not jobs.

- `state.json` sets `status`, `slug`, `effort`, `notes` and `error`. The possible states include
  `starting`, `running`, `done`, `question`, `failed`, `cancelled`, `orphaned` and `limit`.
  For Codex, `slug` and `effort` set the model and the effort level. For volunteer, `slug` is the model
  that is working now, and `effort` is `-`. When the model switches, volunteer appends
  the note `HH:MM ...; switching to ...` and changes `slug`.
- `events.jsonl` holds the events of the run. `item.completed` with `item.type = agent_message` is a message;
  `reasoning` is hidden; `command_execution` sets the commands; `turn.completed` ends the run.
  The event time is the moment the hub read the line. OpenCode reports a command after it finishes,
  so for volunteer the current command is the last known command.

## How the card finds a job

The worker type is determined by `agentType` in `agent-<id>.meta.json`.

- `start` is detected by a `tool_result` with the line `job <JOB> started: ...`; events are read from the beginning.
- `reply <JOB>`, `attach <JOB>` and `wait <JOB>` are detected in a Bash command with the matching
  executor script. Events are read from the current end, because earlier runs are already shown.
- A `reply: <JOB>` or `attach: <JOB>` line in the user prompt opens the job before the script
  starts. The prompt can be a string or a set of text blocks. Events and notes that already exist
  are skipped when a job is continued.
- If the state file has not appeared yet, the card uses the usual subagent display. Until the first
  state, the model is not shown in the header.

Until a job is detected, the card stays an ordinary subagent card.

## One card per job in a session

`SubagentWatcher` keeps a mapping "executor and JOB -> card owner". If a new worker
finds a job from the registry before showing its own card, it continues the last part of the previous
owner's card with the same id. The registry separates executors, so the same JOB for Codex and volunteer
does not merge the cards. Texts and times are kept, the job description is updated.

The counter adds up the completed commands of all accepted runs. The work time sums the time of the runs
themselves, not counting the wait for a reply between them. After the handover the previous worker no longer changes the card.
A full card is continued by a separate part; the next worker takes the last part.
A new part replies to the previous card in the topic, if it was shown; a job handover
that updates the same card does not create a separate reply.

The registry lives only in the current session and is cleared when the watcher stops. After a restart of the
plugin, or for a job from another session, a new card is created. If the new worker has already shown its own
card, there is no handover.

## What the card shows

The header, the job description, the status and the current command go in this order. The executor name is `codex` or
`volunteer`; the model of the Claude Code worker (`haiku`) is not shown.

- For Codex the header keeps the format `🤖 **codex** · <model> · <effort>`. The model is formatted
  the same way as Claude models (for example, `sol`, or the version if it is known).
- For volunteer the header takes the model from `state.slug`: the first segment becomes the provider,
  the last one the model name, and the `:free` suffix is removed. For example,
  `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` is shown as
  `🤖 **volunteer** · openrouter · nemotron-3-ultra-550b-a55b`; `groq/openai/gpt-oss-120b` as
  `groq · gpt-oss-120b`. A one-part slug is shown as is. The effort level `-`
  is not printed in the header. When the slug changes, the header is updated.

The history gets the executor's messages and new `notes` lines in the form `🔁 <text>` with the time from
the note itself. An `agent_message` immediately followed by `turn.completed`
is held back and dropped as the final report: it stays in the worker's final answer. On a failure, the `error` from
the state is added as a separate entry `❌ <text>`.

Intermediate summaries (a line starting with `codex job ` or `volunteer job `) and start lines
(`job <JOB> started…`, `job <JOB> resumed with the reply`) do not go into the history, because the job data
is already shown directly. The worker's final report, including STATUS, Summary and the list of changed
files, stays visible. If the job files are missing, the worker's text is shown as usual.

While the job runs, the status line holds the time, the number of completed commands, the time of the last event
and the current command, if it is known. A question, a failure, a cancellation and a completion are shown as separate
statuses. For a question the executor name is used: `❓ Codex is waiting for an answer` or
`❓ Volunteer is waiting for an answer`. These texts are English by default and Russian when rig's language is
`ru`, see `language-design.md`.

## Out of scope

- Direct script runs that do not belong to a subagent of the matching type get no cards.
- `file_change` and the service files of the job directory are not shown.
