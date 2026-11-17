import { readdirSync, statSync } from "fs";
import { join } from "path";

// Claude Code names a project's transcript dir after its cwd with every
// non-alphanumeric character replaced by '-'.
export function sanitizeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

// The existing transcript of a session under the projects dir, whichever
// project dir holds it.
export function findTranscript(sessionId: string, projectsDir: string): string | undefined {
  let dirs: string[];
  try {
    dirs = readdirSync(projectsDir);
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    const path = join(projectsDir, dir, `${sessionId}.jsonl`);
    if (isFile(path)) return path;
  }
  return undefined;
}

// The file a session's records go to. A session resumed in another cwd (a
// worktree, a subdirectory) keeps writing to the transcript where it began,
// while the path named after the current cwd (the SessionStart hook's
// transcript_path) does not exist: an existing transcript of the session wins.
// The named path stands only while the session has none yet (a new session).
export function sessionTranscriptPath(sessionId: string, named: string, configDir: string): string {
  if (isFile(named)) return named;
  return findTranscript(sessionId, join(configDir, "projects")) ?? named;
}

export function transcriptPathFor(sessionId: string, cwd: string, configDir: string): string {
  return sessionTranscriptPath(sessionId, join(configDir, "projects", sanitizeCwd(cwd), `${sessionId}.jsonl`), configDir);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
