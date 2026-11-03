import { afterEach, expect, test } from "bun:test";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { RigEvents } from "../src/hub/rig-events.ts";
import { tempDir } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = tempDir();
  const stateDir = tempDir();
  dirs.push(dir, stateDir);
  let available = true;
  const sent: string[] = [];
  const calls: string[] = [];
  const events = new RigEvents({ dir, stateDir, running: () => true, available: () => available,
    send: async event => { sent.push(`${event.type}:${event.text}`); },
    features: async () => { calls.push("features"); }, restart: () => { calls.push("restart"); },
    language: async () => { calls.push("language"); }, warn: () => {} });
  return { dir, events, sent, calls, file: join(dir, "events.jsonl"), offset: () => readFileSync(join(dir, "events.offset"), "utf8"),
    available: (next: boolean) => { available = next; } };
}

function line(id: string, type: string, text = "invented notice") {
  return JSON.stringify({ id, time: "2026-01-01T00:00:00Z", type, text, level: "info" }) + "\n";
}

test("a language-changed event is handled once and also delivered as text", async () => {
  const f = fixture();
  writeFileSync(f.file, line("a", "language-changed", "language is now ru"));
  await f.events.poll();
  expect(f.calls).toEqual(["language"]);
  expect(f.sent).toEqual(["language-changed:language is now ru"]);
});

test("several language-changed events in one poll cause one re-read", async () => {
  const f = fixture();
  writeFileSync(f.file, line("a", "language-changed") + line("b", "language-changed") + line("c", "language-changed"));
  await f.events.poll();
  expect(f.calls).toEqual(["language"]);
  expect(f.sent).toHaveLength(3);
});

test("a language-changed event and a features-changed event in one poll read the features once", async () => {
  const f = fixture();
  writeFileSync(f.file, line("a", "features-changed") + line("b", "language-changed"));
  await f.events.poll();
  // features-changed first: it reads the features, then the language handler runs.
  expect(f.calls).toEqual(["features", "language"]);
  // language-changed first: its handler reads the features, so the features-changed behind it adds no second read.
  const g = fixture();
  writeFileSync(g.file, line("a", "language-changed") + line("b", "features-changed"));
  await g.events.poll();
  expect(g.calls).toEqual(["language"]);
});

test("a language-changed event is handled while Telegram delivery is off, and not delivered", async () => {
  const f = fixture();
  f.available(false);
  writeFileSync(f.file, line("a", "language-changed"));
  await f.events.poll();
  expect(f.calls).toEqual(["language"]);
  expect(f.sent).toEqual([]);
  // Delivery on again: the event is still owed as text, but is not handled a second time.
  f.available(true);
  await f.events.poll();
  expect(f.calls).toEqual(["language"]);
  expect(f.sent).toHaveLength(1);
  expect(f.offset()).toBe(String(Buffer.byteLength(line("a", "language-changed"))));
});

test("a later poll handles a new language-changed event again", async () => {
  const f = fixture();
  writeFileSync(f.file, line("a", "language-changed"));
  await f.events.poll();
  appendFileSync(f.file, line("b", "language-changed"));
  await f.events.poll();
  expect(f.calls).toEqual(["language", "language"]);
});
