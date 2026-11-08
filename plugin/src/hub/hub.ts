import type { Server, ServerWebSocket } from "bun";
import type { Config } from "../shared/config.ts";
import type { Logger } from "../shared/log.ts";
import type { Entity, Formatted } from "../shared/markdown.ts";
import type { OutFile } from "../shared/media.ts";
import type { Language, Messages } from "../shared/i18n/index.ts";
import type { AskQuestion, ChannelMeta, EnableResult, HookBody, HubToPlugin, LimitsReading, PermissionBehavior, PluginToHub, QuestionDecision, ResolutionKind, TopicCommand } from "../shared/protocol.ts";
import type { PermissionMode } from "./launch.ts";
import type { OutItem, Piece } from "./outbox.ts";
import type { Poll } from "./questions.ts";
import type { SessionRecord } from "./sessions.ts";
import type { Button, Message, TelegramApi, Update } from "./telegram.ts";
import type { RichMessage } from "./rich.ts";
import type { HubCommand } from "./router.ts";
import type { VideoTools } from "./video.ts";
import type { ExecShell } from "./exec-shell.ts";
import type { CleanupResult } from "./skill-cleanup.ts";
import type { MessageKind } from "../shared/notification.ts";
import type { ExitGate } from "./exit-gate.ts";
import type { Platform } from "../shared/platform.ts";
import type { MachineCommand, RigInvocation, RigOutput } from "./rig.ts";
import type { MachineDestination, RigConfirmation } from "./machine-outbox.ts";

import { randomUUID } from "crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync } from "fs";
import { basename, dirname, join } from "path";
import { z } from "zod";
import { chunk, hasVisibleText } from "../shared/chunk.ts";
import { notifies } from "../shared/notification.ts";
import { isInside } from "../shared/config.ts";
import { field } from "../shared/guards.ts";
import { catalogOf, DEFAULT_LANGUAGE } from "../shared/i18n/index.ts";
import { toTelegram } from "../shared/markdown.ts";
import { albums, kindOf } from "../shared/media.ts";
import { PROTOCOL_VERSION } from "../shared/protocol.ts";
import { cleanupReport, commandReply, hookBody, limitsPost, pluginToHub, questionBody, sendFilesMessage, sendMessage, terminateRequest, turnEndBody } from "../shared/protocol-schema.ts";
import { loadCards, saveCards } from "./cards.ts";
import { loadPollOffset, savePollOffset } from "./poll-offset.ts";
import { CodexLimits } from "./codex-limits.ts";
import { VolunteerLimits } from "./volunteer-limits.ts";
import { DEFAULT_CONFIG_DIR, defaultLoginAccount, isDefaultConfigDir } from "./default-account.ts";
import { messageKind } from "./message-kind.ts";
import { Outbox } from "./outbox.ts";
import { hasModePlaceholder, isTmuxCommand, LAUNCH_EXIT_GRACE_MS, launchCommand, LaunchError, LaunchExitError, PERMISSION_MODES, sessionCwd, sessionTranscript, spawnDetached, tmuxAttachHint, transcriptMode } from "./launch.ts";
import { commandOf, hubCommandOf, machineCommandOf, routeCallback, routeUpdate } from "./router.ts";
import { accountOf, SessionStore, topicName } from "./sessions.ts";
import { isThreadNotFound, TelegramError } from "./telegram.ts";
import { media, richPhotos, richToMarkdown } from "./rich.ts";
import { withContext } from "./reply-context.ts";
import { answerLine, CANCEL_REASON, checkedLabels, parsePollPress, POLL_PREFIX, questionButtons, questionText, withOutcome } from "./questions.ts";
import { richPieces } from "./rich-out.ts";
import { DEFAULT_VIDEO_TOOLS, probeVideo, thumbPath } from "./video.ts";
import { EXEC_CARD_MS, EXEC_CHECK_MS, EXEC_MAX_AGE_MS, Execs } from "./exec.ts";
import { freshEnv } from "./exec-env.ts";
import { isAlive, killTree, spawnRunner } from "./exec-runner.ts";
import { findPowershell } from "./exec-shell.ts";
import { cleanTranscript, CleanupError } from "./skill-cleanup.ts";
import { formatPermission } from "./format-permission.ts";
import { exitGate } from "./exit-gate.ts";
import { MAX_RECONNECT_PAUSE_MS } from "../shared/reconnect.ts";
import { PLATFORM } from "../shared/platform.ts";
import { featureText, findRig, Rig, rigAction, rigErrorText, runRig, statusText } from "./rig.ts";
import { confirmationPromptId, MachineOutbox } from "./machine-outbox.ts";
import { RigEvents, RIG_POLL_MS } from "./rig-events.ts";
import { hubCommit, RigLifecycle, startedCommit } from "./rig-lifecycle.ts";

// The queue id prefix of the start notice, "starting the session".
const LAUNCH_NOTICE = "launch-";
// CLAUDE_CODE_ENTRYPOINT of a window started in the terminal; such a window is on by default.
const CLI_ENTRYPOINT = "cli";
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
// Leave one polling interval beyond the plugin's longest reconnect pause.
export const CLEANUP_SETTLE_MS = MAX_RECONNECT_PAUSE_MS + EXIT_POLL_MS;
// How long /cleanup waits for the module to report its compact.
const CLEANUP_COMPACT_MS = 600_000;
// A topic message starting with it interrupts a working agent; it reaches a
// compacting window at once. The hub strips it and tells the window by a flag.
const INTERRUPT_PREFIX = "!";
// The prefix with the whitespace around it, as stripped from the text.
const INTERRUPT_MARK = /^\s*!\s*/;
// The outbox id of a poll's question: poll:<key>:<index>#<piece>.
const POLL_ITEM = /^poll:([0-9a-f]+):(\d+)#/;
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
// Topic messages that come together (an album, forwards, a text after them)
// reach the agent as one: the batch goes once no message came for the quiet
// window, or this long after its first message at the latest.
const BATCH_QUIET_MS = 1000;
const BATCH_MAX_MS = 10_000;
// How long a question waits for its window to relay the text written
// before the call; a window too old to answer costs this much.
const CATCH_UP_MS = 1000;
// Sent batches whose ✍ is cleared with their first message; the oldest are
// forgotten past this.
const MAX_BATCH_IDS = 200;
// Telegram shows "typing…" for up to 5 s; it is renewed this often while the
// agent works.
const TYPING_EVERY_MS = 4000;

// The bot's command menu in the hub's language; bashName is the platform's name for the bash shell.
function botCommands(m: Messages, bashName: string): { command: string; description: string }[] {
  return [
    { command: "info", description: m.commandInfo },
    { command: "compact", description: m.commandCompact },
    { command: "rename", description: m.commandRename },
    { command: "run", description: m.commandRun },
    { command: "stop", description: m.commandStop },
    { command: "cleanup", description: m.commandCleanup },
    { command: "mode", description: m.commandMode },
    { command: "pwsh", description: m.commandPwsh },
    { command: "cmd", description: m.commandCmd },
    { command: "bash", description: m.commandBash({ shell: bashName }) },
    { command: "feature", description: m.commandFeature },
    { command: "rig", description: m.commandRig },
  ];
}

// exitingPid: the Claude Code process the plugin said it is ending.
type Conn = { windowKey?: string; sessionId?: string; cwd?: string; account?: string; entrypoint?: string; busy?: boolean; reportsSeen?: boolean; exitingPid?: number; attachedOffset?: number; launchedMode?: PermissionMode };
type WS = ServerWebSocket<Conn>;
// cancelled: /stop won; held items still wait for the ending process.
type ModeRestart = { mode: PermissionMode; held: Held[]; cancelled?: boolean };
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
type GatedLaunch = { account: string | undefined; held: Held[]; announce: boolean; mode?: PermissionMode };
type QueuedBatch = { messages: Message[]; captured: boolean };
type Replay = { held: Held[]; inFlight: Held[]; after: (() => void)[] };
// Topic messages of a session waiting to go to its window together.
type AnswerGroup = { api: TelegramApi; poll: Poll; index: number; messages: Message[]; parts: string[]; timer: ReturnType<typeof setTimeout> };
type Batch = { api: TelegramApi; messages: Message[]; quietTimer: ReturnType<typeof setTimeout>; maxTimer: ReturnType<typeof setTimeout> };
// A /cleanup under way: the id of its command and whether the window is
// compacting or exiting. held: topic messages for the session from the start
// of the compact on, the window still open or not.
// compactTimer: gives up on a compact the module never reports.
type Cleanup = {
  id: string;
  phase: "compacting" | "exiting";
  held: Held[];
  compactTimer?: ReturnType<typeof setTimeout>;
  ended?: boolean;
};

// The queue item of a /cleanup's first module reply, the "will compact" one:
// reply 0 to the command, its first piece.
const cleanupStartKey = (c: Cleanup) => `cmd-${c.id}.0#0`;

