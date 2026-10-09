import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";

export type SessionRecord = { topicId: number; title: string; project: string; enabled: boolean };

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
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) this.data = parsed;
      else throw new Error("not an object");
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

  setEnabled(sessionId: string, on: boolean): void {
    const rec = this.data[sessionId];
    if (!rec || rec.enabled === on) return;
    rec.enabled = on;
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n");
    renameSync(tmp, this.file);
  }
}

const MAX_TOPIC_NAME = 128;
const SEP = " · ";

export function topicName(project: string, title: string): string {
  const t = title.trim() || "без названия";
  const name = `${project}${SEP}${t}`;
  if (name.length <= MAX_TOPIC_NAME) return name;
  return name.slice(0, MAX_TOPIC_NAME - 1) + "…";
}
