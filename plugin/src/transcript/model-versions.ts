import type { Logger } from "../shared/log.ts";

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { dirname } from "path";
import { z } from "zod";
import { field } from "../shared/guards.ts";
import { nullLogger } from "../shared/log.ts";

// claude-opus-5-5, claude-haiku-4-5-20251001: line "opus", version "5.5".
const CLAUDE_MODEL = /^claude-([a-z]+)-(\d+)-(\d+)\b/;
// gpt-6.1-sol, gpt-6-luna: line "sol", version "6.1".
const CODEX_MODEL = /^gpt-(\d+(?:\.\d+)*)-([a-z]+)$/;
const versionsSchema = z.record(z.string(), z.string());

// A model as its line and version, as Claude and Codex name theirs; any
// other name is kept whole.
export type Model = { kind: "claude" | "codex"; line: string; version: string } | { kind: "other"; name: string };

export function claudeModel(id: string): Model {
  const [, line, major, minor] = id.match(CLAUDE_MODEL) ?? [];
  return line && major && minor ? { kind: "claude", line, version: `${major}.${minor}` } : { kind: "other", name: id };
}

export function codexModel(slug: string): Model {
  const [, version, line] = slug.match(CODEX_MODEL) ?? [];
  return line && version ? { kind: "codex", line, version } : { kind: "other", name: slug };
}

// The model of an assistant record and the effort it answered with; Claude
// Code's own messages carry the model "<synthetic>".
export function recordModel(rec: unknown): { model: Model; effort: string | undefined } | undefined {
  const id = field(field(rec, "message"), "model");
  if (field(rec, "type") !== "assistant" || typeof id !== "string" || !id || id.startsWith("<")) return undefined;
  const effort = field(rec, "effort");
  return { model: claudeModel(id), effort: typeof effort === "string" && effort ? effort : undefined };
}

// The newest version seen of each model line, shared by every window through
// a file: a card names a model by its line alone ("opus") while its version
// is the newest seen, and with the version ("haiku 4.5") once a newer one
// was. Without a file it remembers for this process only.
export class ModelVersions {
  private latest: Record<string, string> = {};
  private readAt: number | undefined;

  constructor(
    private file?: string,
    private log: Logger = nullLogger,
  ) {
    this.refresh();
  }

  see(m: Model): void {
    if (m.kind === "other") return;
    this.refresh();
    const key = `${m.kind}:${m.line}`;
    const known = this.latest[key];
    if (known !== undefined && compareVersions(m.version, known) <= 0) return;
    this.latest[key] = m.version;
    this.save(key, m.version);
  }

  label(m: Model): string {
    if (m.kind === "other") return m.name;
    this.see(m);
    const known = this.latest[`${m.kind}:${m.line}`];
    return known !== undefined && compareVersions(m.version, known) < 0 ? `${m.line} ${m.version}` : m.line;
  }

  // Another window may have seen a newer version: the file is read again
  // whenever it changed.
  private refresh(): void {
    if (!this.file) return;
    let mtime: number;
    try {
      mtime = statSync(this.file).mtimeMs;
    } catch {
      return;
    }
    if (mtime === this.readAt) return;
    this.readAt = mtime;
    const read = this.read();
    for (const [key, version] of Object.entries(read)) {
      const known = this.latest[key];
      if (known === undefined || compareVersions(version, known) > 0) this.latest[key] = version;
    }
  }

  private read(): Record<string, string> {
    if (!this.file) return {};
    try {
      const parsed = versionsSchema.safeParse(JSON.parse(readFileSync(this.file, "utf8")));
      if (parsed.success) return parsed.data;
      this.log.warn(`${this.file}: not a map of model versions; starting over`);
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) this.log.warn(`reading ${this.file} failed: ${e}`);
    }
    return {};
  }

  // Written whole through a temporary file, merged with what other windows
  // wrote meanwhile.
  private save(key: string, version: string): void {
    if (!this.file) return;
    const all = { ...this.read(), [key]: version };
    for (const [k, v] of Object.entries(this.latest)) {
      const known = all[k];
      if (known === undefined || compareVersions(v, known) > 0) all[k] = v;
    }
    this.latest = all;
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
      renameSync(tmp, this.file);
      this.readAt = statSync(this.file).mtimeMs;
    } catch (e) {
      this.log.warn(`writing ${this.file} failed: ${e}`);
    }
  }
}

// Dotted versions compared number by number: 5.5 < 5.10, 6 = 6.0.
export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}
