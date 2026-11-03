import type { RigError, RigOutput } from "../src/hub/rig.ts";
import type { Language } from "../src/shared/i18n/index.ts";

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { Rig, rigAction, rigErrorText, RIG_QUERY_LIMIT_MS } from "../src/hub/rig.ts";
import { en } from "../src/shared/i18n/en.ts";
import { catalogOf, isLanguage } from "../src/shared/i18n/index.ts";
import { ru } from "../src/shared/i18n/ru.ts";
import { LANGUAGES } from "../src/shared/protocol.ts";
import { hubToPlugin } from "../src/shared/protocol-schema.ts";
import { platformFor } from "../src/shared/platform.ts";
import { manualClock } from "./manual-clock.ts";

function fixture(found = true) {
  let output: RigOutput = { code: 0, stdout: JSON.stringify({ language: "en" }), stderr: "" };
  const warnings: string[] = [];
  const calls: string[][] = [];
  const clock = manualClock();
  const rig = new Rig({ find: () => found ? "rig-file" : undefined, platform: platformFor("win32"),
    run: async invocation => { calls.push(invocation.argv); return output; }, warn: text => { warnings.push(text); },
    messages: () => catalogOf("en"), setTimer: clock.set, clearTimer: clock.clear });
  return { rig, warnings, calls, output: (next: RigOutput) => { output = next; } };
}

describe("rig language query", () => {
  test("asks rig language --json and returns what rig answers", async () => {
    const f = fixture();
    expect(await f.rig.language()).toBe("en");
    f.output({ code: 0, stdout: JSON.stringify({ language: "ru" }), stderr: "" });
    expect(await f.rig.language()).toBe("ru");
    expect(f.calls.map(argv => argv.join(" "))).toEqual([expect.stringContaining("language --json"), expect.stringContaining("language --json")]);
    expect(f.warnings).toEqual([]);
  });

  test("English with a warning when rig is missing", async () => {
    const f = fixture(false);
    expect(await f.rig.language()).toBe("en");
    expect(f.warnings).toHaveLength(1);
    expect(f.calls).toEqual([]);
  });

  test("English with a warning when rig fails", async () => {
    const f = fixture();
    f.output({ code: 1, stdout: "", stderr: "broken" });
    expect(await f.rig.language()).toBe("en");
    expect(f.warnings).toHaveLength(1);
    expect(f.warnings[0]).toContain("broken");
  });

  test("English with a warning on bad JSON, an unknown language or extra fields", async () => {
    for (const stdout of ["not json", "", JSON.stringify({ language: "de" }), JSON.stringify({ language: "ru", extra: true }), JSON.stringify({})]) {
      const f = fixture();
      f.output({ code: 0, stdout, stderr: "" });
      expect(await f.rig.language()).toBe("en");
      expect(f.warnings).toHaveLength(1);
    }
  });
});

// A rig whose catalog can be switched, to show that an error is rendered when it is displayed.
function switchable(run: (signal?: AbortSignal) => Promise<RigOutput>, windowsPath = "rig-file") {
  let language: Language = "en";
  const clock = manualClock();
  const warnings: string[] = [];
  const rig = new Rig({ find: () => windowsPath, platform: platformFor("win32"), run: (_invocation, signal) => run(signal), warn: text => { warnings.push(text); },
    messages: () => catalogOf(language), setTimer: clock.set, clearTimer: clock.clear });
  return { rig, clock, warnings, setLanguage: (next: Language) => { language = next; } };
}

