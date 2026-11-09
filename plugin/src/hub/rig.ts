import type { Language, Messages } from "../shared/i18n/index.ts";
import type { Platform } from "../shared/platform.ts";

import { spawn } from "child_process";
import { homedir } from "os";
import { z } from "zod";
import { en } from "../shared/i18n/en.ts";
import { DEFAULT_LANGUAGE, isLanguage } from "../shared/i18n/index.ts";
import { LANGUAGES } from "../shared/protocol.ts";
import { PLATFORM } from "../shared/platform.ts";

const MS_PER_SECOND = 1000;
const FEATURE_NAME = /^[a-z][a-z0-9-]*$/;
// rig feature --json, rig status --json and rig language --json take no lock, so they answer fast; a longer one is a failure.
export const RIG_QUERY_LIMIT_MS = 30_000;
const languageSchema = z.strictObject({ language: z.enum(LANGUAGES) });
const featureSchema = z.strictObject({ name: z.string().regex(FEATURE_NAME), description: z.string(), enabled: z.boolean(), platformAllowed: z.boolean() });
export const featuresSchema = z.array(featureSchema);
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
export type RigInvocation = { argv: string[]; verbatim: boolean };
export type RigResult<T, E = RigError> = { ok: true; value: T } | { ok: false; error: E };
// Why a rig call failed, as data: the text is made from it by the catalog current when it is shown.
export type RigError =
  | { kind: "missing" }
  | { kind: "percentPath"; file: string }
  | { kind: "timeout"; seconds: number }
  | { kind: "exitCode"; code: number; output: string }
  | { kind: "invalidJson"; message: string }
  | { kind: "failure"; message: string };
export type RigOutput = { code: number; stdout: string; stderr: string };
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

// The arguments come only from rigAction or fixed JSON queries, never shell text.
export function rigInvocation(file: string, args: string[], platform: Platform = PLATFORM): RigInvocation {
  return platform.windows
    ? { argv: ["cmd.exe", "/d", "/s", "/c", `""${file}" ${args.join(" ")}"`], verbatim: true }
    : { argv: [file, ...args], verbatim: false };
}

export function runRig(invocation: RigInvocation, signal?: AbortSignal): Promise<RigOutput> {
  return new Promise(resolve => {
    const [file, ...args] = invocation.argv;
    if (!file) return resolve({ code: 1, stdout: "", stderr: "empty rig invocation" });
    const child = spawn(file, args, { windowsHide: true, windowsVerbatimArguments: invocation.verbatim, signal, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (data: Buffer) => out.push(data));
    child.stderr.on("data", (data: Buffer) => err.push(data));
    child.on("error", error => resolve({ code: 1, stdout: "", stderr: error.message }));
    child.on("close", code => resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
  });
}

export class Rig {
  state: FeatureState = { kind: "missing" };
  private initialized = false;

  constructor(private deps: {
    find(): string | undefined; platform: Platform; run(invocation: RigInvocation, signal?: AbortSignal): Promise<RigOutput>; warn(text: string): void;
    setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout>; clearTimer(handle: ReturnType<typeof setTimeout>): void;
    // The catalog of the hub's current language, for the errors that reach Telegram.
    messages(): Messages;
  }) {
    if (deps.find()) this.state = { kind: "loading" };
  }

  invocation(args: string[]): RigResult<RigInvocation> {
    const file = this.deps.find();
    if (!file) return { ok: false, error: { kind: "missing" } };
    // cmd.exe expands %NAME% even inside quotes, so such a path cannot be passed safely.
    if (this.deps.platform.windows && file.includes("%")) return { ok: false, error: { kind: "percentPath", file } };
    return { ok: true, value: rigInvocation(file, args, this.deps.platform) };
  }

  // A query that runs longer than the limit is aborted and counts as a failure.
  private async limited(invocation: RigInvocation): Promise<RigOutput | "timeout"> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"timeout">(resolve => {
      timer = this.deps.setTimer(() => {
        controller.abort();
        resolve("timeout");
      }, RIG_QUERY_LIMIT_MS);
    });
    try { return await Promise.race([this.deps.run(invocation, controller.signal), expired]); }
    finally { if (timer !== undefined) this.deps.clearTimer(timer); }
  }

  private async query<T>(args: string[], schema: z.ZodType<T>): Promise<RigResult<T>> {
    const invocation = this.invocation(args);
    if (!invocation.ok) return invocation;
    try {
      const output = await this.limited(invocation.value);
      if (output === "timeout") return { ok: false, error: { kind: "timeout", seconds: RIG_QUERY_LIMIT_MS / MS_PER_SECOND } };
      if (output.code !== 0) return { ok: false, error: { kind: "exitCode", code: output.code, output: output.stderr || output.stdout } };
      const parsed = schema.safeParse(JSON.parse(output.stdout));
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: { kind: "invalidJson", message: parsed.error.message } };
    } catch (error) {
      return { ok: false, error: { kind: "failure", message: String(error) } };
    }
  }

  async refresh(): Promise<RigResult<RigFeature[]>> {
    const result = await this.query(["feature", "--json"], featuresSchema);
    if (result.ok) this.state = { kind: "ready", features: result.value };
    else if (!this.deps.find()) this.state = { kind: "missing" };
    else if (!this.initialized) this.state = { kind: "failed", error: result.error };
    else this.deps.warn(rigErrorText(result.error, en));
    this.initialized = true;
    return result;
  }

  status(): Promise<RigResult<RigStatus>> { return this.query(["status", "--json"], statusSchema); }

  // The language rig keeps; English when rig is missing or fails in any way.
  async language(): Promise<Language> {
    const result = await this.query(["language", "--json"], languageSchema);
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
  return features.map(feature => `${feature.enabled ? "✅" : "⏹"} ${feature.name}: ${feature.description}${feature.platformAllowed ? "" : ` ${m.featureNotOnPlatform}`}`).join("\n") || m.featuresEmpty;
}

// A release is read from a commit, so without a commit there is nothing to name.
function versionText(release: string | null, commit: string | null): string {
  if (commit === null) return "—";
  return release === null ? commit : `${release} (${commit})`;
}

export function statusText(status: RigStatus, m: Messages): string {
  return [m.statusMode({ mode: status.mode }), `rig: ${versionText(status.releases.rig, status.versions.rig)}`, `hub: ${versionText(status.releases.hub, status.versions.hub)}`,
    featureText(status.features, m), m.statusLastUpdate({ text: status.lastUpdate?.text ?? "—" }),
    m.statusPendingRestart({ text: status.pendingHubRestart ?? "—" }),
    ...status.errors.map(error => `${error.time} ${error.type}: ${error.text}`)].join("\n");
}
