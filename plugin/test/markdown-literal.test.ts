import { describe, expect, test } from "bun:test";
import { literal, toTelegram } from "../src/shared/markdown.ts";

const RANDOM_CASES = 3000;
const RANDOM_MAX_LENGTH = 24;
const SEED = 20240607;
const LCG_MULTIPLIER = 1664525;
const LCG_INCREMENT = 1013904223;
const LCG_MODULUS = 2 ** 32;

// toTelegram trims, so a case with blanks at an end is compared trimmed.
const FOREIGN: readonly string[] = [
  "C:\\projects\\_tmp\\a*b*c",
  "rig session <subcommand> [arguments]",
  "2*3*4",
  "**x**",
  "__x__ and ~~y~~",
  "`code` and ``a`b``",
  "```\nfenced\n```",
  "1. item",
  "1) item",
  "- item\n* item\n+ item",
  "# h",
  "###### h6\n\nbody",
  "> q",
  ">> nested",
  "a\n    code",
  "a\n\tcode",
  "---",
  "***",
  "___",
  "a\n---",
  "a\n===",
  "&amp;",
  "&#65; &lt;",
  "<b>y</b>",
  "<https://a.b/c>",
  "<a@b.c>",
  "https://a.b/c_d",
  "www.example.com",
  "a@b.c",
  "[a](https://b.c)",
  "![img](https://b.c/i.png)",
  "[ref]: https://b.c",
  "| a | b |\n|---|---|\n| 1 | 2 |",
  "- [x] task",
  "line one\nline two\n\n\nline five",
  "a  \nb",
  "a\r\nb",
  "тест *звёздочки* и _подчёркивания_",
  "",
  "plain text",
];

const expectLiteral = (s: string) => {
  const f = toTelegram(literal(s));
  expect(f.text).toBe(s.trim());
  expect(f.entities).toEqual([]);
};

describe("literal", () => {
  for (const s of FOREIGN) {
    test(`shows ${JSON.stringify(s)} as written`, () => expectLiteral(s));
  }

  test("leading blanks are kept after other text, so no indented code forms", () => {
    const f = toTelegram(`a\n\n${literal("    code")}`);
    expect(f.text).toBe("a\n\n    code");
    expect(f.entities).toEqual([]);
  });

  test("random strings of markup characters show as written", () => {
    const alphabet = [..."\\`*_[]()<>#+-.!|~{}&;=:/@ \t\n\r123aб"];
    let state = SEED;
    const next = (n: number) => {
      state = (Math.imul(state, LCG_MULTIPLIER) + LCG_INCREMENT) % LCG_MODULUS;
      return Math.floor((state / LCG_MODULUS) * n);
    };
    for (let i = 0; i < RANDOM_CASES; i++) {
      const length = next(RANDOM_MAX_LENGTH + 1);
      let s = "";
      for (let j = 0; j < length; j++) s += alphabet[next(alphabet.length)];
      const f = toTelegram(literal(s));
      expect({ s, text: f.text, entities: f.entities }).toEqual({ s, text: s.replace(/\r/g, "\r").trim(), entities: [] });
    }
  });

  test("Markdown around a literal still renders", () => {
    const f = toTelegram("**h** " + literal("a*b"));
    expect(f.text).toBe("h a*b");
    expect(f.entities).toEqual([{ type: "bold", offset: 0, length: 1 }]);
  });
});
