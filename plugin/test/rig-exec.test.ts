import type { RigInvocation, RigOutput } from "../src/hub/rig.ts";

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import { cwdArg, execStatusSchema, isGone, RigExec } from "../src/hub/rig-exec.ts";
import { Rig, runRig } from "../src/hub/rig.ts";
import { en } from "../src/shared/i18n/en.ts";
import { platformFor } from "../src/shared/platform.ts";
import { manualClock } from "./manual-clock.ts";
import { tempDir } from "./helpers.ts";

const FAILED_EXIT = 1;
const STDIN_BYTES = 4 * 1024 * 1024;
const EARLY_EXIT_CODE = 3;

// What rig 0.7.1 printed for `rig exec start`, `status` and `stop` (recorded from a real run).
const START_JSON = '{"id":"3f9c2a1e-6b7d-4c58-9a10-2d5e8b7f4a01","shell":"cmd","cwd":"C:\\\\proj","pid":4242,"startedAt":"2026-11-15T10:00:00.000Z"}';
const START_RIG_JSON = '{"id":"7d1e5c90-2b44-4f0a-8e63-91a7c0d3b5f2","shell":"rig","args":["update"],"pid":5151,"startedAt":"2026-11-15T10:00:01.000Z"}';
const STATUS_RUNNING_JSON = '{"id":"3f9c2a1e","shell":"cmd","startedAt":"2026-11-15T10:00:00.000Z","state":"running","log":{"from":0,"to":6,"size":6,"text":"hello\\n"}}';
const STATUS_ENDED_JSON = '{"id":"7d1e5c90","shell":"rig","startedAt":"2026-11-15T10:00:01.000Z","state":"ended","end":{"kind":"exit","code":0,"at":"2026-11-15T10:00:09.000Z"},"result":{"mode":"server","outcome":"complete"},"log":{"from":6,"to":6,"size":6,"text":""}}';
const STATUS_NO_RESULT_JSON = '{"id":"7d1e5c90","shell":"rig","startedAt":"2026-11-15T10:00:01.000Z","state":"ended","end":{"kind":"exit","code":1,"reason":"empty-result","at":"2026-11-15T10:00:09.000Z"},"log":{"from":0,"to":0,"size":0,"text":""}}';
const STATUS_STOPPED_JSON = '{"id":"3f9c2a1e","shell":"cmd","startedAt":"2026-11-15T10:00:00.000Z","state":"ended","end":{"kind":"stopped","code":null,"at":"2026-11-15T10:00:05.000Z"},"log":{"from":6,"to":6,"size":6,"text":""}}';
const STATUS_LOST_JSON = '{"id":"3f9c2a1e","shell":"cmd","startedAt":"2026-11-15T10:00:00.000Z","state":"ended","end":{"kind":"lost","at":"2026-11-15T10:00:05.000Z","reason":"process-gone"},"log":{"from":0,"to":0,"size":0,"text":""}}';
const STOP_JSON = '{"id":"3f9c2a1e","stopping":true}';
const STOP_ENDED_JSON = '{"id":"3f9c2a1e","state":"ended"}';
const UNAVAILABLE_JSON = '{"error":{"code":"exec-unavailable","message":"The pwsh feature is off; run: rig feature pwsh enable"}}';
const UNKNOWN_JSON = '{"error":{"code":"exec-unknown","message":"No run 3f9c2a1e"}}';

type Call = { argv: string[]; stdin?: string };

