import { expect, test } from "bun:test";
import { dirname, resolve } from "path";
import { scanTracked } from "./cyrillic-scan.ts";

// The one tracked file that may hold Cyrillic: the Russian catalog.
const RUSSIAN_CATALOG = "plugin/src/shared/i18n/ru.ts";
const REPO_ROOT = resolve(dirname(import.meta.path), "..", "..");

test("no tracked file holds Cyrillic except the Russian catalog", () => {
  const scan = scanTracked(REPO_ROOT, RUSSIAN_CATALOG);
  expect(scan.unreadable).toEqual([]);
  expect(scan.offenders).toEqual([]);
});
