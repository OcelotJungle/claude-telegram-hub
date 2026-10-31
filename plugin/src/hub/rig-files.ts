import { mkdtempSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

export type RigFile = "events.offset" | "hub-restarting.json" | "hub-ready.json";

// mkdtemp fails when rig's directory is absent; it never creates that directory.
export function writeRigFile(dir: string, name: RigFile, content: string): void {
  const temporary = mkdtempSync(join(dir, ".hub-"));
  try {
    const file = join(temporary, name);
    writeFileSync(file, content, "utf8");
    renameSync(file, join(dir, name));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
