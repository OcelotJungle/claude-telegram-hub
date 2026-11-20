import type { Messages } from "../shared/i18n/index.ts";
import type { MessageKind } from "../shared/notification.ts";
import type { RigError } from "./rig.ts";
import type { RigAutocompact, RigCleanup, RigCompact, RigRename, RigStop } from "./rig-session.ts";

import { literal } from "../shared/markdown.ts";
import { tokens } from "../shared/tokens.ts";
import { rigErrorText } from "./rig.ts";

// What the topic is told when a `rig session` call ends: the text and how loud it is.
export type SessionOutcome = { text: string; kind: MessageKind };

// rig's code for a session whose Claude Code does not have the hooks module loaded: only a restart helps.
const NO_MODULE_CODE = "session-no-module";

function compactedLine(c: { tokensBefore: number; tokensAfter: number } | { skip: string } | { error: string }, m: Messages): SessionOutcome {
  if ("skip" in c) return { text: m.compactSkipped({ reason: literal(c.skip) }), kind: "warning" };
  if ("error" in c) return { text: m.compactFailed({ error: literal(c.error) }), kind: "warning" };
  return { text: m.compactDoneTokens({ before: tokens(c.tokensBefore), after: tokens(c.tokensAfter) }), kind: "info" };
}

export function compactOutcome(value: RigCompact, m: Messages): SessionOutcome {
  return compactedLine(value, m);
}

export function renameOutcome(value: RigRename, m: Messages): SessionOutcome {
  return { text: m.renameDone({ name: literal(value.name) }), kind: "info" };
}

// rig's own words when it said any, otherwise the window that was set.
export function autocompactOutcome(value: RigAutocompact, m: Messages): SessionOutcome {
  const text = value.text?.trim();
  return { text: text ? literal(text) : m.autocompactDone({ window: String(value.window) }), kind: "info" };
}

export function cleanupOutcome(value: RigCleanup, m: Messages): SessionOutcome {
  const sizes = { before: tokens(value.compacted.tokensBefore), after: tokens(value.compacted.tokensAfter) };
  return { text: value.skillsRemoved > 0 ? m.cleanupDoneSkills({ ...sizes, skills: value.skillsRemoved }) : m.cleanupDone(sizes), kind: "info" };
}

// A stop reports its compaction even when another stop ended the session while it was compacting.
export function stopOutcome(value: RigStop, m: Messages): SessionOutcome {
  if (!value.stopped && value.compacted === undefined) return { text: m.sessionNotRunning, kind: "info" };
  if (value.compacted === null || value.compacted === undefined) return { text: m.sessionEnded, kind: "info" };
  const compacted = compactedLine(value.compacted, m);
  return { text: `${m.sessionEnded}\n${compacted.text}`, kind: compacted.kind };
}

// rig's own message goes as it is; a session without the module also learns what to do about it.
export function failureOutcome(error: RigError, m: Messages): SessionOutcome {
  const text = literal(rigErrorText(error, m));
  const needsRestart = error.kind === "rig" && error.code === NO_MODULE_CODE;
  return { text: needsRestart ? `${text}\n${m.sessionRestartHint}` : text, kind: "error" };
}
