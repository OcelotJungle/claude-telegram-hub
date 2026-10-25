// Turns one transcript (.jsonl) record into the events the relay cares about.
// Record shapes: see "Результаты проверки" in the design spec.
import { basename } from "path";
import { arr, field, isObject } from "../shared/guards.ts";

// The block kind sits near the start of a thinking signature; this much of
// its base64 covers it.
const SIGNATURE_HEAD_CHARS = 64;
// A tool call's detail (its file, command or pattern) is cut to this.
const MAX_DETAIL_CHARS = 60;
// Input fields that tell what a tool call does, best first.
const DETAIL_FIELDS = ["file_path", "notebook_path", "description", "pattern", "command", "url", "query", "prompt"];
const CHANNEL_MESSAGE_ID = /<channel\b[^>]*\bmessage_id="(\d+)"/g;
// Claude Code's record for Esc: "[Request interrupted by user]", or "… for tool use]".
const INTERRUPTED = /^\[Request interrupted by user\b/;
// How the result of a TaskStop call begins.
const TASK_STOPPED = "Successfully stopped task";
// The note of a notification Claude Code writes each time a background agent
// ends a turn with a task of its own still running: the agent goes on.
const AGENT_WAITING = /<note>[^<]*background work of its own still running/;
// The model name of messages Claude Code writes itself.
const SYNTHETIC_MODEL = "<synthetic>";

export type TranscriptEvent =
  | { kind: "text"; text: string; messageId: string }
  // detail: what the call works on, for a status line.
  | { kind: "tool_use"; name: string; messageId: string; detail?: string }
  // cut: the connection to the API failed, before or during the response,
  // and the turn ended on it: the answer is missing or incomplete.
  | { kind: "turn_end"; messageId: string; cut?: true }
  // Claude Code's record of a failed connection to the API. The turn may go
  // on: the record is written as well when only the auto mode classifier's
  // response broke off, or before Claude Code retries the request itself. It
  // ended the turn only if turn_closed comes before the turn goes on.
  | { kind: "api_error"; messageId: string }
  // Claude Code closed the turn (system record turn_duration). pendingAgents:
  // background subagents still running; the Stop hook does not see them.
  | { kind: "turn_closed"; pendingAgents: number }
  | { kind: "terminal_input" }
  | { kind: "title"; source: "custom" | "agent" | "ai"; title: string }
  // A thinking block with text whose kind is neither thinking nor narration:
  // the record format changed, and visible text may be going unrelayed.
  | { kind: "unknown_thinking"; blockKind: string }
  // A background task (a subagent among them) stopped: completed, failed or
  // killed. taskId of a subagent is its agent id.
  | { kind: "task_status"; taskId: string; status: string }
  // A subagent started a background task (Bash, Monitor, Agent): it will be woken
  // when the task ends.
  | { kind: "task_started"; taskId: string }
  // Topic messages that reached the agent's context: Telegram message ids.
  | { kind: "channel_seen"; messageIds: number[] }
  // The user stopped the turn (Esc).
  | { kind: "interrupted" };

type Rec = Record<string, unknown>;

export function parseRecord(r: unknown): TranscriptEvent[] {
  if (!isObject(r)) return [];
  if (r.isSidechain === true) return [];
  switch (r.type) {
    case "assistant":
      return parseAssistant(r);
    case "user":
      if (isTerminalInput(r)) return [{ kind: "terminal_input" }];
      if (isOurChannel(r.origin)) return channelSeen(contentText(r));
      return INTERRUPTED.test(contentText(r)) ? [{ kind: "interrupted" }] : taskStatus(contentText(r));
    // A message typed while the agent works is absorbed into the running turn.
    case "attachment": {
      const a = r.attachment;
      if (field(a, "type") !== "queued_command") return [];
      if (field(field(a, "origin"), "kind") === "human") return [{ kind: "terminal_input" }];
      const prompt = field(a, "prompt");
      if (field(field(a, "origin"), "kind") === "task-notification") return typeof prompt === "string" ? taskStatus(prompt) : [];
      return isOurChannel(field(a, "origin")) && typeof prompt === "string" ? channelSeen(prompt) : [];
    }
    case "custom-title":
      return title("custom", r.customTitle);
    case "agent-name":
      return title("agent", r.agentName);
    case "ai-title":
      return title("ai", r.aiTitle);
    case "system":
      if (r.subtype !== "turn_duration") return [];
      return [{ kind: "turn_closed", pendingAgents: typeof r.pendingBackgroundAgentCount === "number" ? r.pendingBackgroundAgentCount : 0 }];
    default:
      return [];
  }
}

// A record of a subagent's own transcript (subagents/agent-<id>.jsonl): all
// of them are sidechain records.
export function parseAgentRecord(r: unknown): TranscriptEvent[] {
  if (!isObject(r)) return [];
  if (r.type === "assistant") return parseAssistant(r);
  return r.type === "user" ? parseAgentUser(r) : [];
}

// A tool result or a task notification in a subagent's transcript: the
// subagent's own background tasks start and end there. A Monitor's event
// notification has no <status>: the Monitor goes on.
function parseAgentUser(r: Rec): TranscriptEvent[] {
  const res = r.toolUseResult;
  // A background agent's notification has its agent id as the task id.
  const agent = field(res, "isAsync") === true ? field(res, "agentId") : undefined;
  const started = field(res, "backgroundTaskId") ?? field(res, "taskId") ?? agent;
  if (typeof started === "string" && started) return [{ kind: "task_started", taskId: started }];
  // TaskStop's result.
  const stopped = field(res, "task_id");
  const message = field(res, "message");
  if (typeof stopped === "string" && typeof message === "string" && message.startsWith(TASK_STOPPED)) return [{ kind: "task_status", taskId: stopped, status: "killed" }];
  return r.isMeta === true ? taskStatus(contentText(r)) : [];
}

function parseAssistant(r: Rec): TranscriptEvent[] {
  const msg = r.message;
  if (!isObject(msg) || typeof msg.id !== "string" || !Array.isArray(msg.content)) return [];
  const messageId = msg.id;
  // Claude Code's own message for a failed connection: "API Error: Connection
  // lost mid-response…", "The response stopped arriving…", "Can't reach the
  // API server… (ENOTFOUND)", "Connection refused…". Its text is not the
  // agent's; other errors (rate_limit, invalid_request…) are not the
  // network's, their text is news for the person and they end the turn.
  if (r.isApiErrorMessage === true && r.error === "server_error") return [{ kind: "api_error", messageId }];
  // Claude Code's own stub reply ("No response requested.") is not the
  // agent's either, and tells the person nothing; it still ends the turn.
  const stub = msg.model === SYNTHETIC_MODEL && r.isApiErrorMessage !== true;
  const out: TranscriptEvent[] = [];
  for (const block of stub ? [] : arr(msg.content)) {
    if (!isObject(block)) continue;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      out.push({ kind: "text", text: block.text, messageId });
    } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
      // Narration is shown in the terminal as ordinary text; hidden thinking is
      // written empty, or as a summary when the user turned summaries on.
      const kind = thinkingKind(block.signature);
      if (kind === "narration") out.push({ kind: "text", text: block.thinking.trimEnd(), messageId });
      else if (kind !== "thinking") out.push({ kind: "unknown_thinking", blockKind: kind ?? "?" });
    } else if (block.type === "tool_use" && typeof block.name === "string") {
      const detail = toolDetail(block.input);
      out.push(detail ? { kind: "tool_use", name: block.name, messageId, detail } : { kind: "tool_use", name: block.name, messageId });
    }
  }
  // Every record of a split message carries the final stop_reason; the relay
  // de-duplicates turn_end by messageId.
  if (typeof msg.stop_reason === "string" && msg.stop_reason !== "tool_use") out.push({ kind: "turn_end", messageId });
  return out;
}

