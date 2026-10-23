import type { Server, ServerWebSocket } from "bun";
import type { Config } from "../shared/config.ts";
import type { Logger } from "../shared/log.ts";
import type { Entity, Formatted } from "../shared/markdown.ts";
import type { OutFile } from "../shared/media.ts";
import type { ChannelMeta, EnableResult, HookBody, HubToPlugin, LimitsReading, PermissionBehavior, PluginToHub, TopicCommand } from "../shared/protocol.ts";
import type { OutItem, Piece } from "./outbox.ts";
import type { SessionRecord } from "./sessions.ts";
import type { Button, Message, TelegramApi, Update } from "./telegram.ts";
import type { RichMessage } from "./rich.ts";
import type { HubCommand } from "./router.ts";
import type { VideoTools } from "./video.ts";
import type { ExecShell } from "./exec-shell.ts";
import type { CleanupResult } from "./skill-cleanup.ts";

import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync } from "fs";
import { basename, dirname, join } from "path";
import { z } from "zod";
import { chunk } from "../shared/chunk.ts";
import { isInside } from "../shared/config.ts";
import { field } from "../shared/guards.ts";
import { toTelegram } from "../shared/markdown.ts";
import { albums, kindOf } from "../shared/media.ts";
import { PROTOCOL_VERSION } from "../shared/protocol.ts";
import { cleanupReport, commandReply, hookBody, limitsPost, pluginToHub, sendFilesMessage, sendMessage, terminateRequest } from "../shared/protocol-schema.ts";
import { tokens } from "../shared/tokens.ts";
import { loadCards, saveCards } from "./cards.ts";
import { DEFAULT_CONFIG_DIR, defaultLoginAccount, isDefaultConfigDir } from "./default-account.ts";
import { messageKind } from "./message-kind.ts";
import { Outbox } from "./outbox.ts";
import { launchCommand, LaunchError, sessionCwd, sessionTranscript } from "./launch.ts";
import { commandOf, hubCommandOf, routeCallback, routeUpdate } from "./router.ts";
import { accountOf, SessionStore, topicName } from "./sessions.ts";
import { isThreadNotFound, TelegramError } from "./telegram.ts";
import { richPhotos, richToMarkdown } from "./rich.ts";
import { richPieces } from "./rich-out.ts";
import { DEFAULT_VIDEO_TOOLS, probeVideo, thumbPath } from "./video.ts";
import { EXEC_CARD_MS, EXEC_CHECK_MS, EXEC_MAX_AGE_MS, Execs } from "./exec.ts";
import { freshEnv } from "./exec-env.ts";
import { isAlive, killTree, spawnRunner } from "./exec-runner.ts";
import { DEFAULT_BASH, findPowershell } from "./exec-shell.ts";
import { cleanTranscript } from "./skill-cleanup.ts";

const INACTIVE_TEXT = "сессия сейчас не активна";
// The queue id prefix of the start notice, "starting the session".
const LAUNCH_NOTICE = "launch-";
const LAUNCHED_TEXT = "✅ Сессия запущена";
// After a launched session says hello, Claude Code still registers the
// channel; messages sent sooner are lost.
const READY_DELAY_MS = 1500;
// How long a started hub waits for windows before it hands on results of
// runs that ended while it was off: a window's longest reconnect pause
// (5 s and jitter), then the ready delay, with room.
const EXEC_GRACE_MS = 10_000;
const STOP_TIMEOUT_MS = 15_000;
// /cleanup edits the transcript only once Claude Code has exited: it waits
// this long for the process, checking this often; with the process unknown,
// it gives the window this long to go.
const CLEANUP_EXIT_MS = 30_000;
const EXIT_POLL_MS = 200;
const CLEANUP_SETTLE_MS = 3000;
// How long /cleanup waits for the module to report its compact.
const CLEANUP_COMPACT_MS = 600_000;
// A topic message starting with it reaches a compacting window at once, as
// it interrupts the agent (the plugin's own prefix).
const INTERRUPT_PREFIX = "!";
// The size of a removed skill in tokens, roughly.
const CHARS_PER_TOKEN = 4;
const CLEANUP_BUSY = "⏳ /cleanup уже идёт";
const CLEANUP_STOPPED = " Сессия остановлена.";
// Messages a starting session holds; more are dropped.
const MAX_HELD = 50;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;
const HOOK_TTL_MS = 60_000;
const SPOOL_SCAN_MS = 5000;
const POLL_TIMEOUT_SEC = 25;
const POLL_RETRY_BASE_MS = 1000;
const MAX_POLL_DELAY_MS = 15_000;
const SEND_RETRY_BASE_MS = 1000;
const SEND_RETRY_MAX_MS = 30_000;
// Telegram's answer to an upload over its size limit: Request Entity Too Large.
const TOO_LARGE = 413;
const COMMAND_PICKUP_MS = 10_000;
// How much of a message the hub cannot read goes into the log.
const LOGGED_MESSAGE_CHARS = 200;
// How much of a tool's input a permission message shows.
const MAX_PREVIEW_CHARS = 1500;
// Permission prompts the hub remembers for the buttons under them.
const MAX_PERMISSIONS = 200;
const PERMISSION_KEY_CHARS = 8;
const PERMISSION_ANSWERS: Record<PermissionBehavior, string> = { allow: "✅ Разрешено", deny: "❌ Отклонено" };
// A subagent card is edited at most this often; versions in between are skipped.
const CARD_EDIT_MS = 5000;
// Edits of all cards together go at most this often. Telegram lets a group
// have about 20 messages a minute, and a dozen subagents editing their cards
// every few seconds would use it all up and hold back the agent's own text.
const CARD_GAP_MS = 6000;
// Cards remembered for editing; the oldest are forgotten past this.
const MAX_CARDS = 200;
const TOO_MANY_REQUESTS = 429;
// On a topic message from when the hub hands it to the session until it is
// in the agent's context.
const TAKEN_REACTION = "✍";
// It goes on only if the agent has not had the message for this long, so an
// idle agent's message does not blink with it.
const REACTION_DELAY_MS = 3000;
// Telegram shows "typing…" for up to 5 s; it is renewed this often while the
// agent works.
const TYPING_EVERY_MS = 4000;
const BOT_COMMANDS = [
  { command: "info", description: "Лимиты и контекст сессии" },
  { command: "compact", description: "Сжать контекст; /compact N — окно автокомпакта" },
  { command: "run", description: "Запустить сессию; /run N — на аккаунте N" },
  { command: "stop", description: "Завершить сессию" },
  { command: "cleanup", description: "Сжать контекст и убрать накопившиеся скиллы" },
  { command: "exec", description: "Команда в PowerShell в папке сессии" },
  { command: "cmd", description: "Команда в cmd в папке сессии" },
  { command: "bash", description: "Команда в Git Bash в папке сессии" },
];
const EXEC_NOT_SET = "⚠️ Команды оболочки в этом хабе не настроены";

// exitingPid: the Claude Code process the plugin said it is ending.
type Conn = { windowKey?: string; sessionId?: string; cwd?: string; account?: string; busy?: boolean; reportsSeen?: boolean; exitingPid?: number };
type WS = ServerWebSocket<Conn>;
type Card = {
  text: string;
  final: boolean;
  // The final version is shown: nothing more to do.
  done: boolean;
  messageId?: number;
  shown?: string;
  lastEdit: number;
  editing: boolean;
  timer?: ReturnType<typeof setTimeout>;
  // Go with the first send and every edit; an edit without them takes them off.
  buttons?: Button[][];
};
type Inbound = { content: string; meta: ChannelMeta; onSent(): void };
// What a starting session gets once it connects: topic messages and the
// results of topic commands.
type Held = { message: Message } | { inbound: Inbound };
// A /cleanup under way: the id of its command, the context the module
// reported before compacting, and whether the window is compacting or
// exiting. noRelaunch: a /stop came meanwhile. held: topic messages for the
// session from the start of the compact on, the window still open or not.
// compactTimer: gives up on a compact the module never reports.
type Cleanup = {
  id: string;
  before?: number;
  phase: "compacting" | "exiting";
  noRelaunch?: boolean;
  held: Held[];
  compactTimer?: ReturnType<typeof setTimeout>;
};

export type HubOptions = {
  port: number;
  sessionsFile: string;
  outboxFile: string;
  // Where subagent cards are kept across restarts; in memory only without it.
  cardsFile?: string;
  // Where a closing window leaves the text it could not hand to a hub.
  spoolDir?: string;
  spoolScanMs?: number;
  // The only place file copies to send are taken from (and removed from).
  filesDir: string;
  inboxDir: string;
  api: TelegramApi | undefined;
  // ffprobe and ffmpeg, for the metadata and thumbnail of videos to send.
  videoTools?: VideoTools;
  config: () => Config;
  idleMs: number;
  // How long a command from the topic waits for the plugin's module to take it.
  commandPickupMs?: number;
  pollTimeoutSec?: number;
  pollRetryBaseMs?: number;
  // Pause between attempts to deliver the head of a session's queue.
  sendRetryBaseMs?: number;
  sendRetryMaxMs?: number;
  cardEditMs?: number;
  cardGapMs?: number;
  typingEveryMs?: number;
  reactionDelayMs?: number;
  // Where Claude Code keeps transcripts, to find the cwd of a session the hub
  // has not recorded one for.
  projectsDir?: string;
  // Runs a launch command; by default a detached process.
  spawn?(command: string[]): void;
  readyDelayMs?: number;
  stopTimeoutMs?: number;
  // /cleanup: how long it waits for the compact, for Claude Code to exit,
  // and with the process unknown; how it tells the process is still there,
  // and what empties the skills in the transcript.
  cleanupCompactMs?: number;
  cleanupExitMs?: number;
  cleanupSettleMs?: number;
  isAlive?(pid: number): boolean;
  cleanTranscript?: typeof cleanTranscript;
  // A window in this config dir runs on the default login, whose account is
  // asked of defaultAccount (cswap by default).
  defaultConfigDir?: string;
  defaultAccount?(): Promise<string | undefined>;
  // Topic commands (/exec, /cmd, /bash): their logs and runs; without them
  // the commands answer that they are not set up.
  execDir?: string;
  execsFile?: string;
  execCheckMs?: number;
  execCardMs?: number;
  execMaxAgeMs?: number;
  execGraceMs?: number;
  // The largest log file sent whole; Telegram's limit by default.
  execFileLimit?: number;
  // Starts a command's runner; the detached exec-runner by default.
  spawnRunner?(specFile: string): number;
  log: Logger;
  onExit(): void;
};

// A spool file: what a closing window could not hand to a hub. Older plugins
// wrote text items without a type.
const spoolItems = z.array(z.union([sendFilesMessage, sendMessage.extend({ type: z.literal("send").optional(), sessionId: z.string() })]));

// Delivery cannot work until the user fixes the setup: no token, no groupId,
// the bot is not in the group or may not write there.
class SetupError extends Error {}

// A queued file copy vanished from disk: retrying cannot help.
class LostFileError extends Error {}

type Failure = "retry" | "setup" | "rejected";

function classify(e: unknown): Failure {
  if (e instanceof SetupError) return "setup";
  if (e instanceof LostFileError) return "rejected";
  if (!(e instanceof TelegramError)) return "retry";
  if (e.code === 401 || e.code === 403 || e.code === 404) return "setup";
  // The upload is over Telegram's size limit: the same request never passes.
  if (e.code === TOO_LARGE) return "rejected";
  if (e.code === 400) {
    return /chat not found|not enough rights|have no rights|CHAT_WRITE_FORBIDDEN|CHAT_ADMIN_REQUIRED|bot was kicked|upgraded to a supergroup/i.test(e.description) ? "setup" : "rejected";
  }
  return "retry";
}

