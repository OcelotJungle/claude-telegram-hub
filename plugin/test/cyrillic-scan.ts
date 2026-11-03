import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const CYRILLIC = /\p{Script=Cyrillic}/u;
const GIT_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;

// What a scan found: files with Cyrillic, and files it could not read.
export type CyrillicScan = { offenders: string[]; unreadable: string[] };

type ScanDeps = {
  read: (file: string) => string;
  exists: (file: string) => boolean;
};

// The files git tracks (the index), relative to the root. Untracked files are not the repository's.
export function listTracked(root: string): string[] {
  const listing = execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: GIT_OUTPUT_LIMIT_BYTES }).toString("utf8");
  return listing.split("\0").filter(file => file !== "");
}

// A tracked file deleted in the working tree is skipped; one that exists but cannot be read is reported,
// never skipped silently.
export function findCyrillic(files: string[], skip: string, deps: ScanDeps): CyrillicScan {
  const scan: CyrillicScan = { offenders: [], unreadable: [] };
  for (const file of files) {
    if (file === skip || !deps.exists(file)) continue;
    let text: string;
    try {
      text = deps.read(file);
    } catch {
      scan.unreadable.push(file);
      continue;
    }
    if (CYRILLIC.test(text)) scan.offenders.push(file);
  }
  return scan;
}

export function scanTracked(root: string, skip: string): CyrillicScan {
  return findCyrillic(listTracked(root), skip, {
    read: file => readFileSync(join(root, file), "utf8"),
    exists: file => existsSync(join(root, file)),
  });
}
