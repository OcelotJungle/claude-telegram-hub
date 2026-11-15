import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { plainLines, renderRigLine, renderRigLines, renderRigRun } from "../src/hub/rig-output.ts";
import { en } from "../src/shared/i18n/en.ts";
import { ru } from "../src/shared/i18n/ru.ts";

const line = (value: unknown) => JSON.stringify(value);
const progress = (code: string, data?: unknown) => line({ progress: { code, ...(data === undefined ? {} : { data }) } });

describe("rig progress lines", () => {
  test("each known progress code is words, in the language given", () => {
    expect(renderRigLine(progress("lock-waiting"), en)).toEqual([en.rigProgressLockWaiting]);
    expect(renderRigLine(progress("service-stopping"), en)).toEqual([en.rigProgressServiceStopping]);
    expect(renderRigLine(progress("program-install", { name: "bun", command: "winget install bun" }), en)).toEqual([en.rigProgressProgramInstall({ name: "bun", command: "winget install bun" })]);
    expect(renderRigLine(progress("lock-waiting"), ru)).toEqual([ru.rigProgressLockWaiting]);
    expect(ru.rigProgressLockWaiting).not.toBe(en.rigProgressLockWaiting);
  });

  test("an update step's output line is shown as it is", () => {
    expect(renderRigLine(progress("update-step-output", { line: "Fetching origin" }), en)).toEqual(["Fetching origin"]);
  });

  test("a progress code this hub does not know is a catalog line with its code, never JSON", () => {
    expect(renderRigLine(progress("brand-new-step", { x: 1 }), en)).toEqual([en.rigProgressUnknown({ code: "brand-new-step" })]);
    expect(en.rigProgressUnknown({ code: "brand-new-step" })).toContain("brand-new-step");
  });

  test("a known code with data missing is not drawn from nothing", () => {
    expect(renderRigLine(progress("program-install"), en)).toEqual([en.rigProgressUnknown({ code: "program-install" })]);
    expect(renderRigLine(progress("update-step-output"), en)).toEqual([en.rigProgressUnknown({ code: "update-step-output" })]);
  });

  test("a progress line with an empty or missing code shows nothing, not an empty line", () => {
    expect(renderRigLine(progress(""), en)).toEqual([]);
    expect(renderRigLine(line({ progress: {} }), en)).toEqual([]);
    expect(renderRigLine(line({ progress: { code: 5 } }), en)).toEqual([]);
  });
});

describe("rig results and errors", () => {
  test("a feature switch", () => {
    expect(renderRigLine(line({ feature: "pwsh", enabled: true }), en)).toEqual([en.rigFeatureEnabled({ name: "pwsh" })]);
    expect(renderRigLine(line({ feature: "pwsh", enabled: false }), en)).toEqual([en.rigFeatureDisabled({ name: "pwsh" })]);
  });

  test("an update outcome, for the running mode and the pending one", () => {
    expect(renderRigLine(line({ mode: "server", outcome: "complete" }), en)).toEqual([en.rigUpdateComplete({ pending: false })]);
    expect(renderRigLine(line({ mode: "server", outcome: "checked" }), en)).toEqual([en.rigUpdateChecked({ pending: false })]);
    expect(renderRigLine(line({ mode: "server", outcome: "deferred" }), en)).toEqual([en.rigUpdateDeferred({ pending: false })]);
    expect(renderRigLine(line({ mode: "pending", outcome: "complete" }), en)).toEqual([en.rigUpdateComplete({ pending: true })]);
    expect(en.rigUpdateComplete({ pending: true })).not.toBe(en.rigUpdateComplete({ pending: false }));
  });

  test("the language: shown, changed, already set", () => {
    expect(renderRigLine(line({ language: "ru" }), en)).toEqual([en.rigLanguageIs({ language: "ru" })]);
    expect(renderRigLine(line({ language: "ru", changed: true }), en)).toEqual([en.rigLanguageChanged({ language: "ru" })]);
    expect(renderRigLine(line({ language: "ru", changed: false }), en)).toEqual([en.rigLanguageUnchanged({ language: "ru" })]);
  });

  test("rig's error is its message as it is, without the code", () => {
    expect(renderRigLine(line({ error: { code: "update-busy", message: "Another update is running" } }), ru)).toEqual(["Another update is running"]);
  });

  test("a multi-line error message is its lines, in order, so the cause at the end can be kept", () => {
    const message = "update failed\nstep one ok\r\nstep two: the real cause\n";
    expect(renderRigLine(line({ error: { code: "update-failed", message } }), en)).toEqual(["update failed", "step one ok", "step two: the real cause"]);
  });

  test("an answer with no words here shows its plain fields, never JSON", () => {
    const text = renderRigLine(line({ mode: "server", outcome: "surprise", nested: { a: 1 }, list: [1] }), en);
    expect(text).toEqual(["mode: server, outcome: surprise"]);
    expect(text.join("")).not.toContain("{");
    expect(renderRigLine(line({ nested: { a: 1 } }), en)).toEqual([]);
  });
});

describe("lines that are not rig's JSON", () => {
  test("plain text, a JSON array or scalar and broken JSON stay as they are", () => {
    for (const plain of ["Waiting for the lock", "[1,2]", "42", "{broken", ""]) {
      expect(renderRigLine(plain, en)).toEqual([plain]);
    }
  });

  test("a list is rendered line by line, keeping the order", () => {
    const lines = ["start", progress("lock-waiting"), line({ feature: "pwsh", enabled: true }), "end"];
    expect(renderRigLines(lines, en)).toEqual(["start", en.rigProgressLockWaiting, en.rigFeatureEnabled({ name: "pwsh" }), "end"]);
    expect(renderRigLines([], en)).toEqual([]);
  });

  test("plainLines keeps the text lines of an output and drops its JSON objects", () => {
    const text = [progress("lock-waiting"), "Traceback (most recent call last):", "", line({ x: 1 }), "  boom"].join("\n");
    expect(plainLines(text)).toBe("Traceback (most recent call last):\n  boom");
    expect(plainLines(progress("lock-waiting"))).toBe("");
    expect(plainLines("")).toBe("");
  });
});

describe("a rig run as a whole", () => {
  test("the progress comes first and the result last, whatever the order they were written in", () => {
    const result = [line({ feature: "pwsh", enabled: true })];
    const late = [progress("lock-waiting"), progress("update-step-output", { line: "late step" })];
    expect(renderRigRun(late, result, en)).toEqual([en.rigProgressLockWaiting, "late step", en.rigFeatureEnabled({ name: "pwsh" })]);
  });
});

describe("the fake rig of the service smoke test", () => {
  test("writes its progress to stderr, as the rig API says; stdout holds only the result", () => {
    const source = readFileSync(join(import.meta.dir, "..", "..", "scripts", "rig-service-process.ts"), "utf8");
    const progressLines = source.split("\n").filter(l => l.includes("progress:"));
    expect(progressLines.length).toBeGreaterThan(0);
    for (const l of progressLines) {
      expect(l).toContain("console.error(");
      expect(l).not.toContain("console.log(");
    }
  });
});
