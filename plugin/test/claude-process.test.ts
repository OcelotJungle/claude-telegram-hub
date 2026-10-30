import { describe, expect, test } from "bun:test";
import { findClaudePid, linuxProcessInfo, processInfoFor, windowsProcessInfo } from "../src/plugin/claude-process.ts";

const TREE: Record<number, { name: string; parent: number }> = {
  30: { name: "bun.exe", parent: 20 },
  20: { name: "bun.exe", parent: 10 },
  10: { name: "claude.exe", parent: 5 },
  5: { name: "python.exe", parent: 1 },
  7: { name: "claude.exe", parent: 1 },
  8: { name: "notepad.exe", parent: 1 },
};
const info = (pid: number) => TREE[pid];

describe("findClaudePid", () => {
  test("walks up to claude.exe", () => {
    expect(findClaudePid(30, info)).toBe(10);
  });

  test("CLAUDE_PID wins when it is a claude.exe", () => {
    expect(findClaudePid(30, info, "7")).toBe(7);
    expect(findClaudePid(30, info, "8")).toBe(10);
    expect(findClaudePid(30, info, "junk")).toBe(10);
  });

  test("no claude.exe up the chain gives nothing", () => {
    expect(findClaudePid(5, info)).toBeUndefined();
    expect(findClaudePid(99, info)).toBeUndefined();
  });
});

test("Linux and other platforms read /proc, only win32 asks PowerShell", () => {
  expect(processInfoFor("win32")).toBe(windowsProcessInfo);
  expect(processInfoFor("linux")).toBe(linuxProcessInfo);
  expect(processInfoFor("darwin")).toBe(linuxProcessInfo);
});

test("platform process lookup tells the name and parent of this process", () => {
  const me = (process.platform === "win32" ? windowsProcessInfo : linuxProcessInfo)(process.pid);
  expect(me?.name).toMatch(/^bun/i);
  expect(me?.parent).toBe(process.ppid);
}, 15_000);

describe("Linux parent-chain fixtures", () => {
  const files: Record<string, string> = {
    "/proc/30/stat": "30 (bun) S 20 0 0",
    "/proc/30/cmdline": "bun\0plugin.ts\0",
    "/proc/20/stat": "20 (node) S 10 0 0",
    "/proc/20/cmdline": "node\0/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js\0--resume\0",
    "/proc/10/stat": "10 (claude) S 1 0 0",
    "/proc/10/cmdline": "/home/user/.local/bin/claude\0",
    "/proc/5/stat": "5 (a (name)) S 1 0 0",
  };
  const info = (pid: number) => linuxProcessInfo(pid, path => files[path]);

  test("finds node Claude and native Claude", () => {
    expect(findClaudePid(30, info)).toBe(20);
    expect(findClaudePid(10, info)).toBe(10);
    expect(findClaudePid(30, info, "10")).toBe(10);
    expect(info(5)).toEqual({ name: "a (name)", parent: 1, argv: [] });
  });

  test("rejects unrelated node processes, missing records and parent cycles", () => {
    expect(findClaudePid(20, pid => pid === 20 ? { name: "node", parent: 20, argv: ["node", "/app/server.js"] } : undefined)).toBeUndefined();
    expect(linuxProcessInfo(99, path => files[path])).toBeUndefined();
    expect(linuxProcessInfo(5, () => "malformed")).toBeUndefined();
  });
});