describe("rig errors are data, rendered in the language shown", () => {
  test("a failed first refresh is shown in the language current when unavailable() is asked", async () => {
    const f = switchable(async () => ({ code: 1, stdout: "", stderr: "broken" }));
    await f.rig.refresh();
    expect(f.rig.unavailable("pwsh")).toContain("exit code 1");
    f.setLanguage("ru");
    const russian = f.rig.unavailable("pwsh");
    expect(russian).toContain("broken");
    expect(russian).not.toContain("exit code");
    expect(russian).toBe(rigErrorText({ kind: "exitCode", code: 1, output: "broken" }, ru));
  });

  test("every error kind has a distinct English and Russian text with its details", () => {
    const errors: RigError[] = [
      { kind: "percentPath", file: "C:\\100%\\rig.cmd" }, { kind: "timeout", seconds: 30 }, { kind: "exitCode", code: 7, output: "boom" },
      { kind: "invalidJson", message: "bad shape" }, { kind: "failure", message: "spawn failed" },
    ];
    for (const error of errors) {
      const english = rigErrorText(error, en);
      const russian = rigErrorText(error, ru);
      expect(russian).not.toBe(english);
      expect(english).toContain("rig");
      expect(russian).toContain("rig");
    }
    expect(rigErrorText({ kind: "timeout", seconds: 30 }, ru)).toContain("30");
    expect(rigErrorText({ kind: "exitCode", code: 7, output: "boom" }, ru)).toContain("7");
    expect(rigErrorText({ kind: "exitCode", code: 7, output: "boom" }, ru)).toContain("boom");
    expect(rigErrorText({ kind: "percentPath", file: "C:\\100%\\rig.cmd" }, ru)).toContain("C:\\100%\\rig.cmd");
    expect(rigErrorText({ kind: "invalidJson", message: "bad shape" }, ru)).toContain("bad shape");
    expect(rigErrorText({ kind: "missing" }, ru)).toBe(ru.rigMissing);
    expect(rigErrorText({ kind: "missing" }, en)).toBe(en.rigMissing);
  });

  test("the query results carry the kind, not text", async () => {
    const hung = switchable(() => new Promise<RigOutput>(() => {}));
    let settled: unknown;
    void hung.rig.status().then(result => { settled = result.ok ? "ok" : result.error; });
    await hung.clock.advance(RIG_QUERY_LIMIT_MS);
    expect(settled).toEqual({ kind: "timeout", seconds: RIG_QUERY_LIMIT_MS / 1000 });
    const failing = switchable(async () => ({ code: 3, stdout: "", stderr: "nope" }));
    const result = await failing.rig.status();
    expect(result.ok ? undefined : result.error).toEqual({ kind: "exitCode", code: 3, output: "nope" });
    const garbled = switchable(async () => ({ code: 0, stdout: "not json", stderr: "" }));
    const parsed = await garbled.rig.status();
    expect(parsed.ok ? undefined : parsed.error.kind).toBe("failure");
    const wrong = switchable(async () => ({ code: 0, stdout: "{}", stderr: "" }));
    const invalid = await wrong.rig.status();
    expect(invalid.ok ? undefined : invalid.error.kind).toBe("invalidJson");
    const percent = switchable(async () => ({ code: 0, stdout: "[]", stderr: "" }), "C:\\100%\\rig.cmd");
    const refused = percent.rig.invocation(["update"]);
    expect(refused.ok ? undefined : refused.error).toEqual({ kind: "percentPath", file: "C:\\100%\\rig.cmd" });
  });

  test("the warning log stays English whatever the language", async () => {
    const f = switchable(async () => ({ code: 1, stdout: "", stderr: "later" }));
    f.setLanguage("ru");
    await f.rig.refresh();
    await f.rig.refresh();
    expect(f.warnings).toEqual(["rig: exit code 1: later"]);
  });

  test("a timed-out language query falls back to English with a warning", async () => {
    const f = switchable(() => new Promise<RigOutput>(() => {}));
    let language: Language | undefined;
    void f.rig.language().then(value => { language = value; });
    await f.clock.advance(RIG_QUERY_LIMIT_MS - 1);
    expect(language).toBeUndefined();
    await f.clock.advance(1);
    expect(language).toBe("en");
    expect(f.warnings).toHaveLength(1);
    expect(f.warnings[0]).toContain("30");
  });
});

describe("one list of languages", () => {
  test("every listed language passes isLanguage, the protocol message and the rig query; others fail", async () => {
    for (const language of LANGUAGES) {
      expect(isLanguage(language)).toBe(true);
      expect(hubToPlugin.safeParse({ type: "language", language }).success).toBe(true);
      const f = fixture();
      f.output({ code: 0, stdout: JSON.stringify({ language }), stderr: "" });
      expect(await f.rig.language()).toBe(language);
      expect(f.warnings).toEqual([]);
    }
    for (const other of ["de", "", "EN"]) {
      expect(isLanguage(other)).toBe(false);
      expect(hubToPlugin.safeParse({ type: "language", language: other }).success).toBe(false);
    }
  });

  test("the list is written once in the source", () => {
    const written = /"en"\s*,\s*"ru"|"en"\s*\|\s*"ru"|=== "en"\s*\|\|/;
    const holders = ["hub/rig.ts", "shared/protocol-schema.ts", "shared/i18n/index.ts", "shared/protocol.ts"]
      .filter(file => written.test(readFileSync(join(import.meta.dir, "..", "src", file), "utf8")));
    expect(holders).toEqual(["shared/protocol.ts"]);
  });
});

describe("/rig language command", () => {
  const m = catalogOf("en");

  test("no argument shows the language, en and ru switch it, without confirmation", () => {
    expect(rigAction({ name: "rig", args: "language" }, m)).toEqual({ ok: true, value: { kind: "mutate", args: ["language"], confirm: false } });
    expect(rigAction({ name: "rig", args: "language en" }, m)).toEqual({ ok: true, value: { kind: "mutate", args: ["language", "en"], confirm: false } });
    expect(rigAction({ name: "rig", args: "language ru" }, m)).toEqual({ ok: true, value: { kind: "mutate", args: ["language", "ru"], confirm: false } });
  });

  test("any other argument gets the usage reply", () => {
    for (const args of ["language de", "language ru extra", "language --json", "languages"]) {
      expect(rigAction({ name: "rig", args }, m)).toEqual({ ok: false, error: m.rigUsage });
    }
  });
});
