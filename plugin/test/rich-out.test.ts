import { describe, expect, test } from "bun:test";
import { MAX_RICH_BLOCKS, MAX_RICH_BYTES, richPieces, toRichBlocks } from "../src/hub/rich-out.ts";

describe("agent Markdown to rich blocks", () => {
  test("heading, paragraph with inline formatting and links, code, quote, divider", () => {
    expect(
      toRichBlocks(
        [
          "## \u041f\u043b\u0430\u043d",
          "",
          "\u0421\u043d\u0430\u0447\u0430\u043b\u0430 **v2g1**, *\u043f\u043e\u0442\u043e\u043c* ~~\u043d\u0435~~ `cleanup`, [\u0434\u043e\u043a\u0438](https://gramio.dev), https://t.me \u0438 [\u043b\u043e\u043a\u0430\u043b\u044c\u043d\u043e](./a.md).",
          "",
          "```ts",
          "if (a < b) $HOME",
          "```",
          "",
          "> \u0446\u0438\u0442\u0430\u0442\u0430",
          "",
          "---",
        ].join("\n"),
      ),
    ).toEqual([
      { type: "heading", size: 2, text: "\u041f\u043b\u0430\u043d" },
      {
        type: "paragraph",
        text: [
          "\u0421\u043d\u0430\u0447\u0430\u043b\u0430 ",
          { type: "bold", text: "v2g1" },
          ", ",
          { type: "italic", text: "\u043f\u043e\u0442\u043e\u043c" },
          " ",
          { type: "strikethrough", text: "\u043d\u0435" },
          " ",
          { type: "code", text: "cleanup" },
          ", ",
          { type: "url", text: "\u0434\u043e\u043a\u0438", url: "https://gramio.dev" },
          ", https://t.me \u0438 \u043b\u043e\u043a\u0430\u043b\u044c\u043d\u043e (./a.md).",
        ],
      },
      { type: "pre", text: "if (a < b) $HOME", language: "ts" },
      { type: "blockquote", blocks: [{ type: "paragraph", text: "\u0446\u0438\u0442\u0430\u0442\u0430" }] },
      { type: "divider" },
    ]);
  });

  // Telegram's own Markdown parser drops unknown tags, joins lines and makes
  // formulas of $…$; blocks carry the text as it is.
  test("tags, dollars and line breaks stay as written", () => {
    expect(toRichBlocks('\u0422\u0435\u0433 <channel source="x"> \u0438 $x^2$\n\u0432\u0442\u043e\u0440\u0430\u044f \u0441\u0442\u0440\u043e\u043a\u0430 &amp; <!-- c -->\n\n<div>\u0431\u043b\u043e\u043a</div>')).toEqual([
      { type: "paragraph", text: '\u0422\u0435\u0433 <channel source="x"> \u0438 $x^2$\n\u0432\u0442\u043e\u0440\u0430\u044f \u0441\u0442\u0440\u043e\u043a\u0430 & <!-- c -->' },
      { type: "paragraph", text: "<div>\u0431\u043b\u043e\u043a</div>" },
    ]);
  });

  test("lists: nested, numbered from their start, tasks", () => {
    expect(toRichBlocks("- \u0440\u0430\u0437\n  - \u0432\u043b\u043e\u0436\u0435\u043d\u043d\u044b\u0439\n- \u0434\u0432\u0430\n\n3. \u0442\u0440\u0438\n4. \u0447\u0435\u0442\u044b\u0440\u0435\n\n- [x] \u0441\u0434\u0435\u043b\u0430\u043d\u043e\n- [ ] \u043d\u0435\u0442")).toEqual([
      {
        type: "list",
        items: [
          { blocks: [{ type: "paragraph", text: "\u0440\u0430\u0437" }, { type: "list", items: [{ blocks: [{ type: "paragraph", text: "\u0432\u043b\u043e\u0436\u0435\u043d\u043d\u044b\u0439" }] }] }] },
          { blocks: [{ type: "paragraph", text: "\u0434\u0432\u0430" }] },
        ],
      },
      {
        type: "list",
        items: [
          { blocks: [{ type: "paragraph", text: "\u0442\u0440\u0438" }], type: "1", value: 3 },
          { blocks: [{ type: "paragraph", text: "\u0447\u0435\u0442\u044b\u0440\u0435" }], type: "1", value: 4 },
        ],
      },
      {
        type: "list",
        items: [
          { blocks: [{ type: "paragraph", text: "\u0441\u0434\u0435\u043b\u0430\u043d\u043e" }], has_checkbox: true, is_checked: true },
          { blocks: [{ type: "paragraph", text: "\u043d\u0435\u0442" }], has_checkbox: true },
        ],
      },
    ]);
  });

  test("a table with its alignment and inline formatting in cells", () => {
    expect(toRichBlocks("| \u041a\u043e\u043c\u043c\u0438\u0442 | \u0427\u0442\u043e |\n|---|--:|\n| `2cca113` | \u043b\u043e\u0433 |")).toEqual([
      {
        type: "table",
        cells: [
          [
            { text: "\u041a\u043e\u043c\u043c\u0438\u0442", is_header: true, align: "center", valign: "middle" },
            { text: "\u0427\u0442\u043e", is_header: true, align: "right", valign: "middle" },
          ],
          [
            { text: { type: "code", text: "2cca113" }, align: "left", valign: "middle" },
            { text: "\u043b\u043e\u0433", align: "right", valign: "middle" },
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
    const para = "\u044f".repeat(6000); // 12000 bytes
    const pieces = richPieces([para, para, para].join("\n\n"));
    expect(pieces.map(p => p.blocks?.length)).toEqual([2, 1]);
    expect(pieces.every(p => Buffer.byteLength(p.text) <= MAX_RICH_BYTES)).toBe(true);
    expect(pieces[1].text).toBe(para);
  });

  test("splits to stay within the block count", () => {
    // A list block, its 150 items and their paragraphs: 301 blocks.
    const list = Array.from({ length: 150 }, (_, i) => `- ${i}`).join("\n");
    const pieces = richPieces(`${list}\n\n\u043f\u043e\u0441\u043b\u0435\n\n${list}`);
    expect(pieces.length).toBe(2);
    expect(pieces[0].blocks?.at(-1)).toEqual({ type: "paragraph", text: "\u043f\u043e\u0441\u043b\u0435" });
  });

  // Too big for one rich message: it goes as plain formatted text, which
  // splits anywhere.
  test("a single block too big for a rich message is a piece without blocks", () => {
    const code = "```\n" + "x".repeat(MAX_RICH_BYTES) + "\n```";
    expect(richPieces(`\u0434\u043e\n\n${code}\n\n\u043f\u043e\u0441\u043b\u0435`)).toEqual([
      { text: "\u0434\u043e", blocks: [{ type: "paragraph", text: "\u0434\u043e" }] },
      { text: code },
      { text: "\u043f\u043e\u0441\u043b\u0435", blocks: [{ type: "paragraph", text: "\u043f\u043e\u0441\u043b\u0435" }] },
    ]);
    expect(MAX_RICH_BLOCKS).toBeLessThanOrEqual(500);
  });

  test("empty text has no pieces", () => {
    expect(richPieces("  \n\n ")).toEqual([]);
  });
});
