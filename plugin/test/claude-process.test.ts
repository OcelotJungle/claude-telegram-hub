import { describe, expect, test } from "bun:test";
import { findClaudePid, windowsProcessInfo } from "../src/plugin/claude-process.ts";

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

test("windowsProcessInfo tells the name and parent of this process", () => {
  const me = windowsProcessInfo(process.pid);
  expect(me?.name).toMatch(/^bun/i);
  expect(me?.parent).toBe(process.ppid);
}, 15_000);
