import { describe, expect, test } from "bun:test";
import { MAX_RICH_BLOCKS, MAX_RICH_BYTES, richPieces, toRichBlocks } from "../src/hub/rich-out.ts";

describe("agent Markdown to rich blocks", () => {
  test("heading, paragraph with inline formatting and links, code, quote, divider", () => {
    expect(
      toRichBlocks(
        [
          "## План",
          "",
          "Сначала **v2g1**, *потом* ~~не~~ `cleanup`, [доки](https://gramio.dev), https://t.me и [локально](./a.md).",
          "",
          "```ts",
          "if (a < b) $HOME",
          "```",
          "",
          "> цитата",
          "",
          "---",
        ].join("\n"),
      ),
    ).toEqual([
      { type: "heading", size: 2, text: "План" },
      {
        type: "paragraph",
        text: [
          "Сначала ",
          { type: "bold", text: "v2g1" },
          ", ",
          { type: "italic", text: "потом" },
          " ",
          { type: "strikethrough", text: "не" },
          " ",
          { type: "code", text: "cleanup" },
          ", ",
          { type: "url", text: "доки", url: "https://gramio.dev" },
          ", https://t.me и локально (./a.md).",
        ],
      },
      { type: "pre", text: "if (a < b) $HOME", language: "ts" },
      { type: "blockquote", blocks: [{ type: "paragraph", text: "цитата" }] },
      { type: "divider" },
    ]);
  });

  // Telegram's own Markdown parser drops unknown tags, joins lines and makes
  // formulas of $…$; blocks carry the text as it is.
  test("tags, dollars and line breaks stay as written", () => {
    expect(toRichBlocks('Тег <channel source="x"> и $x^2$\nвторая строка &amp; <!-- c -->\n\n<div>блок</div>')).toEqual([
      { type: "paragraph", text: 'Тег <channel source="x"> и $x^2$\nвторая строка & <!-- c -->' },
      { type: "paragraph", text: "<div>блок</div>" },
    ]);
  });

  test("lists: nested, numbered from their start, tasks", () => {
    expect(toRichBlocks("- раз\n  - вложенный\n- два\n\n3. три\n4. четыре\n\n- [x] сделано\n- [ ] нет")).toEqual([
      {
        type: "list",
        items: [
          { blocks: [{ type: "paragraph", text: "раз" }, { type: "list", items: [{ blocks: [{ type: "paragraph", text: "вложенный" }] }] }] },
          { blocks: [{ type: "paragraph", text: "два" }] },
        ],
      },
      {
        type: "list",
        items: [
          { blocks: [{ type: "paragraph", text: "три" }], type: "1", value: 3 },
          { blocks: [{ type: "paragraph", text: "четыре" }], type: "1", value: 4 },
        ],
      },
      {
        type: "list",
        items: [
          { blocks: [{ type: "paragraph", text: "сделано" }], has_checkbox: true, is_checked: true },
          { blocks: [{ type: "paragraph", text: "нет" }], has_checkbox: true },
        ],
      },
    ]);
  });

  test("a table with its alignment and inline formatting in cells", () => {
    expect(toRichBlocks("| Коммит | Что |\n|---|--:|\n| `2cca113` | лог |")).toEqual([
      {
        type: "table",
        cells: [
          [
            { text: "Коммит", is_header: true, align: "center", valign: "middle" },
            { text: "Что", is_header: true, align: "right", valign: "middle" },
          ],
          [
            { text: { type: "code", text: "2cca113" }, align: "left", valign: "middle" },
            { text: "лог", align: "right", valign: "middle" },
          ],
        ],
        is_bordered: true,
        is_striped: true,
      },
    ]);
  });
});

describe("pieces of a long text", () => {
  test("a short text is one piece with its blocks", () => {
    expect(richPieces("# A\n\ntext")).toEqual([{ text: "# A\n\ntext", blocks: [{ type: "heading", size: 1, text: "A" }, { type: "paragraph", text: "text" }] }]);
  });

  test("splits between top-level blocks to stay within the size", () => {
    const para = "я".repeat(6000); // 12000 bytes
    const pieces = richPieces([para, para, para].join("\n\n"));
    expect(pieces.map(p => p.blocks?.length)).toEqual([2, 1]);
    expect(pieces.every(p => Buffer.byteLength(p.text) <= MAX_RICH_BYTES)).toBe(true);
    expect(pieces[1]!.text).toBe(para);
  });

  test("splits to stay within the block count", () => {
    // A list block, its 150 items and their paragraphs: 301 blocks.
    const list = Array.from({ length: 150 }, (_, i) => `- ${i}`).join("\n");
    const pieces = richPieces(`${list}\n\nпосле\n\n${list}`);
    expect(pieces.length).toBe(2);
    expect(pieces[0]!.blocks!.at(-1)).toEqual({ type: "paragraph", text: "после" });
  });

  // Too big for one rich message: it goes as plain formatted text, which
  // splits anywhere.
  test("a single block too big for a rich message is a piece without blocks", () => {
    const code = "```\n" + "x".repeat(MAX_RICH_BYTES) + "\n```";
    expect(richPieces(`до\n\n${code}\n\nпосле`)).toEqual([
      { text: "до", blocks: [{ type: "paragraph", text: "до" }] },
      { text: code },
      { text: "после", blocks: [{ type: "paragraph", text: "после" }] },
    ]);
    expect(MAX_RICH_BLOCKS).toBeLessThanOrEqual(500);
  });

  test("empty text has no pieces", () => {
    expect(richPieces("  \n\n ")).toEqual([]);
  });
});
