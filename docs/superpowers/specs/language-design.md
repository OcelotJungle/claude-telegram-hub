# Hub language

## Intent

The hub is meant for anyone, so English is the default everywhere: README, specs, instructions and texts for agents,
bot replies and buttons, errors. Russian appears only in what the hub shows a person in Telegram, and only when rig's
shared language setting is Russian.

## Contract with rig (rig 0.3.0)

1. Only rig stores the language; the hub keeps no copy, in memory across restarts or on disk.
   `rig language --json` prints exactly `{"language":"en"}` or `{"language":"ru"}`. When rig is missing, the command
   fails (non-zero exit, timeout, output that does not match that schema), the language is English.
2. The hub reads the language at start and on a `language-changed` event in `events.jsonl`. Like every other text
   event, the hub sends it to the shared topic as is: its text is already in the new language. Then the hub re-reads
   the language and the feature list: `description` in `rig feature --json` is a string in the current language.
3. `rig status --json` is unchanged; it has no language field.
4. Output of rig commands is already in the current language; the hub shows it as is.
5. `/rig language` shows the language, `/rig language en|ru` switches it. Accepted from allowFrom users exactly like
   `/rig status|update`: the hub runs rig and shows its output. Other arguments get the usage reply.
6. Agents' answers are not tied to the setting: their own rules make them answer in the user's language. The hub does
   not interfere.

## What is localized

Every text the hub or a window's plugin puts in front of a person in Telegram: messages and their edits, buttons, poll
texts, callback answers, notices and errors, the topic fallback name, `/info` and the other topic commands, the bot
command menu (`setMyCommands`). Rig's own output and event texts are shown as is.

Not localized, always English: logs, MCP instructions and tool results for agents, errors that only reach logs,
docs, code and comments.

## Message catalog

- `plugin/src/shared/i18n/en.ts` defines the full message set and its type; `plugin/src/shared/i18n/ru.ts` is the
  Russian catalog of the same type, so a missing or extra key fails the type check.
- A message with values is a function of named parameters; the catalog owns word order.
- Plural forms come from `Intl.PluralRules` for the catalog's language; the catalog gives the form per plural
  category. No language grammar is coded by hand.
- `ru.ts` is the only tracked file allowed to contain Cyrillic. A guard test lists `git ls-files` and fails on any
  other tracked file with a Cyrillic character. Test data that must exercise non-Latin text writes it as `\u` escapes.

## Language state

- The hub holds the current language (`en` or `ru`) and passes the matching catalog to the code that renders texts;
  render code takes the catalog as an argument rather than reading a global.
- At start: one `rig language --json` query with a strict schema, through the same runner and time limit as the other
  rig queries. Any failure gives English and a log warning.
- On `language-changed`: the event is a text event and is delivered like any other. It is also a service event: it is
  handled when read even while Telegram delivery is off, and its handling does not wait for delivery. Handling
  re-reads the language, then the features, then sets the bot command menu again in the new language. Several
  `language-changed` events in one poll cause one re-read.
- Windows: the hub sends the current language to each plugin when it connects and again on every change; a plugin
  renders its Telegram texts with that catalog and uses English until the first message arrives.
- Messages the hub updates in place (Codex card, subagent cards, statuses, polls still open) are rendered in the new
  language at their next update; nothing is re-sent just because the language changed.

## Checks (tests)

- Without a language from rig (rig missing, failing or returning bad JSON) every hub and plugin text is English.
- The hub picks up the language at start and on a `language-changed` event: texts, feature descriptions and the bot
  command menu follow it; a plugin gets the language on connect and on change.
- `/rig language`, `/rig language ru` from an allowFrom user run rig and show its output; from a user outside allowFrom
  they are ignored.
- Guard: no Cyrillic in tracked files except the Russian catalog.
