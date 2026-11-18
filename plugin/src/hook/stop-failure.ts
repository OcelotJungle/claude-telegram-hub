#!/usr/bin/env bun
// StopFailure hook: Claude Code ended the turn on an API error (the connection
// broke mid-response, a server error). Claude Code writes no turn_duration
// record after such a turn, so this hook is the window's only sign that the
// turn is over. Tells the window through the hub, keyed by the window's
// messaging socket. Never fails, never prints.
import { z } from "zod";

import { hubPort } from "../shared/config.ts";

const HUB_TIMEOUT_MS = 1500;

const hookInput = z.object({ session_id: z.string().min(1) });

try {
  const parsed = hookInput.safeParse(JSON.parse(await Bun.stdin.text()));
  const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (parsed.success && socket) {
    await fetch(`http://127.0.0.1:${hubPort()}/turn-failed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messagingSocket: socket, session_id: parsed.data.session_id }),
      signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
    }).catch(() => undefined);
  }
} catch {}
process.exit(0);
