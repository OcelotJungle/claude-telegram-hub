import { describe, expect, test } from "bun:test";
import { decideTurnEnd, hasQuestion } from "../src/hook/turn-end.ts";

describe("hasQuestion", () => {
  test("a question in the last paragraph", () => {
    expect(hasQuestion("Done.\n\nShall we go on?")).toBe(true);
  });

  test("a question only in an earlier paragraph does not count", () => {
    expect(hasQuestion("Why so?\n\nBecause so.")).toBe(false);
  });

  test("a ? only inside a fenced block does not count", () => {
    expect(hasQuestion("Here is the code:\n\n```js\nconst a = b ? 1 : 2;\n```")).toBe(false);
  });

  test("a ? only inside inline code does not count", () => {
    expect(hasQuestion("The operator `a?b` is ready.")).toBe(false);
  });

  test("a ? only inside a URL does not count", () => {
    expect(hasQuestion("Look at https://x.y/?q=1")).toBe(false);
  });

  test("a ? right at the end of a URL asks", () => {
    expect(hasQuestion("see https://x.y?")).toBe(true);
    expect(hasQuestion("Will you look at https://x.y/a? Then.")).toBe(true);
  });

  test("an unclosed fenced block is dropped to the end of the text", () => {
    expect(hasQuestion("Ready.\n\n```js\nconst a = b ? 1 : 2;")).toBe(false);
    expect(hasQuestion("Will this do?\n\n```\ncut ? off")).toBe(true);
  });

  test("a code block after the question paragraph: the question paragraph is the last non-empty one", () => {
    expect(hasQuestion("Will this do?\n\n```\ncode\n```\n")).toBe(true);
  });

  test("CRLF text", () => {
    expect(hasQuestion("Ready.\r\n\r\nHow is it?")).toBe(true);
    expect(hasQuestion("How is it?\r\n\r\nReady.")).toBe(false);
  });

  test("empty text", () => {
    expect(hasQuestion("")).toBe(false);
  });
});

describe("decideTurnEnd", () => {
  test("no tasks and no question: done", () => {
    expect(decideTurnEnd({ last_assistant_message: "Ready.", background_tasks: [] })).toEqual({ final: true, kind: "done" });
  });

  test("tasks and a question: ask", () => {
    expect(decideTurnEnd({ last_assistant_message: "Continue?", background_tasks: [{}] })).toEqual({ final: true, kind: "ask" });
  });

  test("tasks and no question: not final", () => {
    expect(decideTurnEnd({ last_assistant_message: "Waiting for the monitor.", background_tasks: [{}] })).toEqual({ final: false });
  });

  test("a missing message is decided by the tasks only", () => {
    expect(decideTurnEnd({})).toEqual({ final: true, kind: "done" });
    expect(decideTurnEnd({ background_tasks: [{}] })).toEqual({ final: false });
  });
});
