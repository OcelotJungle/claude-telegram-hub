#!/usr/bin/env bun
// PreToolUse hook for AskUserQuestion: while Telegram mode is on, the hub asks
// the questions in the topic and holds the request until they are answered.
// Prints a decision only for an answer (allow with the answers) or a cancel
// (deny); otherwise, or on any error, prints nothing and the terminal shows
// its own dialog.
import { z } from "zod";
import { hubPort } from "../shared/config.ts";
import { questionDecision } from "../shared/protocol-schema.ts";

// The part of the hook input the hub needs; the hub checks the questions.
// The tool input stays whole: updatedInput replaces it, so other fields must
// survive.
const hookInput = z.object({
  session_id: z.string().min(1),
  tool_input: z.looseObject({ questions: z.array(z.unknown()) }),
});

try {
  const parsed = hookInput.safeParse(JSON.parse(await Bun.stdin.text()));
  if (parsed.success) {
    const input = parsed.data;
    // No deadline: the hook's own timeout bounds the wait. timeout: false
    // turns off Bun's 5-minute idle timer on the held request.
    const res = await fetch(`http://127.0.0.1:${hubPort()}/question`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messagingSocket: process.env.CLAUDE_CODE_MESSAGING_SOCKET,
        session_id: input.session_id,
        tool_input: input.tool_input,
      }),
      timeout: false,
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
