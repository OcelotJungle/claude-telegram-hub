import { existsSync, readdirSync } from "fs";
import { join } from "path";

// Claude Code names a project's transcript dir after its cwd with every
// non-alphanumeric character replaced by '-'.
export function sanitizeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export function transcriptPathFor(sessionId: string, cwd: string, configDir: string): string {
  const projects = join(configDir, "projects");
  const expected = join(projects, sanitizeCwd(cwd), `${sessionId}.jsonl`);
  if (existsSync(expected)) return expected;
  try {
    for (const dir of readdirSync(projects)) {
      const candidate = join(projects, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {}
  return expected;
}
