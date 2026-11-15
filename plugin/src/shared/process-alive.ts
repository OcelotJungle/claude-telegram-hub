import { field } from "./guards.ts";

// Whether a process with this pid exists. EPERM means it exists but belongs to someone else.
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return field(e, "code") === "EPERM";
  }
}
