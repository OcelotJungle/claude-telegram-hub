import { describe, expect, test } from "bun:test";
import { decideTurnEnd, hasQuestion } from "../src/hook/turn-end.ts";

describe("hasQuestion", () => {
  test("a question in the last paragraph", () => {
    expect(hasQuestion("Сделал.\n\nДелаем дальше?")).toBe(true);
  });

  test("a question only in an earlier paragraph does not count", () => {
    expect(hasQuestion("Почему так?\n\nПотому что так.")).toBe(false);
  });

  test("a ? only inside a fenced block does not count", () => {
    expect(hasQuestion("Вот код:\n\n```js\nconst a = b ? 1 : 2;\n```")).toBe(false);
  });

  test("a ? only inside inline code does not count", () => {
    expect(hasQuestion("Оператор `a?b` готов.")).toBe(false);
  });

  test("a ? only inside a URL does not count", () => {
    expect(hasQuestion("Смотри https://x.y/?q=1")).toBe(false);
  });

  test("a ? right at the end of a URL asks", () => {
    expect(hasQuestion("see https://x.y?")).toBe(true);
    expect(hasQuestion("Глянешь https://x.y/a? Потом.")).toBe(true);
  });

  test("an unclosed fenced block is dropped to the end of the text", () => {
    expect(hasQuestion("Готово.\n\n```js\nconst a = b ? 1 : 2;")).toBe(false);
    expect(hasQuestion("Так подойдёт?\n\n```\ncut ? off")).toBe(true);
  });

  test("a code block after the question paragraph: the question paragraph is the last non-empty one", () => {
    expect(hasQuestion("Так подойдёт?\n\n```\ncode\n```\n")).toBe(true);
  });

  test("CRLF text", () => {
    expect(hasQuestion("Готово.\r\n\r\nКак тебе?")).toBe(true);
    expect(hasQuestion("Как тебе?\r\n\r\nГотово.")).toBe(false);
  });

  test("empty text", () => {
    expect(hasQuestion("")).toBe(false);
  });
});

describe("decideTurnEnd", () => {
  test("no tasks and no question: done", () => {
    expect(decideTurnEnd({ last_assistant_message: "Готово.", background_tasks: [] })).toEqual({ final: true, kind: "done" });
  });

  test("tasks and a question: ask", () => {
    expect(decideTurnEnd({ last_assistant_message: "Продолжать?", background_tasks: [{}] })).toEqual({ final: true, kind: "ask" });
  });

  test("tasks and no question: not final", () => {
    expect(decideTurnEnd({ last_assistant_message: "Жду монитор.", background_tasks: [{}] })).toEqual({ final: false });
  });

  test("a missing message is decided by the tasks only", () => {
    expect(decideTurnEnd({})).toEqual({ final: true, kind: "done" });
    expect(decideTurnEnd({ background_tasks: [{}] })).toEqual({ final: false });
  });
});
