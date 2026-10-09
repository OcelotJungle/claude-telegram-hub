#!/usr/bin/env bun
// SessionStart hook: tells the hub which session this window runs now (after
// startup, /resume, /clear, compact), keyed by the window's messaging socket,
// which the MCP server of the same window also sees. Never fails, never prints:
// hook stdout would land in the session context.
import { z } from "zod";
import { hubPort } from "../shared/config.ts";

const HUB_TIMEOUT_MS = 1500;

// The part of the hook input the hub needs.
const hookInput = z.object({ session_id: z.string().min(1), transcript_path: z.string().min(1), cwd: z.string().optional(), source: z.string().optional() });

try {
  const parsed = hookInput.safeParse(JSON.parse(await Bun.stdin.text()));
  const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (socket && parsed.success) {
    const input = parsed.data;
    await fetch(`http://127.0.0.1:${hubPort()}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messagingSocket: socket,
        session_id: input.session_id,
        transcript_path: input.transcript_path,
        cwd: input.cwd ?? "",
        source: input.source,
      }),
      signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
    });
  }
} catch {}
process.exit(0);
