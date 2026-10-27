import type { VolunteerLimitsResult } from "../shared/protocol.ts";

import { homedir } from "os";
import { join } from "path";
import { z } from "zod";
import { existsSync } from "fs";

const SCRIPT_TIMEOUT_MS = 5_000;
const MS_PER_SECOND = 1_000;
const PROVIDER_NAMES: Record<string, string> = {
  openrouter: "OpenRouter",
  requesty: "Requesty",
  groq: "Groq",
  // Not "Z.ai": Telegram turns a domain-like name into a link.
  zhipu: "Zhipu",
};

const commonScriptOutput = {
  checked_at: z.string().refine((v) => Number.isFinite(Date.parse(v))),
  error: z.string().nullable(),
};
const providerSchema = z.record(
  z.string(),
  z.object({
    used: z.number().nonnegative(),
    cap: z.number().nonnegative().nullable(),
  })
);
const scriptOutputSchema = z.discriminatedUnion("source", [
  z.object({
    ...commonScriptOutput,
    source: z.enum(["proxy", "quota-file"]),
    day_percent: z.number().nonnegative(),
    used: z.number().nonnegative(),
    cap: z.number().nonnegative().nullable(),
    reset_in_s: z.number().int().nonnegative(),
    providers: providerSchema,
  }),
  z.object({
    ...commonScriptOutput,
    source: z.literal("none"),
    day_percent: z.null(),
    used: z.null(),
    cap: z.null(),
    reset_in_s: z.null(),
    providers: providerSchema.nullable(),
  }),
]);

export class VolunteerLimits {
  constructor(
    private scriptPath: string = join(homedir(), ".claude", "tools", "volunteer-models.py"),
    private command: string[] = ["python", "-I"],
    private timeoutMs: number = SCRIPT_TIMEOUT_MS
  ) {}

  async read(): Promise<VolunteerLimitsResult> {
    try {
      if (!existsSync(this.scriptPath)) {
        return { kind: "none" };
      }
      const args = [...this.command.slice(1), this.scriptPath, "limits", "--json"];
      const proc = Bun.spawn([this.command[0], ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          proc.kill();
          reject(new Error("timeout"));
        }, this.timeoutMs);
      });

      try {
        const [stdout, stderr] = await Promise.race([
          Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]),
          timeout,
        ]);

        const exitCode = await proc.exited;

        if (exitCode !== 0) {
          return { kind: "error", reason: `script exited with code ${exitCode}: ${stderr.trim() || "no stderr"}` };
        }

        const parsed = scriptOutputSchema.safeParse(JSON.parse(stdout));
        if (!parsed.success) {
          return { kind: "error", reason: "bad JSON from script" };
        }

        const data = parsed.data;

        if (data.source === "none") {
          return { kind: "error", reason: data.error ?? "no data source" };
        }

        const at = Date.parse(data.checked_at);
        const resetsAt = at + data.reset_in_s * MS_PER_SECOND;

        // A provider whose cap is unknown says nothing about how much is left.
        const providers = Object.entries(data.providers).flatMap(([key, value]) =>
          value.cap === null ? [] : [{ name: PROVIDER_NAMES[key] ?? key, used: value.used, cap: value.cap }]
        );

        return {
          kind: "ok",
          at,
          dayPercent: data.day_percent,
          resetsAt,
          providers,
        };
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      }
    } catch (e) {
      if (e instanceof Error && e.message === "timeout") {
        return { kind: "error", reason: "timeout" };
      }
      return { kind: "error", reason: e instanceof Error ? e.message : String(e) };
    }
  }
}
