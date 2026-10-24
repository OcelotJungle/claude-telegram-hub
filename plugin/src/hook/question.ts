#!/usr/bin/env bun
// PreToolUse hook for AskUserQuestion: while Telegram mode is on, the hub asks
// the questions in the topic and holds the request until they are answered.
// Prints a decision only for an answer (allow with the answers) or a cancel
// (deny); otherwise, or on any error, prints nothing and the terminal shows
// its own dialog.
import { z } from "zod";
import { isAlive } from "../hub/exec-runner.ts";
import { hubPort } from "../shared/config.ts";
import { questionDecision } from "../shared/protocol-schema.ts";
import { PARENT_CHECK_MS, QUESTION_DEADLINE_MS } from "./question-limits.ts";

// The part of the hook input the hub needs; the hub checks the questions.
// The tool input stays whole: updatedInput replaces it, so other fields must
// survive. tool_use_id lets the window wait until its transcript shows the
// call; without it the question still goes, only without that wait.
const hookInput = z.object({
  session_id: z.string().min(1),
  tool_use_id: z.string().optional().catch(undefined),
  tool_input: z.looseObject({ questions: z.array(z.unknown()) }),
});

// The wait ends at the hook's own deadline (TG_HUB_QUESTION_DEADLINE_MS
// shortens it for tests) or once the parent is gone: a hook that Claude Code
// no longer waits for must not hold the poll open. Only signals the parent,
// so it starts no process; on Windows ppid keeps the dead parent's number.
const stop = new AbortController();
const parent = process.ppid;
const deadline = Number(process.env.TG_HUB_QUESTION_DEADLINE_MS) || QUESTION_DEADLINE_MS;
setTimeout(() => stop.abort(), deadline);
setInterval(() => {
  if (process.ppid !== parent || !isAlive(parent)) stop.abort();
}, PARENT_CHECK_MS);

try {
  const parsed = hookInput.safeParse(JSON.parse(await Bun.stdin.text()));
  if (parsed.success) {
    const input = parsed.data;
    // timeout: false turns off Bun's 5-minute idle timer on the held request.
    const res = await fetch(`http://127.0.0.1:${hubPort()}/question`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messagingSocket: process.env.CLAUDE_CODE_MESSAGING_SOCKET,
        session_id: input.session_id,
        ...(input.tool_use_id ? { tool_use_id: input.tool_use_id } : {}),
        tool_input: input.tool_input,
      }),
      timeout: false,
      signal: stop.signal,
    });
    const decision = questionDecision.safeParse(await res.json());
    if (decision.success && decision.data.decision !== "none") {
      const d = decision.data;
      const output =
        d.decision === "allow"
          ? { permissionDecision: "allow", permissionDecisionReason: "Answered in Telegram", updatedInput: { ...input.tool_input, answers: d.answers } }
          : { permissionDecision: "deny", permissionDecisionReason: d.reason };
      // Awaited: process.exit below must not cut a large answer short.
      await Bun.write(Bun.stdout, JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...output } }));
    }
  }
} catch {}
process.exit(0);
