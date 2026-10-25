import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { claudeModel, codexModel, compareVersions, ModelVersions } from "../src/transcript/model-versions.ts";
import { tempDir } from "./helpers.ts";

// File times a step apart, so a rewrite is seen as a change.
const LATER_S = 10;

describe("model names", () => {
  test("Claude and Codex names split into line and version, others stay whole", () => {
    expect(claudeModel("claude-opus-5-5")).toEqual({ kind: "claude", line: "opus", version: "5.5" });
    expect(claudeModel("claude-haiku-4-5-20251001")).toEqual({ kind: "claude", line: "haiku", version: "4.5" });
    expect(claudeModel("gpt-proxy")).toEqual({ kind: "other", name: "gpt-proxy" });
    expect(codexModel("gpt-6.1-sol")).toEqual({ kind: "codex", line: "sol", version: "6.1" });
    expect(codexModel("gpt-6-luna")).toEqual({ kind: "codex", line: "luna", version: "6" });
    expect(codexModel("o4-mini")).toEqual({ kind: "other", name: "o4-mini" });
  });

  test("versions compare number by number", () => {
    expect(compareVersions("5.5", "5.10")).toBe(-1);
    expect(compareVersions("6", "6.0")).toBe(0);
    expect(compareVersions("6.1", "6")).toBe(1);
  });
});

describe("ModelVersions", () => {
  const dirs: string[] = [];
  const dir = () => {
    const d = tempDir();
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("the newest version seen is named by its line, an older one with its version", () => {
    const v = new ModelVersions();
    expect(v.label(claudeModel("claude-haiku-4-5"))).toBe("haiku");
    expect(v.label(claudeModel("claude-haiku-5-5"))).toBe("haiku");
    expect(v.label(claudeModel("claude-haiku-4-5"))).toBe("haiku 4.5");
    expect(v.label(codexModel("gpt-6.1-sol"))).toBe("sol");
    v.see(codexModel("gpt-6.2-sol"));
    expect(v.label(codexModel("gpt-6.1-sol"))).toBe("sol 6.1");
    // Lines are apart: a Claude line does not count for a Codex one.
    expect(v.label(codexModel("gpt-6-luna"))).toBe("luna");
    expect(v.label(claudeModel("gpt-proxy"))).toBe("gpt-proxy");
  });

  test("the file keeps the versions for the next window and takes what another one saw", () => {
    const file = join(dir(), "state", "model-versions.json");
    const a = new ModelVersions(file);
    a.see(claudeModel("claude-opus-5-5"));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "claude:opus": "5.5" });
    const b = new ModelVersions(file);
    expect(b.label(claudeModel("claude-opus-5-1"))).toBe("opus 5.1");
    // Another window saw a newer model: this one reads the changed file.
    writeFileSync(file, JSON.stringify({ "claude:opus": "6.0" }));
    const later = Date.now() / 1000 + LATER_S;
    utimesSync(file, later, later);
    expect(a.label(claudeModel("claude-opus-5-5"))).toBe("opus 5.5");
    // A save merges what the file holds instead of overwriting it.
    a.see(codexModel("gpt-6.1-sol"));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "claude:opus": "6.0", "codex:sol": "6.1" });
  });

  test("a broken file is started over", () => {
    const file = join(dir(), "model-versions.json");
    writeFileSync(file, "{");
    const v = new ModelVersions(file);
    expect(v.label(claudeModel("claude-opus-5-5"))).toBe("opus");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "claude:opus": "5.5" });
  });
});
