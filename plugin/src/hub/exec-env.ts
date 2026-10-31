// The environment a topic command gets: the one a new terminal window would
// have, built from the registry, not the hub's. The hub's may date from logon
// or carry the variables of the Claude Code window it was started from.
import type { Logger } from "../shared/log.ts";

import { spawnSync } from "child_process";
import { PLATFORM } from "../shared/platform.ts";

const REG_TIMEOUT_MS = 10_000;
const MACHINE_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";
const USER_KEY = "HKCU\\Environment";
const VOLATILE_KEY = "HKCU\\Volatile Environment";
// What Windows itself sets for a logon, not kept in those keys: the only
// variables a command takes from the hub's own environment.
const SYSTEM_VARS = new Set(
  [
    "SystemRoot",
    "windir",
    "SystemDrive",
    "COMPUTERNAME",
    "USERNAME",
    "USERDOMAIN",
    "USERDOMAIN_ROAMINGPROFILE",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PUBLIC",
    "ALLUSERSPROFILE",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "CommonProgramFiles",
    "CommonProgramFiles(x86)",
    "CommonProgramW6432",
    "NUMBER_OF_PROCESSORS",
    "OS",
    "PATHEXT",
    "ComSpec",
    "LOGONSERVER",
    "SESSIONNAME",
    "DriverData",
  ].map(n => n.toLowerCase()),
);
const SYSTEM_PREFIX = /^PROCESSOR_/i;
// What Claude Code and the hub set for themselves; dropped when the registry
// cannot be read and the hub's environment is all there is.
const OWN_VARS = /^(CLAUDE|TG_HUB_|ANTHROPIC_)/i;
// A value line of `reg query`: four spaces between name, type and value.
const REG_LINE = /^ {4}(.+?) {4}(REG_SZ|REG_EXPAND_SZ)(?: {4}(.*))?$/;
const VAR_REF = /%([^%]+)%/g;

export type RegValue = { type: "REG_SZ" | "REG_EXPAND_SZ"; value: string };

export function parseRegQuery(out: string): Record<string, RegValue> {
  const values: Record<string, RegValue> = {};
  for (const line of out.split(/\r?\n/)) {
    const m = REG_LINE.exec(line);
    const name = m?.[1];
    const type = m?.[2];
    if (name === undefined || (type !== "REG_SZ" && type !== "REG_EXPAND_SZ")) continue;
    values[name] = { type, value: m?.[3] ?? "" };
  }
  return values;
}

const isSystemVar = (name: string) => SYSTEM_VARS.has(name.toLowerCase()) || SYSTEM_PREFIX.test(name);

// As a new logon builds it: the system variables from the hub, then the
// machine's, the logon's volatile ones and the user's; Path is machine;user.
export function mergeEnv(
  base: Record<string, string | undefined>,
  machine: Record<string, RegValue>,
  user: Record<string, RegValue>,
  volatile: Record<string, RegValue>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && isSystemVar(k)) env[k] = v;
  const keyOf = (name: string) => Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase());
  const get = (name: string) => {
    const k = keyOf(name);
    return k === undefined ? undefined : env[k];
  };
  const set = (name: string, value: string) => {
    const old = keyOf(name);
    if (old !== undefined) delete env[old];
    env[name] = value;
  };
  const resolve = (v: RegValue) => (v.type === "REG_EXPAND_SZ" ? v.value.replace(VAR_REF, (ref, name: string) => get(name) ?? ref) : v.value);
  const isPath = (name: string) => name.toLowerCase() === "path";
  // Plain values first, so expanded ones can refer to them, as Windows does.
  for (const vars of [machine, volatile, user]) {
    const entries = Object.entries(vars).filter(([k]) => !isPath(k));
    for (const [k, v] of entries) if (v.type === "REG_SZ") set(k, v.value);
    for (const [k, v] of entries) if (v.type === "REG_EXPAND_SZ") set(k, resolve(v));
  }
  const machinePath = Object.entries(machine).find(([k]) => isPath(k));
  const userPath = Object.entries(user).find(([k]) => isPath(k));
  const parts = [machinePath, userPath].flatMap(p => (p ? [resolve(p[1])] : []));
  const pathName = machinePath?.[0] ?? userPath?.[0];
  if (pathName !== undefined) set(pathName, parts.join(";"));
  return env;
}

// The hub's own environment without its and Claude Code's variables.
function hubEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !OWN_VARS.test(k)) env[k] = v;
  return env;
}

// One registry key's string values, or undefined when reg fails. reg runs
// after chcp 65001 in the same console, so non-ASCII values come as UTF-8.
function regQuery(key: string): Record<string, RegValue> | undefined {
  const r = spawnSync("cmd.exe", ["/d", "/s", "/c", `"chcp 65001>nul & reg query "${key}""`], {
    windowsVerbatimArguments: true,
    windowsHide: true,
    encoding: "utf8",
    timeout: REG_TIMEOUT_MS,
  });
  if (r.status !== 0) return undefined;
  return parseRegQuery(r.stdout);
}

export function freshEnv(log?: Logger): Record<string, string> {
  if (!PLATFORM.windows) return hubEnv();
  const machine = regQuery(MACHINE_KEY);
  const user = regQuery(USER_KEY);
  if (machine === undefined || user === undefined) {
    log?.warn("exec: reg query failed; the command gets the hub's environment");
    return hubEnv();
  }
  // A logon without it only lacks a few variables the hub's list has anyway.
  const volatile = regQuery(VOLATILE_KEY) ?? {};
  return mergeEnv(process.env, machine, user, volatile);
}
