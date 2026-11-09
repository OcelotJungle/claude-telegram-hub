import type { RigOutput } from "../src/hub/rig.ts";

import { describe, expect, test } from "bun:test";
import { findRig, Rig, rigAction, rigErrorText, rigInvocation, RIG_QUERY_LIMIT_MS, statusSchema, statusText } from "../src/hub/rig.ts";
import { en } from "../src/shared/i18n/en.ts";
import { platformFor } from "../src/shared/platform.ts";
import { manualClock } from "./manual-clock.ts";

const FEATURES = [{ name: "pwsh", description: "PowerShell", enabled: true, platformAllowed: true }];

function fixture(platform = "win32", found = true) {
  let output: RigOutput = { code: 0, stdout: JSON.stringify(FEATURES), stderr: "" };
  const warnings: string[] = [];
  const calls: string[][] = [];
  const clock = manualClock();
  const rig = new Rig({ find: () => found ? "rig-file" : undefined, platform: platformFor(platform), messages: () => en,
    run: async invocation => { calls.push(invocation.argv); return output; }, warn: text => { warnings.push(text); },
    setTimer: clock.set, clearTimer: clock.clear });
  return { rig, warnings, calls, clock, output: (next: RigOutput) => { output = next; }, found: (next: boolean) => { found = next; } };
}

const STATUS = { schemaVersion: 1, mode: "server", versions: { rig: "r", hub: "h" }, releases: { rig: "1.0.0", hub: null }, features: [], lastUpdate: null, pendingHubRestart: null, errors: [] };

