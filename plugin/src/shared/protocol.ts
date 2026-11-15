// Messages between a plugin (one per Claude Code window) and the hub, as JSON
// over a localhost WebSocket.
import type { Entity } from "./markdown.ts";

export const PROTOCOL_VERSION = 1;

// The hub's localhost port unless TELEGRAM_HUB_PORT says otherwise. This file has no
// imports, so hooks can use it too.
export const DEFAULT_PORT = 47613;

// The one list of languages; every other place derives from it.
export const LANGUAGES = ["en", "ru"] as const;
export type Language = (typeof LANGUAGES)[number];
export type ResolutionKind = "success" | "warning" | "progress";

export type ChannelMeta = Record<string, string>;

export type QueuedFile = { path: string; name: string; size: number };

// What a plugin asks the hub to do; the hub answers with a res message.
export type HubRequest = { op: "enable"; title: string } | { op: "disable" } | { op: "download"; fileId: string };
// The result of enable.
export type EnableResult = { topicTitle: string; created: boolean };

// configDir: the window's CLAUDE_CONFIG_DIR, which names its cswap account
// (older plugins omit it). busy: the agent is in a turn. reportsSeen: the
// plugin sends seen, so a reaction put on a message will come off.
export type PluginToHub =
  // entrypoint: CLAUDE_CODE_ENTRYPOINT ("cli" for the terminal, absent or other for SDK runs); title: the session's title now.
  | { type: "hello"; v: number; windowKey: string; sessionId: string; cwd: string; configDir?: string; busy?: boolean; reportsSeen?: boolean; entrypoint?: string; title?: string }
  | { type: "session"; sessionId: string; cwd: string; configDir?: string; entrypoint?: string; title?: string }
  | ({ type: "req"; id: string } & HubRequest)
  // sessionId: the session the text was written in (older plugins omit it;
  // then the window's current session is meant).
  | { type: "send"; id: string; sessionId?: string; text: string; notify: boolean }
  // Files for the topic; paths are the plugin's copies in outbox-files/.
  // asDocument: every file goes as a document, so Telegram does not recompress images.
  | { type: "sendFiles"; id: string; sessionId: string; files: QueuedFile[]; caption: string; notify: boolean; asDocument?: boolean }
  // A permission prompt in the terminal; requestId (older plugins omit it)
  // lets the topic answer it.
  | { type: "permission"; requestId?: string; toolName: string; description: string; inputPreview?: string }
  | { type: "title"; title: string }
  // A subagent's card as formatted text (plain text + Telegram entities): one
  // Telegram message, sent once and then edited in place. final: the card closes;
  // reopen explicitly allows a continuation to update a closed card. Older
  // plugins omit entities and send the card as Markdown.
  | { type: "card"; id: string; sessionId: string; text: string; entities?: Entity[]; final: boolean; reopen?: boolean; replyTo?: string }
  // Topic messages that reached the agent's context, by Telegram message id.
  | { type: "seen"; messageIds: number[] }
  // The agent started working, or stopped: its turn ended or it waits for the user.
  | { type: "busy"; busy: boolean }
  // The answer to catchUp: the text written before the tool call is sent.
  | { type: "caughtUp"; id: string };

export type HubToPlugin =
  | { type: "state"; enabled: boolean; topicTitle?: string }
  // interrupt: the message stops the agent's turn if it works (the user
  // started it with "!", which the hub strips from content).
  | { type: "inbound"; content: string; meta: ChannelMeta; interrupt?: true }
  | { type: "res"; id: string; ok: boolean; result?: unknown; error?: string }
  | { type: "ack"; id: string }
  // Every send of a sendFiles message left the hub's queue; error if any failed.
  | { type: "filesSent"; id: string; error?: string }
  | { type: "switchSession"; sessionId: string; transcriptPath: string; cwd: string }
  // The answer to a permission prompt, given in the topic.
  | { type: "permissionReply"; requestId: string; behavior: PermissionBehavior }
  // The Stop hook's decision on how the turn ended; kind only when final.
  | { type: "turnEnd"; final: boolean; kind?: TurnEndKind }
  // The hub is about to show a question: relay the text the agent wrote
  // before the tool call, then answer caughtUp with the same id.
  | { type: "catchUp"; id: string }
  // The hub's language: sent on connect and on every change. A plugin uses English
  // until the first one arrives. Older plugins log it as an unknown message.
  | { type: "language"; language: Language };

export type PermissionBehavior = "allow" | "deny";
export type TurnEndKind = "ask" | "done";

// Body the Stop hook POSTs to /turn-end.
export type TurnEndBody = {
  messagingSocket: string;
  session_id: string;
  final: boolean;
  kind?: TurnEndKind;
};

// One question of an AskUserQuestion call, as the tool input carries it.
export type AskQuestion = {
  question: string;
  header: string;
  options: { label: string; description: string; preview?: string }[];
  multiSelect: boolean;
};

// Body the AskUserQuestion PreToolUse hook POSTs to /question; the hub holds
// the request open until the topic answers.
export type QuestionBody = {
  messagingSocket?: string;
  session_id: string;
  tool_input: { questions: AskQuestion[] };
};

// The hub's answer to /question; "none" leaves the dialog to the terminal.
// answers maps a question's text to the chosen labels joined with ", ".
export type QuestionDecision =
  | { decision: "allow"; answers: Record<string, string> }
  | { decision: "deny"; reason: string }
  | { decision: "none" };

// Body the SessionStart hook POSTs to /hook.
export type HookBody = {
  messagingSocket: string;
  session_id: string;
  transcript_path: string;
  cwd: string;
  source?: string;
};
