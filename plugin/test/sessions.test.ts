import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { SessionStore, topicName } from "../src/hub/sessions.ts";
import { tempDir } from "./helpers.ts";

const rec = { topicId: 101, title: "Fix login", project: "app", enabled: true };

describe("SessionStore", () => {
  test("a record survives a new store instance (hub restart)", () => {
    const file = join(tempDir(), "sessions.json");
    new SessionStore(file).set("s1", rec);
    expect(new SessionStore(file).get("s1")).toEqual(rec);
  });

  test("the same session id (after --resume) finds the same topic", () => {
    const file = join(tempDir(), "sessions.json");
    const a = new SessionStore(file);
    a.set("s1", rec);
    a.set("s2", { ...rec, topicId: 202 });
    const b = new SessionStore(file);
    expect(b.get("s1")?.topicId).toBe(101);
    expect(b.findByTopic(202)).toBe("s2");
    expect(b.findByTopic(999)).toBeUndefined();
  });

  test("setEnabled is persisted", () => {
    const file = join(tempDir(), "sessions.json");
    const a = new SessionStore(file);
    a.set("s1", rec);
    a.setEnabled("s1", false);
    expect(new SessionStore(file).get("s1")?.enabled).toBe(false);
  });

  test("setEnabled on an unknown session does nothing", () => {
    const file = join(tempDir(), "sessions.json");
    const a = new SessionStore(file);
    a.setEnabled("nope", true);
    expect(a.get("nope")).toBeUndefined();
  });

  test("a corrupt file is moved aside and the store starts empty", () => {
    const dir = tempDir();
    const file = join(dir, "sessions.json");
    writeFileSync(file, "{oops");
    const s = new SessionStore(file);
    expect(s.get("s1")).toBeUndefined();
    expect(readdirSync(dir).some(f => f.startsWith("sessions.json.corrupt-"))).toBe(true);
    s.set("s1", rec);
    expect(existsSync(file)).toBe(true);
  });
});

describe("topicName", () => {
  test('is "<project> · <title>"', () => {
    expect(topicName("claude-telegram-hub", "Реализация хаба")).toBe("claude-telegram-hub · Реализация хаба");
  });

  test("empty title falls back to a placeholder", () => {
    expect(topicName("app", "  ")).toBe("app · без названия");
  });

  test("is cut to 128 characters by shortening the title", () => {
    const name = topicName("app", "x".repeat(300));
    expect(name.length).toBe(128);
    expect(name.startsWith("app · xxx")).toBe(true);
    expect(name.endsWith("…")).toBe(true);
  });
});