describe("rig contract", () => {
  test("missing rig preserves Windows shells, but Linux shells stay unavailable", async () => {
    const f = fixture("win32", false);
    expect((await f.rig.refresh()).ok).toBe(false);
    expect(f.rig.unavailable("pwsh")).toBeUndefined();
    expect(f.calls).toEqual([]);
    expect(fixture("linux", false).rig.unavailable("cmd")).toBe(en.commandUnavailable({ name: "cmd" }));
  });

  test("startup errors close shells, successful JSON opens them and runtime failure retains it", async () => {
    const f = fixture();
    expect(f.rig.unavailable("pwsh")).toBe(en.rigFeaturesLoading);
    f.output({ code: 1, stdout: "", stderr: "broken" });
    await f.rig.refresh();
    expect(f.rig.unavailable("pwsh")).toContain("broken");
    f.output({ code: 0, stdout: JSON.stringify(FEATURES), stderr: "" });
    await f.rig.refresh();
    expect(f.rig.unavailable("pwsh")).toBeUndefined();
    f.output({ code: 1, stdout: "", stderr: "later" });
    await f.rig.refresh();
    expect(f.rig.unavailable("pwsh")).toBeUndefined();
    expect(f.warnings).toEqual(["rig: exit code 1: later"]);
  });

  test("feature JSON refuses missing or extra fields and non-JSON output", async () => {
    for (const stdout of ["not json", '[{"name":"cmd"}]', JSON.stringify(FEATURES.map(feature => ({ ...feature, extra: true })))]) {
      const f = fixture();
      f.output({ code: 0, stdout, stderr: "" });
      expect((await f.rig.refresh()).ok).toBe(false);
      expect(f.rig.unavailable("cmd")).toContain("rig:");
    }
  });

  test("both flags are required for a shell", async () => {
    for (const flags of [{ enabled: false, platformAllowed: true }, { enabled: true, platformAllowed: false }]) {
      const f = fixture();
      f.output({ code: 0, stdout: JSON.stringify([{ ...FEATURES[0], ...flags }]), stderr: "" });
      await f.rig.refresh();
      expect(f.rig.unavailable("pwsh")).toBe(en.commandDisabled({ name: "pwsh" }));
    }
  });

  test("missing rig restores the standalone state after it was previously found", async () => {
    const f = fixture();
    f.output({ code: 0, stdout: "[]", stderr: "" });
    await f.rig.refresh();
    expect(f.rig.unavailable("cmd")).toBe(en.commandDisabled({ name: "cmd" }));
    f.found(false);
    await f.rig.refresh();
    expect(f.rig.unavailable("cmd")).toBeUndefined();
  });

  test("Windows shim and PATH fallback have separate fixed command arguments", () => {
    const lookedUp: string[] = [];
    const file = findRig(platformFor("linux"), "/home/test", name => { lookedUp.push(name); return name.endsWith("/bin/rig") ? name : null; });
    expect(lookedUp).toEqual(["rig", "/home/test/.local/bin/rig"]);
    expect(file).toBe("/home/test/.local/bin/rig");
    expect(rigInvocation("/bin/rig", ["feature", "cmd", "enable"], platformFor("linux")).argv).toEqual(["/bin/rig", "feature", "cmd", "enable"]);
    expect(rigInvocation("C:\\rig tools\\rig.cmd", ["update"], platformFor("win32"))).toEqual({ argv: ["cmd.exe", "/d", "/s", "/c", '""C:\\rig tools\\rig.cmd" update"'], verbatim: true });
  });

  test("status shows a release next to its commit and the commit alone without a release", async () => {
    const f = fixture();
    f.output({ code: 0, stdout: JSON.stringify({ ...STATUS, versions: { rig: "r", hub: null } }), stderr: "" });
    const result = await f.rig.status();
    expect(result.ok).toBe(true);
    if (result.ok) expect(statusText(result.value, en).split("\n").slice(1, 3)).toEqual(["rig: 1.0.0 (r)", "hub: —"]);
    f.output({ code: 0, stdout: JSON.stringify(STATUS), stderr: "" });
    const bare = await f.rig.status();
    expect(bare.ok).toBe(true);
    if (bare.ok) expect(statusText(bare.value, en)).toContain("hub: h\n");
  });

  test("status keeps the saved restart state as the string the contract defines", async () => {
    const f = fixture();
    const pending = "2026-01-01T00:00:00Z:abc123";
    f.output({ code: 0, stdout: JSON.stringify({ ...STATUS, pendingHubRestart: pending }), stderr: "" });
    const result = await f.rig.status();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pendingHubRestart).toBe(pending);
      expect(statusText(result.value, en)).toContain(en.statusPendingRestart({ text: pending }));
    }
    f.output({ code: 0, stdout: JSON.stringify(STATUS), stderr: "" });
    expect((await f.rig.status()).ok).toBe(true);
    f.output({ code: 0, stdout: JSON.stringify({ ...STATUS, pendingHubRestart: { nested: true } }), stderr: "" });
    expect((await f.rig.status()).ok).toBe(false);
  });

  test("a rig JSON query that exceeds the limit fails and is cancelled", async () => {
    const f = fixture();
    let signal: AbortSignal | undefined;
    const hung = new Rig({ find: () => "rig-file", platform: platformFor("linux"), messages: () => en, warn: text => { f.warnings.push(text); },
      run: (_invocation, abort) => { signal = abort; return new Promise<RigOutput>(() => {}); }, setTimer: f.clock.set, clearTimer: f.clock.clear });
    let settled: string | undefined;
    void hung.status().then(result => { settled = result.ok ? "ok" : rigErrorText(result.error, en); });
    await f.clock.advance(RIG_QUERY_LIMIT_MS - 1);
    expect(settled).toBeUndefined();
    await f.clock.advance(1);
    expect(settled).toContain("30");
    expect(signal?.aborted).toBe(true);
    // A query that finished in time leaves no timer that could fire later.
    expect((await f.rig.refresh()).ok).toBe(true);
    await f.clock.advance(RIG_QUERY_LIMIT_MS * 2);
    expect(f.warnings).toEqual([]);
  });

  test("a rig path with a percent sign is refused on Windows, where cmd.exe would expand it", async () => {
    const run = async () => ({ code: 0, stdout: "[]", stderr: "" });
    const clock = manualClock();
    const make = (windows: string) => new Rig({ find: () => "C:\\100%\\rig.cmd", platform: platformFor(windows), messages: () => en, run, warn: () => {}, setTimer: clock.set, clearTimer: clock.clear });
    const refused = make("win32").invocation(["update"]);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(rigErrorText(refused.error, en)).toContain("%");
    expect(make("linux").invocation(["update"]).ok).toBe(true);
  });

  test("client text cannot become an executable, path, option or shell expression", () => {
    for (const args of ["../cmd enable", "cmd&calc enable", "--help enable", "cmd enable extra", "cmd ENABLE", "cmd%PATH% enable", '"cmd" enable', "cmd enable\nupdate"]) {
      expect(rigAction({ name: "rig", args: `feature ${args}` }, en).ok).toBe(false);
    }
    expect(rigAction({ name: "rig", args: "feature telegram disable" }, en)).toEqual({ ok: true, value: { kind: "mutate", args: ["feature", "telegram", "disable"], confirm: true } });
    expect(rigAction({ name: "rig", args: "status --json" }, en).ok).toBe(false);
    expect(statusSchema.safeParse({ schemaVersion: 2 }).success).toBe(false);
  });

  test("/rig feature lists the features; /rig feature <name> enable|disable mutates one of them", () => {
    expect(rigAction({ name: "rig", args: "feature" }, en)).toEqual({ ok: true, value: { kind: "features" } });
    expect(rigAction({ name: "rig", args: "feature cmd enable" }, en)).toEqual({ ok: true, value: { kind: "mutate", args: ["feature", "cmd", "enable"], confirm: false } });
    expect(rigAction({ name: "rig", args: "feature telegram disable" }, en)).toEqual({ ok: true, value: { kind: "mutate", args: ["feature", "telegram", "disable"], confirm: true } });
    expect(rigAction({ name: "rig", args: "feature cmd" }, en)).toEqual({ ok: false, error: en.rigFeatureUsage });
  });

  test("bad /rig arguments answer the usage that lists every form", () => {
    for (const args of ["", "bogus", "status now", "language xx"]) {
      expect(rigAction({ name: "rig", args }, en)).toEqual({ ok: false, error: en.rigUsage });
    }
    expect(en.rigUsage).toContain("/rig status");
    expect(en.rigUsage).toContain("/rig update");
    expect(en.rigUsage).toContain("/rig language [en|ru]");
    expect(en.rigUsage).toContain("/rig feature");
    expect(en.rigUsage).toContain("/rig feature <name> enable|disable");
  });
});
