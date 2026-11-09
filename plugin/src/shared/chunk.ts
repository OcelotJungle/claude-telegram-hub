import type { Entity, Formatted } from "./markdown.ts";

// Telegram caps a message at 4096 chars of plain text. Split long text,
// preferring paragraph, then line, then word boundaries past half the limit;
// hard cut otherwise, never inside a surrogate pair. Each piece gets the parts
// of the entities that fall into it.
export const MAX_MESSAGE = 4096;
// Whitespace and characters that render as nothing (zero-width space, joiners,
// BOM, soft hyphen...). Telegram rejects a text made only of these with
// "text must be non-empty", and `trim()` keeps the invisible ones.
const VISIBLE = /[^\p{White_Space}\p{Default_Ignorable_Code_Point}]/u;

export function hasVisibleText(text: string): boolean {
  return VISIBLE.test(text);
}

export function chunk(f: Formatted, limit = MAX_MESSAGE): Formatted[] {
  const { text } = f;
  const out: Formatted[] = [];
  let start = 0;
  for (;;) {
    while (start < text.length && /\s/.test(text[start])) start++;
    if (text.length - start <= limit) {
      piece(f, start, text.length, out);
      return out;
    }
    const end = start + limit;
    const para = text.lastIndexOf("\n\n", end);
    const line = text.lastIndexOf("\n", end);
    const space = text.lastIndexOf(" ", end);
    const half = start + limit / 2;
    let cut = para > half ? para : line > half ? line : space > half ? space : end;
    if (/[\uD800-\uDBFF]/.test(text[cut - 1] ?? "")) cut--;
    piece(f, start, cut, out);
    start = cut;
  }
}

function piece(f: Formatted, start: number, end: number, out: Formatted[]): void {
  while (end > start && /\s/.test(f.text[end - 1])) end--;
  if (!hasVisibleText(f.text.slice(start, end))) return;
  out.push(slice(f, start, end));
}

// The part of a Formatted between two text indices, entities clipped to it.
function slice(f: Formatted, start: number, end: number): Formatted {
  const entities: Entity[] = [];
  for (const e of f.entities) {
    const s = Math.max(e.offset, start);
    const t = Math.min(e.offset + e.length, end);
    if (t > s) entities.push({ ...e, offset: s - start, length: t - s });
  }
  return { text: f.text.slice(start, end), entities };
}

// Truncates a Formatted to at most `limit` UTF-16 code units, without splitting
// a surrogate pair. Clips entities to the cut and appends "…" if truncated.
export function truncateFormatted(f: Formatted, limit: number): Formatted {
  if (f.text.length <= limit) return f;
  let cut = limit;
  if (/[\uD800-\uDBFF]/.test(f.text[cut - 1] ?? "")) cut--;
  const head = slice(f, 0, cut);
  return { text: `${head.text}…`, entities: head.entities };
}