// The single Telegram poller on the machine. Plugins (one per Claude Code
// window) connect over a localhost WebSocket; whoever binds the port is the hub.
export class Hub {
  private server: Server<Conn> | undefined;
  private conns = new Set<WS>();
  private store: SessionStore;
  private chains = new Map<string, Promise<unknown>>();
  private pendingHooks = new Map<string, { body: HookBody; at: number }>();
  private outbox: Outbox;
  // sendFiles messages still in the queue: what failed so far, and the window
  // that waits for the result.
  private fileMessages = new Map<string, { errors: string[]; ws?: WS }>();
  // Results for windows that were not connected when their files went out
  // (the hub restarted meanwhile), by session; given out on hello.
  private heldResults = new Map<string, HubToPlugin[]>();
  // Commands from the topic the plugin's module has not taken yet, by session.
  private commands = new Map<string, { cmd: TopicCommand; timer: ReturnType<typeof setTimeout> }[]>();
  // The latest rate-limit reading of each session, with its account then.
  private limits = new Map<string, LimitsReading & { account?: string }>();
  private botUsername: string | undefined;
  // Permission prompts sent to topics, by the key in their buttons' data.
  private permissions = new Map<string, { sessionId: string; requestId: string } & Formatted>();
  // Subagent cards by `${sessionId}:${cardId}`: text is the latest Markdown
  // version, shown what the message holds now (undefined until it is sent).
  private cards = new Map<string, Card>();
  // The earliest time the next card edit may go, hub-wide.
  private nextCardEdit = 0;
  private pumping = new Set<string>();
  // The latest reaction change of a topic message, by message id.
  private reactions = new Map<number, Promise<void>>();
  // Topic messages handed to a session whose ✍ is not on yet, by message id.
  private reactionTimers = new Map<number, ReturnType<typeof setTimeout>>();
  // Sessions being started from the topic, with the messages they will get.
  private launches = new Map<string, { account: string; held: Held[]; timer: ReturnType<typeof setTimeout> }>();
  private execs: Execs | undefined;
  // Sessions told to end, until their window goes.
  private stops = new Map<string, ReturnType<typeof setTimeout>>();
  // Sessions whose /stop waits for the module's terminate request: the id of
  // the stop command.
  private stopping = new Map<string, string>();
  private cleanups = new Map<string, Cleanup>();
  // The start notices sent to a session's topic: Telegram message id and the
  // text it shows. They go once its agent starts working.
  private launchNotices = new Map<string, { id: number; text: string }[]>();
  // How the latest start of a session ended: the start notice then reads
  // "started", or leaves the topic as the loud failure notice comes.
  private launchEnds = new Map<string, "started" | "failed">();
  private readyTimers = new Set<ReturnType<typeof setTimeout>>();
  // Sessions whose delivery waits for the user to fix the setup.
  private blocked = new Set<string>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  // Idle time is up, but the queue is still being delivered.
  private idleExpired = false;
  private spoolTimer: ReturnType<typeof setInterval> | undefined;
  private typingTimer: ReturnType<typeof setInterval> | undefined;
  // Sessions whose "typing…" fails, with the failures in a row: only the
  // first is logged, and the count once it works again.
  private typingFailed = new Map<string, number>();
  // "typing…" goes one request at a time: some networks let few new
  // connections through, so parallel requests hang while one connection,
  // reused, takes them in turn. A session is queued once.
  private typingQueue: Promise<void> = Promise.resolve();
  private typingQueued = new Set<string>();
  private abort = new AbortController();
  private running = false;
  private log: Logger;

  constructor(private opts: HubOptions) {
    this.store = new SessionStore(opts.sessionsFile);
    this.log = opts.log;
    this.outbox = new Outbox(opts.outboxFile, opts.log);
    // A card's edits go on after a restart; one not yet shown gets its next
    // version as an edit, a "not modified" answer being no error.
    if (opts.cardsFile) {
      for (const [key, c] of loadCards(opts.cardsFile)) {
        this.cards.set(key, {
          text: c.text,
          final: c.done,
          done: c.done,
          ...(c.messageId !== undefined ? { messageId: c.messageId } : {}),
          ...(c.done ? { shown: c.text } : {}),
          ...(c.buttons ? { buttons: c.buttons } : {}),
          lastEdit: 0,
          editing: false,
        });
      }
    }
    if (opts.execDir && opts.execsFile) {
      this.execs = new Execs({
        dir: opts.execDir,
        file: opts.execsFile,
        shells: () => ({ powershell: findPowershell(), bash: this.bashPath() }),
        env: () => freshEnv(this.log),
        spawnRunner: opts.spawnRunner ?? spawnRunner,
        alive: isAlive,
        kill: killTree,
        card: (sid, cardId, markdown, final, buttons) => this.upsertCard(sid, cardId, markdown, final, buttons),
        notice: (sid, text, loud) => this.notice(sid, text, loud),
        sendFile: (sid, path, name, loud) => this.sendExecFile(sid, path, name, loud),
        report: (sid, content, meta, onSent) => this.reportExec(sid, { content, meta, onSent }),
        now: () => Date.now(),
        checkMs: opts.execCheckMs ?? EXEC_CHECK_MS,
        cardMs: opts.execCardMs ?? EXEC_CARD_MS,
        maxAgeMs: opts.execMaxAgeMs ?? EXEC_MAX_AGE_MS,
        ...(opts.execFileLimit ? { fileLimit: opts.execFileLimit } : {}),
        hasWindow: sid => this.connOf(sid) !== undefined,
        graceMs: opts.execGraceMs ?? EXEC_GRACE_MS,
        log: opts.log,
      });
    }
  }

