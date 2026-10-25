import type { ChimeKind } from "../shared/chime.ts";
import type { Logger } from "../shared/log.ts";
import type { ChannelMeta, HubToPlugin, PermissionBehavior } from "../shared/protocol.ts";
import type { TranscriptEvent } from "../transcript/parse.ts";
import type { Outgoing } from "../transcript/relay.ts";
import type { Titles } from "../transcript/tail.ts";

import { randomUUID } from "crypto";
import { copyFileSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { playChime } from "../shared/chime.ts";
import { isInside, loadConfig } from "../shared/config.ts";
import { toTelegram } from "../shared/markdown.ts";
import { BYTES_PER_MB, MAX_CAPTION, MAX_UPLOAD } from "../shared/media.ts";
import { PROTOCOL_VERSION } from "../shared/protocol.ts";
import { enableResult } from "../shared/protocol-schema.ts";
import { transcriptPathFor } from "../transcript/locate.ts";
import { ModelVersions, recordModel } from "../transcript/model-versions.ts";
import { parseRecord } from "../transcript/parse.ts";
import { Relay } from "../transcript/relay.ts";
import { SubagentWatcher } from "../transcript/subagents.ts";
import { effectiveTitle, readSessionTitles, TranscriptTailer } from "../transcript/tail.ts";
import { HubClient } from "./hub-client.ts";

// Called by our PostToolBatch hook (hooks/hooks.json), not by the agent.
export const HOOK_NOTE_TOOL = "tg_hook_note";

const MODE_OFF_NOTE =
  "tg-hub: Telegram mode is now OFF for this session, because the user typed a message in the terminal. " +
  "Your text is no longer relayed to Telegram. " +
  "If that message asks to continue in Telegram, call tg_enable.";

// A turn ended by a failed connection to the API: the agent is told to go
// on, as the person would, while the mode is on and the person is away.
export const CONTINUE_PROMPT =
  "tg-hub: your last turn ended with an API connection error (the API Error message above), " +
  "so your last response may be missing or incomplete. Continue from where you stopped.";
export const CUT_NOTE = "🔁 Сбой связи с API — агент продолжает сам.";
// Cuts in a row, with no turn ending normally in between, before it stops
// and calls the person: the network may be down for good.
export const MAX_AUTO_CONTINUES = 10;
export const CUT_LIMIT_NOTE = `⚠️ Сбой связи с API ${MAX_AUTO_CONTINUES} раз подряд — сам больше не продолжаю, жду тебя.`;
// Telegram refused files after tg_send_file returned: the agent fixes it, the
// topic is not told.
export function filesRejectedPrompt(error: string): string {
  return (
    `tg-hub: Telegram did not take files you sent earlier with tg_send_file: ${error}. ` +
    "The topic was not told. Deal with it yourself: for example, make the files smaller and send them again."
  );
}
// Requests that make the hub call Telegram. The hub retries a flaky network
// for up to 2 minutes (TelegramApi deadlineMs), so wait a bit longer than that.
const HUB_TELEGRAM_TIMEOUT_MS = 150_000;
// Tools that wait for the user's answer: the agent is not working meanwhile.
const WAITS_FOR_USER = new Set(["AskUserQuestion"]);
// With the mode off, a finished turn chimes in the terminal only if this
// long has passed since the user last typed in the terminal (a question
// always chimes).
export const CHIME_MIN_TURN_MS = 30_000;

// A bad turnEndChime in config.json is logged once per process.
let chimeConfigWarned = false;

// A topic message that interrupts the agent, in the <channel> tag Claude Code
// would have put it in.
export function interruptPrompt(content: string, meta: ChannelMeta): string {
  const attrs = Object.entries(meta).map(([k, v]) => ` ${k}="${v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"`).join("");
  return (
    "tg-hub: the user interrupted your work from Telegram with this topic message. " +
    "It is their message, as if it came through the channel: answer it.\n" +
    `<channel source="tg-hub"${attrs}>\n${content}\n</channel>`
  );
}

export type PluginOptions = {
  sessionId: string;
  cwd: string;
  configDir: string;
  windowKey: string;
  port: number;
  // Where text the hub never acked goes when the window closes.
  spoolDir: string;
  // tg-hub state: never sent, except inbox/ (what came from Telegram).
  stateDir: string;
  // Where files to send are copied for the hub.
  filesDir: string;
  // How long tg_send_file waits for the hub to send the files.
  fileWaitMs?: number;
  spawnHub(): void;
  emitChannel(content: string, meta: ChannelMeta): void;
  // Ends the agent's turn, as Esc in the terminal would, and gives it the
  // prompt instead.
  interrupt(prompt: string): Promise<void>;
  // Answers a permission prompt of Claude Code.
  answerPermission(requestId: string, behavior: PermissionBehavior): void;
  // Ends the Claude Code process of this window (/stop in the topic), first
  // passing its pid to `exiting`; neither happens if the process is not found.
  terminate(exiting: (pid: number) => void): void;
  log: Logger;
  tailIntervalMs?: number;
  // How often a subagent card may change; the watcher's own default if unset.
  cardEveryMs?: number;
  // Plays the end-of-turn sound; the configured command by default.
  chime?: (kind: ChimeKind) => void;
  now?: () => number;
};

// Plays the turnEndChime of config.json; a bad one is logged once per
// process and the default sound plays instead.
export function playConfiguredChime(kind: ChimeKind, log: Logger, play: (template: string, kind: ChimeKind) => void = playChime): void {
  const config = loadConfig();
  if (config.turnEndChimeError && !chimeConfigWarned) {
    chimeConfigWarned = true;
    log.warn(`${config.turnEndChimeError}; playing the default sound`);
  }
  play(config.turnEndChime, kind);
}

// Our own tools never make the text before them "intermediate".
export function isOwnTool(name: string): boolean {
  return /(^|__)tg_(enable|disable)$/.test(name);
}

// Whether the agent works after this event; undefined when it tells nothing.
function busyAfter(ev: TranscriptEvent): boolean | undefined {
  switch (ev.kind) {
    case "terminal_input":
    case "channel_seen":
    case "text":
      return true;
    case "tool_use":
      return !WAITS_FOR_USER.has(ev.name);
    case "turn_end":
    case "interrupted":
      return false;
    default:
      return undefined;
  }
}

// One per Claude Code window: follows the session transcript, relays the
// agent's text to the hub, delivers inbound topic messages to the session.

export class PluginCore {
  private sessionId: string;
  private cwd: string;
  private transcriptPath: string;
  private tailer: TranscriptTailer | undefined;
  private subagents: SubagentWatcher | undefined;
  // The newest model versions seen, so cards name a current model by its line.
  private versions: ModelVersions;
  private relay: Relay;
  private client: HubClient;
  private titles: Titles = {};
  private log: Logger;
  private reportedKinds = new Set<string>();
  // Terminal input turned the mode off and the agent has not been told yet.
  private noteOwed = false;
  // Responses cut since a turn last ended normally.
  private cuts = 0;
  // The message of an API error record that may yet end the turn.
  private apiError: string | undefined;
  // The agent is in a turn and not waiting for the user.
  private busy = false;
  private now: () => number;
  // When the user last typed in the terminal of this window.
  private lastInputAt: number | undefined;
  // Topic messages reach the session one after another, in the order they came.
  private inbound = Promise.resolve();
  enabled = false;

  constructor(private opts: PluginOptions) {
    this.sessionId = opts.sessionId;
    this.cwd = opts.cwd;
    this.log = opts.log;
    this.versions = new ModelVersions(join(opts.stateDir, "model-versions.json"), opts.log);
    this.now = opts.now ?? Date.now;
    this.relay = new Relay({ isOwnTool, onFinalClose: kind => this.turnClosed(kind), now: this.now });
    this.transcriptPath = transcriptPathFor(opts.sessionId, opts.cwd, opts.configDir);
    this.client = new HubClient({
      port: opts.port,
      hello: () => ({ type: "hello", v: PROTOCOL_VERSION, windowKey: opts.windowKey, sessionId: this.sessionId, cwd: this.cwd, configDir: opts.configDir, busy: this.busy, reportsSeen: true }),
      spawnHub: opts.spawnHub,
      onMessage: m => this.onHubMessage(m),
      log: opts.log,
    });
  }

  start(): void {
    this.follow(this.transcriptPath);
    this.client.start();
  }

  stop(): void {
    this.tailer?.stop();
    this.subagents?.stop();
    this.client.stop();
  }

  // The window is closing: relay what was written last, then stop. Text no
  // hub took goes to the spool directory, and a hub is started to send it.
  async shutdown(timeoutMs: number): Promise<void> {
    this.tailer?.pollNow();
    this.flush(this.relay.endTurn());
    await this.client.drain(timeoutMs);
    const left = this.client.unacked;
    if (left.length) {
      try {
        mkdirSync(this.opts.spoolDir, { recursive: true });
        const file = join(this.opts.spoolDir, `${this.sessionId}-${process.pid}-${Date.now()}.json`);
        writeFileSync(`${file}.tmp`, JSON.stringify(left));
        renameSync(`${file}.tmp`, file);
        this.log.warn(`hub unreachable at shutdown: ${left.length} message(s) left in ${file}`);
        this.client.spawnHubNow();
      } catch (e) {
        this.log.error(`could not spool ${left.length} message(s): ${e}\n${left.map(o => (o.type === "sendFiles" ? `files: ${o.files.map(f => f.path).join(", ")}` : o.text)).join("\n---\n")}`);
      }
    }
    this.stop();
  }

  async enable(): Promise<string> {
    this.tailer?.pollNow();
    this.titles = readSessionTitles(this.transcriptPath);
    const res = enableResult.parse(await this.client.request({ op: "enable", title: effectiveTitle(this.titles) ?? "" }, HUB_TELEGRAM_TIMEOUT_MS));
    return `Telegram mode is on. Topic «${res.topicTitle}»${res.created ? " was created" : ""}. Your text output is now relayed to it.`;
  }

  async disable(): Promise<string> {
    await this.client.request({ op: "disable" });
    return "Telegram mode is off.";
  }

  async download(fileId: string): Promise<string> {
    return String(await this.client.request({ op: "download", fileId }, HUB_TELEGRAM_TIMEOUT_MS));
  }

  // Hook output after a batch of tool calls. Only the transcript knows who
  // wrote a prompt (origin.kind), and Claude Code writes the prompt record
  // after UserPromptSubmit hooks run, so the agent hears of it here. Catch up
  // on the transcript first: the hook may come before the tailer's next poll.
  // A subagent's batch (agentId set) leaves the note for the main agent.
  hookNote(agentId: string): string {
    this.tailer?.pollNow();
    if (agentId || !this.noteOwed) return "";
    this.noteOwed = false;
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: MODE_OFF_NOTE } });
  }

  // Checks everything before sending anything, then hands the hub copies:
  // the agent may change or delete the originals right after the call.
  async sendFiles(paths: string[], caption = "", asDocument = false): Promise<string> {
    if (!paths.length) throw new Error("give at least one file path");
    const files = paths.map(p => this.sendable(p));
    const shown = toTelegram(caption).text.length;
    if (shown > MAX_CAPTION) throw new Error(`the caption is ${shown} characters, Telegram allows ${MAX_CAPTION} — shorten it or write the text as a normal message`);
    const id = randomUUID();
    const dir = join(this.opts.filesDir, id);
    let queued: { path: string; name: string; size: number }[];
    try {
      mkdirSync(dir, { recursive: true });
      queued = files.map((f, i) => {
        const path = join(dir, `${i}-${f.name}`);
        copyFileSync(f.path, path);
        return { ...f, path };
      });
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`could not queue the files: ${e instanceof Error ? e.message : e}`);
    }
    this.tailer?.pollNow();
    this.flush(this.relay.textBeforeToolCall());
    const res = await this.client.sendFiles(
      { type: "sendFiles", id, sessionId: this.sessionId, files: queued, caption, notify: !this.enabled, ...(asDocument ? { asDocument } : {}) },
      this.opts.fileWaitMs ?? HUB_TELEGRAM_TIMEOUT_MS,
    );
    if (!res) return `Telegram is not reachable right now: the ${files.length} file(s) are queued, and the hub will send them when it is.`;
    if (res.error) throw new Error(res.error);
    return `Sent ${files.length} file(s) to the Telegram topic.`;
  }

  private sendable(p: string): { path: string; name: string; size: number } {
    const path = resolve(this.cwd, p);
    let st;
    try {
      st = statSync(path);
    } catch {
      throw new Error(`${p}: no such file`);
    }
    if (!st.isFile()) throw new Error(`${p}: not a file`);
    if (st.size === 0) throw new Error(`${p}: the file is empty, Telegram does not take empty files`);
    if (st.size > MAX_UPLOAD) throw new Error(`${p}: ${(st.size / BYTES_PER_MB).toFixed(1)} MB, over the ${MAX_UPLOAD / BYTES_PER_MB} MB a bot may upload`);
    let real = path;
    let state = this.opts.stateDir;
    try {
      real = realpathSync(path);
      state = realpathSync(state);
    } catch {}
    if (isInside(state, real) && !isInside(join(state, "inbox"), real)) throw new Error(`${p}: refusing to send tg-hub state files`);
    return { path, name: basename(path), size: st.size };
  }

  permissionRequest(p: { request_id: string; tool_name: string; description: string; input_preview?: string }): void {
    if (!this.enabled) return;
    this.client.send({
      type: "permission",
      requestId: p.request_id,
      toolName: p.tool_name,
      description: p.description,
      ...(p.input_preview ? { inputPreview: p.input_preview } : {}),
    });
  }

  // /clear or /resume inside the window changed the session (from the
  // SessionStart hook, via the hub).
  switchSession(sessionId: string, transcriptPath: string, cwd: string): void {
    this.tailer?.pollNow();
    if (sessionId === this.sessionId) {
      // startup/compact: same session, maybe a differently spelled path.
      if (transcriptPath !== this.transcriptPath) this.follow(transcriptPath);
      return;
    }
    this.log.info(`session ${this.sessionId} → ${sessionId}`);
    this.flush(this.relay.endTurn());
    this.setEnabled(false);
    this.setBusy(false);
    this.sessionId = sessionId;
    this.cwd = cwd || this.cwd;
    this.follow(transcriptPath);
    this.client.send({ type: "session", sessionId, cwd: this.cwd, configDir: this.opts.configDir });
  }

  private follow(path: string): void {
    this.tailer?.stop();
    this.transcriptPath = path;
    this.titles = readSessionTitles(path);
    this.tailer = new TranscriptTailer({
      path,
      onRecord: rec => this.onRecord(rec),
      onIdle: () => this.flush(this.relay.idle()),
      intervalMs: this.opts.tailIntervalMs,
      log: this.log,
    });
    this.tailer.start();
    this.subagents?.stop();
    // Claude Code keeps a session's subagents in <session>/subagents/ next to
    // its transcript.
    const sessionId = this.sessionId;
    this.subagents = new SubagentWatcher({
      dir: join(dirname(path), basename(path, ".jsonl"), "subagents"),
      onCard: card => this.client.send({ type: "card", sessionId, ...card }),
      canStart: () => this.enabled,
      intervalMs: this.opts.tailIntervalMs,
      sendEveryMs: this.opts.cardEveryMs,
      log: this.log,
      versions: this.versions,
    });
    this.subagents.start();
  }

  private onRecord(rec: unknown): void {
    // The session's own answers tell a new model version as well.
    const answered = recordModel(rec);
    if (answered) this.versions.see(answered.model);
    for (const ev of parseRecord(rec).flatMap(e => this.settleApiError(e))) {
      this.flush(this.relay.feed(ev));
      if (ev.kind === "terminal_input") this.lastInputAt = this.now();
      if (ev.kind === "terminal_input" && this.enabled) {
        this.client.send({ type: "terminalInput" });
        this.setEnabled(false);
        this.noteOwed = true;
      } else if (ev.kind === "unknown_thinking" && !this.reportedKinds.has(ev.blockKind)) {
        this.reportedKinds.add(ev.blockKind);
        this.log.warn(`transcript: thinking block of unknown kind "${ev.blockKind}" with text — not relayed; the transcript format may have changed`);
      } else if (ev.kind === "title") {
        const before = effectiveTitle(this.titles);
        this.titles[ev.source] = ev.title;
        const after = effectiveTitle(this.titles);
        if (after && after !== before) this.client.send({ type: "title", title: after });
      } else if (ev.kind === "task_status") {
        this.subagents?.taskStatus(ev.taskId, ev.status);
      } else if (ev.kind === "channel_seen") {
        this.client.send({ type: "seen", messageIds: ev.messageIds });
      } else if (ev.kind === "turn_end") {
        if (ev.cut) this.responseCut();
        else this.cuts = 0;
      }
      const busy = busyAfter(ev);
      if (busy !== undefined) this.setBusy(busy);
    }
  }

  // An API error record ends the turn, cut, only if Claude Code closes the
  // turn before the agent goes on.
  private settleApiError(ev: TranscriptEvent): TranscriptEvent[] {
    if (ev.kind === "api_error") {
      this.apiError = ev.messageId;
      return [];
    }
    const pending = this.apiError;
    if (ev.kind === "turn_closed") {
      this.apiError = undefined;
      return pending === undefined ? [ev] : [{ kind: "turn_end", messageId: pending, cut: true }, ev];
    }
    if ("messageId" in ev) this.apiError = undefined;
    return [ev];
  }

  // The topic shows the bot typing while the agent is busy.
  private setBusy(busy: boolean): void {
    if (busy === this.busy) return;
    this.busy = busy;
    this.client.send({ type: "busy", busy });
  }

  // A message the hub flagged as an interrupt stops a working agent's turn
  // and comes in its place; when that fails, it comes as a channel message.
  private deliver(content: string, meta: ChannelMeta, flagged: boolean): void {
    const interrupt = this.busy && flagged;
    this.inbound = this.inbound.then(async () => {
      if (interrupt) {
        try {
          await this.opts.interrupt(interruptPrompt(content, meta));
          this.log.info(`session ${this.sessionId}: interrupted from the topic`);
          return;
        } catch (e) {
          this.log.warn(`session ${this.sessionId}: could not interrupt the agent: ${e}`);
        }
      }
      this.opts.emitChannel(content, meta);
    });
  }

  private responseCut(): void {
    const before = this.cuts++;
    if (!this.enabled) return;
    // The error text ended the turn: it goes before the note.
    this.flush(this.relay.endTurn());
    if (before >= MAX_AUTO_CONTINUES) {
      if (before === MAX_AUTO_CONTINUES) this.client.enqueue(this.sessionId, CUT_LIMIT_NOTE, true);
      return;
    }
    this.client.enqueue(this.sessionId, CUT_NOTE, false);
    this.opts.emitChannel(CONTINUE_PROMPT, { user: "tg-hub", reason: "response_cut" });
  }

  private flush(out: Outgoing[]): void {
    for (const o of out) this.client.enqueue(this.sessionId, o.text, o.notify);
  }

  // Turning off still sends what was written while the mode was on.
  private setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) this.noteOwed = false;
    this.flush(this.relay.setEnabled(on));
  }

  // The Stop hook's verdict. The transcript is read first: the hook may come
  // before the tailer has seen the end of the turn.
  private onTurnEnd(final: boolean, kind: ChimeKind | undefined): void {
    this.tailer?.pollNow();
    this.flush(this.relay.decide(final ? { final: true, kind: kind ?? "done" } : { final: false }));
  }

  // A turn closed as final. With the mode on the relay sent the text loud and
  // the phone is the signal; with it off the terminal chimes: always on a
  // question, on "done" only when the user has not typed here for a while.
  private turnClosed(kind: ChimeKind): void {
    if (this.enabled) return;
    if (kind === "done" && this.lastInputAt !== undefined && this.now() - this.lastInputAt < CHIME_MIN_TURN_MS) return;
    try {
      if (this.opts.chime) this.opts.chime(kind);
      else playConfiguredChime(kind, this.log);
    } catch (e) {
      this.log.warn(`turn-end chime failed: ${e}`);
    }
  }

  private onHubMessage(m: HubToPlugin): void {
    switch (m.type) {
      case "state":
        // Turned off elsewhere (tg_disable, another window): first relay what
        // the transcript already holds, written while the mode was on.
        if (!m.enabled && this.enabled) this.tailer?.pollNow();
        this.setEnabled(m.enabled);
        return;
      case "inbound":
        this.deliver(m.content, m.meta, m.interrupt === true);
        return;
      case "switchSession":
        this.switchSession(m.sessionId, m.transcriptPath, m.cwd);
        return;
      case "permissionReply":
        this.log.info(`permission ${m.requestId}: ${m.behavior} from the topic`);
        this.opts.answerPermission(m.requestId, m.behavior);
        return;
      case "filesSent":
        // tg_send_file returned before the hub was done; a late success is
        // what the agent was told to expect.
        if (m.error) this.opts.emitChannel(filesRejectedPrompt(m.error), { user: "tg-hub", reason: "files_rejected" });
        return;
      case "turnEnd":
        this.onTurnEnd(m.final, m.kind);
        return;
      // A question is coming: the text before it goes first, as with files.
      case "catchUp":
        this.tailer?.pollNow();
        this.flush(this.relay.textBeforeToolCall());
        this.client.send({ type: "caughtUp", id: m.id });
        return;
      case "terminate":
        this.log.info(`session ${this.sessionId}: /stop from the topic, ending Claude Code`);
        this.tailer?.pollNow();
        this.flush(this.relay.endTurn());
        // The hub waits for this pid to be gone before it touches the transcript.
        this.opts.terminate(pid => this.client.send({ type: "exiting", pid }));
        return;
    }
  }
}
