import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { RigEvents } from "../src/hub/rig-events.ts";
import { tempDir } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const PIECES = 3;
const LONG_LINE_BYTES = 200 * 1024;

function fixture() {
  const dir = tempDir();
  const stateDir = tempDir();
  dirs.push(dir, stateDir);
  let available = true;
  let running = true;
  let failAt: number | undefined;
  let rejected = false;
  const sent: string[] = [];
  const pieces: string[] = [];
  const services: string[] = [];
  const warnings: string[] = [];
  const events = new RigEvents({ dir, stateDir, running: () => running, available: () => available,
    send: async (event, already, accepted) => {
      if (rejected) return false;
      // Every event goes out in PIECES pieces; failAt is the piece that Telegram refuses.
      for (let index = already; index < PIECES; index++) {
        if (failAt === index) throw new Error("offline");
        pieces.push(`${event.text}#${index}`);
        accepted(index + 1);
      }
      sent.push(`${event.level}:${event.text}`);
    },
    features: async () => { services.push("features"); }, restart: () => { services.push("restart"); }, language: async () => {}, warn: text => { warnings.push(text); } });
  return { dir, stateDir, events, sent, pieces, services, warnings, available: (next: boolean) => { available = next; }, running: (next: boolean) => { running = next; },
    fail: (next: number | undefined) => { failAt = next; }, reject: (next: boolean) => { rejected = next; },
    file: join(dir, "events.jsonl"), state: join(stateDir, "rig-events.json"), offsetFile: join(dir, "events.offset"),
    offset: () => readFileSync(join(dir, "events.offset"), "utf8") };
}

function line(type = "future-event", text = "Hello", level = "info", id = "invented-event") {
  return JSON.stringify({ id, time: "2026-01-01T00:00:00Z", type, text, level }) + "\n";
}

test("absent file and unavailable Telegram leave the offset untouched", async () => {
  const f = fixture();
  await f.events.poll();
  expect(existsSync(f.offsetFile)).toBe(false);
  writeFileSync(f.file, line());
  f.available(false);
  await f.events.poll();
  expect(existsSync(f.offsetFile)).toBe(false);
  expect(f.sent).toEqual([]);
});

test("only complete UTF-8 lines are delivered and byte offsets survive reload", async () => {
  const f = fixture();
  const first = line();
  const second = line("future", "more", "warn", "second");
  writeFileSync(f.file, first + second.slice(0, -1));
  await f.events.poll();
  expect(f.sent).toEqual(["info:Hello"]);
  expect(f.offset()).toBe(String(Buffer.byteLength(first)));
  appendFileSync(f.file, "\n");
  await f.events.poll();
  expect(f.sent).toEqual(["info:Hello", "warn:more"]);
  expect(f.offset()).toBe(String(Buffer.byteLength(first + second)));
  await f.events.poll();
  expect(f.sent).toHaveLength(2);
});

test("a line longer than one read block is read whole", async () => {
  const f = fixture();
  const big = line("future", "\u044f".repeat(LONG_LINE_BYTES / 2));
  writeFileSync(f.file, big + line("future", "after", "info", "after"));
  await f.events.poll();
  expect(f.sent).toEqual([`info:${"\u044f".repeat(LONG_LINE_BYTES / 2)}`, "info:after"]);
  expect(f.offset()).toBe(String(Buffer.byteLength(big + line("future", "after", "info", "after"))));
});

test("rejected Telegram send does not advance; the next poll retries", async () => {
  const f = fixture();
  writeFileSync(f.file, line());
  f.fail(0);
  await f.events.poll();
  expect(existsSync(f.offsetFile)).toBe(false);
  f.fail(undefined);
  await f.events.poll();
  expect(f.sent).toEqual(["info:Hello"]);
  f.reject(true);
  appendFileSync(f.file, line("future", "waits", "info", "waits"));
  await f.events.poll();
  expect(f.offset()).toBe(String(Buffer.byteLength(line())));
});

test("pieces Telegram already accepted are not sent again, also after a restart of the hub", async () => {
  const f = fixture();
  writeFileSync(f.file, line("future", "long"));
  f.fail(2);
  await f.events.poll();
  expect(f.pieces).toEqual(["long#0", "long#1"]);
  f.fail(undefined);
  await f.events.poll();
  expect(f.pieces).toEqual(["long#0", "long#1", "long#2"]);
  expect(f.sent).toEqual(["info:long"]);
  // A new process reads the memory the old one left in the state dir.
  const again = fixture();
  writeFileSync(again.file, line("future", "second"));
  again.fail(1);
  await again.events.poll();
  const second = new RigEvents({ dir: again.dir, stateDir: again.stateDir, running: () => true, available: () => true,
    send: async (event, already) => { f.pieces.push(`${event.text}:from${already}`); },
    features: async () => {}, restart: () => {}, language: async () => {}, warn: () => {} });
  await second.poll();
  expect(f.pieces.at(-1)).toBe("second:from1");
});

test("service events behind a stuck event are handled at once and only once", async () => {
  const f = fixture();
  writeFileSync(f.file, line("future", "stuck") + line("features-changed", "", "info", "a") + line("hub-restart-pending", "", "info", "b"));
  f.fail(0);
  await f.events.poll();
  expect(f.services).toEqual(["features", "restart"]);
  expect(existsSync(f.offsetFile)).toBe(false);
  await f.events.poll();
  expect(f.services).toEqual(["features", "restart"]);
  // A new service event behind the stuck one is also handled, the older ones not again.
  appendFileSync(f.file, line("features-changed", "", "info", "c"));
  await f.events.poll();
  expect(f.services).toEqual(["features", "restart", "features"]);
  f.fail(undefined);
  await f.events.poll();
  expect(f.sent).toEqual(["info:stuck"]);
  expect(f.services).toEqual(["features", "restart", "features"]);
  expect(f.offset()).toBe(String(Buffer.byteLength(readFileSync(f.file, "utf8"))));
});

