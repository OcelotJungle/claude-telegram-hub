#!/usr/bin/env bun
// Stop hook: decides how the turn ended (final ask/done or only a pause) and
// tells the window through the hub, keyed by the window's messaging socket.
// With no hub to tell, a final turn plays the terminal sound itself. Never
// fails, never prints: hook stdout would land in the session context.
import { z } from "zod";
import { decideTurnEnd } from "./turn-end.ts";
import { playChime } from "../shared/chime.ts";
import { hubPort, loadConfig } from "../shared/config.ts";

const HUB_TIMEOUT_MS = 1500;

// The part of the hook input the decision needs.
const hookInput = z.object({
  session_id: z.string().min(1),
  last_assistant_message: z.string().optional(),
  background_tasks: z.array(z.unknown()).optional(),
});

try {
  const parsed = hookInput.safeParse(JSON.parse(await Bun.stdin.text()));
  if (parsed.success) {
    const input = parsed.data;
    const decision = decideTurnEnd(input);
    const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
    let delivered = false;
    if (socket) {
      try {
        const res = await fetch(`http://127.0.0.1:${hubPort()}/turn-end`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messagingSocket: socket,
            session_id: input.session_id,
            final: decision.final,
            ...(decision.final ? { kind: decision.kind } : {}),
          }),
          signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
        });
        delivered = res.status === 200;
      } catch {}
    }
    if (!delivered && decision.final) playChime(loadConfig().turnEndChime, decision.kind);
  }
} catch {}
process.exit(0);
