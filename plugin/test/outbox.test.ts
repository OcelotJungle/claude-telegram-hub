import { beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { Outbox } from "../src/hub/outbox.ts";
import { memLogger, tempDir } from "./helpers.ts";

let dir: string;
let file: string;
let log: ReturnType<typeof memLogger>;

beforeEach(() => {
  dir = tempDir();
  file = join(dir, "outbox.json");
  log = memLogger();
});

const piece = (text: string, silent = true) => ({ text, silent });
const photo = (name: string) => ({ path: `/q/${name}`, name, size: 1, kind: "photo" as const });

describe("Outbox", () => {
  test("pieces of a session come out in order, sessions apart", () => {
    const o = new Outbox(file, log);
    o.add("m1", "a", [piece("a1"), piece("a2")]);
    o.add("m2", "b", [piece("b1")]);
    o.add("m3", "a", [piece("a3", false)]);
    expect(o.sessions().sort()).toEqual(["a", "b"]);
    const seen: string[] = [];
    for (let h = o.head("a"); h; h = o.head("a")) {
      seen.push(h.text);
      o.remove(h.id);
    }
    expect(seen).toEqual(["a1", "a2", "a3"]);
    expect(o.head("b")?.text).toBe("b1");
    expect(o.size).toBe(1);
  });

  test("the queue survives a restart", () => {
    const o = new Outbox(file, log);
    o.add("m1", "a", [piece("one"), piece("two", false)]);
    o.remove(o.head("a")!.id);
    const again = new Outbox(file, log);
    expect(again.head("a")).toMatchObject({ sessionId: "a", text: "two", silent: false });
  });

  test("a message id already queued is not queued again, even after a restart", () => {
    const o = new Outbox(file, log);
    expect(o.add("m1", "a", [piece("x")])).toBe(true);
    expect(o.add("m1", "a", [piece("x")])).toBe(false);
    o.remove(o.head("a")!.id);
    expect(new Outbox(file, log).add("m1", "a", [piece("x")])).toBe(false);
    expect(o.size).toBe(0);
  });

  test("a notice takes the place of a piece and is loud", () => {
    const o = new Outbox(file, log);
    o.add("m1", "a", [piece("bad"), piece("next")]);
    o.replaceWithNotice(o.head("a")!.id, "⚠️ notice");
    expect(new Outbox(file, log).head("a")).toMatchObject({ text: "⚠️ notice", silent: false, notice: true });
    expect(o.countOf("a")).toBe(2);
  });

  test("a notice in place of files carries neither files nor entities", () => {
    const o = new Outbox(file, log);
    o.add("m1", "a", [{ text: "cap", silent: true, entities: [{ type: "bold", offset: 0, length: 3 }], files: [photo("x.png")] }]);
    o.replaceWithNotice(o.head("a")!.id, "⚠️ notice");
    const h = new Outbox(file, log).head("a")!;
    expect(h.files).toBeUndefined();
    expect(h.entities).toBeUndefined();
  });

  test("a piece can lose its entities, in place and on disk", () => {
    const o = new Outbox(file, log);
    o.add("m1", "a", [{ text: "b", silent: true, entities: [{ type: "bold", offset: 0, length: 1 }] }, piece("next")]);
    o.dropEntities(o.head("a")!.id);
    expect(new Outbox(file, log).head("a")).toMatchObject({ text: "b" });
    expect(new Outbox(file, log).head("a")!.entities).toBeUndefined();
    expect(o.countOf("a")).toBe(2);
  });

  test("a piece can be replaced by several, keeping its place and its message", () => {
    const o = new Outbox(file, log);
    o.add("m1", "a", [piece("one"), piece("three")]);
    o.replace(o.head("a")!.id, [piece("one-a"), piece("one-b")]);
    const again = new Outbox(file, log);
    const seen: string[] = [];
    for (let h = again.head("a"); h; h = again.head("a")) {
      seen.push(h.text);
      expect(again.hasMessage("m1")).toBe(true);
      again.remove(h.id);
    }
    expect(seen).toEqual(["one-a", "one-b", "three"]);
    expect(again.hasMessage("m1")).toBe(false);
  });

  test("hasMessage tells pieces of one message from another with a longer id", () => {
    const o = new Outbox(file, log);
    o.add("m10", "a", [piece("x")]);
    expect(o.hasMessage("m1")).toBe(false);
    expect(o.hasMessage("m10")).toBe(true);
  });

  test("a corrupt file is kept aside and reported, not silently dropped", () => {
    writeFileSync(file, "{oops");
    const o = new Outbox(file, log);
    expect(o.size).toBe(0);
    expect(readdirSync(dir).some(f => f.startsWith("outbox.json.corrupt-"))).toBe(true);
    expect(log.lines.some(l => l.startsWith("ERROR") && l.includes("outbox"))).toBe(true);
  });
});
