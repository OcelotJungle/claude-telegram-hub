import type { Token } from "marked";

import { Lexer } from "marked";
import { isMarked } from "../shared/markdown.ts";

// Rich is only what ordinary Telegram markup cannot hold: a heading, a list
// (any kind, task lists included), a table or a horizontal rule, at any nesting
// level. Everything else goes as an ordinary message with its entities, however
// long. Why: when the user replies to a part of a rich message, Telegram does
// not give the bot the quote; quotes of ordinary messages do arrive.
const RICH_BLOCKS: ReadonlySet<string> = new Set(["heading", "list", "table", "hr"]);

export function messageKind(md: string): "plain" | "rich" {
  const tokens = new Lexer({ gfm: true }).lex(md);
  return some(tokens, t => RICH_BLOCKS.has(t.type)) ? "rich" : "plain";
}

function some(tokens: Token[], pred: (t: Token) => boolean): boolean {
  return tokens.some(t => pred(t) || some(children(t), pred));
}

function children(t: Token): Token[] {
  if (!isMarked(t)) return [];
  if (t.type === "list") return t.items;
  return "tokens" in t && Array.isArray(t.tokens) ? t.tokens : [];
}