test("service events are handled while delivery is impossible, and the offset stays", async () => {
  const f = fixture();
  writeFileSync(f.file, line("future", "waits") + line("hub-restart-pending", "", "info", "r") + line("features-changed", "", "info", "s"));
  f.available(false);
  await f.events.poll();
  expect(f.services).toEqual(["restart", "features"]);
  expect(existsSync(f.offsetFile)).toBe(false);
  expect(f.sent).toEqual([]);
  await f.events.poll();
  expect(f.services).toEqual(["restart", "features"]);
  f.available(true);
  await f.events.poll();
  expect(f.sent).toEqual(["info:waits"]);
  expect(f.services).toEqual(["restart", "features"]);
});

test("a stopped hub neither delivers nor handles anything", async () => {
  const f = fixture();
  writeFileSync(f.file, line("hub-restart-pending"));
  f.running(false);
  await f.events.poll();
  expect(f.services).toEqual([]);
});

test("a failing feature refresh does not stop delivery", async () => {
  const f = fixture();
  const events = new RigEvents({ dir: f.dir, stateDir: f.stateDir, running: () => true, available: () => true,
    send: async event => { f.sent.push(event.text); }, features: async () => { throw new Error("rig down"); }, restart: () => {}, language: async () => {}, warn: text => { f.warnings.push(text); } });
  writeFileSync(f.file, line("features-changed") + line("future", "after", "info", "x"));
  await events.poll();
  expect(f.sent).toEqual(["after"]);
  expect(f.warnings.join()).toContain("rig down");
});

test("malformed records cannot block service events or unknown textual types", async () => {
  const f = fixture();
  writeFileSync(f.file, "broken\n{}\n" + line("features-changed") + line("hub-restart-pending") + line("unknown", "failure", "error"));
  await f.events.poll();
  expect(f.services).toEqual(["features", "restart"]);
  expect(f.sent).toEqual(["error:failure"]);
  expect(f.warnings).toHaveLength(2);
});

test("an offset beyond the end of the file means truncation: reading starts over", async () => {
  const f = fixture();
  writeFileSync(f.file, line());
  writeFileSync(f.offsetFile, String(Buffer.byteLength(line()) + 1));
  await f.events.poll();
  expect(f.sent).toEqual(["info:Hello"]);
});

test("a file that was trimmed and grew past the offset is told by its first line id", async () => {
  const f = fixture();
  writeFileSync(f.file, line("future", "old", "info", "old-1") + line("future", "old-two", "info", "old-2"));
  await f.events.poll();
  expect(f.sent).toEqual(["info:old", "info:old-two"]);
  // rig cleared the file and wrote more events than the old offset: the offset is in range and on a line boundary.
  writeFileSync(f.file, line("future", "new-one", "info", "new-1") + line("future", "new-two", "info", "new-2") + line("future", "new-three", "info", "new-3"));
  await f.events.poll();
  expect(f.sent.slice(2)).toEqual(["info:new-one", "info:new-two", "info:new-three"]);
  expect(f.offset()).toBe(String(Buffer.byteLength(readFileSync(f.file, "utf8"))));
  // The same file is not read again.
  await f.events.poll();
  expect(f.sent).toHaveLength(5);
});

test("the first line id is the hub's own memory: kept in its state dir, never in rig's", async () => {
  const f = fixture();
  writeFileSync(f.file, line("future", "one", "info", "id-1"));
  await f.events.poll();
  expect(JSON.parse(readFileSync(f.state, "utf8")).firstId).toBe("id-1");
  expect(existsSync(join(f.dir, "rig-events.json"))).toBe(false);
});

test("without a remembered first id the saved offset is trusted, and the id is learned", async () => {
  const f = fixture();
  const first = line("future", "seen before", "info", "seen");
  writeFileSync(f.file, first + line("future", "fresh", "info", "fresh"));
  writeFileSync(f.offsetFile, String(Buffer.byteLength(first)));
  await f.events.poll();
  expect(f.sent).toEqual(["info:fresh"]);
  expect(JSON.parse(readFileSync(f.state, "utf8")).firstId).toBe("seen");
});

test("a trimmed file seen while Telegram is down is reset once delivery is possible, offset first", async () => {
  const f = fixture();
  writeFileSync(f.file, line("future", "a-text", "info", "old"));
  await f.events.poll();
  writeFileSync(f.file, line("future", "b-text", "info", "new") + line("future", "c-text", "info", "new-2"));
  f.available(false);
  await f.events.poll();
  expect(f.offset()).toBe(String(Buffer.byteLength(line("future", "a-text", "info", "old"))));
  f.available(true);
  await f.events.poll();
  expect(f.sent).toEqual(["info:a-text", "info:b-text", "info:c-text"]);
});

test("one batch of historical feature events loads current state once", async () => {
  const f = fixture();
  writeFileSync(f.file, line("features-changed") + line("features-changed", "", "info", "again"));
  await f.events.poll();
  expect(f.services).toEqual(["features"]);
});
