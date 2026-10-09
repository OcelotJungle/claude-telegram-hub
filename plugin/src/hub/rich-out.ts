import type { Token, Tokens } from "marked";

import { decodeHTML } from "entities";
import { Lexer } from "marked";
import { z } from "zod";
import { isMarked } from "../shared/markdown.ts";

// Agent text (CommonMark + GFM) as a rich message in blocks (Bot API 10.1),
// so Telegram shows real headings, lists and tables. Blocks carry text as it
// is: Telegram's own Markdown parser would drop unknown tags, join lines and
// make formulas of $…$.

// Telegram cuts Cyrillic text short of its documented 32768 characters, near
// 35000 bytes, without an error; a piece stays well below.
export const MAX_RICH_BYTES = 30_000;
// Every block counts, nested ones, list items and table rows included.
export const MAX_RICH_BLOCKS = 500;
// Between the Markdown of the top-level blocks of a piece.
const BLOCK_SEPARATOR = "\n\n";

// The blocks made here. Not @gramio/types: it leaves out the plain string and
// the array forms of RichText that the Bot API allows.
export type RichText =
  | string
  | RichText[]
  | { type: "bold" | "italic" | "strikethrough" | "code"; text: RichText }
  | { type: "url"; text: RichText; url: string };
type ListItem = { blocks: Block[]; has_checkbox?: true; is_checked?: true; type?: "1"; value?: number };
type Cell = { text: RichText; is_header?: true; align: "left" | "center" | "right"; valign: "middle" };
export type Block =
  | { type: "paragraph"; text: RichText }
  | { type: "heading"; size: number; text: RichText }
  | { type: "pre"; text: string; language?: string }
  | { type: "blockquote"; blocks: Block[] }
  | { type: "list"; items: ListItem[] }
  | { type: "table"; cells: Cell[][]; is_bordered?: true; is_striped?: true }
  | { type: "divider" };

// Blocks as the hub's queue file keeps them.
const richTextSchema: z.ZodType<RichText> = z.lazy(() =>
  z.union([
    z.string(),
    z.array(richTextSchema),
    z.object({ type: z.enum(["bold", "italic", "strikethrough", "code"]), text: richTextSchema }),
    z.object({ type: z.literal("url"), text: richTextSchema, url: z.string() }),
  ]),
);
const listItemSchema: z.ZodType<ListItem> = z.lazy(() =>
  z.object({
    blocks: z.array(blockSchema),
    has_checkbox: z.literal(true).optional(),
    is_checked: z.literal(true).optional(),
    type: z.literal("1").optional(),
    value: z.number().optional(),
  }),
);
const cellSchema: z.ZodType<Cell> = z.object({
  text: richTextSchema,
  is_header: z.literal(true).optional(),
  align: z.enum(["left", "center", "right"]),
  valign: z.literal("middle"),
});
export const blockSchema: z.ZodType<Block> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal("paragraph"), text: richTextSchema }),
    z.object({ type: z.literal("heading"), size: z.number(), text: richTextSchema }),
    z.object({ type: z.literal("pre"), text: z.string(), language: z.string().optional() }),
    z.object({ type: z.literal("blockquote"), blocks: z.array(blockSchema) }),
    z.object({ type: z.literal("list"), items: z.array(listItemSchema) }),
    z.object({ type: z.literal("table"), cells: z.array(z.array(cellSchema)), is_bordered: z.literal(true).optional(), is_striped: z.literal(true).optional() }),
    z.object({ type: z.literal("divider") }),
  ]),
);

// One rich message: its Markdown source and blocks. A single block too big
// for a rich message has no blocks and goes as plain formatted text.
export type RichPiece = { text: string; blocks?: Block[] };

export function toRichBlocks(md: string): Block[] {
  return blocks(new Lexer({ gfm: true }).lex(md));
}

// Splits between top-level blocks; the whole text is lexed at once, so link
// references resolve in every piece.
export function richPieces(md: string): RichPiece[] {
  const out: RichPiece[] = [];
  let group: { raw: string[]; blocks: Block[]; bytes: number; count: number } | undefined;
  const flush = () => {
    if (group) out.push({ text: group.raw.join(BLOCK_SEPARATOR), blocks: group.blocks });
    group = undefined;
  };
  for (const t of new Lexer({ gfm: true }).lex(md)) {
    const raw = t.raw.trim();
    const made = block(t);
    if (!made || !raw) continue;
    const bytes = Buffer.byteLength(raw);
    const count = made.reduce((n, b) => n + blockCount(b), 0);
    if (bytes > MAX_RICH_BYTES || count > MAX_RICH_BLOCKS) {
      flush();
      out.push({ text: raw });
      continue;
    }
    if (group && (group.bytes + BLOCK_SEPARATOR.length + bytes > MAX_RICH_BYTES || group.count + count > MAX_RICH_BLOCKS)) flush();
    group ??= { raw: [], blocks: [], bytes: -BLOCK_SEPARATOR.length, count: 0 };
    group.raw.push(raw);
    group.blocks.push(...made);
    group.bytes += BLOCK_SEPARATOR.length + bytes;
    group.count += count;
  }
  flush();
  return out;
}

