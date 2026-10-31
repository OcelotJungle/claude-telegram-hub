import type { Platform } from "../shared/platform.ts";

import { spawn } from "child_process";
import { homedir } from "os";
import { z } from "zod";
import { PLATFORM } from "../shared/platform.ts";

const FEATURE_NAME = /^[a-z][a-z0-9-]*$/;
// rig feature --json and rig status --json take no lock, so they answer fast; a longer one is a failure.
export const RIG_QUERY_LIMIT_MS = 30_000;
export const RIG_MISSING = "rig не установлен на этой машине";
const featureSchema = z.strictObject({ name: z.string().regex(FEATURE_NAME), description: z.string(), enabled: z.boolean(), platformAllowed: z.boolean() });
export const featuresSchema = z.array(featureSchema);
const eventSchema = z.object({ type: z.string(), time: z.string(), text: z.string() });
export const statusSchema = z.strictObject({
  schemaVersion: z.literal(1), mode: z.enum(["dev", "server"]),
  versions: z.strictObject({ rig: z.string().nullable(), hub: z.string().nullable() }),
  features: featuresSchema, lastUpdate: eventSchema.nullable(),
  // The saved state is a string in the contract; it is displayed, never interpreted.
  pendingHubRestart: z.string().nullable(), errors: z.array(eventSchema),
});
export type RigFeature = z.infer<typeof featureSchema>;
export type RigStatus = z.infer<typeof statusSchema>;
export type RigInvocation = { argv: string[]; verbatim: boolean };
export type RigResult<T> = { ok: true; value: T } | { ok: false; error: string };
export type RigOutput = { code: number; stdout: string; stderr: string };
export type FeatureState = { kind: "missing" } | { kind: "ready"; features: RigFeature[] } | { kind: "failed"; error: string };
export type MachineCommand = { name: "feature" | "rig"; args: string };
export type RigAction = { kind: "features" } | { kind: "status" } | { kind: "mutate"; args: string[]; confirm: boolean };

export function rigAction(command: MachineCommand): RigResult<RigAction> {
  const args = command.args.trim().split(/\s+/).filter(Boolean);
  if (command.name === "feature") {
    if (!args.length) return { ok: true, value: { kind: "features" } };
    const [name, action] = args;
    if (args.length === 2 && name && FEATURE_NAME.test(name) && (action === "enable" || action === "disable")) {
      return { ok: true, value: { kind: "mutate", args: ["feature", name, action], confirm: name === "telegram" && action === "disable" } };
    }
    return { ok: false, error: "Используй /feature или /feature <name> enable|disable" };
  }
  if (args.length === 1 && args[0] === "status") return { ok: true, value: { kind: "status" } };
  if (args.length === 1 && args[0] === "update") return { ok: true, value: { kind: "mutate", args: ["update"], confirm: false } };
  return { ok: false, error: "Используй /rig status или /rig update" };
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
  }) {
    if (deps.find()) this.state = { kind: "failed", error: "Состояние фич rig ещё загружается" };
  }

  invocation(args: string[]): RigResult<RigInvocation> {
    const file = this.deps.find();
    if (!file) return { ok: false, error: RIG_MISSING };
    // cmd.exe expands %NAME% even inside quotes, so such a path cannot be passed safely.
    if (this.deps.platform.windows && file.includes("%")) return { ok: false, error: `rig: путь с «%» нельзя передать в cmd.exe: ${file}` };
    return { ok: true, value: rigInvocation(file, args, this.deps.platform) };
  }

  // A query that runs longer than the limit is aborted and counts as a failure.
  private async limited(invocation: RigInvocation): Promise<RigOutput> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<RigOutput>(resolve => {
      timer = this.deps.setTimer(() => {
        controller.abort();
        resolve({ code: 1, stdout: "", stderr: `запрос дольше ${RIG_QUERY_LIMIT_MS / 1000} с` });
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
      if (output.code !== 0) return { ok: false, error: `rig: код ${output.code}: ${output.stderr || output.stdout}` };
      const parsed = schema.safeParse(JSON.parse(output.stdout));
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: `rig: неверный JSON: ${parsed.error.message}` };
    } catch (error) {
      return { ok: false, error: `rig: ${String(error)}` };
    }
  }

  async refresh(): Promise<RigResult<RigFeature[]>> {
    const result = await this.query(["feature", "--json"], featuresSchema);
    if (result.ok) this.state = { kind: "ready", features: result.value };
    else if (result.error === RIG_MISSING) this.state = { kind: "missing" };
    else if (!this.initialized) this.state = { kind: "failed", error: result.error };
    else this.deps.warn(result.error);
    this.initialized = true;
    return result;
  }

  status(): Promise<RigResult<RigStatus>> { return this.query(["status", "--json"], statusSchema); }

  unavailable(name: "pwsh" | "cmd"): string | undefined {
    if (!this.deps.platform.windows) return `/${name} недоступна на этой платформе`;
    if (this.state.kind === "missing") return undefined;
    if (this.state.kind === "failed") return this.state.error;
    const feature = this.state.features.find(feature => feature.name === name);
    return feature?.enabled && feature.platformAllowed ? undefined : `/${name} выключена или недоступна. Включить: /feature ${name} enable`;
  }
}

export function featureText(features: RigFeature[]): string {
  return features.map(feature => `${feature.enabled ? "✅" : "⏹"} ${feature.name}: ${feature.description}${feature.platformAllowed ? "" : " (недоступна на этой платформе)"}`).join("\n") || "Список фич пуст";
}

export function statusText(status: RigStatus): string {
  return [`Режим: ${status.mode}`, `rig: ${status.versions.rig ?? "—"}`, `hub: ${status.versions.hub ?? "—"}`,
    featureText(status.features), `Последнее обновление: ${status.lastUpdate?.text ?? "—"}`,
    `Ожидаемый перезапуск: ${status.pendingHubRestart ?? "—"}`,
    ...status.errors.map(error => `${error.time} ${error.type}: ${error.text}`)].join("\n");
}
