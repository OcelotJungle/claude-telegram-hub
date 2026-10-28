import { describe, expect, test } from "bun:test";
import { messageKind } from "../src/hub/message-kind.ts";

const LONG_TEXT_LINES = 40;

function longText(line: string): string {
  return Array.from({ length: LONG_TEXT_LINES }, (_, i) => `${line} ${i}`).join("\n\n");
}

describe("messageKind", () => {
  test("text without markup is plain, however long", () => {
    expect(messageKind("готово")).toBe("plain");
    expect(messageKind(longText("строка"))).toBe("plain");
    expect(messageKind("см. https://example.com/a_b_c")).toBe("plain");
  });

  test("ordinary Telegram markup is plain, however long", () => {
    expect(messageKind(longText("**Итог:** всё работает"))).toBe("plain");
    expect(messageKind(longText("*курсив* и ~~зачёркнуто~~"))).toBe("plain");
    expect(messageKind(longText("см. `hub.ts`"))).toBe("plain");
    expect(messageKind(longText("см. [доки](https://example.com)"))).toBe("plain");
    expect(messageKind(longText("> цитата"))).toBe("plain");
    expect(messageKind("```ts\nconst a = 1;\n```")).toBe("plain");
    expect(messageKind("```\n1\n2\n3\n4\n5\n6\n```")).toBe("plain");
  });

  test("a list of any kind is rich, even one line long", () => {
    expect(messageKind("- раз")).toBe("rich");
    expect(messageKind("1. раз")).toBe("rich");
    expect(messageKind("- [ ] задача")).toBe("rich");
    expect(messageKind("- **раз**\n  - вложенный")).toBe("rich");
  });

  test("a heading is rich, even a short one", () => {
    expect(messageKind("## Итог")).toBe("rich");
    expect(messageKind("## Итог\n\nВсё **работает**.")).toBe("rich");
  });

  test("a table is rich", () => {
    expect(messageKind("| a | b |\n|---|---|\n| 1 | 2 |")).toBe("rich");
    expect(messageKind("> | a |\n> |---|\n> | 1 |")).toBe("rich");
  });

  test("a horizontal rule is rich", () => {
    expect(messageKind("до\n\n---\n\nпосле")).toBe("rich");
  });

  test("a list nested in a blockquote is rich", () => {
    expect(messageKind("> цитата\n>\n> - раз")).toBe("rich");
    expect(messageKind("> - раз")).toBe("rich");
  });
});
