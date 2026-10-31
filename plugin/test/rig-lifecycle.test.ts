import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { RigLifecycle, RIG_RESTART_EXIT, startedCommit } from "../src/hub/rig-lifecycle.ts";
import { tempDir } from "./helpers.ts";

// Full SHA-1 commit lengths, synthetic time, never the real repository's commits.
const COMMIT = "a".repeat(40);
const NEW_COMMIT = "b".repeat(40);
const START = Date.parse("2026-01-01T00:00:00Z");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(commitKnown = true) {
  const dir = tempDir();
  dirs.push(dir);
  let head: string | undefined = COMMIT;
  let started: string | undefined = commitKnown ? COMMIT : undefined;
  let idle = true;
  let now = START;
  const exits: number[] = [];
  const notices: { id: string; text: string }[] = [];
  const warnings: string[] = [];
  const lifecycle = new RigLifecycle({ dir, head: () => head, started: () => started, idle: () => idle, now: () => now,
    exit: code => { exits.push(code); }, notice: (id, text) => { notices.push({ id, text }); }, warn: text => { warnings.push(text); } });
  return { dir, lifecycle, exits, notices, warnings,
    head: (next: string | undefined) => { head = next; }, started: (next: string | undefined) => { started = next; },
    idle: (next: boolean) => { idle = next; }, now: (next: number) => { now = next; } };
}

test("readiness waits for Bot API success, announces changed commits and refreshes its timestamp", () => {
  const f = fixture();
  expect(existsSync(join(f.dir, "hub-ready.json"))).toBe(false);
  writeFileSync(join(f.dir, "hub-ready.json"), JSON.stringify({ commit: NEW_COMMIT, time: new Date(START).toISOString() }));
  f.lifecycle.ready();
  expect(f.notices).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(f.dir, "hub-ready.json"), "utf8")).commit).toBe(COMMIT);
  f.now(START + 1);
  f.lifecycle.request();
  expect(JSON.parse(readFileSync(join(f.dir, "hub-ready.json"), "utf8")).time).toBe(new Date(START + 1).toISOString());
  expect(f.exits).toEqual([]);
});

test("a late start on the new HEAD acknowledges a pending event instead of exiting", () => {
  const f = fixture();
  f.lifecycle.request();
  f.lifecycle.check();
  expect(existsSync(join(f.dir, "hub-ready.json"))).toBe(false);
  expect(f.exits).toEqual([]);
  // The hub stays up until the acknowledgement is written.
  expect(f.lifecycle.waiting).toBe(true);
  f.lifecycle.ready();
  expect(existsSync(join(f.dir, "hub-ready.json"))).toBe(true);
  expect(f.lifecycle.waiting).toBe(false);
  expect(f.notices).toEqual([]);
});

test("busy work and a new turn postpone exit without a deadline", () => {
  const f = fixture();
  f.head(NEW_COMMIT);
  f.lifecycle.request();
  f.idle(false);
  f.lifecycle.check();
  expect(existsSync(join(f.dir, "hub-restarting.json"))).toBe(false);
  f.idle(true);
  // A new turn before the final synchronous check closes the gate again.
  f.idle(false);
  f.lifecycle.check();
  expect(f.exits).toEqual([]);
  f.idle(true);
  f.lifecycle.check();
  expect(f.exits).toEqual([RIG_RESTART_EXIT]);
  expect(JSON.parse(readFileSync(join(f.dir, "hub-restarting.json"), "utf8"))).toEqual({ time: new Date(START).toISOString() });
});

test("a failed hub-restarting.json write is tried again: the hub exits only once the marker is written", () => {
  const f = fixture();
  f.lifecycle.ready();
  f.head(NEW_COMMIT);
  f.lifecycle.request();
  const unblock = blockRestartFile(f.dir);
  f.lifecycle.check();
  f.lifecycle.check();
  expect(f.exits).toEqual([]);
  expect(f.lifecycle.waiting).toBe(true);
  expect(f.warnings).toHaveLength(1);
  unblock();
  f.lifecycle.check();
  expect(f.exits).toEqual([RIG_RESTART_EXIT]);
  expect(JSON.parse(readFileSync(join(f.dir, "hub-restarting.json"), "utf8"))).toEqual({ time: new Date(START).toISOString() });
});

