import type { Language, Messages } from "../shared/i18n/index.ts";
import type { InfoData } from "../shared/info-data.ts";
import type { Platform } from "../shared/platform.ts";
import type { PermissionMode, RigAutocompact, RigCleanup, RigCompact, RigMode, RigRename, RigRun, RigRunOptions, RigStop } from "./rig-session.ts";

import { spawn } from "child_process";
import { homedir } from "os";
import { StringDecoder } from "string_decoder";
import { z } from "zod";
import { en } from "../shared/i18n/en.ts";
import { DEFAULT_LANGUAGE, isLanguage } from "../shared/i18n/index.ts";
import { isBlockError, RIG_QUERY_LIMIT_MS } from "../shared/info-data.ts";
import { infoDataSchema } from "./info-schema.ts";
import { plainLines } from "./rig-output.ts";
import { literal } from "../shared/markdown.ts";
import { LANGUAGES } from "../shared/protocol.ts";
import { PLATFORM } from "../shared/platform.ts";
import { isPermissionMode, isSessionWaiting, RIG_SESSION_LIMIT_MS, rigAutocompactSchema, rigCleanupSchema, rigCompactSchema, rigModeSchema, rigRenameSchema, rigRunSchema, rigStopSchema } from "./rig-session.ts";

const MS_PER_SECOND = 1000;
const FEATURE_NAME = /^[a-z][a-z0-9-]*$/;
// A session id reaches cmd.exe verbatim, so only the characters of an id are let through.
// Both start with a letter, digit or underscore: a value with a leading "-" is never put on the command line.
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
const ACCOUNT = /^[\w@][\w.@-]*$/;
const WINDOWS_META = /([()\][%!^"`<>&|;, *?])/g;
const SIMPLE_ARGUMENT = /^[A-Za-z0-9_.@/-]+$/;
// rig feature, rig status, rig language and rig info take no lock, so they answer fast; a longer one is a failure.
export { RIG_QUERY_LIMIT_MS };
const languageSchema = z.strictObject({ language: z.enum(LANGUAGES) });
const featureSchema = z.strictObject({ name: z.string().regex(FEATURE_NAME), description: z.string(), enabled: z.boolean(), platformAllowed: z.boolean() });
export const featuresSchema = z.array(featureSchema);
// rig feature answers {"features": [...]}.
const featureReplySchema = z.strictObject({ features: featuresSchema });
const eventSchema = z.object({ type: z.string(), time: z.string(), text: z.string() });
export const statusSchema = z.strictObject({
  schemaVersion: z.literal(1), mode: z.enum(["dev", "server"]),
  versions: z.strictObject({ rig: z.string().nullable(), hub: z.string().nullable() }),
  releases: z.strictObject({ rig: z.string().nullable(), hub: z.string().nullable() }),
  features: featuresSchema, lastUpdate: eventSchema.nullable(),
  // The saved state is a string in the contract; it is displayed, never interpreted.
  pendingHubRestart: z.string().nullable(), errors: z.array(eventSchema),
});
export type RigFeature = z.infer<typeof featureSchema>;
export type RigStatus = z.infer<typeof statusSchema>;
// stdin: text written to the child's standard input before it is closed (rig exec start reads a command from it).
export type RigInvocation = { argv: string[]; verbatim: boolean; stdin?: string };
export type RigResult<T, E = RigError> = { ok: true; value: T } | { ok: false; error: E };
// Why a rig call failed, as data: the text is made from it by the catalog current when it is shown.
export type RigError =
  | { kind: "missing" }
  | { kind: "percentPath"; file: string }
  | { kind: "timeout"; seconds: number }
  | { kind: "exitCode"; code: number; output: string }
  | { kind: "invalidJson"; message: string }
  | { kind: "failure"; message: string }
  // rig's own failure: its message is shown as it is, the code is kept for logs.
  | { kind: "rig"; code: string; message: string }
  | { kind: "badSession" }
  // The hub's own refusals before a command line is built.
  | { kind: "controlChar" }
  | { kind: "badAccount" }
  | { kind: "badMode" }
  // The hub could not save the run before asking rig to start it, so it did not ask.
  | { kind: "notRecorded" };
export type RigOutput = { code: number; stdout: string; stderr: string };
export type RigProgress = (line: string) => void;
// stdin: text the command reads; limit: its own time limit; progress: each stderr line as it arrives.
export type RigQueryOptions = { stdin?: string; limit?: number; progress?: RigProgress };
export type FeatureState = { kind: "missing" } | { kind: "loading" } | { kind: "ready"; features: RigFeature[] } | { kind: "failed"; error: RigError };
export type MachineCommand = { name: "rig"; args: string };
export type RigAction = { kind: "features" } | { kind: "status" } | { kind: "mutate"; args: string[]; confirm: boolean };

export function rigErrorText(error: RigError, m: Messages): string {
  switch (error.kind) {
    case "missing": return m.rigMissing;
    case "percentPath": return m.rigPercentPath({ file: error.file });
    case "timeout": return m.rigTimeout({ seconds: error.seconds });
    case "exitCode": return m.rigExitCode({ code: error.code, output: error.output });
    case "invalidJson": return m.rigInvalidJson({ message: error.message });
    case "failure": return m.rigFailure({ message: error.message });
    case "rig": return error.message;
    case "badSession": return m.rigBadSession;
    case "controlChar": return m.rigControlChar;
    case "badAccount": return m.rigBadAccount;
    case "badMode": return m.rigBadMode;
    case "notRecorded": return m.execNotRecorded;
  }
}

// The error object rig prints on stdout when it fails; undefined when the text is anything else.
export function rigErrorObject(stdout: string): { code: string; message: string } | undefined {
  try {
    const value: unknown = JSON.parse(stdout);
    return isBlockError(value) ? value.error : undefined;
  } catch {
    return undefined;
  }
}

// The usage replies are already texts: the caller passes the catalog it is answering in.
export function rigAction(command: MachineCommand, m: Messages): RigResult<RigAction, string> {
  const args = command.args.trim().split(/\s+/).filter(Boolean);
  if (args[0] === "feature") {
    if (args.length === 1) return { ok: true, value: { kind: "features" } };
    const [, name, action] = args;
    if (args.length === 3 && name && FEATURE_NAME.test(name) && (action === "enable" || action === "disable")) {
      return { ok: true, value: { kind: "mutate", args: ["feature", name, action], confirm: name === "telegram" && action === "disable" } };
    }
    return { ok: false, error: m.rigFeatureUsage };
  }
  if (args.length === 1 && args[0] === "status") return { ok: true, value: { kind: "status" } };
  if (args.length === 1 && args[0] === "update") return { ok: true, value: { kind: "mutate", args: ["update"], confirm: false } };
  // The language is rig's: this only passes the argument on, rig validates and saves it.
  if (args.length === 1 && args[0] === "language") return { ok: true, value: { kind: "mutate", args: ["language"], confirm: false } };
  const [name, language] = args;
  if (args.length === 2 && name === "language" && isLanguage(language)) return { ok: true, value: { kind: "mutate", args: ["language", language], confirm: false } };
  return { ok: false, error: m.rigUsage };
}

export function findRig(platform: Platform = PLATFORM, home = homedir(), which: (file: string) => string | null = Bun.which): string | undefined {
  const name = platform.windows ? "rig.cmd" : "rig";
  return which(name) ?? which(platform.join(home, ".local", "bin", name)) ?? undefined;
}

// Quote CRT arguments, then protect both cmd.exe parses (the rig .cmd shim forwards %*).
// Algorithm: https://github.com/moxystudio/node-cross-spawn/blob/master/lib/util/escape.js.
function windowsArgument(value: string): string {
  if (SIMPLE_ARGUMENT.test(value)) return value;
  const quoted = `"${value.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, "$1$1")}"`;
  return quoted.replace(WINDOWS_META, "^$1").replace(WINDOWS_META, "^$1");
}

// Free text is one argv item, never command text. POSIX needs no shell at all.
export function rigInvocation(file: string, args: string[], platform: Platform = PLATFORM): RigInvocation {
  return platform.windows
    ? { argv: ["cmd.exe", "/d", "/v:off", "/s", "/c", `""${file}" ${args.map(windowsArgument).join(" ")}"`], verbatim: true }
    : { argv: [file, ...args], verbatim: false };
}

export function runRig(invocation: RigInvocation, signal?: AbortSignal, progress?: RigProgress): Promise<RigOutput> {
  return new Promise(resolve => {
    const [file, ...args] = invocation.argv;
    if (!file) return resolve({ code: 1, stdout: "", stderr: "empty rig invocation" });
    const child = spawn(file, args, { windowsHide: true, windowsVerbatimArguments: invocation.verbatim, signal, stdio: ["pipe", "pipe", "pipe"] });
    // A child that exits before reading its input closes the pipe: that is not an error of this call.
    child.stdin.on("error", () => undefined);
    child.stdin.end(invocation.stdin);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const decoder = new StringDecoder("utf8");
    let pending = "";
    child.stdout.on("data", (data: Buffer) => out.push(data));
    child.stderr.on("data", (data: Buffer) => {
      err.push(data);
      pending += decoder.write(data);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) progress?.(line);
    });
    child.on("error", error => resolve({ code: 1, stdout: "", stderr: error.message }));
    child.on("close", code => {
      pending += decoder.end();
      if (pending) progress?.(pending);
      resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
  });
}

export class Rig {
  state: FeatureState = { kind: "missing" };
  private initialized = false;

  constructor(private deps: {
    find(): string | undefined; platform: Platform; run(invocation: RigInvocation, signal?: AbortSignal, progress?: RigProgress): Promise<RigOutput>; warn(text: string): void;
    setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout>; clearTimer(handle: ReturnType<typeof setTimeout>): void;
    // The catalog of the hub's current language, for the errors that reach Telegram.
    messages(): Messages;
  }) {
    if (deps.find()) this.state = { kind: "loading" };
  }

  invocation(args: string[], stdin?: string): RigResult<RigInvocation> {
    const file = this.deps.find();
    if (!file) return { ok: false, error: { kind: "missing" } };
    // cmd.exe expands %NAME% even inside quotes, so such a path cannot be passed safely.
    if (this.deps.platform.windows && file.includes("%")) return { ok: false, error: { kind: "percentPath", file } };
    const invocation = rigInvocation(file, args, this.deps.platform);
    return { ok: true, value: stdin === undefined ? invocation : { ...invocation, stdin } };
  }

  // A query that runs longer than the limit is aborted and counts as a failure.
  private async limited(invocation: RigInvocation, limit = RIG_QUERY_LIMIT_MS, progress?: RigProgress): Promise<RigOutput | "timeout"> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"timeout">(resolve => {
      timer = this.deps.setTimer(() => {
        controller.abort();
        resolve("timeout");
      }, limit);
    });
    try { return await Promise.race([this.deps.run(invocation, controller.signal, progress), expired]); }
    finally { if (timer !== undefined) this.deps.clearTimer(timer); }
  }

  // One rig call whose stdout is JSON: the parsed value, or why it failed. stdin is the text a command reads.
  async query<T>(args: string[], schema: z.ZodType<T>, options: RigQueryOptions = {}): Promise<RigResult<T>> {
    const { stdin, limit = RIG_QUERY_LIMIT_MS, progress } = options;
    const invocation = this.invocation(args, stdin);
    if (!invocation.ok) return invocation;
    try {
      const output = await this.limited(invocation.value, limit, progress);
      if (output === "timeout") return { ok: false, error: { kind: "timeout", seconds: limit / MS_PER_SECOND } };
      if (output.code !== 0) {
        const failure = rigErrorObject(output.stdout);
        if (failure) return { ok: false, error: { kind: "rig", code: failure.code, message: failure.message } };
        return { ok: false, error: { kind: "exitCode", code: output.code, output: plainLines(output.stderr) || plainLines(output.stdout) } };
      }
      const parsed = schema.safeParse(JSON.parse(output.stdout));
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: { kind: "invalidJson", message: parsed.error.message } };
    } catch (error) {
      return { ok: false, error: { kind: "failure", message: String(error) } };
    }
  }

  async refresh(): Promise<RigResult<RigFeature[]>> {
    const reply = await this.query(["feature"], featureReplySchema);
    const result: RigResult<RigFeature[]> = reply.ok ? { ok: true, value: reply.value.features } : reply;
    if (result.ok) this.state = { kind: "ready", features: result.value };
    else if (!this.deps.find()) this.state = { kind: "missing" };
    else if (!this.initialized) this.state = { kind: "failed", error: result.error };
    else this.deps.warn(rigErrorText(result.error, en));
    this.initialized = true;
    return result;
  }

  status(): Promise<RigResult<RigStatus>> { return this.query(["status"], statusSchema); }

  private async sessionQuery<T>(sessionId: string, args: string[], schema: z.ZodType<T>, onWaiting?: () => void): Promise<RigResult<T>> {
    if (!SESSION_ID.test(sessionId)) return { ok: false, error: { kind: "badSession" } };
    // cmd.exe cannot represent an embedded line break as an argv value. Refuse it
    // before constructing a command; POSIX passes multiline instructions directly.
    if (args.some(arg => arg.includes("\0") || (this.deps.platform.windows && /[\r\n]/.test(arg)))) {
      return { ok: false, error: { kind: "controlChar" } };
    }
    let waiting = false;
    const progress = (line: string) => {
      if (!waiting && isSessionWaiting(line)) { waiting = true; onWaiting?.(); }
    };
    return this.query(["session", ...args.slice(0, 1), sessionId, ...args.slice(1)], schema, { limit: RIG_SESSION_LIMIT_MS, progress });
  }

  // Free text goes after the fixed words rig's parser expects (src/commands/session-compact.ts and session-rename.ts in
  // agent-rig take the words after "--instructions" / after the id positionally and join them), so a text with a
  // leading "-" is a value there; a "--" or "--instructions=" form would be read by rig as part of the text.
  compact(sessionId: string, instructions?: string, onWaiting?: () => void): Promise<RigResult<RigCompact>> {
    return this.sessionQuery(sessionId, ["compact", ...(instructions ? ["--instructions", instructions] : [])], rigCompactSchema, onWaiting);
  }

  // `window` is an integer string matching ^[1-9][0-9]*$ or "auto" (rig 0.7.2 refuses anything else as usage).
  autocompact(sessionId: string, window: string, onWaiting?: () => void): Promise<RigResult<RigAutocompact>> {
    return this.sessionQuery(sessionId, ["autocompact", window], rigAutocompactSchema, onWaiting);
  }

  rename(sessionId: string, name: string, onWaiting?: () => void): Promise<RigResult<RigRename>> {
    return this.sessionQuery(sessionId, ["rename", name], rigRenameSchema, onWaiting);
  }

  stop(sessionId: string, onWaiting?: () => void): Promise<RigResult<RigStop>> {
    return this.sessionQuery(sessionId, ["stop"], rigStopSchema, onWaiting);
  }

  cleanup(sessionId: string, onWaiting?: () => void): Promise<RigResult<RigCleanup>> {
    return this.sessionQuery(sessionId, ["cleanup"], rigCleanupSchema, onWaiting);
  }

  run(sessionId: string, options: RigRunOptions = {}, onWaiting?: () => void): Promise<RigResult<RigRun>> {
    if (options.account !== undefined && !ACCOUNT.test(options.account)) return Promise.resolve({ ok: false, error: { kind: "badAccount" } });
    if (options.mode !== undefined && !isPermissionMode(options.mode)) return Promise.resolve({ ok: false, error: { kind: "badMode" } });
    return this.sessionQuery(sessionId, ["run", ...(options.mode ? ["--mode", options.mode] : []), ...(options.account ? ["--account", options.account] : [])], rigRunSchema, onWaiting);
  }

  mode(sessionId: string, mode: PermissionMode, onWaiting?: () => void): Promise<RigResult<RigMode>> {
    if (!isPermissionMode(mode)) return Promise.resolve({ ok: false, error: { kind: "badMode" } });
    return this.sessionQuery(sessionId, ["mode", mode], rigModeSchema, onWaiting);
  }

  // What /info draws for one session; the id is checked here because it ends up in a command line.
  async info(sessionId: string): Promise<RigResult<InfoData>> {
    if (!SESSION_ID.test(sessionId)) return { ok: false, error: { kind: "badSession" } };
    // The schema is rig's contract: an answer that breaks it fails as a whole, with the schema's message.
    return this.query(["info", "--session", sessionId], infoDataSchema);
  }

  // The language rig keeps; English when rig is missing or fails in any way.
  async language(): Promise<Language> {
    const result = await this.query(["language"], languageSchema);
    if (result.ok) return result.value.language;
    this.deps.warn(`language: ${rigErrorText(result.error, en)}; using ${DEFAULT_LANGUAGE}`);
    return DEFAULT_LANGUAGE;
  }

  unavailable(name: "pwsh" | "cmd"): string | undefined {
    const m = this.deps.messages();
    if (!this.deps.platform.windows) return m.commandUnavailable({ name });
    if (this.state.kind === "missing") return undefined;
    if (this.state.kind === "loading") return m.rigFeaturesLoading;
    if (this.state.kind === "failed") return rigErrorText(this.state.error, m);
    const feature = this.state.features.find(feature => feature.name === name);
    return feature?.enabled && feature.platformAllowed ? undefined : m.commandDisabled({ name });
  }
}

export function featureText(features: RigFeature[], m: Messages): string {
  return features.map(feature => `${feature.enabled ? "✅" : "⏹"} ${literal(feature.name)}: ${literal(feature.description)}${feature.platformAllowed ? "" : ` ${m.featureNotOnPlatform}`}`).join("\n") || m.featuresEmpty;
}

// A release is read from a commit, so without a commit there is nothing to name.
function versionText(release: string | null, commit: string | null): string {
  if (commit === null) return "—";
  return release === null ? commit : `${release} (${commit})`;
}

export function statusText(status: RigStatus, m: Messages): string {
  return [m.statusMode({ mode: status.mode }), `rig: ${literal(versionText(status.releases.rig, status.versions.rig))}`, `hub: ${literal(versionText(status.releases.hub, status.versions.hub))}`,
    featureText(status.features, m), m.statusLastUpdate({ text: literal(status.lastUpdate?.text ?? "—") }),
    m.statusPendingRestart({ text: literal(status.pendingHubRestart ?? "—") }),
    ...status.errors.map(error => literal(`${error.time} ${error.type}: ${error.text}`))].join("\n");
}
