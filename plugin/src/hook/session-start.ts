#!/usr/bin/env bun
// SessionStart hook: tells the hub which session this window runs now (after
// startup, /resume, /clear, compact), keyed by the window's messaging socket,
// which the MCP server of the same window also sees. Never fails, never prints:
// hook stdout would land in the session context.
import { hubPort } from "../shared/config.ts"

try {
  const input = JSON.parse(await Bun.stdin.text())
  const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET
  if (socket && input?.session_id && input?.transcript_path) {
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
      signal: AbortSignal.timeout(1500),
    })
  }
} catch {}
process.exit(0)
