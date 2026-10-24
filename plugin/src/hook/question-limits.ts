// Time limits of the AskUserQuestion hook.

// A minute under the hook's timeout in hooks.json (86400 s): the hook gives up
// by itself even if Claude Code never kills it.
export const QUESTION_DEADLINE_MS = 86_340_000;
// How often the hook checks that its parent is still there.
export const PARENT_CHECK_MS = 2000;
