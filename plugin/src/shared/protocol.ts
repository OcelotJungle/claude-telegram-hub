// Messages between a plugin (one per Claude Code window) and the hub, as JSON
// over a localhost WebSocket.
export const PROTOCOL_VERSION = 1;

// The hub's localhost port unless TG_HUB_PORT says otherwise. This file has no
// imports, so the plugin's function hooks module can use it too.
export const DEFAULT_PORT = 47613;

// A command from the topic, which the plugin's function hooks module takes
// from the hub (GET /commands?session=<id>) and answers (POST /reply). stop
// goes only to a module that asks with &stop=1; once it is ready for the
// window to end, it says so with POST /terminate. cleanup goes only to a
// module that asks with &cleanup=1; it compacts with the args and reports
// with POST /cleanup: the context sizes before and after, or the error. rename
// goes to any module with the new name as args; it runs the session's /rename.
export type TopicCommand = { id: string; name: "info" | "compact" | "stop" | "cleanup" | "rename"; args: string };
export type CommandReply = { sessionId: string; id: string; text: string; notify: boolean; replaces?: { id: string; kind: "success" | "warning" }; awaitsResult?: true };
export type TerminateRequest = { sessionId: string; id: string };
export type CleanupReport = { sessionId: string; id: string; before?: number; after?: number; error?: string };

// Rate limits are the account's, but a session knows them only from its own
// last API response. Each module posts its readings (POST /limits, `at` in
// ms), and /info takes the freshest one of the sessions on its account
// (GET /limits?session=<id>, answered with a reading or null).
export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string };
export type LimitsReading = { at: number; rateLimits: RateLimit[] };
export type VolunteerLimitsResult =
  | { kind: "none" }
  | { kind: "error"; reason: string }
  | {
      kind: "ok";
      at: number;
      dayPercent: number;
      resetsAt?: number;
      providers: { name: string; used: number; cap: number }[];
    };
export type LimitsPost = LimitsReading & { sessionId: string };

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
  | { type: "hello"; v: number; windowKey: string; sessionId: string; cwd: string; configDir?: string; busy?: boolean; reportsSeen?: boolean }
  | { type: "session"; sessionId: string; cwd: string; configDir?: string }
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
  | { type: "terminalInput" }
  // A subagent's card as Markdown: one Telegram message, sent once and then
  // edited in place. final: the card closes; reopen explicitly allows a
  // continuation to update a closed card.
  | { type: "card"; id: string; sessionId: string; text: string; final: boolean; reopen?: boolean; replyTo?: string }
  // Topic messages that reached the agent's context, by Telegram message id.
  | { type: "seen"; messageIds: number[] }
  // The agent started working, or stopped: its turn ended or it waits for the user.
  | { type: "busy"; busy: boolean }
  // The plugin is about to end this Claude Code process (after terminate), so
  // the hub can wait until it is gone.
  | { type: "exiting"; pid: number }
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
  // /stop in the topic: end the Claude Code process of this window.
  | { type: "terminate" }
  // The Stop hook's decision on how the turn ended; kind only when final.
  | { type: "turnEnd"; final: boolean; kind?: TurnEndKind }
  // The hub is about to show a question: relay the text the agent wrote
  // before the tool call, then answer caughtUp with the same id.
  | { type: "catchUp"; id: string };

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
