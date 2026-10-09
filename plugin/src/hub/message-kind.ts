import type { Token } from "marked";

import { Lexer } from "marked";
import { isMarked, toTelegram } from "../shared/markdown.ts";

// A message bubble on a phone holds about this many characters per line.
export const CHARS_PER_LINE = 40;
// Formatted text up to this many screen lines stays an ordinary message.
export const MAX_PLAIN_LINES = 5;

// Block kinds that make text formatted even with no inline formatting.
const STRUCTURE = new Set(["heading", "list", "blockquote", "hr", "code", "table"]);

// Agent text goes as an ordinary message (with entities, if it has any)
// unless it is formatted and longer than a few lines, or holds a table: those
// only look right as a rich message.
export function messageKind(md: string): "plain" | "rich" {
  const tokens = new Lexer({ gfm: true }).lex(md);
  if (some(tokens, t => t.type === "table")) return "rich";
  const formatted = toTelegram(md);
  if (!formatted.entities.length && !some(tokens, t => STRUCTURE.has(t.type))) return "plain";
  return screenLines(formatted.text) > MAX_PLAIN_LINES ? "rich" : "plain";
}

function screenLines(text: string): number {
  return text.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / CHARS_PER_LINE)), 0);
}

function some(tokens: Token[], pred: (t: Token) => boolean): boolean {
  return tokens.some(t => pred(t) || some(children(t), pred));
}

function children(t: Token): Token[] {
  if (!isMarked(t)) return [];
  if (t.type === "list") return t.items;
  return "tokens" in t && Array.isArray(t.tokens) ? t.tokens : [];
}