  start(): boolean {
    try {
      this.server = Bun.serve<Conn>({
        port: this.opts.port,
        hostname: "127.0.0.1",
        fetch: (req, server) => this.handleHttp(req, server),
        websocket: {
          open: ws => this.onOpen(ws),
          message: (ws, data) => this.onMessage(ws, String(data)),
          close: ws => this.onClose(ws),
        },
      });
    } catch (e) {
      if (field(e, "code") === "EADDRINUSE") return false;
      throw e;
    }
    this.running = true;
    this.log.info(`hub listening on 127.0.0.1:${this.opts.port}`);
    if (this.outbox.size) this.log.info(`${this.outbox.size} queued piece(s) left by the previous hub — delivering`);
    for (const item of this.outbox.items()) if (item.files) this.fileMessages.set(messageOf(item.id), { errors: [] });
    for (const sid of this.outbox.sessions()) void this.pump(sid);
    this.ingestSpool();
    this.spoolTimer = setInterval(() => this.ingestSpool(), this.opts.spoolScanMs ?? SPOOL_SCAN_MS);
    this.typingTimer = setInterval(() => {
      for (const ws of this.conns) if (ws.data.busy) this.showTyping(ws);
    }, this.opts.typingEveryMs ?? TYPING_EVERY_MS);
    // Before armIdle: commands still running keep the hub up.
    this.execs?.start();
    this.armIdle();
    if (this.opts.api) void this.pollLoop(this.opts.api);
    else this.log.error("no TELEGRAM_BOT_TOKEN — not polling Telegram");
    return true;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort.abort();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.spoolTimer) clearInterval(this.spoolTimer);
    if (this.typingTimer) clearInterval(this.typingTimer);
    for (const queued of this.commands.values()) for (const e of queued) clearTimeout(e.timer);
    for (const card of this.cards.values()) clearTimeout(card.timer);
    for (const l of this.launches.values()) clearTimeout(l.timer);
    for (const t of this.stops.values()) clearTimeout(t);
    for (const c of this.cleanups.values()) clearTimeout(c.compactTimer);
    for (const t of this.readyTimers) clearTimeout(t);
    for (const t of this.reactionTimers.values()) clearTimeout(t);
    // The commands go on; the next hub picks them up.
    this.execs?.stop();
    this.server?.stop(true);
    this.log.info("hub stopped");
  }

  isConnected(sessionId: string): boolean {
    return this.connOf(sessionId) !== undefined;
  }

  // --- transport -----------------------------------------------------------

  private async handleHttp(req: Request, server: Server<Conn>): Promise<Response | undefined> {
    // Browsers always send Origin; local plugins and hooks never do.
    if (req.headers.get("origin")) return new Response("forbidden", { status: 403 });
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (server.upgrade(req, { data: {} })) return undefined;
      return new Response("upgrade required", { status: 426 });
    }
    if (url.pathname === "/health") return Response.json({ ok: true, pid: process.pid });
    if (url.pathname === "/hook" && req.method === "POST") {
      const body = hookBody.safeParse(await req.json().catch(() => undefined));
      if (!body.success) return new Response("bad hook body", { status: 400 });
      this.onHook(body.data);
      return new Response("ok");
    }
    if (url.pathname === "/commands" && req.method === "GET") {
      const session = url.searchParams.get("session") ?? "";
      return Response.json(this.takeCommands(session, url.searchParams.get("stop") === "1", url.searchParams.get("cleanup") === "1"));
    }
    if (url.pathname === "/terminate" && req.method === "POST") {
      const r = terminateRequest.safeParse(await req.json().catch(() => undefined));
      if (!r.success) return new Response("bad terminate request", { status: 400 });
      if (this.stopping.get(r.data.sessionId) === r.data.id) this.terminate(r.data.sessionId);
      return new Response("ok");
    }
    if (url.pathname === "/cleanup" && req.method === "POST") {
      const r = cleanupReport.safeParse(await req.json().catch(() => undefined));
      if (!r.success) return new Response("bad cleanup report", { status: 400 });
      this.onCleanupReport(r.data.sessionId, r.data.id, r.data.before, r.data.error);
      return new Response("ok");
    }
    if (url.pathname === "/limits" && req.method === "POST") {
      const r = limitsPost.safeParse(await req.json().catch(() => undefined));
      if (!r.success) return new Response("bad limits", { status: 400 });
      const { sessionId, ...reading } = r.data;
      const account = this.accountOf(sessionId);
      this.limits.set(sessionId, { ...reading, ...(account ? { account } : {}) });
      return new Response("ok");
    }
    if (url.pathname === "/limits" && req.method === "GET") return Response.json(this.freshestLimits(url.searchParams.get("session") ?? "") ?? null);
    if (url.pathname === "/reply" && req.method === "POST") {
      const r = commandReply.safeParse(await req.json().catch(() => undefined));
      if (!r.success) return new Response("bad reply", { status: 400 });
      this.enqueue(r.data.sessionId, `cmd-${r.data.id}`, r.data.text, r.data.notify);
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  }

  // --- commands from the topic ---------------------------------------------

  // Waits for the session's module; a window without one (an older Claude
  // Code, a window still on the old plugin) never takes it, and the user is
  // told so.
  // A stop not taken in time ends the window at once.
  private queueCommand(sessionId: string, c: Omit<TopicCommand, "id">): string {
    const cmd = { id: randomUUID(), ...c };
    const ms = this.opts.commandPickupMs ?? COMMAND_PICKUP_MS;
    const timer = setTimeout(() => {
      this.commands.set(sessionId, (this.commands.get(sessionId) ?? []).filter(e => e.cmd !== cmd));
      this.log.warn(`/${cmd.name} for session ${sessionId} was not taken in ${ms} ms`);
      if (cmd.name === "stop") {
        if (this.stopping.get(sessionId) === cmd.id) this.terminate(sessionId);
        return;
      }
      if (cmd.name === "cleanup" && this.cleanups.get(sessionId)?.id === cmd.id) this.dropCleanup(sessionId);
      this.enqueue(sessionId, `cmd-${cmd.id}-lost`, `⚠️ /${cmd.name} не выполнена: окно не забрало её за ${ms / MS_PER_SECOND} с. Команды выполняет модуль плагина — перезапусти окно.`, true, false);
    }, ms);
    this.commands.set(sessionId, [...(this.commands.get(sessionId) ?? []), { cmd, timer }]);
    this.log.info(`/${cmd.name} for session ${sessionId}`);
    return cmd.id;
  }

  // The freshest rate-limit reading of the sessions on this session's account;
  // with the account unknown, only the session's own.
  private freshestLimits(sessionId: string): LimitsReading | undefined {
    const account = this.accountOf(sessionId);
    let best: LimitsReading | undefined;
    for (const [sid, r] of this.limits) {
      const same = sid === sessionId || (account !== undefined && (this.accountOf(sid) ?? r.account) === account);
      if (same && r.rateLimits.length && (!best || r.at > best.at)) best = { at: r.at, rateLimits: r.rateLimits };
    }
    return best;
  }

  private accountOf(sessionId: string): string | undefined {
    return this.connOf(sessionId)?.data.account ?? this.store.get(sessionId)?.account;
  }

  // An older module does not know stop or cleanup: it stays queued for its
  // timeout.
  private takeCommands(sessionId: string, takesStop: boolean, takesCleanup: boolean): TopicCommand[] {
    const queued = this.commands.get(sessionId) ?? [];
    const taken = queued.filter(e => (takesStop || e.cmd.name !== "stop") && (takesCleanup || e.cmd.name !== "cleanup"));
    const left = queued.filter(e => !taken.includes(e));
    if (left.length) this.commands.set(sessionId, left);
    else this.commands.delete(sessionId);
    for (const e of taken) clearTimeout(e.timer);
    return taken.map(e => e.cmd);
  }

  private async registerCommands(api: TelegramApi): Promise<void> {
    try {
      await api.setMyCommands(BOT_COMMANDS, this.abort.signal);
    } catch (e) {
      if (this.running) this.log.warn(`registering bot commands failed: ${e}`);
    }
  }

  private onOpen(ws: WS): void {
    this.conns.add(ws);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.idleExpired = false;
  }

  private onClose(ws: WS): void {
    this.conns.delete(ws);
    const sid = ws.data.sessionId;
    if (sid) this.log.info(`window for session ${sid} disconnected`);
    if (sid && !this.connOf(sid)) this.stopping.delete(sid);
    const cleanup = sid ? this.cleanups.get(sid) : undefined;
    if (sid && cleanup && !this.connOf(sid)) {
      if (cleanup.phase === "exiting") {
        // The cleanup's summary tells the topic instead of "session ended".
        const t = this.stops.get(sid);
        if (t) clearTimeout(t);
        this.stops.delete(sid);
        void this.finishCleanup(sid, cleanup, ws.data.exitingPid);
      } else {
        this.log.info(`window for session ${sid} closed while compacting for /cleanup; /cleanup dropped`);
        this.notice(sid, "⚠️ Окно закрылось до конца компакта, /cleanup отменена", true);
        this.dropCleanup(sid);
      }
    }
    const stop = sid ? this.stops.get(sid) : undefined;
    if (sid && stop && !this.connOf(sid)) {
      clearTimeout(stop);
      this.stops.delete(sid);
      this.notice(sid, "⏹ Сессия завершена", false);
    }
    this.armIdle();
  }

  // With idleMs 0, or a launch command to start sessions from the topic, the
  // hub stays up with no window at all; and while a topic command runs, so
  // its result reaches the topic.
  private alwaysOn(): boolean {
    return this.opts.idleMs <= 0 || this.opts.config().launch !== undefined || (this.execs?.running() ?? 0) > 0;
  }

  private armIdle(): void {
    if (this.conns.size > 0 || !this.running || this.alwaysOn()) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.conns.size > 0 || this.alwaysOn()) return;
      this.idleExpired = true;
      if (this.deliverable() > 0) this.log.info(`no plugins connected — exiting once ${this.deliverable()} queued piece(s) reach Telegram`);
      this.maybeExit();
    }, this.opts.idleMs);
  }

  // Queued pieces that can still go out without the user fixing anything.
  private deliverable(): number {
    return this.outbox
      .sessions()
      .filter(s => !this.blocked.has(s))
      .reduce((n, s) => n + this.outbox.countOf(s), 0);
  }

  private maybeExit(): void {
    if (!this.idleExpired || !this.running || this.conns.size > 0 || this.deliverable() > 0) return;
    if (this.outbox.size) this.log.info(`no plugins connected — exiting; ${this.outbox.size} queued piece(s) wait on disk until the setup is fixed`);
    else this.log.info("no plugins connected — exiting");
    void this.stop().then(() => this.opts.onExit());
  }

  private send(ws: WS, msg: HubToPlugin): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {}
  }

  private connOf(sessionId: string): WS | undefined {
    let found: WS | undefined;
    for (const ws of this.conns) if (ws.data.sessionId === sessionId) found = ws;
    return found;
  }

  private onHook(body: HookBody): void {
    if (!body.messagingSocket || !body.session_id || !body.transcript_path) return;
    // /cleanup edits this file; only one named after the session is trusted.
    if (basename(body.transcript_path) === `${body.session_id}.jsonl`) this.store.setTranscript(body.session_id, body.transcript_path);
    for (const ws of this.conns) {
      if (ws.data.windowKey === body.messagingSocket) {
        this.forwardHook(ws, body);
        return;
      }
    }
    this.pendingHooks.set(body.messagingSocket, { body, at: Date.now() });
  }

  private forwardHook(ws: WS, body: HookBody): void {
    this.send(ws, { type: "switchSession", sessionId: body.session_id, transcriptPath: body.transcript_path, cwd: body.cwd });
  }

  // --- plugin messages -----------------------------------------------------

  private onMessage(ws: WS, raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = pluginToHub.safeParse(json);
    if (!parsed.success) {
      this.log.warn(`unknown message from window ${ws.data.windowKey ?? "?"}: ${raw.slice(0, LOGGED_MESSAGE_CHARS)}`);
      return;
    }
    const msg = parsed.data;
    try {
      this.dispatch(ws, msg);
    } catch (e) {
      this.log.error(`handling ${msg.type} failed: ${e}`);
    }
  }

  private dispatch(ws: WS, msg: PluginToHub): void {
    const sid = ws.data.sessionId;
    switch (msg.type) {
      case "hello": {
        if (msg.v !== PROTOCOL_VERSION) this.log.warn(`plugin protocol v${msg.v}, hub v${PROTOCOL_VERSION}`);
        ws.data = { windowKey: msg.windowKey, sessionId: msg.sessionId, cwd: msg.cwd, account: accountOf(msg.configDir), busy: msg.busy, reportsSeen: msg.reportsSeen };
        this.store.setWhere(msg.sessionId, msg.cwd, ws.data.account);
        this.log.info(`window ${msg.windowKey} connected, session ${msg.sessionId}, account ${ws.data.account ?? "not named"}`);
        this.askDefaultAccount(ws, msg.configDir);
        this.pushState(msg.sessionId);
        this.giveHeldResults(ws, msg.sessionId);
        const pending = this.pendingHooks.get(msg.windowKey);
        this.pendingHooks.delete(msg.windowKey);
        if (pending && Date.now() - pending.at < HOOK_TTL_MS) this.forwardHook(ws, pending.body);
        this.launched(ws, msg.sessionId);
        if (msg.busy) this.showTyping(ws);
        return;
      }
      case "session":
        ws.data.sessionId = msg.sessionId;
        ws.data.cwd = msg.cwd;
        ws.data.account = accountOf(msg.configDir) ?? ws.data.account;
        this.store.setWhere(msg.sessionId, msg.cwd, ws.data.account);
        this.log.info(`window ${ws.data.windowKey} switched to session ${msg.sessionId}`);
        this.pushState(msg.sessionId);
        this.launched(ws, msg.sessionId);
        return;
      case "req":
        void this.handleRequest(ws, msg);
        return;
      // The plugin sends only text written while the mode was on, so it is
      // delivered whatever the mode is now. The ack goes once it is on disk.
      case "send": {
        const target = msg.sessionId ?? sid;
        if (target) this.enqueue(target, msg.id, msg.text, msg.notify);
        else this.log.warn(`text from a window that has not said hello, not sent:
${msg.text}`);
        this.send(ws, { type: "ack", id: msg.id });
        return;
      }
      case "sendFiles":
        this.enqueueFiles(msg, ws);
        this.send(ws, { type: "ack", id: msg.id });
        return;
      case "permission":
        if (sid && this.store.get(sid)?.enabled) this.askPermission(sid, msg);
        return;
      case "title":
        if (sid) void this.chain(sid, () => this.retitle(sid, msg.title));
        return;
      case "terminalInput":
        if (!sid) return;
        this.log.info(`terminal input in session ${sid}: Telegram mode off`);
        this.setEnabled(sid, false);
        return;
      case "card":
        this.onCard(msg);
        return;
      case "seen":
        for (const id of msg.messageIds) this.seen(id);
        return;
      // Shown at once, then renewed by the typing timer.
      case "busy":
        ws.data.busy = msg.busy;
        if (!msg.busy) return;
        this.showTyping(ws);
        if (sid) this.dropLaunchNotices(sid);
        return;
      case "exiting":
        this.log.info(`session ${sid}: the plugin ends Claude Code ${msg.pid}`);
        ws.data.exitingPid = msg.pid;
        return;
    }
  }

  // "typing…" in the topic of a busy window's session while the mode is on.
  private showTyping(ws: WS): void {
    const sid = ws.data.sessionId;
    const rec = sid ? this.store.get(sid) : undefined;
    const api = this.opts.api;
    const groupId = this.opts.config().groupId;
    if (!sid || !rec?.enabled || !api || !groupId || this.typingQueued.has(sid)) return;
    this.typingQueued.add(sid);
    this.typingQueue = this.typingQueue.then(() => {
      this.typingQueued.delete(sid);
      return api.sendTyping(groupId, rec.topicId).then(
        () => {
          const failures = this.typingFailed.get(sid);
          if (!failures) return;
          this.typingFailed.delete(sid);
          this.log.info(`typing in the topic of session ${sid} works again after ${failures} failed attempt(s)`);
        },
        e => {
          const failures = this.typingFailed.get(sid) ?? 0;
          if (!failures) this.log.warn(`showing typing in the topic of session ${sid} failed: ${e}`);
          this.typingFailed.set(sid, failures + 1);
        },
      );
    });
  }

  private async handleRequest(ws: WS, msg: Extract<PluginToHub, { type: "req" }>): Promise<void> {
    const sid = ws.data.sessionId;
    try {
      let result: unknown;
      if (!sid) throw new Error("window has not said hello");
      if (msg.op === "enable") result = await this.chain(sid, () => this.enable(sid, ws.data.cwd ?? "", ws.data.account, msg.title));
      else if (msg.op === "disable") result = this.setEnabled(sid, false);
      else result = await this.requireApi().downloadFile(msg.fileId, this.opts.inboxDir);
      this.send(ws, { type: "res", id: msg.id, ok: true, result });
    } catch (e) {
      this.send(ws, { type: "res", id: msg.id, ok: false, error: e instanceof TelegramError ? e.message : e instanceof Error ? e.message : String(e) });
    }
  }

  // Serializes everything that touches one session's topic.
  private chain<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(sessionId, next.catch(() => {}));
    return next;
  }

  private requireApi(): TelegramApi {
    if (!this.opts.api) throw new SetupError("TELEGRAM_BOT_TOKEN is not set — put it into .env in the tg-hub state dir and restart the hub");
    return this.opts.api;
  }

  private requireGroup(): string {
    const groupId = this.opts.config().groupId;
    if (!groupId) {
      throw new SetupError('groupId is not configured — set "groupId" in config.json in the tg-hub state dir; hub.log lists the ids of chats the bot receives messages from');
    }
    return groupId;
  }

  private async enable(sessionId: string, cwd: string, account: string | undefined, title: string): Promise<EnableResult> {
    const api = this.requireApi();
    const groupId = this.requireGroup();
    const existing = this.store.get(sessionId);
    if (existing) {
      if (title && existing.title !== title) await this.renameTopic(api, groupId, sessionId, existing, title);
      this.setEnabled(sessionId, true);
      return { topicTitle: topicName(existing.project, existing.title), created: false };
    }
    const project = projectName(cwd);
    const topic = await api.createForumTopic(groupId, topicName(project, title));
    this.store.set(sessionId, { topicId: topic.message_thread_id, title, project, enabled: true, ...(cwd ? { cwd } : {}), ...(account ? { account } : {}) });
    this.log.info(`created topic ${topic.message_thread_id} "${topic.name}" for session ${sessionId}`);
    this.pushState(sessionId);
    return { topicTitle: topicName(project, title), created: true };
  }

  private async retitle(sessionId: string, title: string): Promise<void> {
    const rec = this.store.get(sessionId);
    if (!rec || !title || rec.title === title || !this.opts.api) return;
    const groupId = this.opts.config().groupId;
    if (!groupId) return;
    try {
      await this.renameTopic(this.opts.api, groupId, sessionId, rec, title);
    } catch (e) {
      this.log.warn(`renaming topic of ${sessionId} failed: ${e}`);
    }
  }

  private async renameTopic(api: TelegramApi, groupId: string, sessionId: string, rec: SessionRecord, title: string): Promise<void> {
    await api.editForumTopic(groupId, rec.topicId, topicName(rec.project, title));
    this.store.set(sessionId, { ...rec, title });
  }

  private setEnabled(sessionId: string, on: boolean): boolean {
    this.store.setEnabled(sessionId, on);
    this.pushState(sessionId);
    return on;
  }

  private pushState(sessionId: string): void {
    const ws = this.connOf(sessionId);
    if (!ws) return;
    const rec = this.store.get(sessionId);
    this.send(ws, { type: "state", enabled: rec?.enabled ?? false, ...(rec ? { topicTitle: topicName(rec.project, rec.title) } : {}) });
  }

  // --- permissions ----------------------------------------------------------

  // A prompt with a request id gets buttons; the tool's input goes under the
  // description as code.
  private askPermission(sessionId: string, msg: Extract<PluginToHub, { type: "permission" }>): void {
    const head = `🔐 Нужно подтверждение: ${msg.toolName} — ${msg.description}`;
    const preview = msg.inputPreview && msg.inputPreview.length > MAX_PREVIEW_CHARS ? `${msg.inputPreview.slice(0, MAX_PREVIEW_CHARS)}…` : msg.inputPreview;
    const f: Formatted = preview ? { text: `${head}\n\n${preview}`, entities: [{ type: "pre", offset: head.length + 2, length: preview.length }] } : { text: head, entities: [] };
    if (!msg.requestId) return this.enqueue(sessionId, `perm-${randomUUID()}`, f.text, true, false);
    const key = randomUUID().replaceAll("-", "").slice(0, PERMISSION_KEY_CHARS);
    this.permissions.set(key, { sessionId, requestId: msg.requestId, ...f });
    for (const old of this.permissions.keys()) {
      if (this.permissions.size <= MAX_PERMISSIONS) break;
      this.permissions.delete(old);
    }
    const buttons = [
      [
        { text: "✅ Разрешить", data: `p:${key}:allow` },
        { text: "❌ Отклонить", data: `p:${key}:deny` },
      ],
    ];
    if (this.outbox.add(`perm-${key}`, sessionId, [{ text: f.text, silent: false, buttons, ...(f.entities.length ? { entities: f.entities } : {}) }])) void this.pump(sessionId);
  }

  // A button under a permission prompt: the answer goes to the session's
  // window, and the message shows it instead of the buttons.
  private async onPermissionPress(api: TelegramApi, groupId: string, press: { id: string; data: string; messageId: number; fromId: string }): Promise<void> {
    const m = press.data.match(/^p:(\w+):(allow|deny)$/);
    const behavior = m?.[2] === "allow" || m?.[2] === "deny" ? m[2] : undefined;
    const p = m?.[1] ? this.permissions.get(m[1]) : undefined;
    if (!m?.[1] || !behavior || !p) {
      await api.answerCallbackQuery(press.id, "Запрос устарел").catch(e => this.log.warn(`answering a button press failed: ${e}`));
      await api.removeKeyboard(groupId, press.messageId).catch(e => this.log.warn(`removing the buttons failed: ${e}`));
      return;
    }
    const ws = this.connOf(p.sessionId);
    const outcome = ws ? PERMISSION_ANSWERS[behavior] : "⚠️ Сессия не активна, ответ не доставлен";
    if (ws) {
      this.permissions.delete(m[1]);
      this.send(ws, { type: "permissionReply", requestId: p.requestId, behavior });
      this.log.info(`permission ${p.requestId} of session ${p.sessionId}: ${behavior} by ${press.fromId}`);
    }
    await api.answerCallbackQuery(press.id, outcome).catch(e => this.log.warn(`answering a button press failed: ${e}`));
    await api.editMessageText(groupId, press.messageId, `${p.text}\n\n${outcome}`, p.entities).catch(e => this.log.warn(`editing a permission message failed: ${e}`));
  }

  // --- subagent cards -------------------------------------------------------

  // The first version of a card is queued like any text, so it keeps its place
  // among the session's messages; later versions edit that message, at most
  // every CARD_EDIT_MS.
  private onCard(msg: Extract<PluginToHub, { type: "card" }>): void {
    this.upsertCard(msg.sessionId, msg.id, msg.text, msg.final);
  }

  // A subagent's card or a topic command's: buttons, when given, go under it.
  private upsertCard(sessionId: string, cardId: string, markdown: string, final: boolean, buttons?: Button[][]): void {
    if (!this.store.get(sessionId)) return;
    const key = `${sessionId}:${cardId}`;
    const card = this.cards.get(key);
    // A finished card stays finished: a late version changes nothing.
    if (card?.done) return;
    if (card) {
      card.text = markdown;
      card.final = final;
      card.buttons = buttons;
      if (card.messageId !== undefined) this.scheduleCardEdit(key, card);
      return;
    }
    this.cards.set(key, { text: markdown, final, done: false, lastEdit: 0, editing: false, ...(buttons ? { buttons } : {}) });
    for (const old of this.cards.keys()) {
      if (this.cards.size <= MAX_CARDS) break;
      this.cards.delete(old);
    }
    this.saveCards();
    const [first] = textPieces(markdown, true);
    // The outbox remembers sent ids: a card sent anew needs a new one.
    if (first && this.outbox.add(`card-${randomUUID()}`, sessionId, [{ ...first, card: key }])) void this.pump(sessionId);
  }

  // On the card's creation, first send and end: its text in between is the
  // plugin's to send again.
  private saveCards(): void {
    if (!this.opts.cardsFile) return;
    try {
      saveCards(
        this.opts.cardsFile,
        [...this.cards].map(([key, c]) => [key, { text: c.text, done: c.done, ...(c.messageId !== undefined ? { messageId: c.messageId } : {}), ...(c.buttons ? { buttons: c.buttons } : {}) }]),
      );
    } catch (e) {
      this.log.warn(`saving subagent cards failed: ${e}`);
    }
  }

  private scheduleCardEdit(key: string, card: Card): void {
    if (card.timer || card.editing) return;
    if (card.text === card.shown) {
      if (card.final && !card.done) {
        card.done = true;
        this.saveCards();
      }
      return;
    }
    this.cardTimer(key, card, card.lastEdit + (this.opts.cardEditMs ?? CARD_EDIT_MS));
  }

  // Takes the next free slot for a card edit, no earlier than `earliest` and
  // not during a flood wait.
  private cardTimer(key: string, card: Card, earliest: number): void {
    const at = Math.max(earliest, this.nextCardEdit, this.opts.api?.floodEndsAt() ?? 0);
    this.nextCardEdit = at + (this.opts.cardGapMs ?? CARD_GAP_MS);
    card.timer = setTimeout(
      () => {
        card.timer = undefined;
        void this.editCard(key, card);
      },
      Math.max(0, at - Date.now()),
    );
  }

  private async editCard(key: string, card: Card): Promise<void> {
    if (!this.running || card.messageId === undefined || !this.opts.api) return;
    // The session's text goes first; the card takes a later slot.
    if (this.pumping.size || this.opts.api.floodEndsAt() > Date.now()) return this.cardTimer(key, card, Date.now());
    const text = card.text;
    const f = cardFormat(text);
    card.editing = true;
    try {
      await this.opts.api.editMessageText(this.requireGroup(), card.messageId, f.text, f.entities, card.buttons);
      card.shown = text;
    } catch (e) {
      if (e instanceof TelegramError && /message is not modified/i.test(e.description)) card.shown = text;
      else if (e instanceof TelegramError && /message to edit not found/i.test(e.description)) {
        this.cards.delete(key);
        this.saveCards();
        return;
      } else if (e instanceof TelegramError && e.code !== TOO_MANY_REQUESTS) {
        // Retrying the same version cannot help; the next one may.
        this.log.warn(`Telegram did not take an edit of subagent card ${key}: ${e.description}`);
        card.shown = text;
      } else this.log.warn(`editing subagent card ${key} failed, retrying: ${e instanceof Error ? e.message : e}`);
    } finally {
      card.editing = false;
      card.lastEdit = Date.now();
    }
    if (this.cards.get(key) === card) this.scheduleCardEdit(key, card);
  }

  // --- delivery -------------------------------------------------------------

  // Puts text for a session's topic into the queue on disk and starts its
  // delivery. Throws only if the queue cannot be written; then the plugin gets
  // no ack and sends the text again. Agent text is Markdown: long formatted
  // text and tables go as rich messages, the rest as ordinary ones with
  // entities. The hub's own texts go as they are.
  private enqueue(sessionId: string, sourceId: string, text: string, notify: boolean, markdown = true): void {
    if (!this.store.get(sessionId)) {
      this.log.warn(`session ${sessionId} has no topic, text not sent:\n${text}`);
      return;
    }
    const pieces = (markdown ? markdownPieces(text) : textPieces(text, false)).map((p, i) => ({ ...p, silent: !(notify && i === 0) }));
    if (pieces.length && this.outbox.add(sourceId, sessionId, pieces)) void this.pump(sessionId);
  }

  // One queue item per Telegram send, so a retry never repeats an album that
  // already went out. The caption and the sound go with the first send.
  private enqueueFiles(msg: Extract<PluginToHub, { type: "sendFiles" }>, ws?: WS): void {
    const fail = (error: string) => {
      this.dropFiles(msg.files.filter(f => this.inFilesDir(f.path)));
      this.filesSent(msg.id, msg.sessionId, [error], ws);
    };
    const outside = msg.files.filter(f => !this.inFilesDir(f.path));
    if (outside.length) {
      this.log.error(`files outside ${this.opts.filesDir} refused for session ${msg.sessionId}: ${outside.map(f => f.path).join(", ")}`);
      return fail(`the hub sends only copies from ${this.opts.filesDir}`);
    }
    if (!this.store.get(msg.sessionId)) {
      this.log.warn(`session ${msg.sessionId} has no topic, files not sent: ${msg.files.map(f => f.name).join(", ")}`);
      return fail("This session has no Telegram topic yet — call tg_enable first.");
    }
    const caption = toTelegram(msg.caption);
    const pieces = albums(msg.files.map(f => ({ ...f, kind: msg.asDocument ? "document" : kindOf(f.name, f.size) }))).map((files, i) => filesPiece(files, i === 0 ? caption : undefined, msg.notify && i === 0));
    if (this.outbox.add(msg.id, msg.sessionId, pieces)) {
      this.fileMessages.set(msg.id, { errors: [], ws });
      void this.pump(msg.sessionId);
    } else if (!this.outbox.hasMessage(msg.id)) {
      // Sent before; the plugin re-sent it after a reconnect.
      this.filesSent(msg.id, msg.sessionId, [], ws);
    } else {
      const entry = this.fileMessages.get(msg.id);
      if (entry) entry.ws = ws;
    }
  }

  private inFilesDir(path: string): boolean {
    return isInside(this.opts.filesDir, path);
  }

  // Removes queued copies, their thumbnails and the message folder once it is empty.
  private dropFiles(files: { path: string }[]): void {
    for (const f of files) {
      if (!this.inFilesDir(f.path)) continue;
      try {
        rmSync(f.path, { force: true });
        rmSync(thumbPath(f.path), { force: true });
        rmdirSync(dirname(f.path));
      } catch {}
    }
  }

  private filesSent(id: string, sessionId: string, errors: string[], ws?: WS): void {
    const msg: HubToPlugin = { type: "filesSent", id, ...(errors.length ? { error: errors.join("; ") } : {}) };
    const target = ws && this.conns.has(ws) ? ws : this.connOf(sessionId);
    if (target) return this.send(target, msg);
    this.heldResults.set(sessionId, [...(this.heldResults.get(sessionId) ?? []), msg]);
  }

  private giveHeldResults(ws: WS, sessionId: string): void {
    for (const msg of this.heldResults.get(sessionId) ?? []) this.send(ws, msg);
    this.heldResults.delete(sessionId);
  }

  // A piece left the queue: its files are no longer needed, and the window
  // hears when the last send of its files is done.
  private settled(item: OutItem): void {
    if (item.files) this.dropFiles(item.files);
    const id = messageOf(item.id);
    const entry = this.fileMessages.get(id);
    if (!entry || this.outbox.hasMessage(id)) return;
    this.fileMessages.delete(id);
    this.filesSent(id, item.sessionId, entry.errors, entry.ws);
  }

  // Delivers a session's queue strictly in order: a piece leaves the queue
  // only after Telegram accepted it. Network and server failures are retried
  // for as long as it takes; a piece Telegram rejects is replaced by a notice.
  private async pump(sessionId: string): Promise<void> {
    if (this.pumping.has(sessionId)) return;
    this.pumping.add(sessionId);
    const base = this.opts.sendRetryBaseMs ?? SEND_RETRY_BASE_MS;
    const max = this.opts.sendRetryMaxMs ?? SEND_RETRY_MAX_MS;
    let failures = 0;
    try {
      while (this.running) {
        const item = this.outbox.head(sessionId);
        if (!item) break;
        try {
          await this.sendItem(sessionId, item);
          this.outbox.remove(item.id);
          this.settled(item);
          if (failures) this.log.info(`delivery to session ${sessionId} works again after ${failures} failed attempt(s)`);
          failures = 0;
          this.blocked.delete(sessionId);
          continue;
        } catch (e) {
          if (!this.running) break;
          const kind = classify(e);
          if (kind === "rejected") {
            this.onRejected(item, e);
            continue;
          }
          failures++;
          if (failures === 1) {
            const waiting = `${this.outbox.countOf(sessionId)} piece(s) wait`;
            this.log.warn(
              kind === "setup"
                ? `delivery to session ${sessionId} is blocked: ${e instanceof Error ? e.message : e} — fix the bot or group setup; ${waiting}, retrying every ${max / 1000} s`
                : `delivery to session ${sessionId} failed (${e instanceof Error ? e.message : e}); ${waiting}, retrying`,
            );
          }
          if (kind === "setup") {
            this.blocked.add(sessionId);
            this.maybeExit();
          }
          await this.sleep(kind === "setup" ? max : Math.min(base * 2 ** (failures - 1), max));
        }
      }
    } finally {
      this.pumping.delete(sessionId);
      if (!this.outbox.head(sessionId)) this.blocked.delete(sessionId);
      this.maybeExit();
    }
  }

  private async sendItem(sessionId: string, item: OutItem): Promise<void> {
    if (!this.store.get(sessionId)) {
      this.log.error(`session ${sessionId} lost its topic record, ${item.files ? `files not sent: ${names(item.files)}` : `text not sent:\n${item.text}`}`);
      return;
    }
    const api = this.requireApi();
    const groupId = this.requireGroup();
    const { rich, files: queued } = item;
    if (rich) {
      await this.sendToTopic(api, groupId, sessionId, thread => api.sendRichMessage(groupId, thread, rich, item.silent));
      return;
    }
    const card = item.card ? this.cards.get(item.card) : undefined;
    if (item.card && card) {
      // The card may have changed while it waited in the queue.
      const text = card.text;
      const f = cardFormat(text);
      const buttons = card.buttons;
      const sent = await this.sendToTopic(api, groupId, sessionId, thread => api.sendMessage(groupId, thread, f.text, true, f.entities, buttons));
      card.messageId = sent.message_id;
      card.shown = text;
      card.lastEdit = Date.now();
      this.saveCards();
      this.scheduleCardEdit(item.card, card);
      return;
    }
    if (!queued) {
      const { text } = item;
      const sent = await this.sendToTopic(api, groupId, sessionId, thread => api.sendMessage(groupId, thread, text, item.silent, item.entities, item.buttons));
      if (item.id.startsWith(LAUNCH_NOTICE)) this.launchNoticeSent(sessionId, sent.message_id, text);
      return;
    }
    const lost = queued.filter(f => !existsSync(f.path));
    if (lost.length) throw new LostFileError(`the queued copy is gone: ${lost.map(f => f.path).join(", ")}`);
    const files = await this.probeVideos(item.id, queued);
    await this.sendToTopic(api, groupId, sessionId, thread => api.sendFiles(groupId, thread, files, item.text, item.entities, item.silent));
  }

  // Videos are probed once, before their first send, and the result stays
  // with the queued piece; a thumbnail gone from disk is just not sent.
  private async probeVideos(itemId: string, queued: OutFile[]): Promise<OutFile[]> {
    let files = queued;
    if (files.some(f => f.kind === "video" && !f.video)) {
      const tools = this.opts.videoTools ?? DEFAULT_VIDEO_TOOLS;
      const probed: OutFile[] = [];
      for (const f of files) probed.push(f.kind === "video" && !f.video ? { ...f, video: await probeVideo(f.path, f.name, tools, this.log) } : f);
      this.outbox.setFiles(itemId, probed);
      files = probed;
    }
    return files.map(f => (f.video?.thumb && !existsSync(f.video.thumb) ? { ...f, video: { ...f.video, thumb: undefined } } : f));
  }

  // Before giving a piece up: a rich message Telegram cannot take goes as
  // plain text with entities, photos as documents, and formatting Telegram
  // cannot take is dropped.
  private onRejected(item: OutItem, e: unknown): void {
    const why = e instanceof TelegramError ? e.message : e instanceof Error ? e.message : String(e);
    if (item.rich) {
      this.log.warn(`Telegram rejected a rich message for session ${item.sessionId} (${why}); sending it as plain formatted text`);
      this.outbox.replace(item.id, textPieces(item.text, true).map((p, i) => ({ ...p, silent: item.silent || i > 0 })));
      return;
    }
    if (item.files?.some(f => f.kind === "photo") && e instanceof TelegramError && /PHOTO_|IMAGE_PROCESS_FAILED/i.test(e.description)) {
      this.log.warn(`Telegram rejected photos for session ${item.sessionId} (${why}); sending them as documents`);
      const files = item.files.map(f => (f.kind === "photo" ? { ...f, kind: "document" as const } : f));
      const caption = { text: item.text, entities: item.entities ?? [] };
      this.outbox.replace(item.id, albums(files).map((g, i) => filesPiece(g, i === 0 ? caption : undefined, !item.silent && i === 0)));
      return;
    }
    if (item.files && item.files.length > 1 && e instanceof TelegramError && e.code === TOO_LARGE) {
      this.log.warn(`Telegram rejected an album for session ${item.sessionId} as too large (${why}); sending its files one by one`);
      const caption = { text: item.text, entities: item.entities ?? [] };
      this.outbox.replace(item.id, item.files.map((f, i) => filesPiece([f], i === 0 ? caption : undefined, !item.silent && i === 0)));
      return;
    }
    if (item.entities?.length) {
      this.log.warn(`Telegram rejected a formatted message for session ${item.sessionId} (${why}); sending it without formatting`);
      this.outbox.dropEntities(item.id);
      return;
    }
    this.reject(item, e instanceof TelegramError ? e.description : why);
  }

  // Explicit beats silent: the topic learns that a message is missing, the
  // log keeps its text. Files the agent sent are the agent's to fix: it hears
  // of them through filesSent, the topic does not.
  private reject(item: OutItem, reason: string): void {
    if (item.files) {
      this.log.error(`Telegram did not take files for session ${item.sessionId}: ${reason}\n--- files ---\n${names(item.files)}\n--- end ---`);
      this.fileMessages.get(messageOf(item.id))?.errors.push(`${names(item.files)}: ${reason}`);
      this.outbox.remove(item.id);
      this.settled(item);
      return;
    }
    this.log.error(`Telegram rejected a message for session ${item.sessionId}: ${reason}\n--- text ---\n${item.text}\n--- end ---`);
    if (item.notice) {
      this.outbox.remove(item.id);
      this.settled(item);
    } else this.outbox.replaceWithNotice(item.id, `⚠️ Telegram не принял сообщение: ${reason}. Текст в hub.log.`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.abort.signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      this.abort.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  // Text a window could not hand to a hub before it closed.
  private ingestSpool(): void {
    const dir = this.opts.spoolDir;
    if (!dir) return;
    let files: string[];
    try {
      files = readdirSync(dir).filter(f => f.endsWith(".json"));
    } catch {
      return;
    }
    for (const f of files) {
      const path = join(dir, f);
      try {
        const items = spoolItems.parse(JSON.parse(readFileSync(path, "utf8")));
        for (const it of items) {
          if (it.type === "sendFiles") this.enqueueFiles(it);
          else this.enqueue(it.sessionId, it.id, it.text, it.notify);
        }
        unlinkSync(path);
        this.log.info(`took ${items.length} message(s) from ${path}`);
      } catch (e) {
        const aside = `${path}.corrupt-${Date.now()}`;
        try {
          renameSync(path, aside);
        } catch {}
        this.log.error(`spool file ${path} is unreadable (${e}); kept as ${aside}`);
      }
    }
  }

  private async sendToTopic<T>(api: TelegramApi, groupId: string, sessionId: string, send: (threadId: number) => Promise<T>): Promise<T> {
    const rec = this.store.get(sessionId);
    if (!rec) throw new Error(`session ${sessionId} has no topic`);
    try {
      return await send(rec.topicId);
    } catch (e) {
      if (!isThreadNotFound(e)) throw e;
      // The topic was deleted by hand: give the session a new one.
      const topic = await api.createForumTopic(groupId, topicName(rec.project, rec.title));
      this.store.set(sessionId, { ...rec, topicId: topic.message_thread_id });
      this.log.warn(`topic ${rec.topicId} of session ${sessionId} is gone, created ${topic.message_thread_id}`);
      return await send(topic.message_thread_id);
    }
  }

  // --- Telegram polling ----------------------------------------------------

  // getMe is a short request with a quick timeout, so it is what fights its way
  // through a flaky network; the long poll then reuses the warm connection.
  // A failed connect inside the long poll would otherwise hang for the whole
  // poll timeout.
  private async pollLoop(api: TelegramApi): Promise<void> {
    let offset = 0;
    let online = false;
    let wasOnline = false;
    let failures = 0;
    while (this.running) {
      if (!online) {
        try {
          const me = await api.getMe(this.abort.signal);
          this.log.info(wasOnline ? "Telegram polling works again" : `polling Telegram as @${me.username ?? me.id}`);
          if (!wasOnline) {
            this.botUsername = me.username;
            void this.registerCommands(api);
          }
          online = wasOnline = true;
          failures = 0;
        } catch (e) {
          if (!this.running) return;
          if (e instanceof TelegramError && e.code === 401) {
            this.log.error("bot token rejected by Telegram (401 Unauthorized) — fix TELEGRAM_BOT_TOKEN in .env and restart the hub; not polling");
            return;
          }
          this.log.warn(`Telegram unreachable (${e}); still trying`);
          await Bun.sleep(this.opts.pollRetryBaseMs ?? POLL_RETRY_BASE_MS);
          continue;
        }
      }
      let updates: Update[];
      try {
        updates = await api.getUpdates(offset, this.opts.pollTimeoutSec ?? POLL_TIMEOUT_SEC, this.abort.signal);
        if (failures) this.log.info("Telegram polling works again");
        failures = 0;
      } catch (e) {
        if (!this.running) return;
        if (!(e instanceof TelegramError)) {
          this.log.warn(`getUpdates lost the connection (${e}); reconnecting`);
          online = false;
          continue;
        }
        failures++;
        const delay = Math.min((this.opts.pollRetryBaseMs ?? POLL_RETRY_BASE_MS) * failures, MAX_POLL_DELAY_MS);
        const conflict = e.code === 409;
        this.log.warn(`${conflict ? "getUpdates 409 Conflict — another poller uses this bot token" : `getUpdates failed: ${e}`}; retry in ${delay}ms`);
        await Bun.sleep(delay);
        continue;
      }
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1);
        try {
          await this.handleUpdate(api, u);
        } catch (e) {
          this.log.error(`update ${u.update_id} failed: ${e}`);
        }
      }
    }
  }

  private async handleUpdate(api: TelegramApi, u: Update): Promise<void> {
    const cfg = this.opts.config();
    const press = routeCallback(u, cfg);
    if (press?.action === "ignore") {
      this.log.info(`ignored ${press.reason}`);
      if (press.id) await api.answerCallbackQuery(press.id).catch(e => this.log.warn(`answering a button press failed: ${e}`));
      return;
    }
    if (press?.data.startsWith("x:")) return this.onExecPress(api, press);
    if (press && cfg.groupId) return this.onPermissionPress(api, cfg.groupId, press);
    const route = routeUpdate(u, cfg, this.store, id => this.isConnected(id));
    const m = u.message;
    if (route.action === "ignore") {
      if (m) this.log.info(`ignored update from chat ${m.chat.id} (${m.chat.type}${m.chat.title ? ` "${m.chat.title}"` : ""}), sender ${m.from?.id}: ${route.reason}`);
      return;
    }
    if (!m) return;
    const hubCmd = m.text !== undefined ? hubCommandOf(m.text, this.botUsername) : undefined;
    if (hubCmd) return this.onHubCommand(route.sessionId, hubCmd, m);
    if (route.action === "inactive") {
      if (this.hold(route.sessionId, { message: m })) return;
      if (cfg.launch) return this.launch(route.sessionId, undefined, [{ message: m }]);
      const text = cfg.launchError ? `${INACTIVE_TEXT}; автозапуск не работает: секция launch в config.json с ошибкой` : INACTIVE_TEXT;
      if (cfg.groupId) await api.sendMessage(cfg.groupId, route.topicId, text, false).catch(e => this.log.warn(`inactive notice failed: ${e}`));
      return;
    }
    if (this.holdForCleanup(route.sessionId, m)) return;
    await this.deliver(api, route.sessionId, m);
  }

  // A /cleanup under way keeps topic messages for the session it starts
  // again; a module command still goes to the window, and so does a message
  // that interrupts the agent.
  private holdForCleanup(sessionId: string, m: Message): boolean {
    const c = this.cleanups.get(sessionId);
    if (!c) return false;
    if (m.text !== undefined && commandOf(m.text, this.botUsername)) return false;
    if ((m.text ?? m.caption ?? "").trimStart().startsWith(INTERRUPT_PREFIX)) return false;
    if (c.held.length >= MAX_HELD) {
      this.log.warn(`/cleanup of session ${sessionId} holds ${MAX_HELD} messages; message ${m.message_id} dropped`);
      return true;
    }
    c.held.push({ message: m });
    this.log.info(`message ${m.message_id} for session ${sessionId} held until /cleanup ends`);
    return true;
  }

  private async deliver(api: TelegramApi, sessionId: string, m: Message): Promise<void> {
    const ws = this.connOf(sessionId);
    if (!ws) {
      this.log.warn(`session ${sessionId} has no window, message ${m.message_id} not delivered`);
      return;
    }
    const cmd = m.text !== undefined ? commandOf(m.text, this.botUsername) : undefined;
    if (cmd) {
      this.queueCommand(sessionId, cmd);
      return;
    }
    this.setEnabled(sessionId, true);
    const { content, meta } = await this.inboundOf(api, m);
    if (ws.data.reportsSeen) this.reactLater(m.message_id);
    this.send(ws, { type: "inbound", content, meta });
    this.log.info(`message ${m.message_id} in topic ${m.message_thread_id} → session ${sessionId}: ${shapeOf(m, content)}`);
  }

  private reactLater(messageId: number): void {
    const timer = setTimeout(() => {
      this.reactionTimers.delete(messageId);
      this.react(messageId, TAKEN_REACTION);
    }, this.opts.reactionDelayMs ?? REACTION_DELAY_MS);
    this.reactionTimers.set(messageId, timer);
  }

  // The agent has the message: ✍ comes off, or never goes on.
  private seen(messageId: number): void {
    const timer = this.reactionTimers.get(messageId);
    if (timer === undefined) return this.react(messageId, undefined);
    clearTimeout(timer);
    this.reactionTimers.delete(messageId);
  }

  // The bot's reaction on a topic message: set, or taken off without an
  // emoji. One message's changes go in the order they were asked for, so a
  // slow set cannot land after the clear that followed it.
  private react(messageId: number, emoji: string | undefined): void {
    const api = this.opts.api;
    const groupId = this.opts.config().groupId;
    if (!api || !groupId) return;
    const prev = this.reactions.get(messageId) ?? Promise.resolve();
    const next = prev
      .then(() => api.setMessageReaction(groupId, messageId, emoji))
      .then(
        () => {},
        e => this.log.warn(`${emoji ? "setting" : "clearing"} the reaction on message ${messageId} failed: ${e}`),
      );
    this.reactions.set(messageId, next);
    void next.then(() => {
      if (this.reactions.get(messageId) === next) this.reactions.delete(messageId);
    });
  }

  // --- starting and stopping sessions --------------------------------------

  // A starting session keeps what comes for it until it connects; false when
  // the session is not starting.
  private hold(sessionId: string, h: Held): boolean {
    const cleanup = this.cleanups.get(sessionId);
    const pending = this.launches.get(sessionId) ?? (cleanup && !this.connOf(sessionId) ? cleanup : undefined);
    if (!pending) return false;
    if (pending.held.length < MAX_HELD) pending.held.push(h);
    else this.log.warn(`session ${sessionId} is starting and holds ${MAX_HELD} messages; ${"message" in h ? `message ${h.message.message_id}` : "a command result"} dropped`);
    return true;
  }

  private onHubCommand(sessionId: string, cmd: HubCommand, m: Message): void {
    if (cmd.name === "exec" || cmd.name === "cmd" || cmd.name === "bash") return this.onExecCommand(sessionId, cmd.name, cmd.args, m);
    if (cmd.name === "run") {
      if (this.cleanups.has(sessionId)) return this.notice(sessionId, CLEANUP_BUSY, false);
      if (this.connOf(sessionId)) return this.notice(sessionId, "Сессия уже работает", false);
      if (this.launches.has(sessionId)) return this.notice(sessionId, "Сессия уже запускается", false);
      return this.launch(sessionId, cmd.args || undefined, []);
    }
    if (cmd.name === "cleanup") return this.startCleanup(sessionId, cmd.args);
    const cleanup = this.cleanups.get(sessionId);
    if (cleanup) return this.stopDuringCleanup(sessionId, cleanup);
    if (!this.connOf(sessionId)) return this.notice(sessionId, "Сессия не запущена", false);
    if (this.stops.has(sessionId)) return;
    if (this.stopping.has(sessionId)) {
      this.log.info(`second /stop for session ${sessionId}: not waiting for the module`);
      return this.terminate(sessionId);
    }
    // The module compacts the session first if it has to.
    this.stopping.set(sessionId, this.queueCommand(sessionId, { name: "stop", args: cmd.args }));
  }

  private terminate(sessionId: string): void {
    this.stopping.delete(sessionId);
    const queued = this.commands.get(sessionId) ?? [];
    for (const e of queued.filter(e => e.cmd.name === "stop")) clearTimeout(e.timer);
    this.commands.set(sessionId, queued.filter(e => e.cmd.name !== "stop"));
    const ws = this.connOf(sessionId);
    if (!ws || this.stops.has(sessionId)) return;
    this.log.info(`stopping session ${sessionId} from the topic`);
    this.send(ws, { type: "terminate" });
    const ms = this.opts.stopTimeoutMs ?? STOP_TIMEOUT_MS;
    this.stops.set(
      sessionId,
      setTimeout(() => {
        this.stops.delete(sessionId);
        if (this.cleanups.has(sessionId)) {
          this.log.warn(`session ${sessionId} did not end for /cleanup; /cleanup dropped`);
          this.dropCleanup(sessionId);
        }
        this.notice(sessionId, `⚠️ Не удалось завершить сессию за ${ms / MS_PER_SECOND} с`, true);
      }, ms),
    );
  }

  // --- /cleanup ---------------------------------------------------------------

  // The module compacts the session, the window ends, the hub empties the
  // skills Claude Code remembers in the transcript and starts it again.
  private startCleanup(sessionId: string, args: string): void {
    if (this.cleanups.has(sessionId)) return this.notice(sessionId, CLEANUP_BUSY, false);
    if (!this.connOf(sessionId)) return this.notice(sessionId, "Сессия не запущена", false);
    if (this.stops.has(sessionId) || this.stopping.has(sessionId)) return this.notice(sessionId, "⏳ Сессия уже завершается", false);
    const c: Cleanup = { id: this.queueCommand(sessionId, { name: "cleanup", args }), phase: "compacting", held: [] };
    const ms = this.opts.cleanupCompactMs ?? CLEANUP_COMPACT_MS;
    c.compactTimer = setTimeout(() => {
      if (this.cleanups.get(sessionId) !== c || c.phase !== "compacting") return;
      this.log.warn(`/cleanup of session ${sessionId}: no compact report in ${ms} ms; /cleanup dropped`);
      this.notice(sessionId, `⚠️ /cleanup не дождалась компакта за ${ms / MS_PER_MINUTE} мин, отменена. Сессию не трогаю`, true);
      this.dropCleanup(sessionId);
    }, ms);
    this.cleanups.set(sessionId, c);
  }

  // The first /stop only keeps the session from starting again; a second one
  // ends a compacting window at once, the transcript untouched.
  private stopDuringCleanup(sessionId: string, c: Cleanup): void {
    if (!c.noRelaunch) {
      c.noRelaunch = true;
      this.log.info(`/stop during /cleanup of session ${sessionId}: it will not start again`);
      return this.notice(sessionId, "⏹ После /cleanup сессию не запущу", false);
    }
    if (c.phase === "compacting") {
      this.log.info(`second /stop during the /cleanup compact of session ${sessionId}: ending the window, the transcript untouched`);
      this.dropCleanup(sessionId);
    }
    this.terminate(sessionId);
  }

  // A /cleanup given up before the window ended: the messages it held go to
  // the window still open, else as to a stopped session.
  private dropCleanup(sessionId: string): void {
    const c = this.cleanups.get(sessionId);
    if (c) clearTimeout(c.compactTimer);
    this.cleanups.delete(sessionId);
    const queued = this.commands.get(sessionId) ?? [];
    for (const e of queued.filter(e => e.cmd.name === "cleanup")) clearTimeout(e.timer);
    const left = queued.filter(e => e.cmd.name !== "cleanup");
    if (left.length) this.commands.set(sessionId, left);
    else this.commands.delete(sessionId);
    if (!c?.held.length) return;
    if (this.connOf(sessionId)) {
      this.log.info(`/cleanup of session ${sessionId} dropped: ${c.held.length} held message(s) go to its window`);
      void this.sendHeld(sessionId, c.held);
    } else if (this.opts.config().launch) {
      this.log.info(`/cleanup of session ${sessionId} dropped: ${c.held.length} held message(s) start the session`);
      this.launch(sessionId, undefined, c.held);
    } else this.log.warn(`/cleanup of session ${sessionId} dropped with no window and no launch command: ${c.held.length} held message(s) dropped`);
  }

  private onCleanupReport(sessionId: string, id: string, before: number | undefined, error: string | undefined): void {
    const c = this.cleanups.get(sessionId);
    if (!c || c.id !== id || c.phase !== "compacting") {
      this.log.info(`/cleanup report ${id} for session ${sessionId} ignored: that /cleanup was dropped or is unknown`);
      return;
    }
    clearTimeout(c.compactTimer);
    if (error !== undefined) {
      this.log.warn(`/cleanup of session ${sessionId}: the compact failed: ${error}`);
      this.notice(sessionId, `⚠️ /cleanup не выполнена: компакт не удался: ${error}. Сессию не трогаю`, true);
      return this.dropCleanup(sessionId);
    }
    this.log.info(`/cleanup of session ${sessionId}: compacted${before === undefined ? "" : ` from ${before} tokens`}; ending the window`);
    if (before !== undefined) c.before = before;
    c.phase = "exiting";
    this.terminate(sessionId);
  }

  // The window is gone: once Claude Code has exited, the skills go from the
  // transcript and the session starts again.
  private async finishCleanup(sessionId: string, c: Cleanup, pid: number | undefined): Promise<void> {
    const current = () => this.running && this.cleanups.get(sessionId) === c;
    const alive = this.opts.isAlive ?? isAlive;
    if (pid === undefined) {
      this.log.info(`/cleanup of session ${sessionId}: the Claude Code process is unknown; waiting for it to go`);
      await this.sleep(this.opts.cleanupSettleMs ?? CLEANUP_SETTLE_MS);
    } else {
      const deadline = Date.now() + (this.opts.cleanupExitMs ?? CLEANUP_EXIT_MS);
      while (current() && alive(pid) && !this.connOf(sessionId) && Date.now() < deadline) await this.sleep(EXIT_POLL_MS);
    }
    if (!current()) return;
    // A window of the session connected again: the edit would race it, and
    // what came meanwhile goes to it.
    if (this.connOf(sessionId)) {
      this.cleanups.delete(sessionId);
      this.log.warn(`/cleanup of session ${sessionId}: a window of the session connected again; the transcript untouched, ${c.held.length} held message(s) go to it`);
      this.notice(sessionId, "⚠️ Сессия снова открыта, скиллы не убраны", true);
      return this.whenReady(() => this.sendHeld(sessionId, c.held));
    }
    if (pid !== undefined && alive(pid)) {
      this.cleanups.delete(sessionId);
      this.log.warn(`/cleanup of session ${sessionId}: Claude Code ${pid} did not exit; the transcript untouched, ${c.held.length} held message(s) dropped`);
      return this.notice(sessionId, "⚠️ Claude Code не завершился, скиллы не убраны, сессию не запускаю", true);
    }
    const path = this.transcriptOf(sessionId);
    let text: string;
    if (!path) {
      this.log.warn(`/cleanup of session ${sessionId}: no transcript found`);
      text = "⚠️ Транскрипт сессии не найден, скиллы не убраны";
    } else {
      try {
        const result = await (this.opts.cleanTranscript ?? cleanTranscript)(path, Date.now());
        this.log.info(`/cleanup of session ${sessionId}: ${path}: ${result.kind}${result.kind === "cleaned" ? `, ${result.records} record(s), backup ${result.backup}` : ""}`);
        text = cleanupSummary(c.before, result);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        this.log.warn(`/cleanup of session ${sessionId}: emptying the skills in ${path} failed: ${why}`);
        text = `⚠️ Скиллы не убраны: ${why}`;
      }
    }
    if (!current()) return;
    this.cleanups.delete(sessionId);
    // A window came back during the edit: it is not started a second time.
    if (this.connOf(sessionId)) {
      this.log.warn(`/cleanup of session ${sessionId}: a window of the session connected during the edit; not starting it, ${c.held.length} held message(s) go to it`);
      this.notice(sessionId, text, true);
      return this.whenReady(() => this.sendHeld(sessionId, c.held));
    }
    // Messages that came meanwhile still reach the agent, as a message to a
    // stopped session starts it.
    const relaunch = !c.noRelaunch || c.held.length > 0;
    this.notice(sessionId, relaunch ? text : text + CLEANUP_STOPPED, true);
    if (relaunch) this.launch(sessionId, undefined, c.held);
    else this.log.info(`/cleanup of session ${sessionId}: done; not starting it again after /stop`);
  }

  // The transcript the hook named, else the one found by the session id.
  private transcriptOf(sessionId: string): string | undefined {
    const known = this.store.get(sessionId)?.transcript;
    if (known && existsSync(known)) return known;
    return this.opts.projectsDir ? sessionTranscript(sessionId, this.opts.projectsDir) : undefined;
  }

  // Runs the configured command for a session without a window: the account
  // given, else the one it ran on last; with neither it does not start. The
  // messages wait until the session connects; one start at a time.
  private launch(sessionId: string, account: string | undefined, held: Held[]): void {
    const cfg = this.opts.config();
    const rec = this.store.get(sessionId);
    if (!rec) return;
    // A window of the session is open: a second Claude Code on the same
    // transcript would break it.
    if (this.connOf(sessionId)) {
      this.log.warn(`session ${sessionId} has a window; not starting it, ${held.length} held message(s) go to it`);
      if (held.length) this.whenReady(() => this.sendHeld(sessionId, held));
      return;
    }
    if (!cfg.launch) {
      const why = cfg.launchError ? `секция launch в config.json с ошибкой: ${cfg.launchError}` : "в config.json нет секции launch";
      return this.notice(sessionId, `⚠️ Автозапуск не настроен: ${why}`, true);
    }
    const acc = account ?? rec.account;
    if (!acc) return this.notice(sessionId, "⚠️ Аккаунт сессии неизвестен, не запускаю. Напиши /run N", true);
    const cwd = rec.cwd ?? (this.opts.projectsDir ? sessionCwd(sessionId, this.opts.projectsDir) : undefined);
    if (!cwd) return this.notice(sessionId, "⚠️ Не знаю, в какой папке запускать сессию: её нет ни в записи хаба, ни в транскрипте", true);
    let command: string[];
    try {
      command = launchCommand(cfg.launch, { cwd, account: acc, session: sessionId });
      this.log.info(`starting session ${sessionId} on account ${acc}: ${JSON.stringify(command)}`);
      (this.opts.spawn ?? spawnDetached)(command);
    } catch (e) {
      const why = e instanceof LaunchError ? e.message : `команда не запустилась (${e instanceof Error ? e.message : e})`;
      this.log.warn(`starting session ${sessionId} failed: ${why}`);
      return this.notice(sessionId, `⚠️ Не могу запустить сессию: ${why}`, true);
    }
    const sec = cfg.launch.timeoutSec;
    const timer = setTimeout(() => {
      const l = this.launches.get(sessionId);
      this.launches.delete(sessionId);
      this.log.warn(`session ${sessionId} did not connect in ${sec} s; ${l?.held.length ?? 0} held message(s) dropped`);
      this.launchEnded(sessionId, "failed");
      this.notice(sessionId, `⚠️ Сессия не запустилась за ${sec} с`, true);
    }, sec * MS_PER_SECOND);
    this.launches.set(sessionId, { account: acc, held, timer });
    this.launchEnds.delete(sessionId);
    this.launchNotice(sessionId, `🚀 Запускаю сессию (аккаунт ${acc})…`);
  }

  // A window of the session connected: a start it waited for is done, and
  // the held messages go once Claude Code is ready for them. A window that
  // does not name its account runs on the one it was started on.
  // Command results the agent has not got go after the held messages, so one
  // held for this start is not sent twice.
  private launched(ws: WS, sessionId: string): void {
    const l = this.launches.get(sessionId);
    if (!l) {
      if (this.execs) this.whenReady(() => this.execs?.connected(sessionId));
      return;
    }
    clearTimeout(l.timer);
    this.launches.delete(sessionId);
    if (!ws.data.account) {
      ws.data.account = l.account;
      this.store.setWhere(sessionId, undefined, l.account);
    }
    this.log.info(`session ${sessionId} started, ${l.held.length} held message(s) to deliver`);
    this.launchEnded(sessionId, "started");
    if (!l.held.length && !this.execs) return;
    this.whenReady(async () => {
      await this.sendHeld(sessionId, l.held);
      this.execs?.connected(sessionId);
    });
  }

  // Hands held messages and command results to the session's window, in the
  // order they came.
  private async sendHeld(sessionId: string, held: Held[]): Promise<void> {
    for (const h of held) {
      try {
        if ("message" in h) await this.deliver(this.requireApi(), sessionId, h.message);
        else this.deliverInbound(sessionId, h.inbound);
      } catch (e) {
        this.log.error(`delivering held ${"message" in h ? `message ${h.message.message_id}` : "command result"} to session ${sessionId} failed: ${e}`);
      }
    }
  }

  // Runs once Claude Code is ready for channel messages.
  private whenReady(fn: () => void | Promise<void>): void {
    const t = setTimeout(() => {
      this.readyTimers.delete(t);
      void fn();
    }, this.opts.readyDelayMs ?? READY_DELAY_MS);
    this.readyTimers.add(t);
  }

  // --- topic commands -------------------------------------------------------

  private bashPath(): string {
    return this.opts.config().exec?.bash ?? DEFAULT_BASH;
  }

  // /exec, /cmd or /bash: the text runs in the session's folder, with or
  // without its window.
  private onExecCommand(sessionId: string, name: "exec" | "cmd" | "bash", text: string, m: Message): void {
    if (!this.execs) return this.notice(sessionId, EXEC_NOT_SET, false);
    if (!text) return this.enqueue(sessionId, `hub-${randomUUID()}`, "Напиши команду: `/exec npm run migrate`", false);
    // cmd /c runs only up to the first line break.
    if (name === "cmd" && /[\r\n]/.test(text)) return this.notice(sessionId, "/cmd выполняет одну строку. Для нескольких — /exec или /bash", false);
    const bash = this.bashPath();
    if (name === "bash" && !existsSync(bash)) return this.notice(sessionId, `Git Bash не найден: ${bash}. Укажи exec.bash в config.json`, false);
    const rec = this.store.get(sessionId);
    const cwd = rec?.cwd ?? (this.opts.projectsDir ? sessionCwd(sessionId, this.opts.projectsDir) : undefined);
    if (!cwd) return this.notice(sessionId, "⚠️ Не знаю, в какой папке запускать команду: её нет ни в записи хаба, ни в транскрипте", true);
    const shell: ExecShell = name === "exec" ? "powershell" : name;
    this.log.info(`/${name} for session ${sessionId}, message ${m.message_id}`);
    this.execs.command(sessionId, shell, text, cwd, { chatId: String(m.chat.id), messageId: m.message_id, date: m.date });
  }

  private async onExecPress(api: TelegramApi, press: { id: string; data: string; fromId: string }): Promise<void> {
    const m = press.data.match(/^x:(\w+):(stop|run)$/);
    const action = m?.[2] === "stop" || m?.[2] === "run" ? m[2] : undefined;
    const answer = !m?.[1] || !action ? "Запуск не найден" : this.execs ? this.execs.press(m[1], action) : EXEC_NOT_SET;
    if (m?.[1] && action) this.log.info(`exec ${m[1]}: ${action} pressed by ${press.fromId}: ${answer}`);
    await api.answerCallbackQuery(press.id, answer).catch(e => this.log.warn(`answering a button press failed: ${e}`));
  }

  // A command's result reaches the agent as a topic message would: at once
  // with a window, after the start with a session starting or startable.
  private reportExec(sessionId: string, inbound: Inbound): void {
    if (this.connOf(sessionId)) this.deliverInbound(sessionId, inbound);
    else if (this.hold(sessionId, { inbound })) {
      // Goes once the session connects.
    } else if (this.opts.config().launch) this.launch(sessionId, undefined, [{ inbound }]);
    else {
      this.notice(sessionId, "⚠️ Сессия не запущена: результат команды агенту не доставлен", true);
      inbound.onSent();
    }
    // The last command ended: the hub may go idle again.
    if (!this.execs?.running()) this.armIdle();
  }

  private deliverInbound(sessionId: string, inbound: Inbound): void {
    const ws = this.connOf(sessionId);
    if (!ws) {
      this.log.warn(`session ${sessionId} has no window, command result not delivered`);
      return;
    }
    this.setEnabled(sessionId, true);
    this.send(ws, { type: "inbound", content: inbound.content, meta: inbound.meta });
    inbound.onSent();
    this.log.info(`command result ${inbound.meta.exec_id ?? "?"} → session ${sessionId}`);
  }

  // The hub's own copy goes, as for files from a window.
  private sendExecFile(sessionId: string, path: string, name: string, loud: boolean): void {
    const id = randomUUID();
    const copy = join(this.opts.filesDir, id, name);
    mkdirSync(dirname(copy), { recursive: true });
    copyFileSync(path, copy);
    const file: OutFile = { path: copy, name, size: statSync(copy).size, kind: "document" };
    if (this.outbox.add(`exec-${id}`, sessionId, [filesPiece([file], undefined, loud)])) void this.pump(sessionId);
  }

  // A window on the default login does not name its account in its config
  // dir; cswap tells which account that login is.
  private askDefaultAccount(ws: WS, configDir: string | undefined): void {
    if (!configDir || !isDefaultConfigDir(configDir, this.opts.defaultConfigDir ?? DEFAULT_CONFIG_DIR)) return;
    void (this.opts.defaultAccount ?? defaultLoginAccount)().then(account => {
      const sid = ws.data.sessionId;
      if (!account || !sid) return this.log.warn(`window ${ws.data.windowKey}: the account of the default login is unknown`);
      this.log.info(`window ${ws.data.windowKey} runs on the default login, account ${account}`);
      ws.data.account = account;
      this.store.setWhere(sid, undefined, account);
    });
  }

  // The hub's own word in a session's topic, in order with the rest.
  private notice(sessionId: string, text: string, loud: boolean): void {
    this.enqueue(sessionId, `hub-${randomUUID()}`, text, loud, false);
  }

  // A silent notice needed only until the session's agent starts working.
  private launchNotice(sessionId: string, text: string): void {
    this.enqueue(sessionId, `${LAUNCH_NOTICE}${randomUUID()}`, text, false, false);
  }

  private launchNoticeSent(sessionId: string, messageId: number, text: string): void {
    const notice = { id: messageId, text };
    this.launchNotices.set(sessionId, [...(this.launchNotices.get(sessionId) ?? []), notice]);
    const end = this.launchEnds.get(sessionId);
    if (this.connOf(sessionId)?.data.busy || end === "failed") this.dropLaunchNotices(sessionId);
    else if (end === "started") this.editLaunchNotice(notice);
  }

  // The start notice is one message: a queued one changes in place, one in
  // the topic is edited, and a failed start takes it away.
  private launchEnded(sessionId: string, end: "started" | "failed"): void {
    this.launchEnds.set(sessionId, end);
    for (const item of this.outbox.items().filter(i => i.sessionId === sessionId && i.id.startsWith(LAUNCH_NOTICE))) {
      if (end === "started") this.outbox.setText(item.id, LAUNCHED_TEXT);
      else this.outbox.remove(item.id);
    }
    if (end === "failed") return this.dropLaunchNotices(sessionId);
    for (const notice of this.launchNotices.get(sessionId) ?? []) this.editLaunchNotice(notice);
  }

  private editLaunchNotice(notice: { id: number; text: string }): void {
    const api = this.opts.api;
    const groupId = this.opts.config().groupId;
    if (notice.text === LAUNCHED_TEXT || !api || !groupId) return;
    notice.text = LAUNCHED_TEXT;
    api.editMessageText(groupId, notice.id, LAUNCHED_TEXT).catch(e => this.log.warn(`editing start notice ${notice.id} failed: ${e}`));
  }

  private dropLaunchNotices(sessionId: string): void {
    const notices = this.launchNotices.get(sessionId);
    const api = this.opts.api;
    const groupId = this.opts.config().groupId;
    if (!notices || !api || !groupId) return;
    this.launchNotices.delete(sessionId);
    for (const { id } of notices) api.deleteMessage(groupId, id).catch(e => this.log.warn(`deleting start notice ${id} failed: ${e}`));
  }

  // Photos inside are downloaded like a photo message; a photo that fails keeps
  // its file_id in the text, as other files do.
  private async richContent(api: TelegramApi, rich: RichMessage): Promise<string> {
    const paths = new Map<string, string>();
    for (const id of richPhotos(rich)) {
      try {
        paths.set(id, await api.downloadFile(id, this.opts.inboxDir));
      } catch (e) {
        this.log.warn(`photo download failed: ${e}`);
      }
    }
    return richToMarkdown(rich, paths);
  }

  // Same meta shape as the official telegram plugin.
  private async inboundOf(api: TelegramApi, m: Message): Promise<{ content: string; meta: ChannelMeta }> {
    const meta: ChannelMeta = {
      chat_id: String(m.chat.id),
      message_id: String(m.message_id),
      user: m.from?.username ?? String(m.from?.id),
      user_id: String(m.from?.id),
      ts: new Date(m.date * MS_PER_SECOND).toISOString(),
    };
    const attach = (kind: string, f: { file_id: string; file_size?: number; mime_type?: string }, name?: string) => {
      meta.attachment_kind = kind;
      meta.attachment_file_id = f.file_id;
      if (f.file_size != null) meta.attachment_size = String(f.file_size);
      if (f.mime_type) meta.attachment_mime = f.mime_type;
      if (name) meta.attachment_name = name;
    };
    let content = m.text ?? m.caption ?? (m.rich_message ? await this.richContent(api, m.rich_message) : undefined);
    const best = m.photo?.at(-1);
    if (best) {
      content ??= "(photo)";
      try {
        meta.image_path = await api.downloadFile(best.file_id, this.opts.inboxDir);
      } catch (e) {
        this.log.warn(`photo download failed: ${e}`);
        attach("photo", best);
      }
    } else if (m.document) {
      const name = safeName(m.document.file_name);
      content ??= `(document: ${name ?? "file"})`;
      attach("document", m.document, name);
    } else if (m.voice) {
      content ??= "(voice message)";
      attach("voice", m.voice);
    } else if (m.audio) {
      const name = safeName(m.audio.file_name);
      content ??= `(audio: ${safeName(m.audio.title) ?? name ?? "audio"})`;
      attach("audio", m.audio, name);
    } else if (m.video) {
      content ??= "(video)";
      attach("video", m.video, safeName(m.video.file_name));
    } else if (m.video_note) {
      content ??= "(video note)";
      attach("video_note", m.video_note);
    } else if (m.sticker) {
      content ??= `(sticker${m.sticker.emoji ? ` ${m.sticker.emoji}` : ""})`;
      attach("sticker", m.sticker);
    }
    return { content: content ?? "", meta };
  }
}

