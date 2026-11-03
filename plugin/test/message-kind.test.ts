import { describe, expect, test } from "bun:test";
import { messageKind } from "../src/hub/message-kind.ts";

const LONG_TEXT_LINES = 40;

function longText(line: string): string {
  return Array.from({ length: LONG_TEXT_LINES }, (_, i) => `${line} ${i}`).join("\n\n");
}

describe("messageKind", () => {
  test("text without markup is plain, however long", () => {
    expect(messageKind("\u0433\u043e\u0442\u043e\u0432\u043e")).toBe("plain");
    expect(messageKind(longText("\u0441\u0442\u0440\u043e\u043a\u0430"))).toBe("plain");
    expect(messageKind("\u0441\u043c. https://example.com/a_b_c")).toBe("plain");
  });

  test("ordinary Telegram markup is plain, however long", () => {
    expect(messageKind(longText("**\u0418\u0442\u043e\u0433:** \u0432\u0441\u0451 \u0440\u0430\u0431\u043e\u0442\u0430\u0435\u0442"))).toBe("plain");
    expect(messageKind(longText("*\u043a\u0443\u0440\u0441\u0438\u0432* \u0438 ~~\u0437\u0430\u0447\u0451\u0440\u043a\u043d\u0443\u0442\u043e~~"))).toBe("plain");
    expect(messageKind(longText("\u0441\u043c. `hub.ts`"))).toBe("plain");
    expect(messageKind(longText("\u0441\u043c. [\u0434\u043e\u043a\u0438](https://example.com)"))).toBe("plain");
    expect(messageKind(longText("> \u0446\u0438\u0442\u0430\u0442\u0430"))).toBe("plain");
    expect(messageKind("```ts\nconst a = 1;\n```")).toBe("plain");
    expect(messageKind("```\n1\n2\n3\n4\n5\n6\n```")).toBe("plain");
  });

  test("a list of any kind is rich, even one line long", () => {
    expect(messageKind("- \u0440\u0430\u0437")).toBe("rich");
    expect(messageKind("1. \u0440\u0430\u0437")).toBe("rich");
    expect(messageKind("- [ ] \u0437\u0430\u0434\u0430\u0447\u0430")).toBe("rich");
    expect(messageKind("- **\u0440\u0430\u0437**\n  - \u0432\u043b\u043e\u0436\u0435\u043d\u043d\u044b\u0439")).toBe("rich");
  });

  test("a heading is rich, even a short one", () => {
    expect(messageKind("## \u0418\u0442\u043e\u0433")).toBe("rich");
    expect(messageKind("## \u0418\u0442\u043e\u0433\n\n\u0412\u0441\u0451 **\u0440\u0430\u0431\u043e\u0442\u0430\u0435\u0442**.")).toBe("rich");
  });

  test("a table is rich", () => {
    expect(messageKind("| a | b |\n|---|---|\n| 1 | 2 |")).toBe("rich");
    expect(messageKind("> | a |\n> |---|\n> | 1 |")).toBe("rich");
  });

  test("a horizontal rule is rich", () => {
    expect(messageKind("\u0434\u043e\n\n---\n\n\u043f\u043e\u0441\u043b\u0435")).toBe("rich");
  });

  test("a list nested in a blockquote is rich", () => {
    expect(messageKind("> \u0446\u0438\u0442\u0430\u0442\u0430\n>\n> - \u0440\u0430\u0437")).toBe("rich");
    expect(messageKind("> - \u0440\u0430\u0437")).toBe("rich");
  });
});
