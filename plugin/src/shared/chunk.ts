import type { Entity, Formatted } from "./markdown.ts";

// Telegram caps a message at 4096 chars of plain text. Split long text,
// preferring paragraph, then line, then word boundaries past half the limit;
// hard cut otherwise, never inside a surrogate pair. Each piece gets the parts
// of the entities that fall into it.
export const MAX_MESSAGE = 4096;

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
  if (end <= start) return;
  const entities: Entity[] = [];
  for (const e of f.entities) {
    const s = Math.max(e.offset, start);
    const t = Math.min(e.offset + e.length, end);
    if (t > s) entities.push({ ...e, offset: s - start, length: t - s });
  }
  out.push({ text: f.text.slice(start, end), entities });
}
