import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { VolunteerLimits } from "../src/hub/volunteer-limits.ts";

const CHECKED_AT = "2026-01-01T08:19:04Z";
const RESET_IN_S = 56455;

function scriptOutput(overrides: Partial<{
  source: "proxy" | "quota-file" | "none";
  day_percent: number | null;
  used: number | null;
  cap: number | null;
  reset_in_s: number | null;
  providers: Record<string, { used: number; cap: number | null }> | null;
  error: string | null;
}> = {}): string {
  const base = {
    checked_at: CHECKED_AT,
    source: "proxy",
    day_percent: 6,
    used: 240,
    cap: 4200,
    reset_in_s: RESET_IN_S,
    providers: {
      openrouter: { used: 39, cap: 1000 },
      requesty: { used: 7, cap: 200 },
      groq: { used: 194, cap: 3000 },
      zhipu: { used: 4, cap: null },
    },
    error: null,
    ...overrides,
  };
  return JSON.stringify(base).replace(/null/g, "None");
}

let scriptDir: string;
let scriptPath: string;

beforeEach(async () => {
  scriptDir = await mkdtemp(join(tmpdir(), "volunteer-limits-"));
  scriptPath = join(scriptDir, "volunteer-models.py");
  await writeFile(scriptPath, "#!/usr/bin/env python3\nprint('test')");
});

afterEach(async () => {
  await rm(scriptDir, { recursive: true, force: true });
});

async function writeScript(content: string): Promise<void> {
  await writeFile(scriptPath, content);
}

describe("VolunteerLimits", () => {
  test("ok: parses script output and maps providers", async () => {
    await writeScript(`#!/usr/bin/env python3
import sys, json
print(json.dumps(${scriptOutput()}))
`);
    const reader = new VolunteerLimits(scriptPath, ["python", "-I"], 5000);
    const result = await reader.read();
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.at).toBe(Date.parse(CHECKED_AT));
      expect(result.dayPercent).toBe(6);
      expect(result.resetsAt).toBe(Date.parse(CHECKED_AT) + RESET_IN_S * 1000);
      expect(result.providers).toEqual([
        { name: "OpenRouter", used: 39, cap: 1000 },
        { name: "Requesty", used: 7, cap: 200 },
        { name: "Groq", used: 194, cap: 3000 },
        { name: "Z.ai", used: 4, cap: null },
      ]);
    }
  });

  test("ok: unknown provider key uses key as name", async () => {
    await writeScript(`#!/usr/bin/env python3
import sys, json
print(json.dumps(${scriptOutput({ providers: { unknown: { used: 10, cap: 100 } } })}))
`);
    const reader = new VolunteerLimits(scriptPath, ["python", "-I"], 5000);
    const result = await reader.read();
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.providers).toEqual([{ name: "unknown", used: 10, cap: 100 }]);
    }
  });

  test("source none: returns error with error text", async () => {
    await writeScript(`#!/usr/bin/env python3
import sys, json
print(json.dumps(${scriptOutput({ source: "none", day_percent: null, used: null, cap: null, reset_in_s: null, providers: null, error: "no proxy configured" })}))
`);
    const reader = new VolunteerLimits(scriptPath, ["python", "-I"], 5000);
    const result = await reader.read();
    expect(result).toEqual({ kind: "error", reason: "no proxy configured" });
  });

  test("source none with null error: returns error with default message", async () => {
    await writeScript(`#!/usr/bin/env python3
import sys, json
print(json.dumps(${scriptOutput({ source: "none", day_percent: null, used: null, cap: null, reset_in_s: null, providers: null, error: null })}))
`);
    const reader = new VolunteerLimits(scriptPath, ["python", "-I"], 5000);
    const result = await reader.read();
    expect(result).toEqual({ kind: "error", reason: "no data source" });
  });

  test("bad JSON: returns error", async () => {
    await writeScript(`#!/usr/bin/env python3
print("not json")
`);
    const reader = new VolunteerLimits(scriptPath, ["python", "-I"], 5000);
    const result = await reader.read();
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toContain("JSON");
    }
  });

  test("missing script file: returns none", async () => {
    const reader = new VolunteerLimits(join(scriptDir, "missing.py"), ["python", "-I"], 5000);
    const result = await reader.read();
    expect(result).toEqual({ kind: "none" });
  });

  test("script crash (non-zero exit): returns error", async () => {
    await writeScript(`#!/usr/bin/env python3
import sys
sys.exit(1)
`);
    const reader = new VolunteerLimits(scriptPath, ["python", "-I"], 5000);
    const result = await reader.read();
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toContain("script exited with code 1");
    }
  });

  test("timeout: returns error", async () => {
    await writeScript(`#!/usr/bin/env python3
import time
time.sleep(10)
`);
    const reader = new VolunteerLimits(scriptPath, ["python", "-I"], 50);
    const result = await reader.read();
    expect(result).toEqual({ kind: "error", reason: "timeout" });
  });

  test("injectable command and timeout for tests", async () => {
    await writeScript(`#!/usr/bin/env python3
import sys, json
print(json.dumps(${scriptOutput()}))
`);
    const reader = new VolunteerLimits(scriptPath, ["python", "-I"], 5000);
    const result = await reader.read();
    expect(result.kind).toBe("ok");
  });
});