test("machines without rig get no rig directory even after getMe", () => {
  const f = fixture();
  const missing = join(f.dir, "missing");
  const lifecycle = new RigLifecycle({ dir: missing, head: () => COMMIT, started: () => COMMIT, now: () => START, idle: () => true, notice() {}, exit() {}, warn() {} });
  lifecycle.ready();
  expect(existsSync(missing)).toBe(false);
});

// A directory in the place of the file makes the atomic rename fail the way a locked or full disk does.
function blockReadyFile(dir: string): () => void {
  const blocker = join(dir, "hub-ready.json");
  mkdirSync(blocker);
  return () => { rmSync(blocker, { recursive: true, force: true }); };
}

// A directory where the file should be makes the rename of the written file fail.
function blockRestartFile(dir: string): () => void {
  const blocker = join(dir, "hub-restarting.json");
  mkdirSync(blocker);
  return () => { rmSync(blocker, { recursive: true, force: true }); };
}

test("a failed hub-ready.json write is tried again, warned about once, and the notice waits for the write", () => {
  const f = fixture();
  const unblock = blockReadyFile(f.dir);
  f.lifecycle.ready();
  f.lifecycle.check();
  f.lifecycle.check();
  expect(f.warnings).toHaveLength(1);
  expect(f.notices).toEqual([]);
  unblock();
  writeFileSync(join(f.dir, "hub-ready.json"), JSON.stringify({ commit: NEW_COMMIT, time: new Date(START).toISOString() }));
  f.lifecycle.check();
  expect(JSON.parse(readFileSync(join(f.dir, "hub-ready.json"), "utf8")).commit).toBe(COMMIT);
  expect(f.notices).toHaveLength(1);
  f.lifecycle.check();
  expect(f.notices).toHaveLength(1);
});

test("an acknowledgement whose write failed is not lost and the hub does not exit before it is written", () => {
  const f = fixture();
  const unblock = blockReadyFile(f.dir);
  f.lifecycle.ready();
  f.lifecycle.request();
  expect(f.lifecycle.waiting).toBe(true);
  f.lifecycle.check();
  expect(f.lifecycle.waiting).toBe(true);
  expect(f.exits).toEqual([]);
  unblock();
  f.lifecycle.check();
  expect(f.lifecycle.waiting).toBe(false);
  expect(existsSync(join(f.dir, "hub-ready.json"))).toBe(true);
});

test("the change notice has a stable id built from both commits and neutral text", () => {
  const f = fixture();
  writeFileSync(join(f.dir, "hub-ready.json"), JSON.stringify({ commit: NEW_COMMIT, time: new Date(START).toISOString() }));
  f.lifecycle.ready();
  expect(f.notices).toHaveLength(1);
  expect(f.notices[0]?.id).toContain(NEW_COMMIT);
  expect(f.notices[0]?.id).toContain(COMMIT);
  // True after a rollback as well: it says that the code differs, not that it is newer.
  expect(f.notices[0]?.text).not.toMatch(/обновлён/);
});

test("an unknown commit does not consume the event: it is retried and General gets one message", () => {
  const f = fixture(false);
  f.lifecycle.ready();
  f.lifecycle.request();
  f.lifecycle.check();
  f.lifecycle.check();
  expect(f.exits).toEqual([]);
  expect(f.lifecycle.waiting).toBe(true);
  expect(f.notices).toHaveLength(1);
  expect(f.warnings).toHaveLength(1);
  expect(existsSync(join(f.dir, "hub-ready.json"))).toBe(false);
  // The commit becomes known: the retained event is handled as usual.
  f.started(COMMIT);
  f.head(NEW_COMMIT);
  f.lifecycle.check();
  expect(f.exits).toEqual([RIG_RESTART_EXIT]);
});

test("an unknown current HEAD is retried too", () => {
  const f = fixture();
  f.head(undefined);
  f.lifecycle.ready();
  f.lifecycle.request();
  f.lifecycle.check();
  expect(f.lifecycle.waiting).toBe(true);
  f.head(COMMIT);
  f.lifecycle.check();
  expect(f.lifecycle.waiting).toBe(false);
  expect(f.exits).toEqual([]);
});

test("the started commit comes from the environment the service script fixed", () => {
  expect(startedCommit({ TELEGRAM_HUB_COMMIT: COMMIT })).toBe(COMMIT);
  expect(startedCommit({ TELEGRAM_HUB_COMMIT: `${COMMIT}\n` })).toBe(COMMIT);
  expect(startedCommit({ TELEGRAM_HUB_COMMIT: "not-a-commit" })).toBeUndefined();
  expect(startedCommit({})).toBeUndefined();
});
