import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { version } from "../package.json";

// rig reads plugin/package.json and Claude Code reads plugin.json: a bump of one alone shows two versions of the same code.
test("the plugin manifest carries the package version", () => {
  const manifest: unknown = JSON.parse(readFileSync(join(import.meta.dir, "..", ".claude-plugin", "plugin.json"), "utf8"));
  expect(manifest).toMatchObject({ version });
});
