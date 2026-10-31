import { spawnSync } from "child_process";
import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { writeRigFile } from "./rig-files.ts";

const commitSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const readySchema = z.object({ commit: commitSchema, time: z.string() });
export const RIG_RESTART_EXIT = 75;
export const COMMIT_ENV = "TG_HUB_COMMIT";
const COMMIT_UNKNOWN_ID = "rig-commit-unknown";
const COMMIT_UNKNOWN_TEXT = "Хаб не смог определить коммит своего кода, поэтому не может обработать обновление. Попытки продолжаются.";
const CODE_CHANGED_TEXT = "Хаб запущен с другим кодом. Окна подхватят его при следующем запуске.";

export function hubCommit(repository: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repository, windowsHide: true, encoding: "utf8" });
  const parsed = commitSchema.safeParse(result.stdout?.trim());
  return result.status === 0 && parsed.success ? parsed.data : undefined;
}

// The commit the service script fixed before it started `bun`: it matches the code that was loaded, `HEAD` read later may not.
export function startedCommit(env: Record<string, string | undefined>): string | undefined {
  const parsed = commitSchema.safeParse(env[COMMIT_ENV]?.trim());
  return parsed.success ? parsed.data : undefined;
}

export class RigLifecycle {
  private commit: string | undefined;
  private online = false;
  private pending = false;
  private refreshing = false;
  // A restart event waiting for the commits to be known; it is not consumed before.
  private requested = false;
  // `hub-ready.json` still has to be written for this process.
  private unwritten = true;
  private commitReported = false;
  private lastWarning = "";
  get waiting(): boolean { return this.pending || this.refreshing || this.requested; }

  constructor(private deps: {
    dir: string; started(): string | undefined; head(): string | undefined; now(): number; idle(): boolean;
    notice(id: string, text: string): void; exit(code: number): void; warn(text: string): void;
  }) {
    this.commit = deps.started();
  }

  // Called only after getMe succeeds. A missing rig directory is left untouched.
  ready(): void {
    this.online = true;
    this.resolve();
    this.publish();
  }

  request(): void {
    this.requested = true;
    this.resolve();
    this.publish();
  }

  check(): void {
    this.resolve();
    this.publish();
    if (!this.pending || !this.deps.idle()) return;
    try {
      // No await between the final idle check, the marker and process exit.
      writeRigFile(this.deps.dir, "hub-restarting.json", JSON.stringify({ time: new Date(this.deps.now()).toISOString() }));
      this.pending = false;
      this.deps.exit(RIG_RESTART_EXIT);
    } catch (error) { this.warnOnce("restart", `rig restart: ${String(error)}`); }
  }

  // Works out what an unanswered restart event means once both commits are known.
  private resolve(): void {
    this.commit ??= this.deps.started();
    if (!this.requested) return;
    const current = this.deps.head();
    if (!this.commit || !current) {
      this.warnOnce("commit", "rig restart: cannot determine hub commit");
      if (!this.commitReported) {
        this.commitReported = true;
        this.deps.notice(`${COMMIT_UNKNOWN_ID}-${this.deps.now()}`, COMMIT_UNKNOWN_TEXT);
      }
      return;
    }
    this.requested = false;
    if (current === this.commit) {
      this.pending = false;
      this.refreshing = true;
    } else this.pending = true;
  }

  // Writes `hub-ready.json` when this process owes one; a failed write is tried again on the next check.
  private publish(): void {
    if (!this.online || !this.commit || !(this.unwritten || this.refreshing)) return;
    try {
      if (!existsSync(this.deps.dir) || !statSync(this.deps.dir).isDirectory()) {
        this.unwritten = false;
        this.refreshing = false;
        return;
      }
      let previous: string | undefined;
      try {
        const parsed = readySchema.safeParse(JSON.parse(readFileSync(join(this.deps.dir, "hub-ready.json"), "utf8")));
        if (parsed.success) previous = parsed.data.commit;
      } catch {}
      const time = new Date(this.deps.now()).toISOString();
      writeRigFile(this.deps.dir, "hub-ready.json", JSON.stringify({ commit: this.commit, time }));
      this.unwritten = false;
      this.refreshing = false;
      // After the write, once, under an id the outbox remembers: a repeated post cannot send it twice.
      if (previous && previous !== this.commit) this.deps.notice(`hub-code-${previous}-${this.commit}-${time}`, CODE_CHANGED_TEXT);
    } catch (error) { this.warnOnce("readiness", `rig readiness: ${String(error)}`); }
  }

  // A failure repeats on every poll; the log gets it once per kind until something else happens.
  private warnOnce(kind: string, text: string): void {
    if (kind === this.lastWarning) return;
    this.lastWarning = kind;
    this.deps.warn(text);
  }
}
