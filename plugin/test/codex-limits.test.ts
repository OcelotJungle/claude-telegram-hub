import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { CodexLimits } from "../src/hub/codex-limits.ts";

const TIMESTAMP = "2026-01-01T12:00:00.000Z";
const RESET_SECONDS = 1767286800;
const OLDER_MTIME = new Date("2026-01-01T10:00:00Z");
const NEWER_MTIME = new Date("2026-01-01T11:00:00Z");
const LARGE_LINE_BYTES = 150_000;
const FILES_OVER_BOUND = 21;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codex-limits-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function event(percent = 41, id = "codex", timestamp = TIMESTAMP): string {
  return JSON.stringify({ timestamp, type: "event_msg", payload: { type: "token_count", rate_limits: {
    limit_id: id,
    primary: { used_percent: percent, window_minutes: 300, resets_at: RESET_SECONDS },
    secondary: { used_percent: 22, window_minutes: 10080 },
  } } });
}

async function rollout(name: string, contents: string, day = "02"): Promise<string> {
  const path = join(dir, "2026", "01", day, `rollout-${name}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  return path;
}

describe("Codex limits", () => {
  test("newest file by date and mtime wins and maps the windows", async () => {
    await rollout("previous-day", event(99), "01");
    const older = await rollout("older", event(10));
    const newer = await rollout("newer", `${event(15)}\n${event()}\n`);
    await utimes(older, OLDER_MTIME, OLDER_MTIME);
    await utimes(newer, NEWER_MTIME, NEWER_MTIME);
    expect(await new CodexLimits(dir).read()).toEqual({
      at: Date.parse(TIMESTAMP),
      rateLimits: [
        { kind: "five_hour", percentUsed: 41, resetsAt: new Date(RESET_SECONDS * 1000).toISOString() },
        { kind: "seven_day", percentUsed: 22 },
      ],
    });
  });

  test("falls back to an older file; premium, null and invalid events are ignored", async () => {
    await rollout("older", event(), "01");
    await rollout("newer", [event(99, "premium"), JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: null } }), "{broken", event().replace('"used_percent":41', '"used_percent":"41"')].join("\n"));
    expect((await new CodexLimits(dir).read())?.rateLimits[0]?.percentUsed).toBe(41);
  });

  test("missing directory and no Codex data return undefined", async () => {
    expect(await new CodexLimits(join(dir, "missing")).read()).toBeUndefined();
    await rollout("premium", event(99, "premium"));
    expect(await new CodexLimits(dir).read()).toBeUndefined();
  });

  test("reads before a large tail, tolerates partial lines, and invalidates cached files on append", async () => {
    const path = await rollout("large", `${event()}\n${JSON.stringify({ text: "я".repeat(LARGE_LINE_BYTES) })}\n{partial`);
    const reader = new CodexLimits(dir);
    expect((await reader.read())?.rateLimits[0]?.percentUsed).toBe(41);
    expect((await reader.read())?.rateLimits[0]?.percentUsed).toBe(41);
    await appendFile(path, `\n${event(52)}\n`);
    expect((await reader.read())?.rateLimits[0]?.percentUsed).toBe(52);
  });

  test("a cached empty file is reconsidered when it grows", async () => {
    const path = await rollout("empty", event(99, "premium"));
    const reader = new CodexLimits(dir);
    expect(await reader.read()).toBeUndefined();
    await appendFile(path, `\n${event()}`);
    expect((await reader.read())?.rateLimits[0]?.percentUsed).toBe(41);
  });

  test("file search is bounded", async () => {
    for (let index = 0; index < FILES_OVER_BOUND; index++) {
      const path = await rollout(String(index), index === 0 ? event() : event(99, "premium"));
      const mtime = new Date(OLDER_MTIME.getTime() + index * 1000);
      await utimes(path, mtime, mtime);
    }
    expect(await new CodexLimits(dir).read()).toBeUndefined();
  });
});
