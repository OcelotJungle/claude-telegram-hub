import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { expect, test } from "bun:test";
import { findCyrillic, listTracked } from "./cyrillic-scan.ts";
import { tempDir } from "./helpers.ts";

// Written as escapes: this file is tracked too, and the guard would flag it.
const ZHE = "\u0436";

test("a file that exists but cannot be read is reported, not skipped", () => {
  const scan = findCyrillic(["a.ts", "b.ts"], "none", {
    exists: () => true,
    read: file => {
      if (file === "b.ts") throw new Error("EACCES");
      return "plain";
    },
  });
  expect(scan).toEqual({ offenders: [], unreadable: ["b.ts"] });
});

test("a tracked file deleted in the working tree is skipped", () => {
  const scan = findCyrillic(["gone.ts", "here.ts"], "none", {
    exists: file => file !== "gone.ts",
    read: file => {
      if (file === "gone.ts") throw new Error("ENOENT");
      return `text ${ZHE}`;
    },
  });
  expect(scan).toEqual({ offenders: ["here.ts"], unreadable: [] });
});

test("the Russian catalog is not scanned", () => {
  const scan = findCyrillic(["ru.ts", "x.ts"], "ru.ts", { exists: () => true, read: () => ZHE });
  expect(scan.offenders).toEqual(["x.ts"]);
});

test("only tracked files are listed: an untracked file is not the repository's", () => {
  const root = tempDir("telegramhub-scan-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "tracked.ts"), "x");
  writeFileSync(join(root, "untracked.ts"), ZHE);
  execFileSync("git", ["add", "sub/tracked.ts"], { cwd: root });
  expect(listTracked(root)).toEqual(["sub/tracked.ts"]);
});