// A rig client over a Rig whose process is a script: it records every invocation and answers from `answer`.
function client(answer: (call: Call) => RigOutput, platform = "linux") {
  const calls: Call[] = [];
  const clock = manualClock();
  const run = async (invocation: RigInvocation): Promise<RigOutput> => {
    const call: Call = { argv: invocation.argv, stdin: invocation.stdin };
    calls.push(call);
    return answer(call);
  };
  const p = platformFor(platform);
  const rig = new Rig({ find: () => "rig-file", platform: p, messages: () => en, run, warn: () => {}, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  return { exec: new RigExec(rig, p.windows), calls, clock };
}

const ok = (stdout: string): RigOutput => ({ code: 0, stdout, stderr: "" });
const failed = (stdout: string): RigOutput => ({ code: FAILED_EXIT, stdout, stderr: "" });

describe("cwdArg", () => {
  test("a folder is passed as it is off Windows", () => {
    expect(cwdArg("/home/me/my project", false)).toEqual({ ok: true, arg: "/home/me/my project" });
  });

  test("a plain Windows folder is bare, one with a space is quoted", () => {
    expect(cwdArg("C:\\proj\\sub-1", true)).toEqual({ ok: true, arg: "C:\\proj\\sub-1" });
    expect(cwdArg("C:\\my proj", true)).toEqual({ ok: true, arg: "\"C:\\my proj\"" });
    expect(cwdArg("C:\\proj&calc", true)).toEqual({ ok: true, arg: "\"C:\\proj&calc\"" });
  });

  test("a folder cmd.exe would read as something else is refused", () => {
    for (const cwd of ["C:\\100%", "C:\\a\"b", "C:\\a\nb", "C:\\a\rb"]) expect(cwdArg(cwd, true)).toEqual({ ok: false });
  });
});

describe("the rig exec client", () => {
  test("starts a shell with the folder as an argument and the text on stdin, never on the command line", async () => {
    const t = client(() => ok(START_JSON));
    const text = "echo \"a b\" && dir | findstr 100%\nline two";
    const result = await t.exec.start("cmd", "C:\\my proj", text);
    expect(result).toEqual({ ok: true, value: { id: "3f9c2a1e-6b7d-4c58-9a10-2d5e8b7f4a01", shell: "cmd", pid: 4242, startedAt: "2026-11-15T10:00:00.000Z" } });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.stdin).toBe(text);
    expect(t.calls[0]?.argv.join(" ")).toContain("exec start cmd --cwd");
    expect(t.calls[0]?.argv.join(" ")).not.toContain("findstr");
  });

  test("quotes a folder with a space on Windows, where rig runs through cmd.exe", async () => {
    const t = client(() => ok(START_JSON), "win32");
    await t.exec.start("cmd", "C:\\my proj", "dir");
    expect(t.calls[0]?.argv.at(-1)).toContain("exec start cmd --cwd \"C:\\my proj\"");
  });

  test("refuses a folder a Windows command line cannot carry, without calling rig", async () => {
    const t = client(() => ok(START_JSON), "win32");
    expect(await t.exec.start("cmd", "C:\\100%", "dir")).toEqual({ ok: false, error: { kind: "cwdUnsafe" } });
    expect(t.calls).toEqual([]);
  });

  test("starts a rig command with its arguments after --, no stdin", async () => {
    const t = client(() => ok(START_RIG_JSON));
    const result = await t.exec.startRig(["feature", "pwsh", "enable"]);
    expect(result.ok && result.value.shell).toBe("rig");
    expect(t.calls[0]?.argv).toEqual(["rig-file", "exec", "start", "rig", "--", "feature", "pwsh", "enable"]);
    expect(t.calls[0]?.stdin).toBeUndefined();
  });

  test("reads a status from an offset", async () => {
    const t = client(() => ok(STATUS_RUNNING_JSON));
    const result = await t.exec.status("3f9c2a1e", 12);
    expect(t.calls[0]?.argv).toEqual(["rig-file", "exec", "status", "3f9c2a1e", "--from", "12"]);
    expect(result).toEqual({ ok: true, value: { id: "3f9c2a1e", shell: "cmd", startedAt: "2026-11-15T10:00:00.000Z", state: "running", log: { from: 0, to: 6, size: 6, text: "hello\n" } } });
  });

  test("a rig run's status carries the result once it ended, and the reason when there is none", async () => {
    const t = client(() => ok(STATUS_ENDED_JSON));
    const done = await t.exec.status("7d1e5c90", 0);
    expect(done.ok && done.value.result).toEqual({ mode: "server", outcome: "complete" });
    expect(done.ok && done.value.end).toEqual({ kind: "exit", code: 0, at: "2026-11-15T10:00:09.000Z" });
    const none = client(() => ok(STATUS_NO_RESULT_JSON));
    const empty = await none.exec.status("7d1e5c90", 0);
    expect(empty.ok && empty.value.result).toBeUndefined();
    expect(empty.ok && empty.value.end?.reason).toBe("empty-result");
  });

  test("stopped and lost ends parse, a null exit code included", () => {
    const stopped = execStatusSchema.safeParse(JSON.parse(STATUS_STOPPED_JSON));
    expect(stopped.success && stopped.data.end).toEqual({ kind: "stopped", code: null, at: "2026-11-15T10:00:05.000Z" });
    const lost = execStatusSchema.safeParse(JSON.parse(STATUS_LOST_JSON));
    expect(lost.success && lost.data.end?.reason).toBe("process-gone");
  });

  test("an answer that breaks the contract is an invalid JSON failure with the schema's message", async () => {
    const t = client(() => ok('{"id":"x","state":"running"}'));
    const result = await t.exec.status("x", 0);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.kind).toBe("invalidJson");
  });

  test("stops a run: asked to stop, or already ended", async () => {
    const a = client(() => ok(STOP_JSON));
    expect(await a.exec.stop("3f9c2a1e")).toEqual({ ok: true, value: { id: "3f9c2a1e", stopping: true } });
    expect(a.calls[0]?.argv).toEqual(["rig-file", "exec", "stop", "3f9c2a1e"]);
    const b = client(() => ok(STOP_ENDED_JSON));
    expect(await b.exec.stop("3f9c2a1e")).toEqual({ ok: true, value: { id: "3f9c2a1e", state: "ended" } });
  });

  test("a rig error keeps its code and message as rig worded them", async () => {
    const t = client(() => failed(UNAVAILABLE_JSON));
    expect(await t.exec.start("pwsh", "C:\\proj", "ls")).toEqual({ ok: false, error: { kind: "rig", code: "exec-unavailable", message: "The pwsh feature is off; run: rig feature pwsh enable" } });
  });

  test("a failure with no rig error object is an exit code failure", async () => {
    const t = client(() => ({ code: FAILED_EXIT, stdout: "", stderr: "boom\n" }));
    expect(await t.exec.status("x", 0)).toEqual({ ok: false, error: { kind: "exitCode", code: FAILED_EXIT, output: "boom" } });
  });

  test("a rig that does not answer in time is a timeout, as data", async () => {
    const clock = manualClock();
    const never = () => new Promise<RigOutput>(() => {});
    const rig = new Rig({ find: () => "rig-file", platform: platformFor("linux"), messages: () => en, run: never, warn: () => {}, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    const pending = new RigExec(rig, false).status("x", 0);
    await clock.advance(60_000);
    const result = await pending;
    expect(!result.ok && result.error.kind).toBe("timeout");
    clock.dispose();
  });
});

describe("isGone", () => {
  test("a run rig does not know or an id it cannot read is gone; any other failure is not", () => {
    expect(isGone({ kind: "rig", code: "exec-unknown", message: "m" })).toBe(true);
    expect(isGone({ kind: "rig", code: "exec-bad-id", message: "m" })).toBe(true);
    expect(isGone({ kind: "rig", code: "exec-io", message: "m" })).toBe(false);
    expect(isGone({ kind: "timeout", seconds: 30 })).toBe(false);
    expect(isGone({ kind: "missing" })).toBe(false);
    expect(isGone({ kind: "cwdUnsafe" })).toBe(false);
    const error = JSON.parse(UNKNOWN_JSON).error;
    expect(isGone({ kind: "rig", code: error.code, message: error.message })).toBe(true);
  });
});

describe("runRig stdin", () => {
  const script = (body: string): string => {
    const file = join(tempDir("telegramhub-rig-stdin-"), "child.ts");
    writeFileSync(file, body);
    return file;
  };

  test("writes the text to the child's stdin and closes it, whole, in UTF-8", async () => {
    const file = script("process.stdin.pipe(process.stdout);\n");
    const text = "first line\nsecond \u044f line\n\"quoted\" 100%\n";
    const out = await runRig({ argv: [process.execPath, file], verbatim: false, stdin: text });
    expect(out).toEqual({ code: 0, stdout: text, stderr: "" });
  });

  test("a call with no stdin gives the child an empty, closed input", async () => {
    const file = script("let n = 0;\nprocess.stdin.on(\"data\", d => { n += d.length; });\nprocess.stdin.on(\"end\", () => console.log(\"read \" + n));\n");
    const out = await runRig({ argv: [process.execPath, file], verbatim: false });
    expect(out.stdout.trim()).toBe("read 0");
  });

  test("a child that exits without reading a large input is not an error of the call", async () => {
    const file = script(`process.exit(${EARLY_EXIT_CODE});\n`);
    const out = await runRig({ argv: [process.execPath, file], verbatim: false, stdin: "x".repeat(STDIN_BYTES) });
    expect(out.code).toBe(EARLY_EXIT_CODE);
  });
});
