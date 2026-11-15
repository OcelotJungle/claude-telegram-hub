// rig info --session <id>: the data /info draws. The shape is rig's InfoData (its src/info-data.ts);
// the hub validates rig's answer with its zod schema (hub/info-schema.ts) and hands the window the validated
// object; the window checks only the shape it reads (parseInfoData). No value imports from outside the shared folder.
import { field, isObject, str } from "./guards.ts";

// rig's limit on a query; the window's wait for the hub is derived from it.
export const RIG_QUERY_LIMIT_MS = 30_000;

export type BlockError = { error: { code: string; message: string } };
export type Block<T> = T | BlockError;
export type ClaudeLimit = { kind: string; percentUsed: number; resetsAt: string | null };
export type ClaudeInfo = { at: string | null; sessionId: string; limits: ClaudeLimit[] };
export type CodexLimit = { windowMinutes: number; usedPercent: number; resetsAt: string | null };
export type CodexInfo = { at: string; limits: CodexLimit[] };
export type VolunteerProvider = { used: number; cap: number | null };
export type VolunteerInfo = {
  at: string;
  source: string;
  dayPercent: number;
  used: number | null;
  cap: number | null;
  resetsAt: string | null;
  providers: Record<string, VolunteerProvider>;
};
export type ContextInfo = { at: string | null; tokens: number; window: number | null; threshold?: number; autocompact?: boolean; estimated?: true };
// codex and volunteers are absent when rig does not allow them on this machine.
export type InfoData = {
  session: string;
  account: number | null;
  claude: Block<ClaudeInfo>;
  codex?: Block<CodexInfo>;
  volunteers?: Block<VolunteerInfo>;
  context: Block<ContextInfo>;
};

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function nullableStr(v: unknown): string | null | undefined {
  return v === null ? null : str(v);
}

function nullableNum(v: unknown): number | null | undefined {
  return v === null ? null : num(v);
}

export function isBlockError(v: unknown): v is BlockError {
  const error = field(v, "error");
  return isObject(error) && typeof error["code"] === "string" && typeof error["message"] === "string";
}

function claudeLimit(v: unknown): ClaudeLimit | undefined {
  const kind = str(field(v, "kind"));
  const percentUsed = num(field(v, "percentUsed"));
  const resetsAt = nullableStr(field(v, "resetsAt"));
  return kind === undefined || percentUsed === undefined || resetsAt === undefined ? undefined : { kind, percentUsed, resetsAt };
}

function codexLimit(v: unknown): CodexLimit | undefined {
  const windowMinutes = num(field(v, "windowMinutes"));
  const usedPercent = num(field(v, "usedPercent"));
  const resetsAt = nullableStr(field(v, "resetsAt"));
  return windowMinutes === undefined || usedPercent === undefined || resetsAt === undefined ? undefined : { windowMinutes, usedPercent, resetsAt };
}

// Every element must pass: a half-read list would draw a wrong picture.
function all<T>(items: unknown[], read: (v: unknown) => T | undefined): T[] | undefined {
  const out: T[] = [];
  for (const item of items) {
    const value = read(item);
    if (value === undefined) return undefined;
    out.push(value);
  }
  return out;
}

function claudeInfo(v: unknown): ClaudeInfo | undefined {
  const at = nullableStr(field(v, "at"));
  const sessionId = str(field(v, "sessionId"));
  const raw = field(v, "limits");
  const limits = Array.isArray(raw) ? all(raw, claudeLimit) : undefined;
  return at === undefined || sessionId === undefined || limits === undefined ? undefined : { at, sessionId, limits };
}

function codexInfo(v: unknown): CodexInfo | undefined {
  const at = str(field(v, "at"));
  const raw = field(v, "limits");
  const limits = Array.isArray(raw) ? all(raw, codexLimit) : undefined;
  return at === undefined || limits === undefined ? undefined : { at, limits };
}

function volunteerProviders(v: unknown): Record<string, VolunteerProvider> | undefined {
  if (!isObject(v)) return undefined;
  const out: Record<string, VolunteerProvider> = {};
  for (const [name, provider] of Object.entries(v)) {
    const used = num(field(provider, "used"));
    const cap = nullableNum(field(provider, "cap"));
    if (used === undefined || cap === undefined) return undefined;
    out[name] = { used, cap };
  }
  return out;
}

function volunteerInfo(v: unknown): VolunteerInfo | undefined {
  const at = str(field(v, "at"));
  const source = str(field(v, "source"));
  const dayPercent = num(field(v, "dayPercent"));
  const used = nullableNum(field(v, "used"));
  const cap = nullableNum(field(v, "cap"));
  const resetsAt = nullableStr(field(v, "resetsAt"));
  const providers = volunteerProviders(field(v, "providers"));
  if (at === undefined || source === undefined || dayPercent === undefined || used === undefined || cap === undefined || resetsAt === undefined || providers === undefined) return undefined;
  return { at, source, dayPercent, used, cap, resetsAt, providers };
}

function contextInfo(v: unknown): ContextInfo | undefined {
  const at = nullableStr(field(v, "at"));
  const tokens = num(field(v, "tokens"));
  const window = nullableNum(field(v, "window"));
  if (at === undefined || tokens === undefined || window === undefined) return undefined;
  const info: ContextInfo = { at, tokens, window };
  const threshold = field(v, "threshold");
  if (threshold !== undefined) {
    const value = num(threshold);
    if (value === undefined) return undefined;
    info.threshold = value;
  }
  const autocompact = field(v, "autocompact");
  if (autocompact !== undefined) {
    if (typeof autocompact !== "boolean") return undefined;
    info.autocompact = autocompact;
  }
  const estimated = field(v, "estimated");
  if (estimated !== undefined) {
    if (estimated !== true) return undefined;
    info.estimated = true;
  }
  return info;
}

function block<T>(v: unknown, read: (v: unknown) => T | undefined): Block<T> | undefined {
  return isBlockError(v) ? { error: { code: v.error.code, message: v.error.message } } : read(v);
}

// Undefined when the answer is not an InfoData: the caller shows its own failure text.
export function parseInfoData(v: unknown): InfoData | undefined {
  const session = str(field(v, "session"));
  const account = nullableNum(field(v, "account"));
  const claude = block(field(v, "claude"), claudeInfo);
  const context = block(field(v, "context"), contextInfo);
  if (session === undefined || account === undefined || claude === undefined || context === undefined) return undefined;
  const info: InfoData = { session, account, claude, context };
  const rawCodex = field(v, "codex");
  if (rawCodex !== undefined) {
    const codex = block(rawCodex, codexInfo);
    if (codex === undefined) return undefined;
    info.codex = codex;
  }
  const rawVolunteers = field(v, "volunteers");
  if (rawVolunteers !== undefined) {
    const volunteers = block(rawVolunteers, volunteerInfo);
    if (volunteers === undefined) return undefined;
    info.volunteers = volunteers;
  }
  return info;
}
