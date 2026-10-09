// Turns one transcript (.jsonl) record into the events the relay cares about.
// Record shapes: see "Результаты проверки" in the design spec.
import { arr, field, isObject } from "../shared/guards.ts";

// The block kind sits near the start of a thinking signature; this much of
// its base64 covers it.
const SIGNATURE_HEAD_CHARS = 64;

export type TranscriptEvent =
  | { kind: "text"; text: string; messageId: string }
  | { kind: "tool_use"; name: string; messageId: string }
  // cut: the connection to the API was lost mid-response, the turn ended on
  // it and the answer may be incomplete.
  | { kind: "turn_end"; messageId: string; cut?: true }
  | { kind: "terminal_input" }
  | { kind: "title"; source: "custom" | "agent" | "ai"; title: string }
  // A thinking block with text whose kind is neither thinking nor narration:
  // the record format changed, and visible text may be going unrelayed.
  | { kind: "unknown_thinking"; blockKind: string };

type Rec = Record<string, unknown>;

export function parseRecord(r: unknown): TranscriptEvent[] {
  if (!isObject(r)) return [];
  if (r.isSidechain === true) return [];
  switch (r.type) {
    case "assistant":
      return parseAssistant(r);
    case "user":
      return isTerminalInput(r) ? [{ kind: "terminal_input" }] : [];
    // A message typed while the agent works is absorbed into the running turn.
    case "attachment":
      return field(r.attachment, "type") === "queued_command" && field(field(r.attachment, "origin"), "kind") === "human" ? [{ kind: "terminal_input" }] : [];
    case "custom-title":
      return title("custom", r.customTitle);
    case "agent-name":
      return title("agent", r.agentName);
    case "ai-title":
      return title("ai", r.aiTitle);
    default:
      return [];
  }
}

function parseAssistant(r: Rec): TranscriptEvent[] {
  const msg = r.message;
  if (!isObject(msg) || typeof msg.id !== "string" || !Array.isArray(msg.content)) return [];
  const messageId = msg.id;
  const out: TranscriptEvent[] = [];
  for (const block of arr(msg.content)) {
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
      out.push({ kind: "tool_use", name: block.name, messageId });
    }
  }
  // Every record of a split message carries the final stop_reason; the relay
  // de-duplicates turn_end by messageId.
  if (typeof msg.stop_reason === "string" && msg.stop_reason !== "tool_use") {
    // Claude Code's own message for a lost connection, "API Error: Connection
    // lost mid-response…"; it retries other errors itself.
    const cut = r.isApiErrorMessage === true && r.truncatedAfterOutput === true;
    out.push(cut ? { kind: "turn_end", messageId, cut } : { kind: "turn_end", messageId });
  }
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

function isTerminalInput(r: Rec): boolean {
  return field(r.origin, "kind") === "human" && r.isMeta !== true && r.isCompactSummary !== true;
}

function title(source: "custom" | "agent" | "ai", value: unknown): TranscriptEvent[] {
  return typeof value === "string" && value.trim() ? [{ kind: "title", source, title: value.trim() }] : [];
}