// The signature is a base64 protobuf whose field 8 names the block kind
// ("thinking" or "narration"); observed in Claude Code with the model.
export function thinkingKind(signature: unknown): string | undefined {
  if (typeof signature !== "string") return undefined;
  const head = Buffer.from(signature.slice(0, SIGNATURE_HEAD_CHARS), "base64").toString("latin1");
  const m = head.match(/\x42([\x01-\x20])([a-z_]+)/);
  const [, size, kind] = m ?? [];
  return size !== undefined && kind !== undefined && kind.length === size.charCodeAt(0) ? kind : undefined;
}

function toolDetail(input: unknown): string | undefined {
  for (const key of DETAIL_FIELDS) {
    const v = field(input, key);
    if (typeof v !== "string" || !v.trim()) continue;
    const s = key.endsWith("path") ? basename(v) : (v.trim().split("\n")[0] ?? "");
    return s.length > MAX_DETAIL_CHARS ? `${s.slice(0, MAX_DETAIL_CHARS)}…` : s;
  }
  return undefined;
}

// Claude Code tells the agent a background task stopped with a prompt
// holding a <task-notification>: a prompt of its own when the agent is idle,
// a queued command absorbed into the running turn otherwise. A background
// agent waiting for its own task is told about as completed too, with a note.
function taskStatus(text: string): TranscriptEvent[] {
  if (!text.includes("<task-notification>") || AGENT_WAITING.test(text)) return [];
  const taskId = text.match(/<task-id>([^<]+)<\/task-id>/)?.[1];
  const status = text.match(/<status>([^<]+)<\/status>/)?.[1];
  return taskId && status ? [{ kind: "task_status", taskId: taskId.trim(), status: status.trim() }] : [];
}

function contentText(r: Rec): string {
  const content = field(r.message, "content");
  return typeof content === "string" ? content : arr(content).map(b => field(b, "text")).filter(t => typeof t === "string").join("\n");
}

// Claude Code names a plugin's channel "plugin:<plugin>:<server>".
// A channel message of ours, or a topic message that interrupted the agent:
// the plugin puts those into the window's inbox, where they become peer
// messages from the tg-hub plugin.
function isOurChannel(origin: unknown): boolean {
  const kind = field(origin, "kind");
  if (kind === "peer") return field(origin, "plugin") === "tg-hub";
  const server = field(origin, "server");
  return kind === "channel" && typeof server === "string" && server.endsWith(":tg-hub");
}

// Claude Code wraps each channel message in a <channel …> tag carrying its
// meta; the plugin wraps an interrupting message the same way.
function channelSeen(text: string): TranscriptEvent[] {
  const messageIds = [...text.matchAll(CHANNEL_MESSAGE_ID)].map(m => Number(m[1]));
  return messageIds.length ? [{ kind: "channel_seen", messageIds }] : [];
}

function isTerminalInput(r: Rec): boolean {
  return field(r.origin, "kind") === "human" && r.isMeta !== true && r.isCompactSummary !== true;
}

function title(source: "custom" | "agent" | "ai", value: unknown): TranscriptEvent[] {
  return typeof value === "string" && value.trim() ? [{ kind: "title", source, title: value.trim() }] : [];
}
