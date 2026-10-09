import { describe, expect, test } from "bun:test";
import { CHARS_PER_LINE, MAX_PLAIN_LINES, messageKind } from "../src/hub/message-kind.ts";

describe("messageKind", () => {
  test("text without markup is plain, however long", () => {
    expect(messageKind("готово")).toBe("plain");
    expect(messageKind(Array.from({ length: 40 }, (_, i) => `строка ${i}`).join("\n"))).toBe("plain");
    expect(messageKind("см. https://example.com/a_b_c")).toBe("plain");
  });

  test("short text with simple formatting is plain", () => {
    expect(messageKind("**Готово.** Тесты *зелёные*, `bun test` прошёл.")).toBe("plain");
    expect(messageKind("## Итог\n\nВсё **работает**.")).toBe("plain");
    expect(messageKind("- раз\n- два\n- три")).toBe("plain");
  });

  test(`formatted text longer than ${MAX_PLAIN_LINES} screen lines is rich`, () => {
    expect(messageKind("- 1\n- 2\n- 3\n- 4\n- 5\n- 6")).toBe("rich");
    expect(messageKind("- 1\n- 2\n- 3\n- 4\n- 5")).toBe("plain");
    const line = "слово ".repeat(CHARS_PER_LINE / 6);
    expect(messageKind(`**Итог:** ${line.repeat(MAX_PLAIN_LINES - 1)}`)).toBe("plain");
    expect(messageKind(`**Итог:** ${line.repeat(MAX_PLAIN_LINES + 1)}`)).toBe("rich");
  });

  test("a table is always rich", () => {
    expect(messageKind("| a | b |\n|---|---|\n| 1 | 2 |")).toBe("rich");
    expect(messageKind("> | a |\n> |---|\n> | 1 |")).toBe("rich");
  });

  test("a code block counts as markup", () => {
    expect(messageKind("```ts\nconst a = 1;\n```")).toBe("plain");
    expect(messageKind("```\n1\n2\n3\n4\n5\n6\n```")).toBe("rich");
  });
});
