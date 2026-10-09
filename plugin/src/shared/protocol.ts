// Messages between a plugin (one per Claude Code window) and the hub, as JSON
// over a localhost WebSocket.
export const PROTOCOL_VERSION = 1

// The hub's localhost port unless TG_HUB_PORT says otherwise. This file has no
// imports, so the plugin's function hooks module can use it too.
export const DEFAULT_PORT = 47613

// A command from the topic, which the plugin's function hooks module takes
// from the hub (GET /commands?session=<id>) and answers (POST /reply).
export type TopicCommand = { id: string; name: "info" | "compact"; args: string }
export type CommandReply = { sessionId: string; id: string; text: string; notify: boolean }

export type ChannelMeta = Record<string, string>

export type QueuedFile = { path: string; name: string; size: number }

export type PluginToHub =
  | { type: "hello"; v: number; windowKey: string; sessionId: string; cwd: string }
  | { type: "session"; sessionId: string; cwd: string }
  | { type: "req"; id: string; op: "enable"; title: string }
  | { type: "req"; id: string; op: "disable" }
  | { type: "req"; id: string; op: "download"; fileId: string }
  // sessionId: the session the text was written in (older plugins omit it;
  // then the window's current session is meant).
  | { type: "send"; id: string; sessionId?: string; text: string; notify: boolean }
  // Files for the topic; paths are the plugin's copies in outbox-files/.
  // asDocument: every file goes as a document, so Telegram does not recompress images.
  | { type: "sendFiles"; id: string; sessionId: string; files: QueuedFile[]; caption: string; notify: boolean; asDocument?: boolean }
  | { type: "permission"; toolName: string; description: string }
  | { type: "title"; title: string }
  | { type: "terminalInput" }

export type HubToPlugin =
  | { type: "state"; enabled: boolean; topicTitle?: string }
  | { type: "inbound"; content: string; meta: ChannelMeta }
  | { type: "res"; id: string; ok: boolean; result?: unknown; error?: string }
  | { type: "ack"; id: string }
  // Every send of a sendFiles message left the hub's queue; error if any failed.
  | { type: "filesSent"; id: string; error?: string }
  | { type: "switchSession"; sessionId: string; transcriptPath: string; cwd: string }


// Body the SessionStart hook POSTs to /hook.
export type HookBody = {
  messagingSocket: string
  session_id: string
  transcript_path: string
  cwd: string
  source?: string
}
