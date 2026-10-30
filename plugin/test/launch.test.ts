import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { launchCommand, LaunchError, sessionCwd, transcriptMode } from "../src/hub/launch.ts";
import { tempDir as makeTempDir } from "./helpers.ts";

// launch.ts reads backwards in MiB blocks; fixtures cross that boundary.
const TAIL_READ_BYTES = 1024 * 1024;
const SID = "11111111-2222-3333-4444-555555555555";
const LAUNCH = {
  command: ["wt.exe", "-d", "{cwd}", "cmd.exe", "/c", "cswap.exe run {account} -- --resume {session} & exit /b 0"],
  timeoutSec: 90,
};
const dirs: string[] = [];
const tempDir = () => { const dir = makeTempDir(); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("launchCommand", () => {
  test("puts the values into every part", () => {
    const cwd = tempDir();
    expect(launchCommand(LAUNCH, { cwd, account: "2", session: SID })).toEqual([
      "wt.exe",
      "-d",
      cwd,
      "cmd.exe",
      "/c",
      `cswap.exe run 2 -- --resume ${SID} & exit /b 0`,
    ]);
  });

  test("refuses values that could change what runs", () => {
    const cwd = tempDir();
    expect(() => launchCommand(LAUNCH, { cwd, account: "1 & calc", session: SID })).toThrow(LaunchError);
    expect(() => launchCommand(LAUNCH, { cwd, account: "1", session: `${SID}&calc` })).toThrow(LaunchError);
    expect(() => launchCommand(LAUNCH, { cwd: join(cwd, "missing"), account: "1", session: SID })).toThrow("папки сессии нет");
    expect(() => launchCommand(LAUNCH, { cwd: `${cwd}&calc`, account: "1", session: SID })).toThrow("опасные для cmd.exe");
    expect(launchCommand(LAUNCH, { cwd, account: "me@mail.com", session: SID })[5]).toContain("run me@mail.com --");
  });

  test("expands an embedded and exact mode placeholder and drops an empty exact argument", () => {
    const cwd = tempDir();
    const launch = { command: ["cswap.exe run {account} -- --resume {session} {mode}", "{mode}"], timeoutSec: 90 };
    expect(launchCommand(launch, { cwd, account: "2", session: SID, mode: "acceptEdits" })).toEqual([
      `cswap.exe run 2 -- --resume ${SID} --permission-mode acceptEdits`,
      "--permission-mode",
      "acceptEdits",
    ]);
    expect(launchCommand({ ...launch, command: ["{mode}"] }, { cwd, account: "2", session: SID })).toEqual([]);
    expect(launchCommand({ ...launch, command: ["{mode}{mode}"] }, { cwd, account: "2", session: SID })).toEqual([]);
    expect(launchCommand({ ...launch, command: ["run {mode}"] }, { cwd, account: "2", session: SID })).toEqual(["run "]);
  });

  test("rejects modes outside the strict allowlist", () => {
    expect(() => launchCommand(LAUNCH, { cwd: tempDir(), account: "2", session: SID, mode: "bypassPermissions" })).toThrow(LaunchError);
  });

  test("refuses a mode when the launch config lost its placeholder", () => {
    expect(() => launchCommand(LAUNCH, { cwd: tempDir(), account: "2", session: SID, mode: "plan" })).toThrow("{mode}");
  });
});

describe("transcriptMode", () => {
  test("reads the last mode, maps default to manual, and honors the launch offset", () => {
    const path = join(tempDir(), "transcript.jsonl");
    const old = `${JSON.stringify({ type: "permission-mode", permissionMode: "plan" })}\n`;
    const next = `${JSON.stringify({ type: "permission-mode", permissionMode: "default" })}\n`;
    writeFileSync(path, `${old}${next}`);
    expect(transcriptMode(path)).toBe("manual");
    expect(transcriptMode(path, Buffer.byteLength(old))).toBe("manual");
    expect(transcriptMode(path, Buffer.byteLength(old + next))).toBeUndefined();
  });

  test("returns unknown when the transcript has no mode record", () => {
    const path = join(tempDir(), "empty.jsonl");
    writeFileSync(path, `${JSON.stringify({ type: "user", message: "hello" })}\n`);
    expect(transcriptMode(path)).toBeUndefined();
  });

  test("finds the last mode in a transcript longer than the tail read, skipping the line the cut lands in", () => {
    const path = join(tempDir(), "long.jsonl");
    const filler = `${JSON.stringify({ type: "user", message: "x".repeat(TAIL_READ_BYTES / 4) })}\n`;
    const plan = `${JSON.stringify({ type: "permission-mode", permissionMode: "plan" })}\n`;
    const accept = `${JSON.stringify({ type: "permission-mode", permissionMode: "acceptEdits" })}\n`;
    writeFileSync(path, `${plan}${filler.repeat(8)}${accept}${filler.repeat(3)}`);
    expect(transcriptMode(path)).toBe("acceptEdits");
    writeFileSync(path, `${plan}${filler.repeat(8)}`);
    expect(transcriptMode(path)).toBe("plan");
  });

  test("reads a record split across a byte block boundary and guards a shrunken offset", () => {
    const path = join(tempDir(), "split.jsonl");
    const record = `${JSON.stringify({ type: "permission-mode", permissionMode: "plan", note: "я".repeat(TAIL_READ_BYTES) })}\n`;
    writeFileSync(path, record);
    expect(transcriptMode(path)).toBe("plan");
    expect(transcriptMode(path, Buffer.byteLength(record) + 1)).toBeUndefined();
  });
});

describe("sessionCwd", () => {
  test("is read from the session's transcript in any project dir", () => {
    const projects = tempDir();
    mkdirSync(join(projects, "C--a"), { recursive: true });
    mkdirSync(join(projects, "C--b"), { recursive: true });
    const lines = [{ type: "ai-title", aiTitle: "x" }, { type: "user", cwd: "C:\\b" }].map(o => JSON.stringify(o)).join("\n");
    writeFileSync(join(projects, "C--b", `${SID}.jsonl`), `${lines}\n`);
    expect(sessionCwd(SID, projects)).toBe("C:\\b");
    expect(sessionCwd("22222222-2222-3333-4444-555555555555", projects)).toBeUndefined();
    expect(sessionCwd(SID, join(projects, "none"))).toBeUndefined();
  });
});