function spawnDetached(command: string[]): void {
  const [exe, ...args] = command;
  if (!exe) throw new LaunchError("пустая команда запуска");
  const child = spawn(exe, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

// The /cleanup summary in the topic: the context before the compact, then
// what came of the skills.
export function cleanupSummary(before: number | undefined, r: CleanupResult): string {
  const was = before === undefined ? undefined : `Контекст был ${tokens(before)}`;
  if (r.kind === "format") {
    const version = r.version ? ` (Claude Code ${r.version})` : "";
    return `🧹 ${was ? `${was}. ` : ""}⚠️ Формат транскрипта изменился, скиллы не убраны${version}`;
  }
  if (r.kind === "nothing" || !r.skills.length) return was ? `🧹 ${was}, скиллов в контексте не было` : "🧹 Скиллов в контексте не было";
  const size = tokens(Math.round(r.skills.reduce((n, s) => n + s.chars, 0) / CHARS_PER_TOKEN));
  const list = `${r.skills.map(s => s.name).join(", ")} (~${size})`;
  return was ? `🧹 ${was}, убраны скиллы: ${list}` : `🧹 Убраны скиллы: ${list}`;
}

// Queue item ids are `<plugin message id>#<n>`, replacements add `.<m>`.
function messageOf(itemId: string): string {
  return itemId.slice(0, itemId.lastIndexOf("#"));
}

function names(files: OutFile[]): string {
  return files.map(f => f.name).join(", ");
}

// Text in pieces of at most one plain message, silent; markdown: formatted
// with entities.
function textPieces(text: string, markdown: boolean): Piece[] {
  return chunk(markdown ? toTelegram(text) : { text, entities: [] }).map(p => ({ text: p.text, silent: true, ...(p.entities.length ? { entities: p.entities } : {}) }));
}

// A card is one message: its first chunk, should it ever outgrow one.
function cardFormat(md: string): Formatted {
  return chunk(toTelegram(md))[0] ?? { text: md, entities: [] };
}

function markdownPieces(md: string): Piece[] {
  if (messageKind(md) === "plain") return textPieces(md, true);
  return richPieces(md).flatMap(p => (p.blocks ? [{ text: p.text, silent: true, rich: p.blocks }] : textPieces(p.text, true)));
}

function filesPiece(files: OutFile[], caption: Formatted | undefined, loud: boolean): Piece {
  return {
    text: caption?.text ?? "",
    silent: !loud,
    files,
    ...(caption?.entities.length ? { entities: caption.entities } : {}),
  };
}

// What a delivered message was, for the log: its kind, length and formatting,
// never its text.
function shapeOf(m: Message, content: string): string {
  const kind = (["rich_message", "photo", "document", "voice", "audio", "video", "video_note", "sticker"] as const).find(k => m[k]) ?? "text";
  const types = [...new Set((m.entities ?? m.caption_entities ?? []).map(e => e.type))];
  return `${kind}, ${content.length} chars${types.length ? `, entities ${types.join(", ")}` : ""}`;
}

// Uploader-controlled names land inside the <channel> tag; strip delimiters.
function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;"]/g, "_");
}

export function projectName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
}