function blockCount(b: Block): number {
  switch (b.type) {
    case "list":
      return 1 + b.items.reduce((n, i) => n + 1 + i.blocks.reduce((m, x) => m + blockCount(x), 0), 0);
    case "blockquote":
      return 1 + b.blocks.reduce((n, x) => n + blockCount(x), 0);
    case "table":
      return 1 + b.cells.length;
    default:
      return 1;
  }
}

function blocks(tokens: Token[]): Block[] {
  return tokens.flatMap(t => block(t) ?? []);
}

// The blocks of one token; undefined for tokens that show nothing.
function block(t: Token): Block[] | undefined {
  if (!isMarked(t)) return [{ type: "paragraph", text: t.raw }];
  switch (t.type) {
    case "space":
    case "def":
    case "checkbox":
      return undefined;
    case "paragraph":
      return [{ type: "paragraph", text: inline(t.tokens ?? []) }];
    case "text":
      return [{ type: "paragraph", text: t.tokens ? inline(t.tokens) : decodeHTML(t.text) }];
    case "heading":
      return [{ type: "heading", size: t.depth, text: inline(t.tokens ?? []) }];
    case "code": {
      const language = t.lang?.split(/\s/)[0];
      return [{ type: "pre", text: t.text, ...(language ? { language } : {}) }];
    }
    case "blockquote":
      return [{ type: "blockquote", blocks: blocks(t.tokens ?? []) }];
    case "list":
      return [list(t)];
    case "table":
      return [table(t)];
    case "hr":
      return [{ type: "divider" }];
    case "html":
      return [{ type: "paragraph", text: t.text.replace(/\n+$/, "") }];
    default:
      return [{ type: "paragraph", text: "text" in t && typeof t.text === "string" ? t.text : t.raw }];
  }
}

function list(t: Tokens.List): Block {
  const start = typeof t.start === "number" ? t.start : 1;
  return {
    type: "list",
    items: t.items.map((item, i): ListItem => ({
      blocks: blocks(item.tokens),
      ...(item.task ? { has_checkbox: true, ...(item.checked ? { is_checked: true } : {}) } : {}),
      ...(t.ordered ? { type: "1", value: start + i } : {}),
    })),
  };
}

function table(t: Tokens.Table): Block {
  const row = (cells: Tokens.TableCell[], header: boolean) =>
    cells.map(
      (c, i): Cell => ({
        text: inline(c.tokens),
        ...(header ? { is_header: true } : {}),
        align: t.align[i] ?? (header ? "center" : "left"),
        valign: "middle",
      }),
    );
  return { type: "table", cells: [row(t.header, true), ...t.rows.map(r => row(r, false))], is_bordered: true, is_striped: true };
}

// Links Telegram can open.
function openable(url: string): boolean {
  return /^(https?|tg):\/\//i.test(url);
}

// Adjacent strings merge; a single part stands alone.
function inline(tokens: Token[]): RichText {
  const parts: RichText[] = [];
  const put = (p: RichText) => {
    if (p === "" || (Array.isArray(p) && !p.length)) return;
    if (Array.isArray(p)) return p.forEach(put);
    const last = parts.at(-1);
    if (typeof p === "string" && typeof last === "string") parts[parts.length - 1] = last + p;
    else parts.push(p);
  };
  for (const t of tokens) {
    if (!isMarked(t)) {
      put(t.raw);
      continue;
    }
    switch (t.type) {
      case "text":
        put(t.tokens ? inline(t.tokens) : decodeHTML(t.text));
        break;
      case "escape":
      case "html":
        put(t.text);
        break;
      case "strong":
        put({ type: "bold", text: inline(t.tokens ?? []) });
        break;
      case "em":
        put({ type: "italic", text: inline(t.tokens ?? []) });
        break;
      case "del":
        put({ type: "strikethrough", text: inline(t.tokens ?? []) });
        break;
      case "codespan":
        put({ type: "code", text: t.text });
        break;
      case "br":
        put("\n");
        break;
      case "link":
      case "image": {
        const label = t.type === "image" ? t.text || t.href : inline(t.tokens ?? []);
        put(link(t.href, label));
        break;
      }
      case "checkbox":
        break;
      default:
        put(t.raw);
    }
  }
  return parts.length === 1 ? parts[0] : parts;
}

// A bare URL, or a link whose text is its URL, stays plain: Telegram links it
// itself. A target Telegram cannot open stays visible after the text.
function link(href: string, label: RichText): RichText {
  if (label === href || label === `mailto:${href}` || `mailto:${label}` === href) return label;
  if (openable(href)) return { type: "url", text: label, url: href };
  return [label, ` (${href})`];
}
