import type { RigOutput } from "../src/hub/rig.ts";

import { describe, expect, test } from "bun:test";
import { findRig, Rig, rigAction, rigErrorText, rigInvocation, RIG_QUERY_LIMIT_MS, statusSchema, statusText } from "../src/hub/rig.ts";
import { en } from "../src/shared/i18n/en.ts";
import { platformFor } from "../src/shared/platform.ts";
import { bareInfo, blockError, commandFailure, fullInfo } from "./info-fixtures.ts";
import { manualClock } from "./manual-clock.ts";

const FEATURES = [{ name: "pwsh", description: "PowerShell", enabled: true, platformAllowed: true }];
const SESSION = "11111111-aaaa";
const FAILED_EXIT = 1;

// rig feature answers {"features": [...]}, not a bare list.
const featuresReply = (features: unknown[]): string => JSON.stringify({ features });

function fixture(platform = "win32", found = true) {
  let output: RigOutput = { code: 0, stdout: featuresReply(FEATURES), stderr: "" };
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
    f.output({ code: 0, stdout: featuresReply(FEATURES), stderr: "" });
    await f.rig.refresh();
    expect(f.rig.unavailable("pwsh")).toBeUndefined();
    f.output({ code: 1, stdout: "", stderr: "later" });
    await f.rig.refresh();
    expect(f.rig.unavailable("pwsh")).toBeUndefined();
    expect(f.warnings).toEqual(["rig: exit code 1: later"]);
  });

  test("feature JSON refuses missing or extra fields and non-JSON output", async () => {
    // The old bare array is not rig's answer any more: the features come under "features".
    const wrong = ["not json", JSON.stringify(FEATURES), featuresReply([{ name: "cmd" }]), featuresReply(FEATURES.map(feature => ({ ...feature, extra: true }))),
      JSON.stringify({ features: FEATURES, extra: true })];
    for (const stdout of wrong) {
      const f = fixture();
      f.output({ code: 0, stdout, stderr: "" });
      expect((await f.rig.refresh()).ok).toBe(false);
      expect(f.rig.unavailable("cmd")).toContain("rig:");
    }
  });

  test("both flags are required for a shell", async () => {
    for (const flags of [{ enabled: false, platformAllowed: true }, { enabled: true, platformAllowed: false }]) {
      const f = fixture();
      f.output({ code: 0, stdout: featuresReply([{ ...FEATURES[0], ...flags }]), stderr: "" });
      await f.rig.refresh();
      expect(f.rig.unavailable("pwsh")).toBe(en.commandDisabled({ name: "pwsh" }));
    }
  });

  test("missing rig restores the standalone state after it was previously found", async () => {
    const f = fixture();
    f.output({ code: 0, stdout: featuresReply([]), stderr: "" });
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
    const run = async () => ({ code: 0, stdout: featuresReply([]), stderr: "" });
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

  test("no query asks for --json: the commands answer JSON on their own", async () => {
    const f = fixture("linux");
    await f.rig.refresh();
    f.output({ code: 0, stdout: JSON.stringify(STATUS), stderr: "" });
    await f.rig.status();
    f.output({ code: 0, stdout: JSON.stringify({ language: "ru" }), stderr: "" });
    await f.rig.language();
    f.output({ code: 0, stdout: JSON.stringify(fullInfo()), stderr: "" });
    await f.rig.info(SESSION);
    expect(f.calls).toEqual([["rig-file", "feature"], ["rig-file", "status"], ["rig-file", "language"], ["rig-file", "info", "--session", SESSION]]);
  });

  test("a failing command's error object on stdout is rig's message, shown as it is", async () => {
    const f = fixture();
    f.output({ code: FAILED_EXIT, stdout: commandFailure("feature-unknown", "No such feature: nope"), stderr: "" });
    const status = await f.rig.status();
    expect(status).toEqual({ ok: false, error: { kind: "rig", code: "feature-unknown", message: "No such feature: nope" } });
    if (!status.ok) expect(rigErrorText(status.error, en)).toBe("No such feature: nope");
    // Without the error object the exit code and the stderr text are all there is.
    f.output({ code: FAILED_EXIT, stdout: "", stderr: "boom" });
    expect(await f.rig.status()).toEqual({ ok: false, error: { kind: "exitCode", code: FAILED_EXIT, output: "boom" } });
    // Progress JSON lines among the stderr text, or a stdout that is not an error object, never reach the user raw.
    const progressLine = JSON.stringify({ progress: { code: "lock-waiting" } });
    f.output({ code: FAILED_EXIT, stdout: JSON.stringify({ unexpected: true }), stderr: `${progressLine}\nTraceback: boom\n` });
    expect(await f.rig.status()).toEqual({ ok: false, error: { kind: "exitCode", code: FAILED_EXIT, output: "Traceback: boom" } });
    f.output({ code: FAILED_EXIT, stdout: JSON.stringify({ unexpected: true }), stderr: progressLine });
    expect(await f.rig.status()).toEqual({ ok: false, error: { kind: "exitCode", code: FAILED_EXIT, output: "" } });
    // A success exit code is never read as a failure, whatever stdout holds.
    f.output({ code: 0, stdout: commandFailure("x", "y"), stderr: "" });
    expect(await f.rig.status()).toMatchObject({ ok: false, error: { kind: "invalidJson" } });
  });

  test("a feature list refused by rig keeps the startup failure with rig's message", async () => {
    const f = fixture();
    f.output({ code: FAILED_EXIT, stdout: commandFailure("state-unreadable", "State file is broken"), stderr: "" });
    await f.rig.refresh();
    expect(f.rig.unavailable("pwsh")).toBe("State file is broken");
  });

  test("info returns the full data with its codex and volunteers blocks", async () => {
    const f = fixture();
    f.output({ code: 0, stdout: JSON.stringify(fullInfo()), stderr: "" });
    expect(await f.rig.info(SESSION)).toEqual({ ok: true, value: fullInfo() });
  });

  test("info without the codex and volunteers blocks leaves them absent, not empty", async () => {
    const f = fixture();
    f.output({ code: 0, stdout: JSON.stringify(bareInfo()), stderr: "" });
    const result = await f.rig.info(SESSION);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("codex" in result.value).toBe(false);
      expect("volunteers" in result.value).toBe(false);
    }
  });

  test("info keeps a block that is rig's error next to the healthy ones", async () => {
    const f = fixture();
    const data = { ...fullInfo(), codex: blockError("codex-no-rollout", "No Codex rollout"), volunteers: blockError("volunteers-script", "Script failed"), context: blockError("context-none", "No context yet") };
    f.output({ code: 0, stdout: JSON.stringify(data), stderr: "" });
    expect(await f.rig.info(SESSION)).toEqual({ ok: true, value: data });
  });

  test("info refuses an answer that is not InfoData, element by element", async () => {
    const f = fixture();
    const full = fullInfo();
    const broken = [
      {},
      { ...full, claude: { ...full.claude, limits: [{ kind: "five_hour" }] } },
      { ...full, context: { at: null, tokens: "many", window: null } },
      { ...full, codex: { at: null, limits: [{ windowMinutes: 300 }] } },
      { ...full, volunteers: { ...full.volunteers, providers: { alpha: { used: "x", cap: null } } } },
    ];
    for (const data of broken) {
      f.output({ code: 0, stdout: JSON.stringify(data), stderr: "" });
      expect(await f.rig.info(SESSION)).toMatchObject({ ok: false, error: { kind: "invalidJson" } });
    }
  });

  test("info fails with rig's message when the command fails with exit 1 and the error object", async () => {
    const f = fixture();
    f.output({ code: FAILED_EXIT, stdout: commandFailure("session-unknown", "No such session"), stderr: "" });
    const result = await f.rig.info(SESSION);
    expect(result).toEqual({ ok: false, error: { kind: "rig", code: "session-unknown", message: "No such session" } });
  });

  test("a session id that is not an id never reaches the command line", async () => {
    const f = fixture();
    for (const id of ["", "a b", "x&calc", "x\"y", "../x", "a%PATH%", "x".repeat(101)]) {
      const result = await f.rig.info(id);
      expect(result).toEqual({ ok: false, error: { kind: "badSession" } });
      if (!result.ok) expect(rigErrorText(result.error, en)).toBe(en.rigBadSession);
    }
    expect(f.calls).toEqual([]);
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
