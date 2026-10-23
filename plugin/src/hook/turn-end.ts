// How a turn ended, decided from the Stop hook input.
export type TurnEnd = { final: false } | { final: true; kind: "ask" | "done" };

const FENCED_CODE = /```[\s\S]*?```/g;
// A block left open by a cut answer runs to the end of the text.
const UNCLOSED_FENCE = /```[\s\S]*$/;
const INLINE_CODE = /`[^`\n]*`/g;
const PARAGRAPH_BREAK = /\r?\n\s*\r?\n/;
const URL = /https?:\/\/\S+/g;

// A question is a "?" in the last non-empty paragraph, outside code and links.
// A "?" ending a link (before a space or the end) asks, it is not the link's.
export function hasQuestion(text: string): boolean {
  const plain = text.replace(FENCED_CODE, "\n\n").replace(UNCLOSED_FENCE, "\n\n").replace(INLINE_CODE, "");
  const paragraphs = plain.split(PARAGRAPH_BREAK).map(p => p.trim()).filter(p => p !== "");
  const last = paragraphs[paragraphs.length - 1];
  if (last === undefined) return false;
  return last.replace(URL, link => (link.endsWith("?") ? "?" : "")).includes("?");
}

// A question ends the turn whatever runs in the background; otherwise a turn
// with live background tasks is only a pause: the agent waits and continues.
export function decideTurnEnd(input: { last_assistant_message?: string; background_tasks?: readonly unknown[] }): TurnEnd {
  if (input.last_assistant_message !== undefined && hasQuestion(input.last_assistant_message)) return { final: true, kind: "ask" };
  if (input.background_tasks === undefined || input.background_tasks.length === 0) return { final: true, kind: "done" };
  return { final: false };
}
