import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { launchCommand, LaunchError, sessionCwd } from "../src/hub/launch.ts";
import { tempDir } from "./helpers.ts";

const SID = "11111111-2222-3333-4444-555555555555";
const LAUNCH = {
  command: ["wt.exe", "-d", "{cwd}", "cmd.exe", "/c", "cswap.exe run {account} -- --resume {session} & exit /b 0"],
  timeoutSec: 90,
};

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
