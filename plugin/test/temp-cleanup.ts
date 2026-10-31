import { afterAll } from "bun:test";
import { rmSync } from "fs";

const createdDirs = new Set<string>();

export function trackTempDir(dir: string): void {
  createdDirs.add(dir);
}

// Bun runs an afterAll registered by a preload once, after the whole run; one registered by a module imported from a test
// file runs after the first file that loaded it only. bunfig.toml preloads this module so the hook covers every file.
afterAll(() => {
  for (const dir of createdDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A detached child can still hold a file on Windows; a directory that cannot be removed must not fail the run.
    }
  }
  createdDirs.clear();
});
