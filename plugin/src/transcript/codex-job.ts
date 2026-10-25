import type { Logger } from "../shared/log.ts";

import { readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { TranscriptTailer } from "./tail.ts";

const JOB = "\\d{8}-\\d{6}-[0-9a-f]+";
const STARTED = new RegExp(`\\bjob (${JOB}) started:`);
const ATTACHED = new RegExp(`(?:^|[\\s/\\\\\"'])codex-run\\.py[\"']?\\s+(?:reply|attach|wait)\\s+(${JOB})\\b`);
const WORKER_TEXT = new RegExp(`^(?:codex job |job ${JOB} (?:started|resumed with the reply))`);
const NOTE = /^([01]\d|2[0-3]):([0-5]\d)\s+(.+)$/;
const FAILURE_STATUSES = new Set(["failed", "orphaned", "limit", "cancelled"]);

const stateSchema = z.object({
  status: z.union([z.literal("starting"), z.literal("running"), z.literal("done"), z.literal("question"), z.literal("failed"), z.literal("cancelled"), z.literal("orphaned"), z.literal("limit")]),
  slug: z.string(),
  effort: z.string(),
  notes: z.array(z.string()).default([]),
  error: z.string().nullable().optional(),
});
const eventSchema = z.object({ type: z.string(), item: z.unknown().optional() });
const itemSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent_message"), text: z.string() }),
  z.object({ type: z.literal("reasoning"), text: z.string() }),
  z.object({ type: z.literal("command_execution"), id: z.string(), command: z.string() }),
]);
const textBlockSchema = z.object({ type: z.literal("text"), text: z.string() });
const toolSchema = z.object({ type: z.literal("tool_use"), name: z.literal("Bash"), input: z.object({ command: z.string() }) });
const resultSchema = z.object({ type: z.literal("tool_result"), content: z.union([z.string(), z.array(z.unknown())]) });
const recordSchema = z.object({ type: z.string(), message: z.object({ content: z.array(z.unknown()) }) });

export type CodexDiscovery = { id: string; fromStart: boolean };
export type CodexEntry = { at: number; text: string };

// Keep the full command: the transcript parser's display detail is truncated.
export function discoverCodexJob(record: unknown): CodexDiscovery | undefined {
  const parsed = recordSchema.safeParse(record);
  if (!parsed.success) return undefined;
  for (const block of parsed.data.message.content) {
    if (parsed.data.type === "assistant") {
      const tool = toolSchema.safeParse(block);
      const id = tool.success ? tool.data.input.command.match(ATTACHED)?.[1] : undefined;
      if (id) return { id, fromStart: false };
    } else if (parsed.data.type === "user") {
      const result = resultSchema.safeParse(block);
      if (!result.success) continue;
      const content = result.data.content;
      const text = typeof content === "string" ? content : content.flatMap(b => {
        const parsed = textBlockSchema.safeParse(b);
        return parsed.success ? [parsed.data.text] : [];
      }).join("\n");
      const id = text.match(STARTED)?.[1];
      if (id) return { id, fromStart: true };
    }
  }
  return undefined;
}

export function isCodexWorkerSummary(text: string): boolean {
  return WORKER_TEXT.test(text.trimStart());
}

// Polls one job; owning an instance captures the reply's event and note boundary
// even when the agent's meta file has not arrived yet.
export class CodexJob {
  state: z.infer<typeof stateSchema> | undefined;
  commands = 0;
  eventAt: number | undefined;
  private tailer: TranscriptTailer;
  private pending: CodexEntry | undefined;
  private entries: CodexEntry[] = [];
  private running = new Map<string, string>();
  private notes: string[] | undefined;
  private error: string | undefined;

  constructor(
    readonly discovery: CodexDiscovery,
    private dir: string,
    private now: () => number,
    log: Logger,
  ) {
    this.tailer = new TranscriptTailer({
      path: join(dir, discovery.id, "events.jsonl"),
      fromStart: discovery.fromStart,
      onRecord: record => this.feed(record),
      log,
    });
    this.tailer.open();
    this.readState();
  }

  get currentCommand(): string | undefined {
    return [...this.running.values()].at(-1);
  }

  poll(): CodexEntry[] {
    this.readState();
    if (this.state) this.tailer.pollNow();
    return this.entries.splice(0);
  }

  private readState(): void {
    try {
      const parsed = stateSchema.safeParse(JSON.parse(readFileSync(join(this.dir, this.discovery.id, "state.json"), "utf8")));
      if (!parsed.success) return;
      const state = parsed.data;
      // A reply can see the previous run's failure before the runner resets it.
      if (!this.state && !this.discovery.fromStart) this.error = state.error ?? undefined;
      // Notes are append-only; compare their prefix so duplicate note strings
      // appended by the runner still produce separate entries.
      const old = this.notes ?? (this.discovery.fromStart ? [] : state.notes);
      let common = 0;
      while (common < old.length && old[common] === state.notes[common]) common++;
      for (const note of state.notes.slice(common)) {
        const match = note.match(NOTE);
        const [, hours, minutes, text] = match ?? [];
        if (hours === undefined || minutes === undefined || text === undefined) continue;
        const at = new Date(this.now());
        at.setHours(Number(hours), Number(minutes));
        this.entries.push({ at: at.getTime(), text: `🔁 ${text}` });
      }
      this.notes = state.notes;
      if (!FAILURE_STATUSES.has(state.status)) this.error = undefined;
      else if (state.error && state.error !== this.error) {
        this.entries.push({ at: this.now(), text: `❌ ${state.error}` });
        this.error = state.error;
      }
      this.state = state;
    } catch {
      // An absent or invalid state leaves the ordinary worker card available.
    }
  }

  private feed(record: unknown): void {
    const parsed = eventSchema.safeParse(record);
    if (!parsed.success) return;
    const event = parsed.data;
    const at = this.now();
    this.eventAt = at;
    const parsedItem = itemSchema.safeParse(event.item);
    // Bookkeeping after the final report does not mean the run continued.
    const continued = event.type === "turn.started" || event.type === "turn.failed" || event.type === "item.started" || (event.type === "item.completed" && parsedItem.success);
    if (this.pending && continued) this.entries.push(this.pending);
    if (continued || event.type === "turn.completed") this.pending = undefined;
    if (!parsedItem.success) return;
    const item = parsedItem.data;
    if (item.type === "command_execution") {
      if (event.type === "item.started") {
        this.running.delete(item.id);
        this.running.set(item.id, item.command);
      } else if (event.type === "item.completed") {
        this.commands++;
        this.running.delete(item.id);
      }
    } else if (event.type === "item.completed" && item.type === "agent_message" && item.text.trim()) {
      this.pending = { at, text: item.text };
    }
  }
}
