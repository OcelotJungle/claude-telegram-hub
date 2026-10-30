import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { basename, dirname } from "path";
import { z } from "zod";

const MAX_TOPIC_NAME = 128;
const SEP = " · ";
// A cswap profile folder: <number>-<email>.
const CSWAP_PROFILE = /^(\d+)-/;

// topicId: absent until the session first writes to Telegram (the topic is made then);
// disabledByUser: the user turned the mode off (tg_disable), so an interactive window does not turn it back on.
// cwd and account: where and on which cswap account the session last ran;
// transcript: its transcript file, as Claude Code's hook named it.
// launchedMode and launchedModeOffset: the mode and transcript size at the last mode-specific launch.
export type SessionRecord = {
  topicId?: number;
  title: string;
  project: string;
  enabled: boolean;
  disabledByUser?: boolean;
  cwd?: string;
  account?: string;
  transcript?: string;
  launchedMode?: string;
  launchedModeOffset?: number;
};

const dataSchema: z.ZodType<Record<string, SessionRecord>> = z.record(
  z.string(),
  z.object({
    topicId: z.number().optional(),
    title: z.string(),
    project: z.string(),
    enabled: z.boolean(),
    disabledByUser: z.boolean().optional(),
    cwd: z.string().optional(),
    account: z.string().optional(),
    transcript: z.string().optional(),
    launchedMode: z.string().optional(),
    launchedModeOffset: z.number().optional(),
  }),
);

// The cswap account of a Claude Code config dir (…\sessions\1-me_gmail.com → "1").
export function accountOf(configDir: string | undefined): string | undefined {
  return configDir ? basename(configDir).match(CSWAP_PROFILE)?.[1] : undefined;
}

// sessionId → topic. Only the hub writes it; a session keeps its topic forever.
export class SessionStore {
  private data: Record<string, SessionRecord> = {};

  constructor(private file: string) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      return;
    }
    try {
      this.data = dataSchema.parse(JSON.parse(raw));
    } catch {
      try {
        renameSync(file, `${file}.corrupt-${Date.now()}`);
      } catch {}
    }
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.data[sessionId];
  }

  findByTopic(topicId: number): string | undefined {
    for (const [id, rec] of Object.entries(this.data)) if (rec.topicId === topicId) return id;
    return undefined;
  }

  set(sessionId: string, rec: SessionRecord): void {
    this.data[sessionId] = rec;
    this.save();
  }

  setTopicId(sessionId: string, topicId: number): void {
    const rec = this.data[sessionId];
    if (!rec) return;
    this.data[sessionId] = { ...rec, topicId };
    this.save();
  }

  setTitle(sessionId: string, title: string): void {
    const rec = this.data[sessionId];
    if (!rec || rec.title === title) return;
    this.data[sessionId] = { ...rec, title };
    this.save();
  }

  // Remembers where the session runs now; unknown values keep the old ones.
  setWhere(sessionId: string, cwd: string | undefined, account: string | undefined): void {
    const rec = this.data[sessionId];
    if (!rec) return;
    const next = { ...rec, ...(cwd ? { cwd } : {}), ...(account ? { account } : {}) };
    if (next.cwd === rec.cwd && next.account === rec.account) return;
    this.data[sessionId] = next;
    this.save();
  }

  setTranscript(sessionId: string, path: string): void {
    const rec = this.data[sessionId];
    if (!rec || rec.transcript === path) return;
    this.data[sessionId] = { ...rec, transcript: path };
    this.save();
  }

  // A start without a mode forgets the last one: the window no longer runs it.
  setLaunchedMode(sessionId: string, mode: string | undefined, offset: number): void {
    const rec = this.data[sessionId];
    if (!rec) return;
    const { launchedMode: _mode, launchedModeOffset: _offset, ...rest } = rec;
    this.data[sessionId] = mode ? { ...rest, launchedMode: mode, launchedModeOffset: offset } : rest;
    this.save();
  }

  // byUser: the user's own tg_disable. It is kept until the mode is turned on again.
  setEnabled(sessionId: string, on: boolean, byUser = false): void {
    const rec = this.data[sessionId];
    if (!rec) return;
    const next: SessionRecord = { ...rec, enabled: on };
    if (on) delete next.disabledByUser;
    else if (byUser) next.disabledByUser = true;
    if (next.enabled === rec.enabled && next.disabledByUser === rec.disabledByUser) return;
    this.data[sessionId] = next;
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n");
    renameSync(tmp, this.file);
  }
}

export function topicName(project: string, title: string): string {
  const t = title.trim() || "без названия";
  const name = `${project}${SEP}${t}`;
  if (name.length <= MAX_TOPIC_NAME) return name;
  return name.slice(0, MAX_TOPIC_NAME - 1) + "…";
}
