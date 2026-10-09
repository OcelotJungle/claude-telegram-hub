import { execFile } from "child_process";
import { homedir } from "os";
import { join, resolve } from "path";

const STATUS_TIMEOUT_MS = 15_000;
// "Status: Account-2 (me@mail.com …)", the first line of `cswap status`.
const STATUS_ACCOUNT = /^Status: Account-(\d+)\b/m;

// The config dir of the default login: plain `claude`, and `cswap run N` when
// N is the account logged in there, run without CLAUDE_CONFIG_DIR.
export const DEFAULT_CONFIG_DIR = join(homedir(), ".claude");

export function isDefaultConfigDir(configDir: string, defaultDir = DEFAULT_CONFIG_DIR): boolean {
  return resolve(configDir).toLowerCase() === resolve(defaultDir).toLowerCase();
}

export function statusAccount(output: string): string | undefined {
  return output.match(STATUS_ACCOUNT)?.[1];
}

// The cswap account of the default login now, or undefined when cswap cannot
// tell. It changes with `cswap switch`, so it is asked each time.
export function defaultLoginAccount(): Promise<string | undefined> {
  // cswap prints box-drawing characters, which a piped Python may not encode.
  const env: Record<string, string | undefined> = { ...process.env, PYTHONIOENCODING: "utf-8" };
  delete env["CLAUDE_CONFIG_DIR"];
  return new Promise(done => {
    execFile("cswap.exe", ["status"], { env, timeout: STATUS_TIMEOUT_MS, windowsHide: true }, (err, stdout) => done(err ? undefined : statusAccount(stdout)));
  });
}
