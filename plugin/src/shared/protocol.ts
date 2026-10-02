// Messages between a plugin (one per Claude Code window) and the hub, as JSON
// over a localhost WebSocket.
export const PROTOCOL_VERSION = 1

export type ChannelMeta = Record<string, string>

export type PluginToHub =
  | { type: 'hello'; v: number; windowKey: string; sessionId: string; cwd: string }
  | { type: 'session'; sessionId: string; cwd: string }
  | { type: 'req'; id: string; op: 'enable'; title: string }
  | { type: 'req'; id: string; op: 'disable' }
  | { type: 'req'; id: string; op: 'download'; fileId: string }
  // sessionId: the session the text was written in (older plugins omit it;
  // then the window's current session is meant).
  | { type: 'send'; id: string; sessionId?: string; text: string; notify: boolean }
  | { type: 'permission'; toolName: string; description: string }
  | { type: 'title'; title: string }
  | { type: 'terminalInput' }

export type HubToPlugin =
  | { type: 'state'; enabled: boolean; topicTitle?: string }
  | { type: 'inbound'; content: string; meta: ChannelMeta }
  | { type: 'res'; id: string; ok: boolean; result?: unknown; error?: string }
  | { type: 'ack'; id: string }
  | { type: 'switchSession'; sessionId: string; transcriptPath: string; cwd: string }

// Body the UserPromptSubmit hook POSTs to /prompt; the answer is PromptAnswer.
export type PromptBody = { session_id: string; input_source?: string }
export type PromptAnswer = { wasEnabled: boolean }

// Body the SessionStart hook POSTs to /hook.
export type HookBody = {
  messagingSocket: string
  session_id: string
  transcript_path: string
  cwd: string
  source?: string
}
