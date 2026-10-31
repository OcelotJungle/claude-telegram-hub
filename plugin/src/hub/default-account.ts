import type { Platform } from "../shared/platform.ts";

import { execFile } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { PLATFORM } from "../shared/platform.ts";

const STATUS_TIMEOUT_MS = 15_000;
// "Status: Account-2 (me@mail.com …)", the first line of `cswap status`.
const STATUS_ACCOUNT = /^Status: Account-(\d+)\b/m;

// The config dir of the default login: plain `claude`, and `cswap run N` when
// N is the account logged in there, run without CLAUDE_CONFIG_DIR.
export const DEFAULT_CONFIG_DIR = join(homedir(), ".claude");

export function isDefaultConfigDir(configDir: string, defaultDir = DEFAULT_CONFIG_DIR, platform: Platform = PLATFORM): boolean {
  return platform.samePath(configDir, defaultDir);
}

export function statusAccount(output: string): string | undefined {
  return output.match(STATUS_ACCOUNT)?.[1];
}

// The cswap account of the default login now, or undefined when cswap cannot
// tell. It changes with `cswap switch`, so it is asked each time.
export function defaultLoginAccount(platform: Platform = PLATFORM, which: (name: string) => string | null = Bun.which): Promise<string | undefined> {
  const cswap = which(platform.cswapName);
  if (!cswap) return Promise.resolve(undefined);
  // cswap prints box-drawing characters, which a piped Python may not encode.
  const env: Record<string, string | undefined> = { ...process.env, PYTHONIOENCODING: "utf-8" };
  delete env["CLAUDE_CONFIG_DIR"];
  return new Promise(done => {
    execFile(cswap, ["status"], { env, timeout: STATUS_TIMEOUT_MS, windowsHide: true }, (err, stdout) => done(err ? undefined : statusAccount(stdout)));
  });
}
