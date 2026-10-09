import { describe, expect, test } from "bun:test";
import { richPhotos, richToMarkdown } from "../src/hub/rich.ts";

const md = (...blocks: unknown[]) => richToMarkdown({ blocks });

describe("rich message to Markdown", () => {
  // A Markdown file pasted into Telegram, as Bot API 10.1 describes it.
  test("a pasted document: heading, paragraph with inline formatting, list, code, quote, divider", () => {
    expect(
      md(
        { type: "heading", size: 1, text: "План" },
        { type: "paragraph", text: ["Сначала ", { type: "bold", text: "v2g1" }, ", потом ", { type: "code", text: "cleanup" }, "."] },
        {
          type: "list",
          items: [
            { label: "1.", blocks: [{ type: "paragraph", text: "масса" }] },
            { label: "2.", blocks: [{ type: "paragraph", text: "трение" }, { type: "list", items: [{ label: "•", blocks: [{ type: "paragraph", text: "вложенный" }] }] }] },
          ],
        },
        { type: "pre", language: "ts", text: "const a = 1\nconst b = 2" },
        { type: "blockquote", blocks: [{ type: "paragraph", text: "цитата" }], credit: "автор" },
        { type: "divider" },
        { type: "footer", text: "конец" },
      ),
    ).toBe(
      [
        "# План",
        "",
        "Сначала **v2g1**, потом `cleanup`.",
        "",
        "1. масса",
        "2. трение",
        "   • вложенный",
        "",
        "```ts\nconst a = 1\nconst b = 2\n```",
        "",
        "> цитата\n> — автор",
        "",
        "---",
        "",
        "конец",
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
        { type: "list", items: [{ label: "•", has_checkbox: true, is_checked: true, blocks: [{ type: "paragraph", text: "сделано" }] }, { label: "•", has_checkbox: true, blocks: [{ type: "paragraph", text: "нет" }] }] },
        { type: "table", cells: [[{ text: "A", is_header: true }, { text: "B|C", is_header: true }], [{ text: "1" }, {}]] },
        { type: "details", summary: "Подробнее", blocks: [{ type: "paragraph", text: "скрыто" }] },
        { type: "mathematical_expression", expression: "\\int x" },
      ),
    ).toBe(["• [x] сделано", "• [ ] нет", "", "| A | B\\|C |", "| --- | --- |", "| 1 |  |", "", "**Подробнее**", "", "скрыто", "", "$$\n\\int x\n$$"].join("\n"));
  });

  test("media name their file_id for download_attachment, with their captions", () => {
    expect(
      md(
        { type: "photo", photo: [{ file_id: "p1" }, { file_id: "p2" }], caption: { text: "схема" } },
        { type: "document", document: { file_id: "d", file_name: "plan.pdf" } },
        { type: "collage", blocks: [{ type: "video", video: { file_id: "v" } }, { type: "animation", animation: { file_id: "a" } }] },
        { type: "audio", audio: { file_id: "au", title: "Гимн" } },
        { type: "voice_note", voice_note: { file_id: "vn" } },
        { type: "map", location: { latitude: 55.75, longitude: 37.62 }, zoom: 10, width: 1, height: 1 },
      ),
    ).toBe(
      [
        "(photo, file_id: p2) схема",
        "(document: plan.pdf, file_id: d)",
        "(video, file_id: v)",
        "(animation, file_id: a)",
        "(audio: Гимн, file_id: au)",
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
    expect(md({ type: "poster", text: ["новое ", { type: "glow", text: "слово" }] }, { type: "gallery", blocks: [{ type: "paragraph", text: "внутри" }] }, { type: "void" })).toBe(
      "новое слово\n\nвнутри",
    );
  });
});
