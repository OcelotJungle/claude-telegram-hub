import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isTmuxCommand, launchCommand, LaunchError, LaunchExitError, sessionCwd, spawnDetached, tmuxAttachHint, tmuxSession, transcriptMode } from "../src/hub/launch.ts";
import { en } from "../src/shared/i18n/en.ts";
import { platformFor } from "../src/shared/platform.ts";
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
    expect(() => launchCommand(LAUNCH, { cwd: join(cwd, "missing"), account: "1", session: SID })).toThrow(en.launchNoDirectory({ cwd: join(cwd, "missing") }));
    expect(() => launchCommand({ ...LAUNCH, command: ["cmd.exe", "/c", "claude --resume {session}"] }, { cwd: `${cwd}&calc`, account: "1", session: SID }, platformFor("win32"))).toThrow(en.launchUnsafeCwd({ cwd: `${cwd}&calc` }));
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

  test("tmux passes separate arguments, mode and a shell metacharacter in the folder", () => {
    const cwd = join(tempDir(), "a&b");
    mkdirSync(cwd);
    const launch = { command: ["tmux", "new-session", "-d", "-s", "claude-{session}", "-c", "{cwd}", "--", "claude", "--resume", "{session}", "{mode}"], timeoutSec: 90 };
    expect(launchCommand(launch, { cwd, account: "", session: SID, mode: "plan" }, platformFor("linux"))).toEqual([
      "tmux", "new-session", "-d", "-s", `claude-${SID}`, "-c", cwd, "--", "claude", "--resume", SID, "--permission-mode", "plan",
    ]);
    for (const executable of ["cmd", "cmd.exe", "CMD.EXE", "C:\\Windows\\System32\\cmd.exe"]) {
      expect(() => launchCommand({ ...launch, command: [executable, "/c", "claude"] }, { cwd, account: "", session: SID }, platformFor("win32"))).toThrow(en.launchUnsafeCwd({ cwd }));
    }
  });

  test("on Windows cmd.exe checks always apply, because cmd can sit inside the template", () => {
    const cwd = join(tempDir(), "a&b");
    mkdirSync(cwd);
    // wt.exe starts cmd.exe itself: the executable is not cmd, the folder still reaches cmd.
    expect(() => launchCommand(LAUNCH, { cwd, account: "1", session: SID }, platformFor("win32"))).toThrow(en.launchUnsafeCwd({ cwd }));
    const tmux = { command: ["tmux", "new-session", "-d", "-c", "{cwd}"], timeoutSec: 90 };
    expect(() => launchCommand(tmux, { cwd, account: "", session: SID }, platformFor("win32"))).toThrow(en.launchUnsafeCwd({ cwd }));
  });

  test("on Linux there is no shell, so cmd.exe characters in the folder are plain text", () => {
    const cwd = join(tempDir(), "a&b%c");
    mkdirSync(cwd);
    const linux = platformFor("linux");
    expect(launchCommand({ command: ["cmd", "/c", "claude"], timeoutSec: 90 }, { cwd, account: "", session: SID }, linux)).toEqual(["cmd", "/c", "claude"]);
    expect(launchCommand({ command: ["tmux", "-c", "{cwd}"], timeoutSec: 90 }, { cwd, account: "", session: SID }, linux)).toEqual(["tmux", "-c", cwd]);
    // Session id, account, mode and folder existence stay checked everywhere.
    expect(() => launchCommand(LAUNCH, { cwd, account: "1 & calc", session: SID }, linux)).toThrow(LaunchError);
    expect(() => launchCommand(LAUNCH, { cwd: join(cwd, "missing"), account: "1", session: SID }, linux)).toThrow(en.launchNoDirectory({ cwd: join(cwd, "missing") }));
  });

  test("rejects modes outside the strict allowlist", () => {
    expect(() => launchCommand(LAUNCH, { cwd: tempDir(), account: "2", session: SID, mode: "bypassPermissions" })).toThrow(LaunchError);
  });

  test("refuses a mode when the launch config lost its placeholder", () => {
    expect(() => launchCommand(LAUNCH, { cwd: tempDir(), account: "2", session: SID, mode: "plan" })).toThrow("{mode}");
  });
});

describe("spawnDetached", () => {
  const BUN = process.execPath;
  const NEVER_FIRES = { graceMs: 0, setTimer: () => setTimeout(() => {}, 0), clearTimer: () => {} };
  const leftovers = () => readdirSync(tmpdir()).filter(name => name.startsWith("hub-launch-"));

  test("a command that exits at once with a non-zero code is a failed launch with its stderr", async () => {
    const before = leftovers();
    const failure = await spawnDetached([BUN, "-e", "console.error('duplicate session: claude-x'); process.exit(1)"], NEVER_FIRES).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(LaunchExitError);
    if (!(failure instanceof LaunchExitError)) return;
    expect(failure.code).toBe(1);
    expect(failure.stderr).toBe("duplicate session: claude-x");
    expect(failure.message).toBe(en.launchExited({ code: 1, stderr: "duplicate session: claude-x" }));
    expect(leftovers()).toEqual(before);
  });

  test("a command that exits at once with code 0 is a launch", async () => {
    await spawnDetached([BUN, "-e", "process.exit(0)"], NEVER_FIRES);
  });

  test("a command that cannot be found is a failed launch", async () => {
    const before = leftovers();
    await expect((async () => spawnDetached(["hub-launch-no-such-command"], NEVER_FIRES))()).rejects.toThrow("hub-launch-no-such-command");
    expect(leftovers()).toEqual(before);
  });

  test("a command still running when the grace time ends is a launch, not waited for", async () => {
    const dir = tempDir();
    const alive = join(dir, "alive");
    writeFileSync(alive, "");
    const timers: (() => void)[] = [];
    const grace = { graceMs: 1, setTimer: (fn: () => void) => { timers.push(fn); return setTimeout(() => {}, 0); }, clearTimer: () => {} };
    const poll = `const fs = require('fs'); setInterval(() => { if (!fs.existsSync(${JSON.stringify(alive)})) process.exit(0); }, 20);`;
    try {
      let settled = false;
      const launched = spawnDetached([BUN, "-e", poll], grace).then(() => { settled = true; });
      for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      timers[0]?.();
      await launched;
      expect(settled).toBe(true);
    } finally {
      rmSync(alive, { force: true });
    }
  });
});

describe("tmux launch commands", () => {
  test("a tmux command is recognised and names its session", () => {
    const command = ["tmux", "new-session", "-d", "-s", `claude-${SID}`, "--", "claude"];
    expect(isTmuxCommand(command)).toBe(true);
    expect(isTmuxCommand(["/usr/bin/tmux", "new-session"])).toBe(true);
    expect(isTmuxCommand(LAUNCH.command)).toBe(false);
    expect(tmuxSession(command)).toBe(`claude-${SID}`);
    expect(tmuxSession(["tmux", "new-session", "-d"])).toBeUndefined();
    expect(tmuxAttachHint(command, en)).toBe(`tmux attach -t claude-${SID}`);
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
    // A Cyrillic letter is a two-byte UTF-8 character, so the block boundary can split it.
    const record = `${JSON.stringify({ type: "permission-mode", permissionMode: "plan", note: "\u044f".repeat(TAIL_READ_BYTES) })}\n`;
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
