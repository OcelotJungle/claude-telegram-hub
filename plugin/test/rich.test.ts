import { describe, expect, test } from "bun:test";
import { richPhotos, richToMarkdown } from "../src/hub/rich.ts";

const md = (...blocks: unknown[]) => richToMarkdown({ blocks });

describe("rich message to Markdown", () => {
  // A Markdown file pasted into Telegram, as Bot API 10.1 describes it.
  test("a pasted document: heading, paragraph with inline formatting, list, code, quote, divider", () => {
    expect(
      md(
        { type: "heading", size: 1, text: "\u041f\u043b\u0430\u043d" },
        { type: "paragraph", text: ["\u0421\u043d\u0430\u0447\u0430\u043b\u0430 ", { type: "bold", text: "v2g1" }, ", \u043f\u043e\u0442\u043e\u043c ", { type: "code", text: "cleanup" }, "."] },
        {
          type: "list",
          items: [
            { label: "1.", blocks: [{ type: "paragraph", text: "\u043c\u0430\u0441\u0441\u0430" }] },
            { label: "2.", blocks: [{ type: "paragraph", text: "\u0442\u0440\u0435\u043d\u0438\u0435" }, { type: "list", items: [{ label: "•", blocks: [{ type: "paragraph", text: "\u0432\u043b\u043e\u0436\u0435\u043d\u043d\u044b\u0439" }] }] }] },
          ],
        },
        { type: "pre", language: "ts", text: "const a = 1\nconst b = 2" },
        { type: "blockquote", blocks: [{ type: "paragraph", text: "\u0446\u0438\u0442\u0430\u0442\u0430" }], credit: "\u0430\u0432\u0442\u043e\u0440" },
        { type: "divider" },
        { type: "footer", text: "\u043a\u043e\u043d\u0435\u0446" },
      ),
    ).toBe(
      [
        "# \u041f\u043b\u0430\u043d",
        "",
        "\u0421\u043d\u0430\u0447\u0430\u043b\u0430 **v2g1**, \u043f\u043e\u0442\u043e\u043c `cleanup`.",
        "",
        "1. \u043c\u0430\u0441\u0441\u0430",
        "2. \u0442\u0440\u0435\u043d\u0438\u0435",
        "   • \u0432\u043b\u043e\u0436\u0435\u043d\u043d\u044b\u0439",
        "",
        "```ts\nconst a = 1\nconst b = 2\n```",
        "",
        "> \u0446\u0438\u0442\u0430\u0442\u0430\n> — \u0430\u0432\u0442\u043e\u0440",
        "",
        "---",
        "",
        "\u043a\u043e\u043d\u0435\u0446",
      ].join("\n"),
    );
  });

  test("inline formatting: italic, strikethrough, links, emoji, math; plain text for the rest", () => {
    expect(
      md({
        type: "paragraph",
        text: [
          { type: "italic", text: "i" },
          " ",
          { type: "strikethrough", text: "s" },
          " ",
          { type: "url", text: "docs", url: "https://x.dev" },
          " ",
          { type: "url", text: "https://y.dev", url: "https://y.dev" },
          " ",
          { type: "custom_emoji", custom_emoji_id: "1", alternative_text: "🔥" },
          " ",
          { type: "mathematical_expression", expression: "E=mc^2" },
          " ",
          { type: "underline", text: [{ type: "mention", text: "@bob", username: "bob" }] },
          { type: "anchor", name: "here" },
        ],
      }),
    ).toBe("*i* ~~s~~ [docs](https://x.dev) https://y.dev 🔥 $E=mc^2$ @bob");
  });

  test("checkboxes, a table, details, and a math block", () => {
    expect(
      md(
        { type: "list", items: [{ label: "•", has_checkbox: true, is_checked: true, blocks: [{ type: "paragraph", text: "\u0441\u0434\u0435\u043b\u0430\u043d\u043e" }] }, { label: "•", has_checkbox: true, blocks: [{ type: "paragraph", text: "\u043d\u0435\u0442" }] }] },
        { type: "table", cells: [[{ text: "A", is_header: true }, { text: "B|C", is_header: true }], [{ text: "1" }, {}]] },
        { type: "details", summary: "\u041f\u043e\u0434\u0440\u043e\u0431\u043d\u0435\u0435", blocks: [{ type: "paragraph", text: "\u0441\u043a\u0440\u044b\u0442\u043e" }] },
        { type: "mathematical_expression", expression: "\\int x" },
      ),
    ).toBe(["• [x] \u0441\u0434\u0435\u043b\u0430\u043d\u043e", "• [ ] \u043d\u0435\u0442", "", "| A | B\\|C |", "| --- | --- |", "| 1 |  |", "", "**\u041f\u043e\u0434\u0440\u043e\u0431\u043d\u0435\u0435**", "", "\u0441\u043a\u0440\u044b\u0442\u043e", "", "$$\n\\int x\n$$"].join("\n"));
  });

  test("media name their file_id for download_attachment, with their captions", () => {
    expect(
      md(
        { type: "photo", photo: [{ file_id: "p1" }, { file_id: "p2" }], caption: { text: "\u0441\u0445\u0435\u043c\u0430" } },
        { type: "document", document: { file_id: "d", file_name: "plan.pdf" } },
        { type: "collage", blocks: [{ type: "video", video: { file_id: "v" } }, { type: "animation", animation: { file_id: "a" } }] },
        { type: "audio", audio: { file_id: "au", title: "\u0413\u0438\u043c\u043d" } },
        { type: "voice_note", voice_note: { file_id: "vn" } },
        { type: "map", location: { latitude: 55.75, longitude: 37.62 }, zoom: 10, width: 1, height: 1 },
      ),
    ).toBe(
      [
        "(photo, file_id: p2) \u0441\u0445\u0435\u043c\u0430",
        "(document: plan.pdf, file_id: d)",
        "(video, file_id: v)",
        "(animation, file_id: a)",
        "(audio: \u0413\u0438\u043c\u043d, file_id: au)",
        "(voice note, file_id: vn)",
        "(map: 55.75, 37.62)",
      ].join("\n\n"),
    );
  });

  test("a downloaded photo is named by its local path", () => {
    const photo = { type: "photo", photo: [{ file_id: "p1" }, { file_id: "p2" }] };
    expect(richToMarkdown({ blocks: [photo] }, new Map([["p2", "C:\\inbox\\p.jpg"]]))).toBe("(photo: C:\\inbox\\p.jpg)");
  });

  test("the photos to download: the largest size of each, wherever it sits", () => {
    const photo = (id: string) => ({ type: "photo", photo: [{ file_id: `${id}-small` }, { file_id: id }] });
    const m = {
      blocks: [
        photo("a"),
        { type: "slideshow", blocks: [photo("b"), { type: "video", video: { file_id: "v" } }] },
        { type: "list", items: [{ label: "•", blocks: [photo("c")] }] },
        { type: "details", summary: "x", blocks: [{ type: "blockquote", blocks: [photo("d")] }] },
        { type: "photo", photo: [] },
      ],
    };
    expect(richPhotos(m)).toEqual(["a", "b", "c", "d"]);
  });

  test("a kind of block or text Telegram adds later still shows its text", () => {
    expect(md({ type: "poster", text: ["\u043d\u043e\u0432\u043e\u0435 ", { type: "glow", text: "\u0441\u043b\u043e\u0432\u043e" }] }, { type: "gallery", blocks: [{ type: "paragraph", text: "\u0432\u043d\u0443\u0442\u0440\u0438" }] }, { type: "void" })).toBe(
      "\u043d\u043e\u0432\u043e\u0435 \u0441\u043b\u043e\u0432\u043e\n\n\u0432\u043d\u0443\u0442\u0440\u0438",
    );
  });
});
