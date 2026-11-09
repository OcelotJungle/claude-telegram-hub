import { describe, expect, test } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import { loadCards, saveCards } from "../src/hub/cards.ts";
import { toTelegram } from "../src/shared/markdown.ts";
import { tempDir } from "./helpers.ts";

describe("saved cards", () => {
  test("a card keeps its text and entities across a save and a load", () => {
    const file = join(tempDir(), "cards.json");
    const card = { ...toTelegram("🤖 **Explore**\n`[12:00]` ok"), done: false, messageId: 7 };
    saveCards(file, [["s:x-0", card]]);
    expect(loadCards(file)).toEqual([["s:x-0", card]]);
  });

  test("a file of the older version, with the card as Markdown, is converted on load", () => {
    const file = join(tempDir(), "cards.json");
    writeFileSync(file, JSON.stringify({ "s:x-0": { text: "🤖 **Explore**\n`[12:00]` ok", done: true, messageId: 3 } }));
    expect(loadCards(file)).toEqual([["s:x-0", { ...toTelegram("🤖 **Explore**\n`[12:00]` ok"), done: true, messageId: 3 }]]);
    expect(loadCards(file)[0]?.[1].text).toBe("🤖 Explore\n[12:00] ok");
  });
});
