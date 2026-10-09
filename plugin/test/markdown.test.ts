import type { Formatted } from "../src/shared/markdown.ts";

import { describe, expect, test } from "bun:test";
import { toTelegram } from "../src/shared/markdown.ts";

// The entity's text, for readable expectations.
const spans = (f: Formatted) => f.entities.map(e => ({ ...e, text: f.text.slice(e.offset, e.offset + e.length) }));
const one = (md: string) => {
  const f = toTelegram(md);
  expect(f.entities.length).toBe(1);
  return { full: f.text, ...spans(f)[0]! };
};

describe("markdown to Telegram entities", () => {
  test("plain text stays as is, with no entities", () => {
    expect(toTelegram("just text, snake_case_name and 2 * 3")).toEqual({ text: "just text, snake_case_name and 2 * 3", entities: [] });
  });

  test("inline styles", () => {
    expect(one("a **b** c")).toMatchObject({ full: "a b c", type: "bold", offset: 2, length: 1 });
    expect(one("a __b__ c")).toMatchObject({ full: "a b c", type: "bold" });
    expect(one("a *b* c")).toMatchObject({ full: "a b c", type: "italic", offset: 2, length: 1 });
    expect(one("a _b_ c")).toMatchObject({ type: "italic" });
    expect(one("a ~~b~~ c")).toMatchObject({ full: "a b c", type: "strikethrough" });
    expect(one("run `bun test` now")).toMatchObject({ full: "run bun test now", type: "code", offset: 4, length: 8 });
  });

  test("nested styles nest, outer entity first", () => {
    const f = toTelegram("**bold *both* bold**");
    expect(f.text).toBe("bold both bold");
    expect(spans(f)).toEqual([
      { type: "bold", offset: 0, length: 14, text: "bold both bold" },
      { type: "italic", offset: 5, length: 4, text: "both" },
    ]);
  });

  test("offsets count UTF-16 code units", () => {
    const f = toTelegram("😀 **b**");
    expect(spans(f)).toEqual([{ type: "bold", offset: 3, length: 1, text: "b" }]);
  });

  test("code block becomes pre with its language", () => {
    const f = toTelegram("before\n\n```ts\nconst a = 1\n  indented\n```\n\nafter");
    expect(f.text).toBe("before\n\nconst a = 1\n  indented\n\nafter");
    expect(spans(f)).toEqual([{ type: "pre", language: "ts", offset: 8, length: 22, text: "const a = 1\n  indented" }]);
  });

  test("code block without a language", () => {
    const f = one("```\nx\n```");
    expect(f).toMatchObject({ full: "x", type: "pre" });
    expect("language" in f).toBe(false);
  });

  test("links", () => {
    expect(one("see [docs](https://example.com/a?b=1)")).toMatchObject({ full: "see docs", type: "text_link", url: "https://example.com/a?b=1", offset: 4, length: 4 });
    expect(one("[chat](tg://resolve?domain=x)")).toMatchObject({ type: "text_link", url: "tg://resolve?domain=x" });
    // Telegram links bare URLs itself.
    expect(toTelegram("go https://x.com now")).toEqual({ text: "go https://x.com now", entities: [] });
    expect(toTelegram("[https://x.com](https://x.com)")).toEqual({ text: "https://x.com", entities: [] });
    // Not a URL Telegram can open: keep the target visible.
    expect(toTelegram("open [plugin.ts](src/plugin.ts)")).toEqual({ text: "open plugin.ts (src/plugin.ts)", entities: [] });
    expect(toTelegram("[src/a.ts](src/a.ts)")).toEqual({ text: "src/a.ts", entities: [] });
  });

  test("styled link text keeps both entities", () => {
    const f = toTelegram("[**x**](https://x.com)");
    expect(spans(f)).toEqual([
      { type: "text_link", url: "https://x.com", offset: 0, length: 1, text: "x" },
      { type: "bold", offset: 0, length: 1, text: "x" },
    ]);
  });

  test("image is shown as a link", () => {
    expect(one("![chart](https://i.example/c.png)")).toMatchObject({ full: "chart", type: "text_link", url: "https://i.example/c.png" });
  });

  test("heading becomes a bold line", () => {
    const f = toTelegram("## Итог\n\ntext");
    expect(f.text).toBe("Итог\n\ntext");
    expect(spans(f)).toEqual([{ type: "bold", offset: 0, length: 4, text: "Итог" }]);
  });

  test("paragraphs are separated by a blank line, soft breaks kept", () => {
    expect(toTelegram("one\ntwo\n\n\n\nthree").text).toBe("one\ntwo\n\nthree");
  });

  test("bullet and ordered lists", () => {
    expect(toTelegram("- a\n- b").text).toBe("• a\n• b");
    expect(toTelegram("3. a\n4. b").text).toBe("3. a\n4. b");
  });

  test("nested list is indented, continuation lines too", () => {
    expect(toTelegram("- a\n  - b\n  - c\n- d").text).toBe("• a\n   ◦ b\n   ◦ c\n• d");
    expect(toTelegram("1. a\n   more\n2. b").text).toBe("1. a\n   more\n2. b");
  });

  test("loose list items are separated by a blank line", () => {
    expect(toTelegram("- a\n\n- b").text).toBe("• a\n\n• b");
  });

  test("task list", () => {
    expect(toTelegram("- [ ] todo\n- [x] done").text).toBe("☐ todo\n☑ done");
  });

  test("styles inside list items", () => {
    const f = toTelegram("- **a** b");
    expect(spans(f)).toEqual([{ type: "bold", offset: 2, length: 1, text: "a" }]);
  });

  test("blockquote", () => {
    const f = toTelegram("> quoted **x**\n> more");
    expect(f.text).toBe("quoted x\nmore");
    expect(spans(f)).toEqual([
      { type: "blockquote", offset: 0, length: 13, text: "quoted x\nmore" },
      { type: "bold", offset: 7, length: 1, text: "x" },
    ]);
  });

  test("nested blockquote gets no second blockquote entity", () => {
    const f = toTelegram("> a\n>> b");
    expect(f.entities.filter(e => e.type === "blockquote").length).toBe(1);
    expect(f.text).toBe("a\n\nb");
  });

  test("table becomes an aligned monospace block", () => {
    const f = toTelegram("| name | n |\n|---|--:|\n| **a** | 1 |\n| bb | 22 |");
    expect(f.text).toBe("name |  n\n-----+---\na    |  1\nbb   | 22");
    expect(f.entities).toEqual([{ type: "pre", offset: 0, length: f.text.length }]);
  });

  test("horizontal rule", () => {
    expect(toTelegram("a\n\n---\n\nb").text).toBe("a\n\n———\n\nb");
  });

  test("HTML stays as text, entities are decoded", () => {
    expect(toTelegram("a <b>x</b> &amp; &lt;y&gt; &#39;z&#39; &copy;").text).toBe("a <b>x</b> & <y> 'z' ©");
  });

  test("backslash escapes give the literal character", () => {
    expect(toTelegram("\\*not italic\\*")).toEqual({ text: "*not italic*", entities: [] });
  });

  test("Windows paths survive", () => {
    expect(toTelegram("C:\\code\\file.ts").text).toBe("C:\\code\\file.ts");
  });

  test("surrounding whitespace is trimmed", () => {
    expect(toTelegram("\n\n  text  \n\n").text).toBe("text");
  });

  test("empty input", () => {
    expect(toTelegram("")).toEqual({ text: "", entities: [] });
  });
});
