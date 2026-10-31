import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { accountOf, SessionStore, topicName } from "../src/hub/sessions.ts";
import { tempDir } from "./helpers.ts";
import { platformFor } from "../src/shared/platform.ts";

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

  test("setWhere remembers the last cwd and account, unknown values keep the old ones", () => {
    const file = join(tempDir(), "sessions.json");
    const a = new SessionStore(file);
    a.set("s1", rec);
    a.setWhere("s1", "C:\\app", "2");
    a.setWhere("s1", "C:\\app", undefined);
    expect(new SessionStore(file).get("s1")).toEqual({ ...rec, cwd: "C:\\app", account: "2" });
    a.setWhere("s1", "C:\\app", "1");
    expect(a.get("s1")?.account).toBe("1");
    a.setWhere("nobody", "C:\\x", "1");
    expect(a.get("nobody")).toBeUndefined();
  });

  test("the account is the number of the cswap profile folder", () => {
    expect(accountOf("C:\\Users\\me\\.claude-swap-backup\\sessions\\1-me_gmail.com", platformFor("win32"))).toBe("1");
    expect(accountOf("C:\\Users\\me\\.claude-swap-backup\\sessions\\12-x_y.com\\", platformFor("win32"))).toBe("12");
    expect(accountOf("C:\\Users\\me\\.claude", platformFor("win32"))).toBeUndefined();
    expect(accountOf(undefined)).toBeUndefined();
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

  test("an explicit off is persisted as disabledByUser", () => {
    const file = join(tempDir(), "sessions.json");
    const a = new SessionStore(file);
    a.set("s1", rec);
    a.setEnabled("s1", false, true);
    expect(new SessionStore(file).get("s1")).toEqual({ ...rec, enabled: false, disabledByUser: true });
  });

  test("an off that is not explicit keeps an earlier explicit off", () => {
    const file = join(tempDir(), "sessions.json");
    const a = new SessionStore(file);
    a.set("s1", rec);
    a.setEnabled("s1", false, true);
    a.setEnabled("s1", false);
    expect(new SessionStore(file).get("s1")).toMatchObject({ enabled: false, disabledByUser: true });
  });

  test("turning on clears disabledByUser", () => {
    const file = join(tempDir(), "sessions.json");
    const a = new SessionStore(file);
    a.set("s1", rec);
    a.setEnabled("s1", false, true);
    expect(a.get("s1")).toMatchObject({ disabledByUser: true });
    a.setEnabled("s1", true);
    const got = new SessionStore(file).get("s1");
    expect(got?.enabled).toBe(true);
    expect(got && "disabledByUser" in got).toBe(false);
  });

  test("a record without a topic loads and keeps working", () => {
    const file = join(tempDir(), "sessions.json");
    const noTopic = { title: "Fix login", project: "app", enabled: true, cwd: "C:\\app" };
    writeFileSync(file, JSON.stringify({ s1: noTopic }));
    expect(new SessionStore(file).get("s1")).toEqual(noTopic);
  });

  test("setTopicId and setTitle are persisted without touching the other fields", () => {
    const file = join(tempDir(), "sessions.json");
    const a = new SessionStore(file);
    a.set("s1", { title: "Fix login", project: "app", enabled: true });
    a.setTitle("s1", "Other");
    a.setTopicId("s1", 300);
    expect(new SessionStore(file).get("s1")).toEqual({ topicId: 300, title: "Other", project: "app", enabled: true });
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
    expect(topicName("project", "Реализация хаба")).toBe("project · Реализация хаба");
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