export type HubOptions = {
  codexSessionsDir?: string;
  // Path to the volunteer-models.py script; defaults to ~/.claude/tools/volunteer-models.py.
  // The command to run it; defaults to ["python", "-I"].
  // Timeout for the script; defaults to 5000 ms.
  volunteerLimitsScript?: string;
  volunteerLimitsCommand?: string[];
  volunteerLimitsTimeoutMs?: number;
  port: number;
  sessionsFile: string;
  outboxFile: string;
  // Where subagent cards are kept across restarts; in memory only without it.
  cardsFile?: string;
  // Where the Telegram update offset is kept across restarts; in memory only without it.
  pollOffsetFile?: string;
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
  batchQuietMs?: number;
  batchMaxMs?: number;
  // How long a question waits for its window to catch up.
  catchUpMs?: number;
  // Where Claude Code keeps transcripts, to find the cwd of a session the hub
  // has not recorded one for.
  projectsDir?: string;
  // Runs a launch command; by default a detached process.
  spawn?(command: string[]): void | Promise<void>;
  setTimer?(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer?(timer: ReturnType<typeof setTimeout>): void;
  readyDelayMs?: number;
  stopTimeoutMs?: number;
  // /cleanup: how long it waits for the compact, for Claude Code to exit,
  // and with the process unknown; how it tells the process is still there,
  // and what empties the skills in the transcript.
  cleanupCompactMs?: number;
  cleanupExitMs?: number;
  cleanupSettleMs?: number;
  exitPollMs?: number;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  isAlive?(pid: number): boolean;
  cleanTranscript?: typeof cleanTranscript;
  // A window in this config dir runs on the default login, whose account is
  // asked of defaultAccount (cswap by default).
  defaultConfigDir?: string;
  defaultAccount?(): Promise<string | undefined>;
  platform?: Platform;
  accountsAvailable?(): boolean;
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
  execEnv?(): Record<string, string>;
  log: Logger;
  rigDir?: string;
  repository?: string;
  findRig?(): string | undefined;
  runRig?(invocation: RigInvocation, signal?: AbortSignal): Promise<RigOutput>;
  hubCommit?(): string | undefined;
  onExit(code?: number): void;
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
  private deliveryOrders = new WeakMap<object, number>();
  private nextDeliveryOrder = 0;
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
  private codexLimits: CodexLimits;
  private volunteerLimits: VolunteerLimits;
  private botUsername: string | undefined;
  private botId: number | undefined;
  // The language of every text sent to Telegram: rig holds it, the hub reads it at start and when rig says it changed.
  private lang: Language = DEFAULT_LANGUAGE;
  private languageReads = 0;
  private languageApplied = 0;
  private registeredCommands: string | undefined;
  private registeringCommands: Promise<void> | undefined;
  // Permission prompts sent to topics, by the key in their buttons' data.
  private permissions = new Map<string, { sessionId: string; requestId: string; settled?: boolean } & Formatted>();
  // Open AskUserQuestion polls, by the key in their buttons' data; one per session.
  private polls = new Map<string, Poll>();
  // Questions waiting for their window to catch up, by poll key.
  private catchUps = new Map<string, () => void>();
  // Messages that answer a poll's question, by poll key: those sent together
  // (an album, a few lines) wait out a quiet window and answer once.
  private answerGroups = new Map<string, AnswerGroup>();
  // Subagent cards by `${sessionId}:${cardId}`: text is the latest Markdown
  // version, shown what the message holds now (undefined until it is sent).
  private cards = new Map<string, Card>();
  // The earliest time the next card edit may go, hub-wide.
  private nextCardEdit = 0;
  private pumping = new Set<string>();
  // Question sends in flight: a poll that ends meanwhile gets its outcome edit
  // only once the send returns the message id, so stop() waits for them.
  private questionSends = new Set<Promise<void>>();
  // The latest reaction change of a topic message, by message id.
  private reactions = new Map<number, Promise<void>>();
  // Topic messages handed to a session whose ✍ is not on yet, by message id.
  private reactionTimers = new Map<number, ReturnType<typeof setTimeout>>();
  // The batch waiting for each session, the other message ids of a sent
  // batch by its first one, and the latest batch send of each session: one
  // goes after another, as photos are downloaded on the way.
  private batches = new Map<string, Batch>();
  private batchIds = new Map<number, number[]>();
  private batchSends = new Map<string, Promise<void>>();
  private batchItems = new Map<string, Set<QueuedBatch>>();
  private deliveredItems = new WeakSet<object>();
  // Sessions being started from the topic, with the messages they will get.
  private launches = new Map<string, { account: string; held: Held[]; timer: ReturnType<typeof setTimeout>; mode?: PermissionMode; cancelled?: boolean }>();
  private exitGates = new Map<string, ExitGate>();
  private gatedLaunches = new Map<string, GatedLaunch>();
  private retained = new Map<string, Held[]>();
  private execs: Execs | undefined;
  // Sessions told to end, until their window goes.
  private stops = new Map<string, ReturnType<typeof setTimeout>>();
  // Sessions whose /stop waits for the module's terminate request: the id of
  // the stop command.
  private stopping = new Map<string, string>();
  // The /stop command that ended a session, until its window is gone: that
  // command's "after the compact" notice turns into the ended notice.
  private stopIds = new Map<string, string>();
  private cleanups = new Map<string, Cleanup>();
  // Held messages being handed to a window; later topic messages join them.
  private replays = new Map<string, Replay>();
  // Messages kept for a stopped window, including a cancelled launch or cleanup.
  private dyingHeld = new Map<string, Held[]>();
  // A mode restart keeps inbound traffic until the replacement window connects.
  private modeRestarts = new Map<string, ModeRestart>();
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
  private rig: Rig;
  private machineOutbox: MachineOutbox;
  private rigEvents: RigEvents | undefined;
  private rigLifecycle: RigLifecycle | undefined;
  private rigTimer: ReturnType<typeof setTimeout> | undefined;
  private rigTickRunning = false;
  private botReady = false;
  private machineQueries = 0;
  // Machine commands run beside the poll loop, so a slow rig cannot delay the intake of other updates.
  private machineTasks = new Set<Promise<void>>();
  private featureRefresh: Promise<void> | undefined;
  private featureRefreshAgain = false;
  private updatesInFlight = 0;
  private disableConfirmations = new Map<string, RigConfirmation>();

  constructor(private opts: HubOptions) {
    this.codexLimits = new CodexLimits(opts.codexSessionsDir);
    this.volunteerLimits = new VolunteerLimits(
      opts.volunteerLimitsScript,
      opts.volunteerLimitsCommand,
      opts.volunteerLimitsTimeoutMs
    );
    this.store = new SessionStore(opts.sessionsFile);
    this.log = opts.log;
    this.outbox = new Outbox(opts.outboxFile, opts.log);
    this.rig = new Rig({ find: opts.findRig ?? (() => opts.rigDir ? findRig(opts.platform ?? PLATFORM) : undefined), platform: opts.platform ?? PLATFORM,
      run: opts.runRig ?? runRig, warn: text => this.log.warn(text),
      setTimer: (fn, ms) => this.setTimer(fn, ms), clearTimer: timer => this.clearTimer(timer), messages: () => this.m() });
    this.machineOutbox = new MachineOutbox(join(dirname(opts.outboxFile), "machine-outbox.json"), text => this.log.warn(text));
    this.disableConfirmations = new Map(this.machineOutbox.confirmations());
    if (opts.rigDir) {
      const head = opts.hubCommit ?? (() => hubCommit(opts.repository ?? join(import.meta.dir, "..", "..", "..")));
      // The commit of the code that was loaded: the service script fixes it before `bun` starts; without it HEAD at start is the best guess.
      const started = startedCommit(process.env) ?? head();
      this.rigLifecycle = new RigLifecycle({ dir: opts.rigDir, head, started: () => started,
        now: opts.now ?? Date.now, idle: () => this.rigIdle(),
        notice: (id, text) => { const group = opts.config().groupId; if (group) this.machineOutbox.post(id, { chatId: group }, text); },
        // Stopping first hands waiting answers and open polls back and flushes batches; the exit happens even if that fails.
        exit: code => { void this.stop().catch(error => this.log.warn(`stop before restart: ${String(error)}`)).then(() => opts.onExit(code)); },
        warn: text => this.log.warn(text), messages: () => this.m() });
      this.rigEvents = new RigEvents({ dir: opts.rigDir, stateDir: dirname(opts.outboxFile), running: () => this.running,
        available: () => this.running && this.botReady && Boolean(opts.config().groupId),
        send: async (event, sent, accepted) => {
          const group = opts.config().groupId;
          if (!group || !opts.api) return false;
          const pieces = chunk(toTelegram(event.text));
          for (const [index, piece] of pieces.entries()) {
            if (index < sent) continue;
            await opts.api.sendMessage(group, undefined, piece.text, event.level === "info", piece.entities);
            accepted(index + 1);
          }
          return true;
        }, features: () => this.refreshFeatures(), language: () => this.onLanguageChanged(), restart: () => this.rigLifecycle?.request(), warn: text => this.log.warn(text) });
    }
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
        shellNames: (opts.platform ?? PLATFORM).shellNames,
        env: opts.execEnv ?? (() => freshEnv(this.log)),
        spawnRunner: opts.spawnRunner ?? spawnRunner,
        alive: opts.isAlive ?? isAlive,
        kill: killTree,
        card: (sid, cardId, markdown, final, kind, buttons) => this.upsertCard(sid, cardId, markdown, final, buttons, false, undefined, kind),
        notice: (sid, text, kind) => this.notice(sid, text, kind),
        sendFile: (sid, path, name, kind) => this.sendExecFile(sid, path, name, kind),
        report: (sid, content, meta, onSent) => this.reportExec(sid, { content, meta, onSent }),
        now: opts.now ?? Date.now,
        checkMs: opts.execCheckMs ?? EXEC_CHECK_MS,
        cardMs: opts.execCardMs ?? EXEC_CARD_MS,
        maxAgeMs: opts.execMaxAgeMs ?? EXEC_MAX_AGE_MS,
        ...(opts.execFileLimit ? { fileLimit: opts.execFileLimit } : {}),
        hasWindow: sid => this.connOf(sid) !== undefined,
        graceMs: opts.execGraceMs ?? EXEC_GRACE_MS,
        log: opts.log,
        messages: () => this.m(),
        unavailable: shell => shell === "powershell" ? this.rig.unavailable("pwsh") : shell === "cmd" ? this.rig.unavailable("cmd") : undefined,
        machineCard: (record, text, final, kind, buttons) => {
          if (record.destination) this.machineOutbox.post(`rig-${record.id}`, record.destination, text, !notifies(kind), buttons, true);
          if (record.destination && final && kind !== "info") this.machineOutbox.post(`rig-failed-${record.id}`, record.destination, text.split("\n").slice(0, 2).join("\n"), false);
          if (this.botReady && opts.api) void this.machineOutbox.flush(opts.api);
        },
        machineFile: (record, path, kind) => {
          const id = `rig-log-${record.id}`;
          // A restore offers the log again: a copy for a log already queued or sent would stay on disk.
          if (record.destination && !this.machineOutbox.known(id)) {
            const copy = join(opts.filesDir, "rig", `${record.id}.log`);
            mkdirSync(dirname(copy), { recursive: true });
            copyFileSync(path, copy);
            this.machineOutbox.post(id, record.destination, "", !notifies(kind), undefined, false, copy);
          }
        },
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
    // The language first: the features and the menu are registered in it.
    this.machineQueries++;
    void this.readLanguage().then(() => this.refreshFeatures()).finally(() => this.endMachineQuery());
    void this.rigTick();
    this.armIdle();
    if (this.opts.api) void this.pollLoop(this.opts.api);
    else this.log.error("no TELEGRAM_BOT_TOKEN — not polling Telegram");
    return true;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.clearTimer(this.rigTimer);
    for (const gate of this.exitGates.values()) gate.cancel();
    // Polling stops first, so no batch starts after the flush.
    this.abort.abort();
    // Waiting answers answer at once, before the polls go to the terminal.
    await Promise.all([...this.answerGroups.keys()].map(key => this.takeAnswer(key)));
    // Waiting batches go at once, while the windows are still connected; an
    // update handled meanwhile may start one more.
    while (this.batches.size || this.batchSends.size) {
      await Promise.all([...this.batches.keys(), ...this.batchSends.keys()].map(sid => this.flushBatch(sid)));
    }
    this.batchIds.clear();
    // Open polls go back to the terminal, which the next hub cannot answer.
    await Promise.allSettled([...this.polls.values()].map(p => this.finishPoll(p, { decision: "none" }, this.m().pollMovedToTerminal)));
    // A question still being sent shows the outcome right after its send.
    await Promise.allSettled([...this.questionSends]);
    if (this.idleTimer) this.clearTimer(this.idleTimer);
    if (this.spoolTimer) clearInterval(this.spoolTimer);
    if (this.typingTimer) clearInterval(this.typingTimer);
    for (const queued of this.commands.values()) for (const e of queued) this.clearTimer(e.timer);
    for (const card of this.cards.values()) this.clearTimer(card.timer);
    for (const l of this.launches.values()) this.clearTimer(l.timer);
    for (const t of this.stops.values()) this.clearTimer(t);
    for (const c of this.cleanups.values()) this.clearTimer(c.compactTimer);
    for (const t of this.readyTimers) this.clearTimer(t);
    for (const t of this.reactionTimers.values()) this.clearTimer(t);
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
    if (url.pathname === "/turn-end" && req.method === "POST") {
      const body = turnEndBody.safeParse(await req.json().catch(() => undefined));
      if (!body.success) return new Response("bad turn-end body", { status: 400 });
      const { messagingSocket, session_id: sessionId, final, kind } = body.data;
      let target: WS | undefined;
      for (const ws of this.conns) if (ws.data.windowKey === messagingSocket) target = ws;
      if (!target) return new Response("no window", { status: 404 });
      this.log.info(`turn end of ${sessionId}: ${final ? `final ${kind ?? "done"}` : "intermediate"}`);
      this.send(target, { type: "turnEnd", final, ...(kind ? { kind } : {}) });
      return new Response("ok");
    }
    if (url.pathname === "/commands" && req.method === "GET") {
      const session = url.searchParams.get("session") ?? "";
      return Response.json(this.takeCommands(session, url.searchParams.get("stop") === "1", url.searchParams.get("cleanup") === "1"));
    }
    if (url.pathname === "/terminate" && req.method === "POST") {
      const r = terminateRequest.safeParse(await req.json().catch(() => undefined));
      if (!r.success) return new Response("bad terminate request", { status: 400 });
      if (this.stopping.get(r.data.sessionId) === r.data.id) this.terminate(r.data.sessionId, r.data.id);
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
    if (url.pathname === "/language" && req.method === "GET") return Response.json({ language: this.lang });
    if (url.pathname === "/limits" && req.method === "GET") return Response.json(this.freshestLimits(url.searchParams.get("session") ?? "") ?? null);
    if (url.pathname === "/codex-limits" && req.method === "GET") return Response.json(await this.codexLimits.read() ?? null);
    if (url.pathname === "/volunteer-limits" && req.method === "GET") return Response.json(await this.volunteerLimits.read());
    if (url.pathname === "/reply" && req.method === "POST") {
      const r = commandReply.safeParse(await req.json().catch(() => undefined));
      if (!r.success) return new Response("bad reply", { status: 400 });
      this.enqueue(r.data.sessionId, `cmd-${r.data.id}`, r.data.text, r.data.notify, true, r.data.replaces, r.data.awaitsResult);
      return new Response("ok");
    }
    if (url.pathname === "/question" && req.method === "POST") {
      const r = questionBody.safeParse(await req.json().catch(() => undefined));
      if (!r.success) return new Response("bad question body", { status: 400 });
      const { messagingSocket, session_id: hookSession, tool_input } = r.data;
      // The window's current session may differ from the hook's after a
      // session switch; the window knows the one with the topic.
      let target: WS | undefined;
      for (const ws of this.conns) if (messagingSocket !== undefined && ws.data.windowKey === messagingSocket) target = ws;
      const sessionId = (target ?? this.connOf(hookSession))?.data.sessionId ?? hookSession;
      if (!this.store.get(sessionId)?.enabled) return Response.json({ decision: "none" });
      // The answer may take hours; the hook's own timeout bounds the wait.
      server.timeout(req, 0);
      return Response.json(await this.askQuestion(sessionId, tool_input.questions, req.signal));
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
    const timer = this.setTimer(() => {
      this.commands.set(sessionId, (this.commands.get(sessionId) ?? []).filter(e => e.cmd !== cmd));
      this.log.warn(`/${cmd.name} for session ${sessionId} was not taken in ${ms} ms`);
      if (cmd.name === "stop") {
        if (this.stopping.get(sessionId) === cmd.id) this.terminate(sessionId);
        return;
      }
      if (cmd.name === "cleanup" && this.cleanups.get(sessionId)?.id === cmd.id) this.dropCleanup(sessionId);
      this.enqueue(sessionId, `cmd-${cmd.id}-lost`, this.m().commandLost({ name: cmd.name, seconds: ms / MS_PER_SECOND }), notifies("error"), false);
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
    for (const e of taken) this.clearTimer(e.timer);
    return taken.map(e => ({ ...e.cmd, language: this.lang }));
  }

  private m(): Messages {
    return catalogOf(this.lang);
  }

  // Reads rig's language (English when rig cannot say) and sends a change to every window.
  // Reads can overlap (the start read and an event read); an answer older than one already applied is dropped.
  private async readLanguage(): Promise<void> {
    const ticket = ++this.languageReads;
    const language = await this.rig.language();
    if (!this.running || ticket < this.languageApplied) return;
    this.languageApplied = ticket;
    if (language === this.lang) return;
    this.lang = language;
    for (const ws of this.conns) this.send(ws, { type: "language", language });
  }

  // `language-changed` from rig: the language, then the features (their descriptions are in it), then the menu.
  private async onLanguageChanged(): Promise<void> {
    await this.readLanguage();
    await this.refreshFeatures();
  }

  private wantedCommands(): { commands: { command: string; description: string }[]; signature: string } {
    const platform = this.opts.platform ?? PLATFORM;
    const commands = botCommands(this.m(), platform.bashName).filter(c => c.command !== "pwsh" && c.command !== "cmd" || !this.rig.unavailable(c.command));
    return { commands, signature: JSON.stringify(commands) };
  }

  // A registration in flight keeps going until the menu matches what is wanted at that moment, so a language
  // change during it is not left to a later tick.
  private registerCommands(api: TelegramApi): Promise<void> {
    if (this.registeringCommands) return this.registeringCommands;
    if (this.wantedCommands().signature === this.registeredCommands) return Promise.resolve();
    this.registeringCommands = (async () => {
      try {
        for (let wanted = this.wantedCommands(); wanted.signature !== this.registeredCommands; wanted = this.wantedCommands()) {
          await api.setMyCommands(wanted.commands, this.abort.signal);
          this.registeredCommands = wanted.signature;
        }
      } catch (error) {
        if (this.running) this.log.warn(`registering bot commands failed: ${String(error)}`);
      } finally {
        this.registeringCommands = undefined;
      }
    })();
    return this.registeringCommands;
  }

  private onOpen(ws: WS): void {
    this.conns.add(ws);
    if (this.idleTimer) this.clearTimer(this.idleTimer);
    this.idleTimer = undefined;
    this.idleExpired = false;
  }

  private onClose(ws: WS): void {
    this.conns.delete(ws);
    const sid = ws.data.sessionId;
    if (!this.running) return;
    if (sid) this.log.info(`window for session ${sid} disconnected`);
    if (sid && !this.connOf(sid)) {
      if (ws.data.exitingPid !== undefined || this.stops.has(sid) || this.modeRestarts.has(sid) || this.dyingHeld.has(sid)) this.gateExit(sid, ws.data.exitingPid);
      this.stopping.delete(sid);
      // Without its window the session cannot take an answer any more.
      for (const p of this.polls.values()) if (p.sessionId === sid) void this.finishPoll(p, { decision: "none" }, this.m().pollMovedToTerminal);
    }
    const cleanup = sid ? this.cleanups.get(sid) : undefined;
    if (sid && cleanup && !this.connOf(sid)) {
      if (cleanup.phase === "exiting") {
        // The cleanup's summary tells the topic instead of "session ended".
        const t = this.stops.get(sid);
        if (t) this.clearTimer(t);
        this.stops.delete(sid);
        void this.finishCleanup(sid, cleanup, ws.data.exitingPid);
      } else {
        this.log.info(`window for session ${sid} closed while compacting for /cleanup; /cleanup dropped`);
        this.cleanupOutcome(sid, cleanup, this.m().cleanupWindowClosed, "warning", "warning");
        this.dropCleanup(sid);
      }
    }
    const stop = sid ? this.stops.get(sid) : undefined;
    if (sid && stop && !this.connOf(sid)) {
      this.clearTimer(stop);
      this.stops.delete(sid);
      const stopId = this.stopIds.get(sid);
      this.stopIds.delete(sid);
      if (!this.modeRestarts.has(sid) || this.modeRestarts.get(sid)?.cancelled) {
        if (stopId) this.enqueue(sid, `hub-${randomUUID()}`, this.m().sessionEnded, notifies("info"), false, { id: `${stopId}.0`, kind: "success" });
        else this.notice(sid, this.m().sessionEnded, "info");
      }
    }
    const restart = sid && !this.connOf(sid) ? this.modeRestarts.get(sid) : undefined;
    if (sid && restart) {
      this.modeRestarts.delete(sid);
      if (restart.cancelled) this.releaseHeld(sid, restart.held);
      else this.launch(sid, ws.data.account, restart.held, true, restart.mode);
    }
    const dying = sid && !this.connOf(sid) ? this.dyingHeld.get(sid) : undefined;
    if (sid && dying) {
      this.dyingHeld.delete(sid);
      this.log.info(`window for session ${sid} ended: ${dying.length} held message(s) go the way of new topic messages`);
      this.releaseHeld(sid, dying);
    }
    this.armIdle();
  }

  // With idleMs 0, or a launch command to start sessions from the topic, the
  // hub stays up with no window at all; and while a topic command runs, so
  // its result reaches the topic.
  private alwaysOn(): boolean {
    return this.opts.idleMs <= 0 || this.opts.config().launch !== undefined || (this.execs?.running() ?? 0) > 0 || this.machineQueries > 0 || this.rigLifecycle?.waiting === true;
  }

  private armIdle(): void {
    if (this.conns.size > 0 || !this.running || this.alwaysOn()) return;
    if (this.idleTimer) this.clearTimer(this.idleTimer);
    this.idleTimer = this.setTimer(() => {
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
    if (!this.idleExpired || !this.running || this.conns.size > 0 || this.deliverable() > 0 || this.machineOutbox.size > 0 || this.machineOutbox.busy || this.alwaysOn()) return;
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
        ws.data = { ...ws.data, windowKey: msg.windowKey, busy: msg.busy, reportsSeen: msg.reportsSeen };
        // First, so nothing the window renders afterwards is in the wrong language.
        this.send(ws, { type: "language", language: this.lang });
        this.attachSession(ws, msg);
        this.log.info(`window ${msg.windowKey} connected, session ${msg.sessionId}, entrypoint ${msg.entrypoint ?? "not given"}, account ${ws.data.account ?? "not named"}`);
        this.askDefaultAccount(ws, msg.configDir);
        this.giveHeldResults(ws, msg.sessionId);
        const pending = this.pendingHooks.get(msg.windowKey);
        this.pendingHooks.delete(msg.windowKey);
        if (pending && Date.now() - pending.at < HOOK_TTL_MS) this.forwardHook(ws, pending.body);
        this.launched(ws, msg.sessionId);
        if (msg.busy) this.showTyping(ws);
        return;
      }
      case "session": {
        this.attachSession(ws, msg);
        this.log.info(`window ${ws.data.windowKey} switched to session ${msg.sessionId}`);
        this.launched(ws, msg.sessionId);
        return;
      }
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
      case "card":
        this.onCard(msg);
        return;
      case "seen":
        for (const id of msg.messageIds) this.seen(id);
        return;
      // Shown at once, then renewed by the typing timer.
      case "busy":
        ws.data.busy = msg.busy;
        if (!msg.busy) {
          // Completed turns may have had their permission answered in the terminal.
          // Keep the cached card for existing button behavior, but it no longer blocks an update.
          if (sid && ![...this.conns].some(connection => connection.data.sessionId === sid && connection.data.busy)) {
            for (const permission of this.permissions.values()) if (permission.sessionId === sid) permission.settled = true;
          }
          return;
        }
        this.showTyping(ws);
        if (sid) this.dropLaunchNotices(sid);
        return;
      case "exiting":
        this.log.info(`session ${sid}: the plugin ends Claude Code ${msg.pid}`);
        ws.data.exitingPid = msg.pid;
        return;
      case "caughtUp":
        this.catchUps.get(msg.id)?.();
        return;
    }
  }

  // "typing…" in the topic of a busy window's session while the mode is on.
  private showTyping(ws: WS): void {
    const sid = ws.data.sessionId;
    const rec = sid ? this.store.get(sid) : undefined;
    const topicId = rec?.topicId;
    const api = this.opts.api;
    const groupId = this.opts.config().groupId;
    // A session with no topic yet has nothing to show typing in.
    if (!sid || !rec?.enabled || topicId === undefined || !api || !groupId || this.typingQueued.has(sid)) return;
    this.typingQueued.add(sid);
    this.typingQueue = this.typingQueue.then(() => {
      this.typingQueued.delete(sid);
      return api.sendTyping(groupId, topicId).then(
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
      else if (msg.op === "disable") result = this.setEnabled(sid, false, true);
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
    if (!this.opts.api) throw new SetupError("TELEGRAM_BOT_TOKEN is not set — put it into .env in the telegram-hub state dir and restart the hub");
    return this.opts.api;
  }

  private requireGroup(): string {
    const groupId = this.opts.config().groupId;
    if (!groupId) {
      throw new SetupError('groupId is not configured — set "groupId" in config.json in the telegram-hub state dir; hub.log lists the ids of chats the bot receives messages from');
    }
    return groupId;
  }

  private async enable(sessionId: string, cwd: string, account: string | undefined, title: string): Promise<EnableResult> {
    const api = this.requireApi();
    const groupId = this.requireGroup();
    const existing = this.store.get(sessionId);
    if (existing) {
      if (title && existing.title !== title) await this.renameTopic(api, groupId, sessionId, existing, title);
      // A session that has no topic yet gets its topic now, not at its first message.
      const created = existing.topicId === undefined;
      if (created) await this.createTopic(api, groupId, sessionId);
      this.setEnabled(sessionId, true);
      return { topicTitle: topicName(existing.project, title || existing.title, this.m()), created };
    }
    const project = projectName(cwd);
    const topic = await api.createForumTopic(groupId, topicName(project, title, this.m()));
    this.store.set(sessionId, { topicId: topic.message_thread_id, title, project, enabled: true, ...(cwd ? { cwd } : {}), ...(account ? { account } : {}) });
    this.log.info(`created topic ${topic.message_thread_id} "${topic.name}" for session ${sessionId}`);
    this.pushState(sessionId);
    return { topicTitle: topicName(project, title, this.m()), created: true };
  }

  private async retitle(sessionId: string, title: string): Promise<void> {
    const rec = this.store.get(sessionId);
    if (!rec || !title || rec.title === title) return;
    // No topic yet: the title is only stored, and the topic is named with it when it is made.
    if (rec.topicId === undefined) {
      this.store.setTitle(sessionId, title);
      return;
    }
    if (!this.opts.api) return;
    const groupId = this.opts.config().groupId;
    if (!groupId) return;
    try {
      await this.renameTopic(this.opts.api, groupId, sessionId, rec, title);
    } catch (e) {
      this.log.warn(`renaming topic of ${sessionId} failed: ${e}`);
    }
  }

  private async renameTopic(api: TelegramApi, groupId: string, sessionId: string, rec: SessionRecord, title: string): Promise<void> {
    if (rec.topicId !== undefined) await api.editForumTopic(groupId, rec.topicId, topicName(rec.project, title, this.m()));
    this.store.setTitle(sessionId, title);
  }

  // Makes the topic of a session that has none, named with the stored title.
  private async createTopic(api: TelegramApi, groupId: string, sessionId: string): Promise<number> {
    const rec = this.store.get(sessionId);
    if (!rec) throw new Error(`session ${sessionId} is not known`);
    const topic = await api.createForumTopic(groupId, topicName(rec.project, rec.title, this.m()));
    this.store.setTopicId(sessionId, topic.message_thread_id);
    this.log.info(`created topic ${topic.message_thread_id} "${topic.name}" for session ${sessionId}`);
    return topic.message_thread_id;
  }

  // Every attachment applies the same window default to its session; topics remain lazy until the first text.
  private attachSession(ws: WS, msg: { sessionId: string; cwd: string; configDir?: string; entrypoint?: string; title?: string }): void {
    const account = accountOf(msg.configDir, this.opts.platform ?? PLATFORM) ?? ws.data.account;
    const entrypoint = msg.entrypoint ?? ws.data.entrypoint;
    const transcript = this.transcriptOf(msg.sessionId);
    const attachedOffset = transcript ? statSync(transcript).size : undefined;
    ws.data = { ...ws.data, sessionId: msg.sessionId, cwd: msg.cwd, account, entrypoint, attachedOffset, launchedMode: undefined };
    this.exitGates.get(msg.sessionId)?.reconnect();
    this.applyDefaultMode({ sessionId: msg.sessionId, cwd: msg.cwd, entrypoint, title: msg.title });
    this.store.setWhere(msg.sessionId, msg.cwd, account);
    const title = msg.title;
    if (title) void this.chain(msg.sessionId, () => this.retitle(msg.sessionId, title));
    this.pushState(msg.sessionId);
  }

  // A terminal window is on by default; a record the user turned off stays off.
  private applyDefaultMode(msg: { sessionId: string; cwd: string; entrypoint?: string; title?: string }): void {
    if (msg.entrypoint !== CLI_ENTRYPOINT) return;
    const rec = this.store.get(msg.sessionId);
    if (!rec) {
      this.store.set(msg.sessionId, { title: msg.title ?? "", project: projectName(msg.cwd), enabled: true });
      return;
    }
    if (!rec.enabled && !rec.disabledByUser) this.store.setEnabled(msg.sessionId, true);
  }

  // byUser: the user's own tg_disable, which keeps the mode off across window restarts.
  private setEnabled(sessionId: string, on: boolean, byUser = false): boolean {
    this.store.setEnabled(sessionId, on, byUser);
    this.pushState(sessionId);
    // With the mode off the user answers in the terminal, as on a timeout.
    if (!on) for (const p of this.polls.values()) if (p.sessionId === sessionId) void this.finishPoll(p, { decision: "none" }, this.m().pollMovedToTerminal);
    return on;
  }

  private pushState(sessionId: string): void {
    const ws = this.connOf(sessionId);
    if (!ws) return;
    const rec = this.store.get(sessionId);
    this.send(ws, { type: "state", enabled: rec?.enabled ?? false, ...(rec ? { topicTitle: topicName(rec.project, rec.title, this.m()) } : {}) });
  }

  // --- permissions ----------------------------------------------------------

  // A prompt with a request id gets buttons; call details go below the head.
  private askPermission(sessionId: string, msg: Extract<PluginToHub, { type: "permission" }>): void {
    const f: Formatted = formatPermission(this.m(), msg.toolName, msg.inputPreview, MAX_PREVIEW_CHARS);
    if (!msg.requestId) return this.enqueue(sessionId, `perm-${randomUUID()}`, f.text, notifies("action"), false);
    const key = randomUUID().replaceAll("-", "").slice(0, PERMISSION_KEY_CHARS);
    this.permissions.set(key, { sessionId, requestId: msg.requestId, ...f });
    for (const old of this.permissions.keys()) {
      if (this.permissions.size <= MAX_PERMISSIONS) break;
      this.permissions.delete(old);
    }
    const buttons = [
      [
        { text: this.m().permissionAllow, data: `p:${key}:allow` },
        { text: this.m().permissionDeny, data: `p:${key}:deny` },
      ],
    ];
    if (this.outbox.add(`perm-${key}`, sessionId, [{ text: f.text, silent: !notifies("action"), buttons, ...(f.entities.length ? { entities: f.entities } : {}) }])) void this.pump(sessionId);
  }

  // A button under a permission prompt: the answer goes to the session's
  // window, and the message shows it instead of the buttons.
  private async onPermissionPress(api: TelegramApi, groupId: string, press: { id: string; data: string; messageId: number; fromId: string }): Promise<void> {
    const m = press.data.match(/^p:(\w+):(allow|deny)$/);
    const behavior = m?.[2] === "allow" || m?.[2] === "deny" ? m[2] : undefined;
    const p = m?.[1] ? this.permissions.get(m[1]) : undefined;
    if (!m?.[1] || !behavior || !p) {
      await api.answerCallbackQuery(press.id, this.m().permissionStale).catch(e => this.log.warn(`answering a button press failed: ${e}`));
      await api.removeKeyboard(groupId, press.messageId).catch(e => this.log.warn(`removing the buttons failed: ${e}`));
      return;
    }
    const ws = this.connOf(p.sessionId);
    const outcome = ws ? (behavior === "allow" ? this.m().permissionAllowed : this.m().permissionDenied) : this.m().permissionNotDelivered;
    if (ws) {
      this.permissions.delete(m[1]);
      this.send(ws, { type: "permissionReply", requestId: p.requestId, behavior });
      this.log.info(`permission ${p.requestId} of session ${p.sessionId}: ${behavior} by ${press.fromId}`);
    }
    await api.answerCallbackQuery(press.id, outcome).catch(e => this.log.warn(`answering a button press failed: ${e}`));
    await api.editMessageText(groupId, press.messageId, `${p.text}\n\n${outcome}`, p.entities).catch(e => this.log.warn(`editing a permission message failed: ${e}`));
  }

  // --- questions ------------------------------------------------------------

  // An AskUserQuestion call from the PreToolUse hook: the questions go to the
  // topic one at a time, and the promise settles with the topic's answer, or
  // with "none" when the call goes back to the terminal (the hook gave up,
  // the window left, the hub stops). A newer poll of the session ends the old one.
  private askQuestion(sessionId: string, questions: AskQuestion[], signal: AbortSignal): Promise<QuestionDecision> {
    if (this.isStarting(sessionId) || this.dyingHeld.has(sessionId)) return Promise.resolve({ decision: "none" });
    for (const old of this.polls.values()) if (old.sessionId === sessionId) void this.finishPoll(old, { decision: "none" }, this.m().pollMovedToTerminal);
    const key = randomUUID().replaceAll("-", "").slice(0, PERMISSION_KEY_CHARS);
    return new Promise(resolve => {
      const p: Poll = { key, sessionId, questions, answers: {}, index: 0, checked: new Set(), messageIds: [], outcomes: [], taken: [], done: false, resolve };
      this.polls.set(key, p);
      if (signal.aborted) {
        void this.finishPoll(p, { decision: "none" }, this.m().pollMovedToTerminal);
        return;
      }
      signal.addEventListener("abort", () => void this.finishPoll(p, { decision: "none" }, this.m().pollMovedToTerminal), { once: true });
      this.log.info(`question poll ${key} for session ${sessionId}: ${questions.length} question(s)`);
      void this.catchUp(sessionId, key).then(() => {
        if (!p.done) this.queueQuestion(p);
      });
    });
  }

  // The agent's text before the tool call reaches the hub only when the
  // window's tailer next reads the transcript, so the window is asked to
  // send it now; the question then queues behind it. Settles when the
  // window answers, or after catchUpMs: an older window never does.
  private catchUp(sessionId: string, key: string): Promise<void> {
    const ws = this.connOf(sessionId);
    if (!ws) return Promise.resolve();
    return new Promise(resolve => {
      const timer = this.setTimer(() => done(), this.opts.catchUpMs ?? CATCH_UP_MS);
      const done = () => {
        this.clearTimer(timer);
        this.catchUps.delete(key);
        resolve();
      };
      this.catchUps.set(key, done);
      this.send(ws, { type: "catchUp", id: key });
    });
  }

  private queueQuestion(p: Poll): void {
    const f = questionText(this.m(), p.questions, p.index);
    const piece = { text: f.text, silent: !notifies("action"), buttons: questionButtons(this.m(), p), ...(f.entities.length ? { entities: f.entities } : {}) };
    if (this.outbox.add(`poll:${p.key}:${p.index}`, p.sessionId, [piece])) void this.pump(p.sessionId);
  }

  private async finishPoll(p: Poll, decision: QuestionDecision, outcome: string): Promise<void> {
    if (p.done) return;
    p.done = true;
    this.polls.delete(p.key);
    p.outcomes[p.index] = outcome;
    p.resolve(decision);
    // The agent has the answers now; with none, it never gets them.
    if (decision.decision === "allow") for (const id of p.taken) this.clearTaken(id);
    this.log.info(`question poll ${p.key} of session ${p.sessionId}: ${decision.decision}`);
    await this.showOutcome(p, p.index);
  }

  // A sent question shows its outcome instead of the buttons; one still in
  // the queue takes its outcome along when it goes.
  private async showOutcome(p: Poll, i: number): Promise<void> {
    const id = p.messageIds[i];
    const outcome = p.outcomes[i];
    const api = this.opts.api;
    const groupId = this.opts.config().groupId;
    if (id === undefined || outcome === undefined || !api || !groupId) return;
    const f = withOutcome(questionText(this.m(), p.questions, i), outcome);
    await api.editMessageText(groupId, id, f.text, f.entities).catch(e => this.log.warn(`editing a question message failed: ${e}`));
  }

  private async answerPoll(p: Poll, answer: string): Promise<void> {
    const q = p.questions[p.index];
    p.answers[q.question] = answer;
    if (p.index + 1 < p.questions.length) {
      const i = p.index;
      p.outcomes[i] = answerLine(answer);
      p.index++;
      p.checked = new Set();
      this.queueQuestion(p);
      await this.showOutcome(p, i);
      return;
    }
    await this.finishPoll(p, { decision: "allow", answers: { ...p.answers } }, answerLine(answer));
  }

  // A button under a question. The poll changes before any await, so a
  // second press right after sees the new state; every press gets one answer.
  private async onPollPress(api: TelegramApi, groupId: string, press: { id: string; data: string; messageId: number; fromId: string }): Promise<void> {
    const warn = (what: string) => (e: unknown) => this.log.warn(`${what} failed: ${e}`);
    const ack = (text?: string) => api.answerCallbackQuery(press.id, text).catch(warn("answering a button press"));
    const parsed = parsePollPress(press.data);
    const known = parsed ? this.polls.get(parsed.key) : undefined;
    // Nobody is left to take the answer: the question moves to the terminal and the button is stale.
    const closed = known && !this.connOf(known.sessionId);
    if (known && closed) void this.finishPoll(known, { decision: "none" }, this.m().pollMovedToTerminal);
    const p = closed ? undefined : known;
    const q = p?.questions[p.index];
    const action = parsed?.action;
    const valid = p && q && parsed?.index === p.index && action !== undefined && (typeof action === "number" ? action >= 1 && action <= q.options.length : action !== "done" || q.multiSelect);
    if (!valid || !p || !q || action === undefined) {
      await ack(this.m().pollStale);
      await api.removeKeyboard(groupId, press.messageId).catch(warn("removing the buttons"));
      return;
    }
    if (action === "cancel") {
      this.log.info(`question poll ${p.key} cancelled by ${press.fromId}`);
      const done = this.finishPoll(p, { decision: "deny", reason: CANCEL_REASON }, this.m().pollCancelled);
      await ack();
      await done;
      return;
    }
    if (action === "custom") {
      this.enqueue(p.sessionId, `qhint-${p.key}-${p.index}-${randomUUID()}`, this.m().pollCustomHint, notifies("info"), false);
      await ack();
      return;
    }
    if (action === "done") {
      if (!p.checked.size) {
        await ack(this.m().pollPickOne);
        return;
      }
      const done = this.answerPoll(p, checkedLabels(q, p.checked));
      await ack();
      await done;
      return;
    }
    if (!q.multiSelect) {
      const done = this.answerPoll(p, q.options[action - 1].label);
      await ack();
      await done;
      return;
    }
    if (p.checked.has(action)) p.checked.delete(action);
    else p.checked.add(action);
    const f = questionText(this.m(), p.questions, p.index);
    const buttons = questionButtons(this.m(), p);
    await ack();
    await api.editMessageText(groupId, press.messageId, f.text, f.entities, buttons).catch(warn("editing a question message"));
  }

  // A question's turn in the queue. A poll that ended meanwhile is not sent
  // when it never showed; a question answered or ended while queued goes
  // with its outcome and without buttons.
  private async sendQuestion(api: TelegramApi, groupId: string, sessionId: string, item: OutItem, key: string, i: number): Promise<void> {
    const p = this.polls.get(key);
    const outcome = p?.outcomes[i];
    if (!p) {
      this.log.info(`question poll ${key} ended before its question ${i + 1} was sent; skipping it`);
      return;
    }
    const { text } = item;
    const buttons = outcome === undefined ? questionButtons(this.m(), p) : undefined;
    const body = outcome === undefined ? text : `${text}\n\n${outcome}`;
    const sent = await this.sendToTopic(api, groupId, sessionId, thread => api.sendMessage(groupId, thread, body, item.silent, item.entities, buttons));
    p.messageIds[i] = sent.message_id;
    if (outcome === undefined && p.outcomes[i] !== undefined) await this.showOutcome(p, i);
  }

  // --- subagent cards -------------------------------------------------------

  // The first version of a card is queued like any text, so it keeps its place
  // among the session's messages; later versions edit that message, at most
  // every CARD_EDIT_MS.
  private onCard(msg: Extract<PluginToHub, { type: "card" }>): void {
    this.upsertCard(msg.sessionId, msg.id, msg.text, msg.final, undefined, msg.reopen, msg.replyTo);
  }

  // A subagent's card or a topic command's: buttons, when given, go under it.
  private upsertCard(sessionId: string, cardId: string, markdown: string, final: boolean, buttons?: Button[][], reopen = false, replyTo?: string, kind?: MessageKind): void {
    if (!this.store.get(sessionId)) return;
    const key = `${sessionId}:${cardId}`;
    const card = this.cards.get(key);
    // Only an explicit continuation may change a finished card.
    if (card?.done && !reopen) return;
    if (card) {
      const reopened = card.done && reopen;
      if (reopened) card.done = false;
      card.text = markdown;
      card.final = final;
      card.buttons = buttons;
      if (reopened) this.saveCards();
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
    if (first && this.outbox.add(`card-${randomUUID()}`, sessionId, [{ ...first, ...(kind ? { silent: !notifies(kind) } : {}), card: key, ...(replyTo ? { cardReplyTo: `${sessionId}:${replyTo}` } : {}) }])) void this.pump(sessionId);
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
    card.timer = this.setTimer(
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
  private enqueue(sessionId: string, sourceId: string, text: string, notify: boolean, markdown = true, replaces?: { id: string; kind: ResolutionKind }, awaitsResult?: true): void {
    if (!this.store.get(sessionId)) {
      this.log.warn(`session ${sessionId} has no topic, text not sent:\n${text}`);
      return;
    }
    const pieces = (markdown ? markdownPieces(text) : textPieces(text, false)).map((p, i) => ({ ...p, silent: !(notify && i === 0), ...(i === 0 && replaces ? { resolution: { id: `cmd-${replaces.id}#0`, kind: replaces.kind } } : {}), ...(i === 0 && awaitsResult ? { keepId: true as const } : {}) }));
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
    const formatted = toTelegram(msg.caption);
    const caption = hasVisibleText(formatted.text) ? formatted : undefined;
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
    if (item.resolution) {
      const isProgress = item.resolution.kind === "progress";
      const messageId = isProgress ? this.outbox.peekMessageId(item.resolution.id) : this.outbox.takeMessageId(item.resolution.id);
      if (messageId !== undefined) {
        if (item.resolution.kind === "success" || isProgress) {
          try {
            await api.editMessageText(groupId, messageId, item.text, item.entities);
            return;
          } catch (e) {
            if (e instanceof TelegramError && e.code === 400 && /message is not modified/i.test(e.description)) return;
            this.log.warn(`editing queued ${isProgress ? "progress" : "result"} message ${messageId} failed: ${e}`);
            if (isProgress) return;
          }
        } else {
          await api.deleteMessage(groupId, messageId).catch(e => this.log.warn(`deleting queued notice ${messageId} failed: ${e}`));
        }
      }
      if (isProgress) return;
      const sent = await this.sendToTopic(api, groupId, sessionId, thread => api.sendMessage(groupId, thread, item.text, item.silent, item.entities, item.buttons));
      if (item.keepId) this.outbox.recordMessageId(item.id, sent.message_id);
      return;
    }
    if (rich) {
      const sent = await this.sendToTopic(api, groupId, sessionId, thread => api.sendRichMessage(groupId, thread, rich, item.silent));
      if (item.keepId) this.outbox.recordMessageId(item.id, sent.message_id);
      return;
    }
    const card = item.card ? this.cards.get(item.card) : undefined;
    if (item.card && card) {
      // The card may have changed while it waited in the queue.
      const text = card.text;
      const f = cardFormat(text);
      const buttons = card.buttons;
      const replyTo = item.cardReplyTo ? this.cards.get(item.cardReplyTo)?.messageId : undefined;
      const sent = await this.sendToTopic(api, groupId, sessionId, thread => api.sendMessage(groupId, thread, f.text, true, f.entities, buttons, replyTo));
      card.messageId = sent.message_id;
      card.shown = text;
      card.lastEdit = Date.now();
      this.saveCards();
      this.scheduleCardEdit(item.card, card);
      return;
    }
    // A notice that replaced a rejected question keeps its id but is plain text.
    const poll = item.notice ? null : POLL_ITEM.exec(item.id);
    if (!queued && poll) {
      const send = this.sendQuestion(api, groupId, sessionId, item, poll[1], Number(poll[2]));
      const tracked: Promise<void> = send.catch(() => undefined).finally(() => this.questionSends.delete(tracked));
      this.questionSends.add(tracked);
      return send;
    }
    if (!queued) {
      const { text } = item;
      const sent = await this.sendToTopic(api, groupId, sessionId, thread => api.sendMessage(groupId, thread, text, item.silent, item.entities, item.buttons));
      if (item.keepId) this.outbox.recordMessageId(item.id, sent.message_id);
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
    // A question the topic cannot show is asked in the terminal.
    const pollKey = item.notice ? undefined : POLL_ITEM.exec(item.id)?.[1];
    const poll = pollKey ? this.polls.get(pollKey) : undefined;
    if (poll) void this.finishPoll(poll, { decision: "none" }, this.m().pollMovedToTerminal);
    if (item.notice) {
      this.outbox.remove(item.id);
      this.settled(item);
    } else this.outbox.replaceWithNotice(item.id, this.m().telegramRejected({ reason }));
  }

  private sleep(ms: number): Promise<void> {
    if (this.opts.sleep) return this.opts.sleep(ms);
    return new Promise(resolve => {
      const onAbort = () => {
        this.clearTimer(timer);
        resolve();
      };
      const timer = this.setTimer(() => {
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
    // A session with no topic yet gets one at its first message. The chain makes concurrent first messages share it.
    const threadId = rec.topicId ?? (await this.chain(sessionId, async () => this.store.get(sessionId)?.topicId ?? (await this.createTopic(api, groupId, sessionId))));
    try {
      return await send(threadId);
    } catch (e) {
      if (!isThreadNotFound(e)) throw e;
      // The topic was deleted by hand: give the session a new one.
      const newId = await this.createTopic(api, groupId, sessionId);
      this.log.warn(`topic ${threadId} of session ${sessionId} is gone, created ${newId}`);
      return await send(newId);
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
            this.botId = me.id;
            // Updates before it were handled by an earlier hub; Telegram would send them again.
            if (this.opts.pollOffsetFile) offset = loadPollOffset(this.opts.pollOffsetFile, me.id);
            void this.registerCommands(api);
          }
          online = wasOnline = true;
          this.botReady = true;
          this.rigLifecycle?.ready();
          failures = 0;
        } catch (e) {
          if (!this.running) return;
          if (e instanceof TelegramError && e.code === 401) {
            this.log.error("bot token rejected by Telegram (401 Unauthorized) — fix TELEGRAM_BOT_TOKEN in .env and restart the hub; not polling");
            return;
          }
          this.log.warn(`Telegram unreachable (${e}); still trying`);
          await (this.opts.sleep ?? Bun.sleep)(this.opts.pollRetryBaseMs ?? POLL_RETRY_BASE_MS);
          continue;
        }
      }
      let updates: Update[];
      try {
        updates = await api.getUpdates(offset, this.opts.pollTimeoutSec ?? POLL_TIMEOUT_SEC, this.abort.signal);
        this.botReady = true;
        if (failures) this.log.info("Telegram polling works again");
        failures = 0;
      } catch (e) {
        if (!this.running) return;
        this.botReady = false;
        if (!(e instanceof TelegramError)) {
          this.log.warn(`getUpdates lost the connection (${e}); reconnecting`);
          online = false;
          this.botReady = false;
          continue;
        }
        failures++;
        const delay = Math.min((this.opts.pollRetryBaseMs ?? POLL_RETRY_BASE_MS) * failures, MAX_POLL_DELAY_MS);
        const conflict = e.code === 409;
        this.log.warn(`${conflict ? "getUpdates 409 Conflict — another poller uses this bot token" : `getUpdates failed: ${e}`}; retry in ${delay}ms`);
        await (this.opts.sleep ?? Bun.sleep)(delay);
        continue;
      }
      for (const u of updates) {
        // A stopping hub takes no more; the next one gets them again.
        if (!this.running) return;
        offset = Math.max(offset, u.update_id + 1);
        try {
          await this.handleUpdate(api, u);
        } catch (e) {
          this.log.error(`update ${u.update_id} failed: ${e}`);
        }
        this.savePollOffset(offset);
      }
    }
  }

  // Once an update is handled, which is also when the next getUpdates confirms it to Telegram.
  private savePollOffset(offset: number): void {
    if (!this.opts.pollOffsetFile || this.botId === undefined) return;
    try {
      savePollOffset(this.opts.pollOffsetFile, this.botId, offset);
    } catch (e) {
      this.log.warn(`saving the update offset failed: ${e}`);
    }
  }

  private async handleUpdate(api: TelegramApi, u: Update): Promise<void> {
    this.updatesInFlight++;
    try { await this.processUpdate(api, u); }
    finally { this.updatesInFlight--; }
  }

  private async processUpdate(api: TelegramApi, u: Update): Promise<void> {
    const cfg = this.opts.config();
    const press = routeCallback(u, cfg);
    if (press?.action === "ignore") {
      this.log.info(`ignored ${press.reason}`);
      if (press.id) await api.answerCallbackQuery(press.id).catch(e => this.log.warn(`answering a button press failed: ${e}`));
      return;
    }
    if (press?.data.startsWith("x:")) return this.onExecPress(api, press);
    if (press?.data.startsWith("rig-disable:")) return this.onRigDisablePress(api, press);
    if (press?.data.startsWith("m:")) return this.onModePress(api, press);
    if (press?.data.startsWith(POLL_PREFIX) && cfg.groupId) return this.onPollPress(api, cfg.groupId, press);
    if (press && cfg.groupId) return this.onPermissionPress(api, cfg.groupId, press);
    const route = routeUpdate(u, cfg, this.store, id => this.isConnected(id), this.botUsername);
    const m = u.message;
    if (m) this.deliveryOrder(m);
    if (route.action === "ignore") {
      if (m) this.log.info(`ignored update from chat ${m.chat.id} (${m.chat.type}${m.chat.title ? ` "${m.chat.title}"` : ""}), sender ${m.from?.id}: ${route.reason}`);
      return;
    }
    if (!m) return;
    if (route.action === "machine") {
      const command = machineCommandOf(m.text ?? "", this.botUsername);
      if (command) this.runMachineCommand(command, m, { chatId: String(m.chat.id), topicId: route.topicId });
      return;
    }
    // Whether Telegram sent a reply's quote shows only in the raw update.
    const r = m.reply_to_message;
    if (r && !r.forum_topic_created && r.message_id !== m.message_thread_id) {
      const quote = m.quote ? `quote of ${Array.from(m.quote.text).length} chars${m.quote.is_manual ? "" : ", not manual"}` : "no quote";
      this.log.info(`message ${m.message_id} replies to ${r.message_id}: ${quote}; fields ${Object.keys(m).join(", ")}`);
    }
    const hubCmd = m.text !== undefined ? hubCommandOf(m.text, this.botUsername) : undefined;
    if (hubCmd) {
      // The messages before the command reach the agent first.
      if (hubCmd.name !== "mode" && hubCmd.name !== "stop") await this.flushBatch(route.sessionId);
      if (route.action === "inactive" && hubCmd.name === "cleanup" && this.opts.config().launch) {
        return this.toInactive(api, route.sessionId, [m]);
      }
      return this.onHubCommand(route.sessionId, hubCmd, m);
    }
    const rest = await this.toPoll(api, route.sessionId, m);
    if (!rest) return;
    if (route.action === "inactive") return this.toInactive(api, route.sessionId, [rest]);
    if (this.holdForCleanup(route.sessionId, rest)) return;
    await this.deliver(api, route.sessionId, rest);
  }

  // A message sent after the open poll's question showed answers it; an
  // earlier one, or one sent while the question is not shown yet, reaches the
  // agent. A "!" message cancels the poll and goes on to the agent as an
  // ordinary message, since the agent waits for the answer and has no turn to
  // stop. Returns the message to deliver, or undefined when nothing is left of it.
  private async toPoll(api: TelegramApi, sessionId: string, m: Message): Promise<Message | undefined> {
    let p: Poll | undefined;
    for (const open of this.polls.values()) if (open.sessionId === sessionId) p = open;
    if (!p) return m;
    const role = pollRole(m, this.botUsername);
    if (role === "pass") return m;
    if (role === "cancel") {
      void this.finishPoll(p, { decision: "deny", reason: CANCEL_REASON }, this.m().pollCancelled);
      // Answer messages still waiting reach the agent before this one.
      await this.takeAnswer(p.key);
      const plain = withoutInterrupt(m);
      return plain.text === "" ? undefined : plain;
    }
    const shownAs = p.messageIds[p.index];
    if (shownAs === undefined || m.message_id <= shownAs || p.done) return m;
    const text = m.text ?? m.caption ?? (m.rich_message ? await this.richContent(api, m.rich_message) : undefined);
    const part = [text, await this.fileMark(api, m)].filter(s => s !== undefined && s !== "").join(" ");
    if (!part) return m;
    if (p.done) return m;
    this.addAnswer(api, p, m, part);
    return undefined;
  }

  // An answer message waits for the ones sent with it, like a batch.
  private addAnswer(api: TelegramApi, p: Poll, m: Message, part: string): void {
    const quietMs = this.opts.batchQuietMs ?? BATCH_QUIET_MS;
    const g = this.answerGroups.get(p.key);
    if (g && g.index === p.index) {
      g.messages.push(m);
      g.parts.push(part);
      this.clearTimer(g.timer);
      g.timer = this.setTimer(() => void this.takeAnswer(p.key), quietMs);
      return;
    }
    if (g) void this.takeAnswer(p.key);
    const timer = this.setTimer(() => void this.takeAnswer(p.key), quietMs);
    this.answerGroups.set(p.key, { api, poll: p, index: p.index, messages: [m], parts: [part], timer });
  }

  // The waiting messages answer their question, their parts after blank
  // lines; when the question was answered or the poll ended meanwhile,
  // they go on to the agent instead.
  private async takeAnswer(key: string): Promise<void> {
    const g = this.answerGroups.get(key);
    if (!g) return;
    this.answerGroups.delete(key);
    this.clearTimer(g.timer);
    const p = g.poll;
    if (p.done || p.index !== g.index) {
      for (const m of g.messages) if (!this.holdForCleanup(p.sessionId, m)) await this.deliver(g.api, p.sessionId, m);
      return;
    }
    this.log.info(`question poll ${key}: answered by message(s) ${g.messages.map(m => m.message_id).join(", ")}`);
    // Like an inbound message, an answer shows ✍ while the agent does not have it.
    if (this.connOf(p.sessionId)?.data.reportsSeen) {
      for (const m of g.messages) {
        this.reactLater(m.message_id);
        p.taken.push(m.message_id);
      }
    }
    await this.answerPoll(p, g.parts.join("\n\n"));
  }

  // Messages for a session without a window: kept for its start under way,
  // else they start it, else the user is told it is not active.
  private async toInactive(api: TelegramApi, sessionId: string, messages: Message[]): Promise<void> {
    const rest = messages.filter(m => !this.hold(sessionId, { message: m }));
    if (!rest.length) return;
    const cfg = this.opts.config();
    if (cfg.launch) return this.launch(sessionId, undefined, rest.map(m => ({ message: m })));
    const text = cfg.launchError ? this.m().sessionInactiveLaunchBroken : this.m().sessionInactive;
    const topicId = this.store.get(sessionId)?.topicId;
    if (!cfg.groupId || topicId === undefined) return;
    await api.sendMessage(cfg.groupId, topicId, text, false).catch(e => this.log.warn(`inactive notice failed: ${e}`));
  }

  // A /cleanup under way keeps topic messages for the session it starts
  // again; a module command still goes to the window, and so does a message
  // that interrupts the agent.
  private holdForCleanup(sessionId: string, m: Message): boolean {
    if (!this.cleanups.has(sessionId)) return false;
    if (m.text !== undefined && commandOf(m.text, this.botUsername)) return false;
    if (isInterrupt(m)) return false;
    return this.keepForCleanup(sessionId, { message: m });
  }

  // Puts a message or a command result on the held list of the /cleanup under
  // way; false when there is none.
  private keepForCleanup(sessionId: string, h: Held): boolean {
    const c = this.cleanups.get(sessionId);
    if (!c) return false;
    const what = "message" in h ? `message ${h.message.message_id}` : "a command result";
    this.keepInOrder(c.held, h);
    this.log.info(`${what} for session ${sessionId} held until /cleanup ends`);
    return true;
  }

  // A topic message joins the session's waiting batch. A module command goes
  // after the batch; a "!" message sends it and starts its own.
  private async deliver(api: TelegramApi, sessionId: string, m: Message): Promise<void> {
    if (this.hold(sessionId, { message: m })) return;
    if (!this.connOf(sessionId)) return this.toInactive(api, sessionId, [m]);
    // Held messages are still being handed over: this one goes after the
    // older ones.
    const open = this.replays.get(sessionId);
    if (open) return void this.keepInOrder(open.held, { message: m });
    const cmd = m.text !== undefined ? commandOf(m.text, this.botUsername) : undefined;
    if (cmd) {
      await this.flushBatch(sessionId);
      if (this.hold(sessionId, { message: m })) return;
      this.queueCommand(sessionId, cmd);
      return;
    }
    if (isInterrupt(m)) void this.flushBatch(sessionId);
    const quietMs = this.opts.batchQuietMs ?? BATCH_QUIET_MS;
    const b = this.batches.get(sessionId);
    if (b) {
      b.messages.push(m);
      this.clearTimer(b.quietTimer);
      b.quietTimer = this.setTimer(() => void this.flushBatch(sessionId), quietMs);
      return;
    }
    this.batches.set(sessionId, {
      api,
      messages: [m],
      quietTimer: this.setTimer(() => void this.flushBatch(sessionId), quietMs),
      maxTimer: this.setTimer(() => void this.flushBatch(sessionId), this.opts.batchMaxMs ?? BATCH_MAX_MS),
    });
  }

  // Sends the session's waiting batch after the batches sent before it;
  // resolves once all of them are in the window.
  private flushBatch(sessionId: string): Promise<void> {
    const b = this.batches.get(sessionId);
    if (b) {
      this.batches.delete(sessionId);
      this.clearTimer(b.quietTimer);
      this.clearTimer(b.maxTimer);
      this.queueBatch(sessionId, b.api, b.messages);
    }
    return this.batchSends.get(sessionId) ?? Promise.resolve();
  }

  private queueBatch(sessionId: string, api: TelegramApi, messages: Message[]): Promise<void> {
    for (const message of messages) this.deliveryOrder(message);
    const entry = { messages, captured: false };
    const items = this.batchItems.get(sessionId) ?? new Set<QueuedBatch>();
    items.add(entry);
    this.batchItems.set(sessionId, items);
    const prev = this.batchSends.get(sessionId) ?? Promise.resolve();
    const next = prev
      .then(() => entry.captured ? undefined : this.sendBatch(api, sessionId, messages, entry))
      .catch(e => this.log.error(`delivering messages ${messages.map(m => m.message_id).join(", ")} to session ${sessionId} failed: ${e}`));
    this.batchSends.set(sessionId, next);
    void next.then(() => {
      items.delete(entry);
      if (!items.size && this.batchItems.get(sessionId) === items) this.batchItems.delete(sessionId);
      if (this.batchSends.get(sessionId) === next) this.batchSends.delete(sessionId);
    });
    return next;
  }

  // One message goes as before, with its attachment in the meta; several go
  // as one notification, their texts after blank lines and their files named
  // in the text.
  private async sendBatch(api: TelegramApi, sessionId: string, messages: Message[], entry: QueuedBatch): Promise<void> {
    const remaining = messages.filter(message => !this.hold(sessionId, { message }));
    if (!remaining.length) return;
    messages = remaining;
    const [first, ...rest] = messages;
    if (!first) return;
    const ws = this.connOf(sessionId);
    const ids = messages.map(m => m.message_id);
    // The window closed while the batch waited: the messages go the way of
    // ones for an inactive session, so none is lost.
    if (!ws) {
      const what = rest.length ? `messages ${ids.join(", ")}` : `message ${first.message_id}`;
      // A hub that stops starts no window: nobody would hand it the messages.
      if (!this.running) return this.log.warn(`session ${sessionId} has no window and the hub is stopping: ${what} not delivered`);
      this.log.info(`session ${sessionId} has no window for ${what}`);
      return this.toInactive(api, sessionId, messages);
    }
    this.setEnabled(sessionId, true);
    // Only the first message of a batch can interrupt: a "!" message starts
    // its own batch. The agent gets the text without the "!".
    const interrupt = isInterrupt(first);
    const flag = interrupt ? { interrupt: true as const } : {};
    const head = interrupt ? withoutInterrupt(first) : first;
    if (!rest.length) {
      const { content, meta } = await this.inboundOf(api, head);
      if (entry.captured) return;
      if (this.rerouteBatch(sessionId, ws, messages)) return;
      if (ws.data.reportsSeen) this.reactLater(first.message_id);
      this.send(ws, { type: "inbound", content, meta, ...flag });
      for (const message of messages) this.deliveredItems.add(message);
      this.log.info(`message ${first.message_id} in topic ${first.message_thread_id} → session ${sessionId}: ${shapeOf(first, content)}`);
      return;
    }
    const parts: string[] = [];
    for (const m of [head, ...rest]) parts.push(await this.itemContent(api, m));
    // A lone "!" leaves an empty first part.
    const content = parts.filter(p => p !== "").join("\n\n");
    if (entry.captured) return;
    if (this.rerouteBatch(sessionId, ws, messages)) return;
    if (ws.data.reportsSeen) {
      for (const id of ids) this.reactLater(id);
      this.batchIds.set(first.message_id, rest.map(m => m.message_id));
      const oldest = this.batchIds.keys().next();
      if (this.batchIds.size > MAX_BATCH_IDS && !oldest.done) this.batchIds.delete(oldest.value);
    }
    this.send(ws, { type: "inbound", content, meta: baseMeta(first), ...flag });
    for (const message of messages) this.deliveredItems.add(message);
    this.log.info(`messages ${ids.join(", ")} in topic ${first.message_thread_id} → session ${sessionId}: ${messages.map(kindOfMessage).join(", ")}, ${content.length} chars`);
  }

  // A message of a batch: its own text first, then its files named.
  private async itemContent(api: TelegramApi, m: Message): Promise<string> {
    const text = m.text ?? m.caption ?? (m.rich_message ? await this.richContent(api, m.rich_message) : undefined);
    const mark = await this.fileMark(api, m);
    return withContext(m, [text, mark].filter(s => s !== undefined && s !== "").join(" "), this.botId);
  }

  private async fileMark(api: TelegramApi, m: Message): Promise<string | undefined> {
    const best = m.photo?.at(-1);
    if (best) {
      try {
        return `(photo: ${await api.downloadFile(best.file_id, this.opts.inboxDir)})`;
      } catch (e) {
        this.log.warn(`photo download failed: ${e}`);
        return media("photo", undefined, best.file_id);
      }
    }
    if (m.document) return media("document", safeName(m.document.file_name), m.document.file_id);
    if (m.voice) return media("voice", undefined, m.voice.file_id);
    if (m.audio) return media("audio", safeName(m.audio.title) ?? safeName(m.audio.file_name), m.audio.file_id);
    if (m.video) return media("video", safeName(m.video.file_name), m.video.file_id);
    if (m.video_note) return media("video note", undefined, m.video_note.file_id);
    if (m.sticker) return media("sticker", m.sticker.emoji, m.sticker.file_id);
    return undefined;
  }

  private reactLater(messageId: number): void {
    const timer = this.setTimer(() => {
      this.reactionTimers.delete(messageId);
      this.react(messageId, TAKEN_REACTION);
    }, this.opts.reactionDelayMs ?? REACTION_DELAY_MS);
    this.reactionTimers.set(messageId, timer);
  }

  // The agent has the message: ✍ comes off, or never goes on. A batch is
  // seen by its first message, so its other messages are cleared with it.
  private seen(messageId: number): void {
    const others = this.batchIds.get(messageId);
    this.batchIds.delete(messageId);
    for (const id of others ?? []) this.clearTaken(id);
    this.clearTaken(messageId);
  }

  private clearTaken(messageId: number): void {
    const timer = this.reactionTimers.get(messageId);
    if (timer === undefined) return this.react(messageId, undefined);
    this.clearTimer(timer);
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
    if (this.deliveredItems.has("message" in h ? h.message : h.inbound)) return true;
    const cleanup = this.cleanups.get(sessionId);
    const restart = this.modeRestarts.get(sessionId);
    const dying = this.dyingHeld.get(sessionId);
    if (dying) { this.keepInOrder(dying, h); return true; }
    const pending = restart ?? this.gatedLaunches.get(sessionId) ?? this.launches.get(sessionId) ?? (cleanup && (cleanup.phase === "exiting" || !this.connOf(sessionId)) ? cleanup : undefined);
    if (!pending) return false;
    this.keepInOrder(pending.held, h);
    return true;
  }

  private onHubCommand(sessionId: string, cmd: HubCommand, m: Message): void {
    if (cmd.name === "pwsh" || cmd.name === "cmd" || cmd.name === "bash") return this.onExecCommand(sessionId, cmd.name, cmd.args, m);
    if (cmd.name === "run") {
      if (cmd.args && !this.hasAccounts()) return this.notice(sessionId, this.m().noAccounts, "warning");
      if (this.cleanups.has(sessionId)) return this.notice(sessionId, this.m().cleanupBusy, "info");
      if (this.isStarting(sessionId)) return this.notice(sessionId, this.m().sessionAlreadyStarting, "info");
      if (this.connOf(sessionId)) return this.notice(sessionId, this.m().sessionAlreadyRunning, "info");
      return this.launch(sessionId, cmd.args || undefined, []);
    }
    if (cmd.name === "cleanup") return this.startCleanup(sessionId, cmd.args);
    if (cmd.name === "mode") return this.onModeCommand(sessionId, cmd.args);
    const cleanup = this.cleanups.get(sessionId);
    if (cleanup) return this.stopDuringCleanup(sessionId, cleanup);
    const restart = this.modeRestarts.get(sessionId);
    if (restart) restart.cancelled = true;
    const gated = this.gatedLaunches.get(sessionId);
    if (gated) {
      gated.mode = undefined;
      if (!gated.held.length) this.gatedLaunches.delete(sessionId);
    }
    const launching = this.launches.get(sessionId);
    if (launching) {
      launching.cancelled = true;
      this.clearTimer(launching.timer);
      return this.notice(sessionId, this.m().launchCancelledWindowEnds, "info");
    }
    if (!this.connOf(sessionId)) return this.notice(sessionId, gated ? this.m().launchCancelledWaitingExit : this.exitGates.has(sessionId) ? this.m().sessionAlreadyEnding : this.m().sessionNotRunning, "info");
    if (this.stops.has(sessionId)) return this.notice(sessionId, this.m().sessionAlreadyEnding, "info");
    this.dyingHeld.set(sessionId, this.dyingHeld.get(sessionId) ?? []);
    this.capturePending(sessionId);
    if (this.stopping.has(sessionId)) {
      this.log.info(`second /stop for session ${sessionId}: not waiting for the module`);
      return this.terminate(sessionId);
    }
    // The module compacts the session first if it has to.
    this.stopping.set(sessionId, this.queueCommand(sessionId, { name: "stop", args: cmd.args }));
  }

  private onModeCommand(sessionId: string, args: string): void {
    const msg = this.m();
    if (this.isStarting(sessionId)) return this.notice(sessionId, msg.sessionAlreadyStarting, "info");
    const requested = PERMISSION_MODES.find(mode => mode.toLowerCase() === args.toLowerCase());
    if (args && !requested) return this.notice(sessionId, msg.modeList({ modes: PERMISSION_MODES.join(", ") }), "info");
    if (!requested) return void this.showModes(sessionId);
    const current = this.knownMode(sessionId);
    if (current === requested) return this.notice(sessionId, msg.modeAlready({ mode: requested }), "info");
    const cfg = this.opts.config();
    if (!cfg.launch) return this.notice(sessionId, msg.autolaunchNotConfigured({ launchError: cfg.launchError }), "warning");
    if (!hasModePlaceholder(cfg.launch)) return this.notice(sessionId, msg.addModePlaceholder, "warning");
    const location = this.launchLocation(sessionId, this.connOf(sessionId)?.data.account);
    if ("error" in location) return this.notice(sessionId, location.error === "account" ? msg.accountUnknown : msg.directoryUnknown, "warning");
    const { account, cwd } = location;
    try {
      launchCommand(cfg.launch, { cwd, account, session: sessionId, mode: requested }, this.opts.platform ?? PLATFORM);
    } catch (e) {
      const why = e instanceof LaunchError ? e.render(msg) : String(e);
      return this.notice(sessionId, msg.restartPrepareFailed({ why }), "warning");
    }
    if (this.cleanups.has(sessionId)) return this.notice(sessionId, msg.cleanupBusy, "info");
    if (this.stops.has(sessionId) || this.stopping.has(sessionId)) return this.notice(sessionId, msg.sessionAlreadyEnding, "info");
    if (this.launches.has(sessionId) || this.modeRestarts.has(sessionId)) return this.notice(sessionId, msg.sessionAlreadyStarting, "info");
    const ws = this.connOf(sessionId);
    if (!ws) return this.launch(sessionId, account, [], true, requested);
    this.modeRestarts.set(sessionId, { mode: requested, held: [] });
    this.notice(sessionId, msg.restartingInMode({ mode: requested }), "info");
    this.terminate(sessionId);
  }

  private currentMode(sessionId: string): string | undefined {
    const rec = this.store.get(sessionId);
    const path = this.transcriptOf(sessionId);
    if (path && rec?.launchedMode && rec.launchedModeOffset !== undefined) {
      const later = transcriptMode(path, rec.launchedModeOffset);
      if (later) return later;
    }
    if (rec?.launchedMode) return rec.launchedMode;
    return path ? transcriptMode(path) : undefined;
  }

  private knownMode(sessionId: string): string | undefined {
    const ws = this.connOf(sessionId);
    if (!ws) return undefined;
    const path = this.transcriptOf(sessionId);
    const rec = this.store.get(sessionId);
    const offset = ws.data.launchedMode ? rec?.launchedModeOffset ?? ws.data.attachedOffset : ws.data.attachedOffset;
    return (path && offset !== undefined ? transcriptMode(path, offset) : undefined) ?? ws.data.launchedMode;
  }

  private launchLocation(sessionId: string, account: string | undefined): { account: string; cwd: string } | { error: "account" | "cwd" | "record" } {
    const rec = this.store.get(sessionId);
    if (!rec) return { error: "record" };
    const resolvedAccount = this.hasAccounts() ? account ?? rec.account : "";
    if (resolvedAccount === undefined) return { error: "account" };
    const cwd = rec.cwd ?? (this.opts.projectsDir ? sessionCwd(sessionId, this.opts.projectsDir) : undefined);
    if (!cwd) return { error: "cwd" };
    return { account: resolvedAccount, cwd };
  }

  private async showModes(sessionId: string): Promise<void> {
    const api = this.opts.api;
    const cfg = this.opts.config();
    const rec = this.store.get(sessionId);
    if (!api || !cfg.groupId || rec?.topicId === undefined) return;
    const known = this.knownMode(sessionId);
    const current = known ?? this.currentMode(sessionId);
    const msg = this.m();
    const label = current === undefined ? msg.modeUnknown : current;
    const buttons = PERMISSION_MODES.map(mode => [{ text: `${current === mode ? "✅ " : ""}${mode}`, data: `m:${sessionId}:${mode}` }]);
    const text = known === undefined && current !== undefined ? msg.modeLastKnown({ mode: label }) : msg.modeCurrent({ mode: label });
    if (this.outbox.add(`modes-${randomUUID()}`, sessionId, [{ text, silent: true, buttons }])) void this.pump(sessionId);
  }

  private terminate(sessionId: string, stopId?: string): void {
    this.stopping.delete(sessionId);
    const queued = this.commands.get(sessionId) ?? [];
    for (const e of queued.filter(e => e.cmd.name === "stop")) this.clearTimer(e.timer);
    this.commands.set(sessionId, queued.filter(e => e.cmd.name !== "stop"));
    const ws = this.connOf(sessionId);
    if (!ws || this.stops.has(sessionId)) return;
    if (!this.modeRestarts.has(sessionId) && !this.cleanups.has(sessionId) && !this.dyingHeld.has(sessionId)) this.dyingHeld.set(sessionId, []);
    this.capturePending(sessionId);
    this.log.info(`stopping session ${sessionId} from the topic`);
    this.send(ws, { type: "terminate" });
    if (stopId) this.stopIds.set(sessionId, stopId);
    const ms = this.opts.stopTimeoutMs ?? STOP_TIMEOUT_MS;
    this.stops.set(
      sessionId,
      this.setTimer(() => {
        this.stops.delete(sessionId);
        this.stopIds.delete(sessionId);
        const restart = this.modeRestarts.get(sessionId);
        if (restart) {
          this.modeRestarts.delete(sessionId);
          this.log.warn(`session ${sessionId} did not end for a mode restart; ${restart.held.length} held message(s) go to its window`);
          this.releaseHeld(sessionId, restart.held);
        }
        const dying = this.dyingHeld.get(sessionId);
        if (dying) {
          // The window stays: what a dropped /cleanup held goes to it.
          this.dyingHeld.delete(sessionId);
          this.log.warn(`session ${sessionId} did not end; ${dying.length} held message(s) go to its window`);
          this.releaseHeld(sessionId, dying);
        }
        if (this.cleanups.has(sessionId)) {
          this.log.warn(`session ${sessionId} did not end for /cleanup; /cleanup dropped`);
          this.dropCleanup(sessionId);
        }
        this.notice(sessionId, this.m().couldNotEnd({ seconds: ms / MS_PER_SECOND }), "warning");
      }, ms),
    );
  }

  // --- /cleanup ---------------------------------------------------------------

  // The module compacts the session, the window ends, the hub empties the
  // skills Claude Code remembers in the transcript; the session stays ended.
  private startCleanup(sessionId: string, args: string): void {
    if (this.cleanups.has(sessionId)) return this.notice(sessionId, this.m().cleanupBusy, "info");
    if (!this.connOf(sessionId)) return this.notice(sessionId, this.m().sessionNotRunning, "info");
    if (this.stops.has(sessionId) || this.stopping.has(sessionId)) return this.notice(sessionId, this.m().sessionAlreadyEnding, "info");
    const c: Cleanup = { id: this.queueCommand(sessionId, { name: "cleanup", args }), phase: "compacting", held: [] };
    const ms = this.opts.cleanupCompactMs ?? CLEANUP_COMPACT_MS;
    c.compactTimer = this.setTimer(() => {
      if (this.cleanups.get(sessionId) !== c || c.phase !== "compacting") return;
      this.log.warn(`/cleanup of session ${sessionId}: no compact report in ${ms} ms; /cleanup dropped`);
      this.cleanupOutcome(sessionId, c, this.m().cleanupCompactTimeout({ minutes: ms / MS_PER_MINUTE }), "warning", "warning");
      this.dropCleanup(sessionId);
    }, ms);
    this.cleanups.set(sessionId, c);
  }

  // The outcome of a /cleanup resolves its "queued" message: a success edits it
  // in place (silent); any other outcome deletes it and arrives as a new message,
  // loud by its kind. One still
  // queued or being sent goes once it is in the topic.
  private cleanupOutcome(sessionId: string, c: Cleanup, text: string, kind: MessageKind, outcome: "success" | "warning"): void {
    c.ended = true;
    const key = cleanupStartKey(c);
    const pieces = textPieces(text, false).map((piece, index) => ({
      ...piece,
      silent: !notifies(kind),
      ...(index === 0 ? { resolution: { id: key, kind: outcome } } : {}),
    }));
    if (this.outbox.add(`cleanup-result-${c.id}`, sessionId, pieces)) void this.pump(sessionId);
  }

  // /stop ends a compacting window at once, the /cleanup dropped and the
  // transcript untouched; an exiting one is ending already.
  private stopDuringCleanup(sessionId: string, c: Cleanup): void {
    if (c.phase === "compacting") {
      this.dyingHeld.set(sessionId, this.dyingHeld.get(sessionId) ?? []);
      this.log.info(`/stop during the /cleanup compact of session ${sessionId}: ending the window, the transcript untouched`);
      this.cleanupOutcome(sessionId, c, this.m().cleanupCancelled, "info", "warning");
      this.dropCleanup(sessionId, true);
      this.capturePending(sessionId);
    }
    this.terminate(sessionId);
  }

  // A /cleanup given up before the window ended: the messages it held go to
  // the window still open, else as to a stopped session. A window about to be
  // terminated does not get them: they wait for it to go and then start the
  // session, as a message to a stopped session does.
  private dropCleanup(sessionId: string, windowDies = false): void {
    const c = this.cleanups.get(sessionId);
    if (c) this.clearTimer(c.compactTimer);
    // An ended one keeps its entry until its "will compact" message is there.
    this.cleanups.delete(sessionId);
    const queued = this.commands.get(sessionId) ?? [];
    for (const e of queued.filter(e => e.cmd.name === "cleanup")) this.clearTimer(e.timer);
    const left = queued.filter(e => e.cmd.name !== "cleanup");
    if (left.length) this.commands.set(sessionId, left);
    else this.commands.delete(sessionId);
    if (!c?.held.length) return;
    if (windowDies && this.connOf(sessionId)) {
      this.log.info(`/cleanup of session ${sessionId} dropped: ${c.held.length} held message(s) wait for the ending window to go`);
      this.dyingHeld.set(sessionId, c.held);
    } else {
      this.log.info(`/cleanup of session ${sessionId} dropped: ${c.held.length} held message(s) go the way of new topic messages`);
      this.releaseHeld(sessionId, c.held);
    }
  }

  private onCleanupReport(sessionId: string, id: string, before: number | undefined, error: string | undefined): void {
    const c = this.cleanups.get(sessionId);
    if (!c || c.id !== id || c.phase !== "compacting") {
      this.log.info(`/cleanup report ${id} for session ${sessionId} ignored: that /cleanup was dropped or is unknown`);
      return;
    }
    this.clearTimer(c.compactTimer);
    if (error !== undefined) {
      this.log.warn(`/cleanup of session ${sessionId}: the compact failed: ${error}`);
      this.cleanupOutcome(sessionId, c, this.m().cleanupCompactFailed({ error }), "error", "warning");
      return this.dropCleanup(sessionId);
    }
    this.log.info(`/cleanup of session ${sessionId}: compacted${before === undefined ? "" : ` from ${before} tokens`}; ending the window`);
    c.phase = "exiting";
    this.terminate(sessionId);
  }

  // The window is gone: once Claude Code has exited, the skills go from the
  // transcript.
  private async finishCleanup(sessionId: string, c: Cleanup, pid: number | undefined): Promise<void> {
    const current = () => this.running && this.cleanups.get(sessionId) === c;
    const gate = this.exitGates.get(sessionId) ?? this.gateExit(sessionId, pid);
    const outcome = await gate.settled;
    if (!current()) return;
    // A window of the session connected again: the edit would race it, and
    // what came meanwhile goes to it.
    if (this.connOf(sessionId)) {
      this.cleanups.delete(sessionId);
      this.log.warn(`/cleanup of session ${sessionId}: a window of the session connected again; the transcript untouched, ${c.held.length} held message(s) go to it`);
      this.cleanupOutcome(sessionId, c, this.m().cleanupReopened, "warning", "warning");
      return this.releaseHeld(sessionId, c.held);
    }
    if (outcome === "deadline") {
      this.cleanups.delete(sessionId);
      this.log.warn(`/cleanup of session ${sessionId}: Claude Code ${pid} did not exit; the transcript untouched, ${c.held.length} held message(s) go the way of new topic messages`);
      this.cleanupOutcome(sessionId, c, this.m().cleanupNoExit, "error", "warning");
      return this.releaseHeld(sessionId, c.held);
    }
    const path = this.transcriptOf(sessionId);
    let text: string;
    let kind: MessageKind = "info";
    let outcomeKind: "success" | "warning" = "success";
    if (!path) {
      this.log.warn(`/cleanup of session ${sessionId}: no transcript found`);
      kind = "warning";
      outcomeKind = "warning";
      text = this.m().cleanupNoTranscript;
    } else {
      try {
        const result = await (this.opts.cleanTranscript ?? cleanTranscript)(path, Date.now());
        this.log.info(`/cleanup of session ${sessionId}: ${path}: ${result.kind}${result.kind === "cleaned" ? `, ${result.records} record(s), backup ${result.backup}` : ""}`);
        if (result.kind === "format") kind = "warning";
        text = cleanupSummary(result, this.m());
        outcomeKind = result.kind === "format" ? "warning" : "success";
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        this.log.warn(`/cleanup of session ${sessionId}: emptying the skills in ${path} failed: ${why}`);
        kind = "error";
        outcomeKind = "warning";
        text = this.m().cleanupFailed({ why: e instanceof CleanupError ? e.render(this.m()) : why });
      }
    }
    if (!current()) return;
    this.cleanups.delete(sessionId);
    // A window came back during the edit: it is not started a second time.
    if (this.connOf(sessionId)) {
      this.log.warn(`/cleanup of session ${sessionId}: a window of the session connected during the edit; not starting it, ${c.held.length} held message(s) go to it`);
      this.cleanupOutcome(sessionId, c, text, kind, outcomeKind);
      return this.releaseHeld(sessionId, c.held);
    }
    // Messages that came meanwhile still reach the agent, as a message to a
    // stopped session starts it.
    const relaunch = c.held.length > 0;
    this.cleanupOutcome(sessionId, c, text, kind, outcomeKind);
    if (relaunch) this.releaseHeld(sessionId, c.held);
    else {
      this.notice(sessionId, this.m().sessionEnded, "info");
      this.log.info(`/cleanup of session ${sessionId}: done; the session stays ended`);
    }
  }

  // The transcript the hook named, else the one found by the session id.
  private transcriptOf(sessionId: string): string | undefined {
    const known = this.store.get(sessionId)?.transcript;
    if (known && existsSync(known)) return known;
    return this.opts.projectsDir ? sessionTranscript(sessionId, this.opts.projectsDir) : undefined;
  }

  // Runs the configured command for a session without a window: the account
  // given, else the one it ran on last; with neither it does not start. The
  // messages wait until the session connects; one start at a time. announce:
  // false leaves out the start notice; a failure is told all the same.
  private launch(sessionId: string, account: string | undefined, held: Held[], announce = true, mode?: PermissionMode): void {
    const saved = this.retained.get(sessionId) ?? [];
    this.retained.delete(sessionId);
    for (const h of held) this.keepInOrder(saved, h);
    held = saved;
    const existing = this.launches.get(sessionId) ?? this.gatedLaunches.get(sessionId);
    if (existing) {
      for (const h of held) this.keepInOrder(existing.held, h);
      return;
    }
    const gate = this.exitGates.get(sessionId);
    if (gate) {
      if (gate.expired && mode) {
        mode = undefined;
        if (!held.length) return this.notice(sessionId, this.m().modeChangeCancelled, "info");
      }
      this.gatedLaunches.set(sessionId, { account, held, announce, mode });
      return;
    }
    const cfg = this.opts.config();
    const rec = this.store.get(sessionId);
    if (!rec) return this.retainHeld(sessionId, held);
    // A window of the session is open: a second Claude Code on the same
    // transcript would break it.
    if (this.connOf(sessionId)) {
      this.log.warn(`session ${sessionId} has a window; not starting it, ${held.length} held message(s) go to it`);
      if (held.length) this.replay(sessionId, held);
      return;
    }
    if (!cfg.launch) {
      this.retainHeld(sessionId, held);
      return this.notice(sessionId, this.m().autolaunchNotConfigured({ launchError: cfg.launchError }), "warning");
    }
    const location = this.launchLocation(sessionId, account);
    if ("error" in location) {
      this.retainHeld(sessionId, held);
      return this.notice(sessionId, location.error === "account" ? this.m().accountUnknown : this.m().directoryUnknown, "warning");
    }
    const { account: acc, cwd } = location;
    let command: string[];
    let modeOffset: number | undefined;
    let spawned: void | Promise<void>;
    try {
      command = launchCommand(cfg.launch, { cwd, account: acc, session: sessionId, ...(mode ? { mode } : {}) }, this.opts.platform ?? PLATFORM);
      const transcript = mode ? this.transcriptOf(sessionId) : undefined;
      if (transcript) modeOffset = statSync(transcript).size;
      this.log.info(`starting session ${sessionId} on account ${acc}: ${JSON.stringify(command)}`);
      spawned = this.opts.spawn ? this.opts.spawn(command) : spawnDetached(command, {
        graceMs: LAUNCH_EXIT_GRACE_MS,
        setTimer: (fn, ms) => this.setTimer(fn, ms),
        clearTimer: timer => this.clearTimer(timer),
      });
    } catch (e) {
      const failure = e instanceof LaunchError ? e.message : catalogOf("en").launchCommandFailed({ error: e instanceof Error ? e.message : String(e) });
      this.log.warn(`starting session ${sessionId} failed: ${failure}`);
      this.retainHeld(sessionId, held);
      const why = e instanceof LaunchError ? e.render(this.m()) : this.m().launchCommandFailed({ error: e instanceof Error ? e.message : String(e) });
      return this.notice(sessionId, this.m().cannotLaunch({ why }), "error");
    }
    const sec = cfg.launch.timeoutSec;
    const timer = this.setTimer(() => {
      const l = this.launches.get(sessionId);
      this.launches.delete(sessionId);
      this.log.warn(`session ${sessionId} did not connect in ${sec} s; ${l?.held.length ?? 0} held item(s) retained`);
      this.retainHeld(sessionId, l?.held ?? []);
      this.launchEnded(sessionId, "failed");
      const tmuxHint = isTmuxCommand(command) ? tmuxAttachHint(command, this.m()) : undefined;
      this.notice(sessionId, this.m().sessionDidNotStart({ seconds: sec, tmuxHint }), "error");
    }, sec * MS_PER_SECOND);
    this.launches.set(sessionId, { account: acc, held, timer, mode });
    this.launchEnds.delete(sessionId);
    const started = () => {
      this.store.setLaunchedMode(sessionId, mode, modeOffset);
      if (announce) this.launchNotice(sessionId, this.m().launching({ account: acc || undefined }));
    };
    if (spawned) void spawned.then(started, e => {
      const l = this.launches.get(sessionId);
      if (!l || l.timer !== timer) return;
      this.clearTimer(timer);
      this.launches.delete(sessionId);
      this.retainHeld(sessionId, l.held);
      this.launchEnded(sessionId, "failed");
      this.notice(sessionId, launchFailure(e, this.m()), "error");
    });
    else started();
  }

  // A window of the session connected: a start it waited for is done, and
  // the held messages go once Claude Code is ready for them. A window that
  // does not name its account runs on the one it was started on.
  // Command results the agent has not got go after the held messages, so one
  // held for this start is not sent twice.
  private launched(ws: WS, sessionId: string): void {
    const l = this.launches.get(sessionId);
    if (!l) {
      const saved = this.retained.get(sessionId);
      if (saved) {
        this.retained.delete(sessionId);
        this.replay(sessionId, saved, () => this.execs?.connected(sessionId));
        return;
      }
      if (this.execs) this.whenReady(() => this.execs?.connected(sessionId));
      return;
    }
    this.clearTimer(l.timer);
    this.launches.delete(sessionId);
    if (l.cancelled) {
      this.dyingHeld.set(sessionId, l.held);
      this.terminate(sessionId);
      return;
    }
    ws.data.launchedMode = l.mode;
    if (l.mode && this.store.get(sessionId)?.launchedModeOffset === undefined && ws.data.attachedOffset !== undefined) {
      this.store.setLaunchedMode(sessionId, l.mode, ws.data.attachedOffset);
    }
    if (!ws.data.account) {
      ws.data.account = l.account;
      this.store.setWhere(sessionId, undefined, l.account);
    }
    this.log.info(`session ${sessionId} started, ${l.held.length} held message(s) to deliver`);
    this.launchEnded(sessionId, "started");
    if (!l.held.length && !this.execs) return;
    this.replay(sessionId, l.held, () => this.execs?.connected(sessionId));
  }

  // Hands held messages and command results to the session's window, in the
  // order they came. Consecutive messages go as one batch at once, cut where
  // a command, a command result or a "!" message comes. A batch waiting in the
  // window meanwhile joins them in the order of arrival, so neither the held
  // messages nor the newer ones jump the queue.
  private async sendHeld(sessionId: string, kept: Held[], wanted: () => boolean): Promise<void> {
    const held = [...kept];
    const waiting = this.batches.get(sessionId);
    if (waiting) {
      this.batches.delete(sessionId);
      this.clearTimer(waiting.quietTimer);
      this.clearTimer(waiting.maxTimer);
      for (const m of waiting.messages) this.keepInOrder(held, { message: m });
    }
    let run: Message[] = [];
    const flush = async () => {
      if (!run.length) return;
      const messages = run;
      run = [];
      await this.queueBatch(sessionId, this.requireApi(), messages);
    };
    for (const h of held) {
      try {
        if (!wanted()) return;
        if (this.hold(sessionId, h)) continue;
        if (!this.connOf(sessionId)) { this.releaseHeld(sessionId, [h]); continue; }
        if (!("message" in h)) {
          await flush();
          if (!wanted()) return;
          this.deliverInbound(sessionId, h.inbound);
          continue;
        }
        const m = h.message;
        const hubCmd = m.text !== undefined ? hubCommandOf(m.text, this.botUsername) : undefined;
        if (hubCmd) {
          await flush();
          if (!wanted()) return;
          if (this.hold(sessionId, h)) continue;
          if (this.connOf(sessionId)) this.onHubCommand(sessionId, hubCmd, m);
          else this.log.warn(`session ${sessionId} has no window, message ${m.message_id} not delivered`);
          continue;
        }
        const cmd = m.text !== undefined ? commandOf(m.text, this.botUsername) : undefined;
        if (cmd) {
          await flush();
          if (!wanted()) return;
          if (this.hold(sessionId, h)) continue;
          if (this.connOf(sessionId)) this.queueCommand(sessionId, cmd);
          else this.log.warn(`session ${sessionId} has no window, message ${m.message_id} not delivered`);
          continue;
        }
        if (isInterrupt(m)) {
          await flush();
          if (!wanted()) return;
        }
        run.push(m);
      } catch (e) {
        this.log.error(`delivering held ${"message" in h ? `message ${h.message.message_id}` : "command result"} to session ${sessionId} failed: ${e}`);
      }
    }
    try {
      await flush();
    } catch (e) {
      this.log.error(`delivering held messages to session ${sessionId} failed: ${e}`);
    }
  }

  // Hands held messages to a window once Claude Code is ready. Topic messages
  // that come meanwhile join them in arrival order, so none jumps
  // ahead of an older held one; the window gets the next round if any came.
  private replay(sessionId: string, held: Held[], after?: () => void): void {
    for (const h of held) this.deliveryOrder("message" in h ? h.message : h.inbound);
    const open = this.replays.get(sessionId);
    if (open) {
      for (const h of held) this.keepInOrder(open.held, h);
      if (after) open.after.push(after);
      return;
    }
    const entry: Replay = { held: [...held], inFlight: [], after: after ? [after] : [] };
    this.replays.set(sessionId, entry);
    this.whenReady(async () => {
      if (this.replays.get(sessionId) !== entry) return;
      while (entry.held.length && this.replays.get(sessionId) === entry) {
        entry.inFlight = entry.held.splice(0);
        await this.sendHeld(sessionId, entry.inFlight, () => this.replays.get(sessionId) === entry);
        entry.inFlight = [];
      }
      if (this.replays.get(sessionId) !== entry) return;
      this.replays.delete(sessionId);
      for (const fn of entry.after) fn();
    });
  }

  // What a /cleanup held leaves it as a new topic message would at this
  // moment: into the open window, else into a start under way, else it starts
  // the session, else the user is told the session is not active.
  private releaseHeld(sessionId: string, held: Held[]): void {
    if (!held.length) {
      if (this.connOf(sessionId) && this.execs) this.whenReady(() => this.execs?.connected(sessionId));
      return;
    }
    const rest = held.filter(h => !this.hold(sessionId, h));
    if (!rest.length) return;
    if (this.connOf(sessionId)) return this.replay(sessionId, rest, () => this.execs?.connected(sessionId));
    if (this.opts.config().launch) return this.launch(sessionId, undefined, rest);
    this.retainHeld(sessionId, rest);
  }

  // Runs once Claude Code is ready for channel messages.
  private whenReady(fn: () => void | Promise<void>): void {
    const t = this.setTimer(() => {
      this.readyTimers.delete(t);
      void fn();
    }, this.opts.readyDelayMs ?? READY_DELAY_MS);
    this.readyTimers.add(t);
  }

  // --- topic commands -------------------------------------------------------

  // One refresh runs at a time; requests that arrive meanwhile share one more run behind it,
  // so the final state is always read after the last request.
  private refreshFeatures(): Promise<void> {
    if (this.featureRefresh) {
      this.featureRefreshAgain = true;
      return this.featureRefresh;
    }
    this.machineQueries++;
    this.featureRefresh = (async () => {
      try {
        do {
          this.featureRefreshAgain = false;
          await this.rig.refresh();
          if (this.botReady && this.opts.api) await this.registerCommands(this.opts.api);
        } while (this.featureRefreshAgain && this.running);
      } finally {
        this.featureRefresh = undefined;
        this.endMachineQuery();
      }
    })();
    return this.featureRefresh;
  }

  private runMachineCommand(command: MachineCommand, message: Message, destination: MachineDestination): void {
    const task: Promise<void> = this.onMachineCommand(command, message, destination)
      .catch(error => this.log.error(`machine command failed: ${String(error)}`))
      .finally(() => { this.machineTasks.delete(task); });
    this.machineTasks.add(task);
  }

  // A finished query that kept the hub alive lets the idle timer start again.
  private endMachineQuery(): void {
    this.machineQueries--;
    this.armIdle();
  }

  // A question or permission request counts only while its window is open: after it closes nobody can answer.
  private rigIdle(): boolean {
    return ![...this.conns].some(ws => ws.data.busy)
      && ![...this.permissions.values()].some(permission => !permission.settled && this.connOf(permission.sessionId))
      && ![...this.polls.values()].some(poll => this.connOf(poll.sessionId))
      && !this.catchUps.size && !this.questionSends.size
      && ![...this.commands.values()].some(queued => queued.length)
      && !(this.execs?.running() ?? 0) && !this.machineQueries && !this.machineTasks.size && !this.updatesInFlight
      && !this.launches.size && !this.modeRestarts.size && !this.exitGates.size && !this.gatedLaunches.size
      && !this.cleanups.size && !this.stops.size && !this.stopping.size && !this.readyTimers.size
      && ![...this.retained.values(), ...this.dyingHeld.values(), ...this.heldResults.values()].some(items => items.length)
      && !this.replays.size && !this.batches.size && !this.batchSends.size && !this.answerGroups.size
      && this.deliverable() === 0 && !this.pumping.size && ![...this.cards.values()].some(card => card.editing)
      && !this.machineOutbox.size && !this.machineOutbox.busy && !this.rigEvents?.busy
      && ![...this.disableConfirmations.values()].some(item => item.recovery !== undefined);
  }

  private async rigStage(name: string, run: () => Promise<void>): Promise<void> {
    try { await run(); } catch (error) { this.log.warn(`rig ${name}: ${String(error)}`); }
  }

  private async rigTick(): Promise<void> {
    if (!this.running || this.rigTickRunning) return;
    this.rigTickRunning = true;
    try {
      // Events come first and each stage has its own guard: a failing Telegram call must not hold back
      // a service event, and a failing event must not hold back the queue.
      await this.rigStage("events", async () => { await this.rigEvents?.poll(); });
      await this.rigStage("queue", async () => {
        const api = this.opts.api;
        for (const [key, confirmation] of this.disableConfirmations) this.queueRigConfirmation(key, confirmation);
        if (api && this.botReady) {
          await this.registerCommands(api);
          await this.machineOutbox.flush(api);
        }
        if (!this.running) return;
        for (const [key, confirmation] of this.disableConfirmations) {
          if (!confirmation.recovery || !this.machineOutbox.delivered(confirmation.recovery)) continue;
          this.launchRig(["feature", "telegram", "disable"], confirmation.message, confirmation.destination);
          this.disableConfirmations.delete(key);
          this.machineOutbox.deleteConfirmation(key);
        }
      });
      if (this.running) await this.rigStage("lifecycle", async () => { this.rigLifecycle?.check(); });
      if (this.running) this.maybeExit();
    } catch (error) { this.log.warn(`rig tick: ${String(error)}`); }
    finally {
      this.rigTickRunning = false;
      if (this.running) this.rigTimer = this.setTimer(() => { void this.rigTick(); }, RIG_POLL_MS);
    }
  }

  private async onMachineCommand(command: MachineCommand, message: Message, destination: MachineDestination): Promise<void> {
    const id = `machine-${destination.chatId}-${message.message_id}`;
    const answer = (text: string, error = false) => this.machineOutbox.post(id, destination, text, !error);
    const action = rigAction(command, this.m());
    if (!action.ok) answer(action.error, true);
    else if (action.value.kind === "features" || action.value.kind === "status") {
      this.machineQueries++;
      try {
        if (action.value.kind === "features") {
          const result = await this.rig.refresh();
          answer(result.ok ? featureText(result.value, this.m()) : rigErrorText(result.error, this.m()), !result.ok);
          if (this.opts.api) await this.registerCommands(this.opts.api);
        } else {
          const result = await this.rig.status();
          answer(result.ok ? statusText(result.value, this.m()) : rigErrorText(result.error, this.m()), !result.ok);
        }
      } finally { this.endMachineQuery(); }
    } else if (this.machineOutbox.handled(id)) return;
    else if (!this.rig.invocation(action.value.args).ok) answer(this.rigInvocationError(action.value.args), true);
    else if (action.value.confirm) {
      // Duplicate updates do not create another active button for the same command.
      if (![...this.disableConfirmations.values()].some(item => item.message.message_id === message.message_id && item.destination.chatId === destination.chatId)) {
        const key = randomUUID();
        const confirmation = { message: { message_id: message.message_id }, destination, sentAt: message.date * MS_PER_SECOND };
        this.disableConfirmations.set(key, confirmation);
        this.machineOutbox.saveConfirmation(key, confirmation);
        this.queueRigConfirmation(key, confirmation);
      }
    } else this.launchRig(action.value.args, message, destination, message.date * MS_PER_SECOND);
    if (this.opts.api) await this.machineOutbox.flush(this.opts.api);
  }

  private rigInvocationError(args: string[]): string {
    const invocation = this.rig.invocation(args);
    return invocation.ok ? this.m().rigMissing : rigErrorText(invocation.error, this.m());
  }

  // `sentAt` (ms) is set for a command run straight from the user's message; a confirmed one was age-checked at the press.
  private launchRig(args: string[], message: Pick<Message, "message_id">, destination: MachineDestination, sentAt?: number): void {
    const id = `machine-${destination.chatId}-${message.message_id}`;
    if (this.machineOutbox.handled(id)) return;
    const invocation = this.rig.invocation(args);
    if (!invocation.ok || !this.execs) {
      this.machineOutbox.post(`rig-error-${destination.chatId}-${message.message_id}`, destination, invocation.ok ? this.m().execNotSet : rigErrorText(invocation.error, this.m()), false);
      return;
    }
    this.execs.machine(invocation.value, `rig ${args.join(" ")}`, this.opts.repository ?? join(import.meta.dir, "..", "..", ".."), destination, message.message_id, sentAt);
    this.machineOutbox.markHandled(id);
  }

  private queueRigConfirmation(key: string, confirmation: RigConfirmation): void {
    if (confirmation.recovery) this.machineOutbox.post(confirmation.recovery, confirmation.destination, this.m().rigRecovery);
    else this.machineOutbox.post(confirmationPromptId(confirmation), confirmation.destination,
      this.m().rigDisableAsk, false, [[{ text: this.m().rigDisableButton, data: `rig-disable:${key}` }]]);
  }

  private async onRigDisablePress(api: TelegramApi, press: { id: string; data: string; messageId: number; fromId: string }): Promise<void> {
    const key = press.data.slice("rig-disable:".length);
    const confirmation = this.disableConfirmations.get(key);
    if (!confirmation || confirmation.recovery) {
      await api.answerCallbackQuery(press.id, this.m().rigConfirmHandled);
      return;
    }
    // Same age limit as /bash: an old button must not switch Telegram off. A confirmation without a time is from an older hub.
    const now = this.opts.now ?? Date.now;
    if (confirmation.sentAt === undefined || now() - confirmation.sentAt > (this.opts.execMaxAgeMs ?? EXEC_MAX_AGE_MS)) {
      this.disableConfirmations.delete(key);
      this.machineOutbox.deleteConfirmation(key);
      await api.answerCallbackQuery(press.id, this.m().rigConfirmOutdated).catch(error => this.log.warn(`rig confirmation: ${String(error)}`));
      return;
    }
    const recovery = `rig-recovery-${key}`;
    confirmation.recovery = recovery;
    this.machineOutbox.saveConfirmation(key, confirmation);
    this.queueRigConfirmation(key, confirmation);
    await api.answerCallbackQuery(press.id, this.m().rigConfirmed).catch(error => this.log.warn(`rig confirmation: ${String(error)}`));
    await this.machineOutbox.flush(api);
    // Starting rig is deferred until the recovery message is accepted by Telegram.
    if (this.machineOutbox.delivered(recovery)) {
      this.launchRig(["feature", "telegram", "disable"], confirmation.message, confirmation.destination);
      this.disableConfirmations.delete(key);
      this.machineOutbox.deleteConfirmation(key);
    }
  }

  private bashPath(): string {
    return this.opts.config().exec?.bash ?? (this.opts.platform ?? PLATFORM).bash;
  }

  private hasAccounts(): boolean {
    return this.opts.accountsAvailable?.() ?? (Bun.which((this.opts.platform ?? PLATFORM).cswapName) !== null);
  }

  // /pwsh, /cmd or /bash: the text runs in the session's folder, with or
  // without its window.
  private onExecCommand(sessionId: string, name: "pwsh" | "cmd" | "bash", text: string, m: Message): void {
    const platform = this.opts.platform ?? PLATFORM;
    if (name !== "bash" && !platform.windows) return this.notice(sessionId, this.m().commandUnavailable({ name }), "warning");
    if (name !== "bash") {
      const why = this.rig.unavailable(name);
      if (why) return this.notice(sessionId, why, "warning");
    }
    if (!this.execs) return this.notice(sessionId, this.m().execNotSet, "error");
    if (!text) return this.enqueue(sessionId, `hub-${randomUUID()}`, this.m().execUsage({ name }), notifies("info"));
    // cmd /c runs only up to the first line break.
    if (name === "cmd" && /[\r\n]/.test(text)) return this.notice(sessionId, this.m().execCmdOneLine, "error");
    const bash = this.bashPath();
    if (name === "bash" && !Bun.which(bash)) return this.notice(sessionId, this.m().execShellNotFound({ shell: platform.bashName, path: bash }), "error");
    const rec = this.store.get(sessionId);
    const cwd = rec?.cwd ?? (this.opts.projectsDir ? sessionCwd(sessionId, this.opts.projectsDir) : undefined);
    if (!cwd) return this.notice(sessionId, this.m().execNoCwd, "warning");
    const shell: ExecShell = name === "pwsh" ? "powershell" : name;
    this.log.info(`/${name} for session ${sessionId}, message ${m.message_id}`);
    this.execs.command(sessionId, shell, text, cwd, { chatId: String(m.chat.id), messageId: m.message_id, date: m.date });
  }

  private async onExecPress(api: TelegramApi, press: { id: string; data: string; fromId: string }): Promise<void> {
    const m = press.data.match(/^x:(\w+):(stop|run)$/);
    const action = m?.[2] === "stop" || m?.[2] === "run" ? m[2] : undefined;
    const answer = !m?.[1] || !action ? this.m().execNotFound : this.execs ? this.execs.press(m[1], action) : this.m().execNotSet;
    if (m?.[1] && action) this.log.info(`exec ${m[1]}: ${action} pressed by ${press.fromId}: ${answer}`);
    await api.answerCallbackQuery(press.id, answer).catch(e => this.log.warn(`answering a button press failed: ${e}`));
  }

  private async onModePress(api: TelegramApi, press: { id: string; data: string; messageId: number; fromId: string }): Promise<void> {
    const match = /^m:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(manual|auto|acceptEdits|plan|dontAsk)$/i.exec(press.data);
    const sessionId = match?.[1];
    const mode = match?.[2] ? PERMISSION_MODES.find(value => value.toLowerCase() === match[2]?.toLowerCase()) : undefined;
    const cfg = this.opts.config();
    if (!sessionId || !mode || !this.store.get(sessionId)) {
      this.log.info(`malformed or stale mode button pressed by ${press.fromId}`);
      await api.answerCallbackQuery(press.id).catch(e => this.log.warn(`answering a mode button failed: ${e}`));
      return;
    }
    const wasStarting = this.isStarting(sessionId);
    this.onModeCommand(sessionId, mode);
    if (!wasStarting && this.isStarting(sessionId) && cfg.groupId) void api.removeKeyboard(cfg.groupId, press.messageId).catch(e => this.log.warn(`removing mode buttons failed: ${e}`));
    await api.answerCallbackQuery(press.id).catch(e => this.log.warn(`answering a mode button failed: ${e}`));
  }

  // A command's result reaches the agent as a topic message would: at once
  // with a window, after the start with a session starting or startable.
  private reportExec(sessionId: string, inbound: Inbound): void {
    this.deliveryOrder(inbound);
    const replay = this.replays.get(sessionId);
    if (this.hold(sessionId, { inbound })) {
      // The ending or starting window must not receive this result yet.
    } else if (replay) {
      this.keepInOrder(replay.held, { inbound });
    } else if (this.connOf(sessionId)) {
      // A /cleanup under way holds it like a topic message: a turn it starts
      // would be cut by the kill.
      if (!this.keepForCleanup(sessionId, { inbound })) this.deliverInbound(sessionId, inbound);
    } else if (this.opts.config().launch) this.launch(sessionId, undefined, [{ inbound }]);
    else {
      this.notice(sessionId, this.m().resultNotDelivered, "warning");
      this.retainHeld(sessionId, [{ inbound }]);
    }
    // The last command ended: the hub may go idle again.
    if (!this.execs?.running()) this.armIdle();
  }

  private deliverInbound(sessionId: string, inbound: Inbound): void {
    if (this.hold(sessionId, { inbound })) return;
    const ws = this.connOf(sessionId);
    if (!ws) {
      this.releaseHeld(sessionId, [{ inbound }]);
      return;
    }
    this.setEnabled(sessionId, true);
    this.send(ws, { type: "inbound", content: inbound.content, meta: inbound.meta });
    this.deliveredItems.add(inbound);
    inbound.onSent();
    this.log.info(`command result ${inbound.meta.exec_id ?? "?"} → session ${sessionId}`);
  }

  private isStarting(sessionId: string): boolean {
    return this.launches.has(sessionId) || this.modeRestarts.has(sessionId) || this.gatedLaunches.has(sessionId);
  }

  private setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    if (this.opts.setTimer) return this.opts.setTimer(fn, ms);
    return setTimeout(fn, ms);
  }

  private clearTimer(timer: ReturnType<typeof setTimeout> | undefined): void {
    if (timer === undefined) return;
    if (this.opts.clearTimer) this.opts.clearTimer(timer);
    else clearTimeout(timer);
  }

  private retainHeld(sessionId: string, held: Held[]): void {
    const saved = this.retained.get(sessionId) ?? [];
    for (const h of held) this.keepInOrder(saved, h);
    if (!saved.length) return;
    this.retained.set(sessionId, saved);
    this.notice(sessionId, this.m().pendingDelivery({ count: saved.length }), "warning");
  }

  private capturePending(sessionId: string): void {
    for (const p of this.polls.values()) if (p.sessionId === sessionId) {
      void this.finishPoll(p, { decision: "none" }, this.m().pollMovedToTerminal);
      void this.takeAnswer(p.key);
    }
    for (const entry of this.batchItems.get(sessionId) ?? []) {
      entry.captured = true;
      for (const message of entry.messages) this.hold(sessionId, { message });
    }
    const batch = this.batches.get(sessionId);
    if (batch) {
      this.batches.delete(sessionId);
      this.clearTimer(batch.quietTimer);
      this.clearTimer(batch.maxTimer);
      for (const message of batch.messages) this.hold(sessionId, { message });
    }
    const replay = this.replays.get(sessionId);
    if (replay) {
      this.replays.delete(sessionId);
      for (const h of replay.inFlight) this.hold(sessionId, h);
      for (const h of replay.held.splice(0)) this.hold(sessionId, h);
    }
  }

  private rerouteBatch(sessionId: string, ws: WS, messages: Message[]): boolean {
    if (this.connOf(sessionId) === ws && !messages.some(message => this.hold(sessionId, { message }))) return false;
    this.releaseHeld(sessionId, messages.map(message => ({ message })));
    return true;
  }

  private gateExit(sessionId: string, pid: number | undefined): ExitGate {
    const existing = this.exitGates.get(sessionId);
    if (existing) return existing;
    if (pid === undefined) this.log.info(`session ${sessionId}: the Claude Code process is unknown; waiting for it to go`);
    const gate = exitGate(pid, {
      now: this.opts.now ?? Date.now,
      sleep: ms => this.sleep(ms),
      isAlive: this.opts.isAlive ?? isAlive,
      pollMs: this.opts.exitPollMs ?? EXIT_POLL_MS,
      deadlineMs: this.opts.cleanupExitMs ?? CLEANUP_EXIT_MS,
      settleMs: this.opts.cleanupSettleMs ?? CLEANUP_SETTLE_MS,
    });
    this.exitGates.set(sessionId, gate);
    void gate.settled.then(outcome => {
      const pending = this.gatedLaunches.get(sessionId);
      if (outcome === "deadline" && pending?.mode) {
        pending.mode = undefined;
        if (!pending.held.length) this.gatedLaunches.delete(sessionId);
        this.notice(sessionId, this.m().modeNotChangedExit, "warning");
      } else if (outcome === "deadline" && !this.cleanups.has(sessionId)) {
        this.notice(sessionId, this.m().launchWaitsForExit, "warning");
      }
    });
    void gate.done.then(outcome => {
      if (this.exitGates.get(sessionId) !== gate) return;
      this.exitGates.delete(sessionId);
      if (!this.running || outcome === "cancelled") return;
      const pending = this.gatedLaunches.get(sessionId);
      this.gatedLaunches.delete(sessionId);
      if (!pending) return;
      if (outcome === "reconnected") {
        if (pending.mode) this.notice(sessionId, this.m().modeNotChangedReopened, "warning");
        this.releaseHeld(sessionId, pending.held);
      } else this.launch(sessionId, pending.account, pending.held, pending.announce, pending.mode);
    });
    return gate;
  }

  // The hub's own copy goes, as for files from a window.
  private sendExecFile(sessionId: string, path: string, name: string, kind: MessageKind): void {
    const id = randomUUID();
    const copy = join(this.opts.filesDir, id, name);
    mkdirSync(dirname(copy), { recursive: true });
    copyFileSync(path, copy);
    const file: OutFile = { path: copy, name, size: statSync(copy).size, kind: "document" };
    if (this.outbox.add(`exec-${id}`, sessionId, [filesPiece([file], undefined, notifies(kind))])) void this.pump(sessionId);
  }

  // A window on the default login does not name its account in its config
  // dir; cswap tells which account that login is.
  private askDefaultAccount(ws: WS, configDir: string | undefined): void {
    if (!this.hasAccounts() || !configDir || !isDefaultConfigDir(configDir, this.opts.defaultConfigDir ?? DEFAULT_CONFIG_DIR, this.opts.platform ?? PLATFORM)) return;
    void (this.opts.defaultAccount ?? defaultLoginAccount)().then(account => {
      const sid = ws.data.sessionId;
      if (!account || !sid) return this.log.warn(`window ${ws.data.windowKey}: the account of the default login is unknown`);
      this.log.info(`window ${ws.data.windowKey} runs on the default login, account ${account}`);
      ws.data.account = account;
      this.store.setWhere(sid, undefined, account);
    });
  }

  // The hub's own word in a session's topic, in order with the rest.
  private notice(sessionId: string, text: string, kind: MessageKind): void {
    this.enqueue(sessionId, `hub-${randomUUID()}`, text, notifies(kind), false);
  }

  // A silent notice needed only until the session's agent starts working.
  private launchNotice(sessionId: string, text: string): void {
    this.enqueue(sessionId, `${LAUNCH_NOTICE}${randomUUID()}`, text, notifies("info"), false);
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
      if (end === "started") this.outbox.setText(item.id, this.m().sessionLaunched);
      else this.outbox.remove(item.id);
    }
    if (end === "failed") return this.dropLaunchNotices(sessionId);
    for (const notice of this.launchNotices.get(sessionId) ?? []) this.editLaunchNotice(notice);
  }

  private editLaunchNotice(notice: { id: number; text: string }): void {
    const api = this.opts.api;
    const groupId = this.opts.config().groupId;
    const launched = this.m().sessionLaunched;
    if (notice.text === launched || !api || !groupId) return;
    notice.text = launched;
    api.editMessageText(groupId, notice.id, launched).catch(e => this.log.warn(`editing start notice ${notice.id} failed: ${e}`));
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
    const meta = baseMeta(m);
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
    return { content: withContext(m, content ?? "", this.botId), meta };
  }

  // Puts a held message before the held ones that came after it: a batch
  // rerouted when its window closed is older than what was held meanwhile.
  // Arrival order also covers results and attachment preparation in flight.
  private keepInOrder(held: Held[], h: Held): void {
    if (held.some(x => "message" in h ? "message" in x && x.message === h.message : "inbound" in x && x.inbound === h.inbound)) return;
    const order = this.deliveryOrder("message" in h ? h.message : h.inbound);
    const at = held.findIndex(x => this.deliveryOrder("message" in x ? x.message : x.inbound) > order);
    if (at < 0) held.push(h);
    else held.splice(at, 0, h);
  }

  private deliveryOrder(item: object): number {
    const existing = this.deliveryOrders.get(item);
    if (existing !== undefined) return existing;
    const order = this.nextDeliveryOrder++;
    this.deliveryOrders.set(item, order);
    return order;
  }
}

const TMUX_DUPLICATE_SESSION = /duplicate session: (\S+)/;

// What the topic is told when the launch command failed. A tmux session of the
// same name means an earlier launch is alive, usually at a dialog: it is not
// launched again.
function launchFailure(e: unknown, m: Messages): string {
  if (e instanceof LaunchExitError) {
    const name = TMUX_DUPLICATE_SESSION.exec(e.stderr)?.[1];
    if (name) return m.tmuxSessionAlive({ name });
  }
  return m.cannotLaunch({ why: e instanceof LaunchError ? e.render(m) : e instanceof Error ? e.message : String(e) });
}

// The /cleanup summary in the topic: what came of the skills.
export function cleanupSummary(r: CleanupResult, m: Messages): string {
  if (r.kind === "format") return m.cleanupFormatChanged({ version: r.version });
  if (r.kind === "nothing" || !r.skills.length) return m.cleanupDone;
  return m.cleanupDoneSkills({ skills: r.skills.map(s => s.name).join(", ") });
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
  const types = [...new Set((m.entities ?? m.caption_entities ?? []).map(e => e.type))];
  return `${kindOfMessage(m)}, ${content.length} chars${types.length ? `, entities ${types.join(", ")}` : ""}`;
}

function kindOfMessage(m: Message): string {
  return (["rich_message", "photo", "document", "voice", "audio", "video", "video_note", "sticker"] as const).find(k => m[k]) ?? "text";
}

// A message that interrupts the agent: its own text starts with "!". A
// forward carries someone else's text, so it never does.
function isInterrupt(m: Message): boolean {
  return !m.forward_origin && (m.text ?? m.caption ?? "").trimStart().startsWith(INTERRUPT_PREFIX);
}

// What a topic message does to an open poll: a command works as usual and
// leaves it open, a "!" message cancels it, anything else is the answer.
function pollRole(m: Message, botUsername: string | undefined): "pass" | "cancel" | "answer" {
  if (m.text !== undefined && (commandOf(m.text, botUsername) || hubCommandOf(m.text, botUsername))) return "pass";
  return isInterrupt(m) ? "cancel" : "answer";
}

// The message as the agent gets it: the "!" is a signal for the hub only. A
// caption left empty goes, so a photo is still named.
function withoutInterrupt(m: Message): Message {
  if (m.text !== undefined) return { ...m, text: m.text.replace(INTERRUPT_MARK, "") };
  return { ...m, caption: m.caption?.replace(INTERRUPT_MARK, "") || undefined };
}

// Who sent a topic message and when; a batch carries its first message's.
function baseMeta(m: Message): ChannelMeta {
  return {
    chat_id: String(m.chat.id),
    message_id: String(m.message_id),
    user: m.from?.username ?? String(m.from?.id),
    user_id: String(m.from?.id),
    ts: new Date(m.date * MS_PER_SECOND).toISOString(),
  };
}

// Uploader-controlled names land inside the <channel> tag; strip delimiters.
function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;"]/g, "_");
}

export function projectName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
}
