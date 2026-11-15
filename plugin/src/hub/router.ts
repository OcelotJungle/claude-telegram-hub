import type { Config } from "../shared/config.ts";
import type { SessionStore } from "./sessions.ts";
import type { Message, Update } from "./telegram.ts";
import type { MachineCommand } from "./rig.ts";

import { z } from "zod";
import { MILLION, THOUSAND } from "../shared/tokens.ts";

// Fields every message may carry, whatever its kind.
const ENVELOPE = new Set([
  "message_id", "date", "edit_date", "chat", "from", "sender_chat", "message_thread_id", "is_topic_message",
  "reply_to_message", "external_reply", "quote", "forward_origin", "via_bot", "author_signature", "has_protected_content",
]);
// Telegram reserves forum topic 1 for General, which may carry a thread id.
const GENERAL_TOPIC_ID = 1;

export type Route =
  | { action: "ignore"; reason: string }
  | { action: "machine"; topicId?: number }
  | { action: "inactive"; sessionId: string; topicId: number }
  | { action: "deliver"; sessionId: string; topicId: number };

// Only topic messages from allowed senders in the configured group reach a
// session; General, DMs, other chats and strangers are ignored.
export function routeUpdate(u: Update, cfg: Pick<Config, "groupId" | "allowFrom">, sessions: SessionStore, isConnected: (sessionId: string) => boolean, botUsername?: string): Route {
  const m = u.message;
  if (!m) return ignore("no message");
  if (!cfg.groupId || String(m.chat.id) !== cfg.groupId) return ignore(`chat ${m.chat.id} is not the group`);
  if (!m.from || m.from.is_bot) return ignore("bot or anonymous sender");
  if (!cfg.allowFrom.includes(String(m.from.id))) return ignore(`sender ${m.from.id} not allowed`);
  if (m.text && machineCommandOf(m.text, botUsername)) {
    const topicId = m.is_topic_message === true && m.message_thread_id !== GENERAL_TOPIC_ID ? m.message_thread_id : undefined;
    if (topicId === undefined || sessions.findByTopic(topicId)) return { action: "machine", ...(topicId === undefined ? {} : { topicId }) };
  }
  if (m.is_topic_message !== true || m.message_thread_id == null) return ignore("not in a topic");
  if (!hasContent(m)) return ignore(`service message (fields: ${Object.keys(m).filter(k => !ENVELOPE.has(k)).join(", ")})`);
  const topicId = m.message_thread_id;
  const sessionId = sessions.findByTopic(topicId);
  if (!sessionId) return ignore(`topic ${topicId} has no session`);
  if (!isConnected(sessionId)) return { action: "inactive", sessionId, topicId };
  return { action: "deliver", sessionId, topicId };
}

// What the hub uses of a button press.
const callbackSchema = z.object({
  id: z.string(),
  from: z.object({ id: z.number() }),
  data: z.string().optional(),
  message: z.object({ message_id: z.number(), chat: z.object({ id: z.number() }) }).optional(),
});

export type CallbackRoute =
  | { action: "ignore"; reason: string; id?: string }
  | { action: "press"; id: string; data: string; messageId: number; fromId: string };

// A press counts only on a message of the bot in the group, by an allowed
// sender; the same rule as for messages.
export function routeCallback(u: Update, cfg: Config): CallbackRoute | undefined {
  if (u.callback_query === undefined) return undefined;
  const parsed = callbackSchema.safeParse(u.callback_query);
  if (!parsed.success) return { action: "ignore", reason: "callback query of an unknown shape" };
  const q = parsed.data;
  if (!q.message || !cfg.groupId || String(q.message.chat.id) !== cfg.groupId) return { action: "ignore", reason: "button press outside the group", id: q.id };
  if (!cfg.allowFrom.includes(String(q.from.id))) return { action: "ignore", reason: `button press by ${q.from.id}, not allowed`, id: q.id };
  return { action: "press", id: q.id, data: q.data ?? "", messageId: q.message.message_id, fromId: String(q.from.id) };
}

// A command the hub runs itself, maybe `@<this bot>`, then arguments. Anything else,
// a command for another bot included, is a plain message. The session actions
// (`/run [account]`, `/mode [mode]`, `/stop`, `/cleanup`, `/compact`, `/rename`) are
// one `rig session` call each; `/info` renders `rig info`. `/pwsh`, `/cmd` and
// `/bash` run their text in a shell in the session's folder.
export type HubCommand = { name: "run" | "stop" | "cleanup" | "mode" | "info" | "compact" | "rename" | "pwsh" | "cmd" | "bash"; args: string };

// `/compact <N>` with a token count (333000, 333k, 1.5m) or `auto` asks for the autocompact window: the value
// (a string rig accepts: digits matching ^[1-9][0-9]*$, or "auto"), `refused` when it is a count that rounds to
// 0 or is too big to be an exact integer, or undefined when the arguments are instructions for the summary.
export type AutocompactArg = { window: string } | { refused: true };
const RIG_WINDOW = /^[1-9][0-9]*$/;

export function autocompactArg(args: string): AutocompactArg | undefined {
  const a = args.trim().toLowerCase();
  if (a === "auto") return { window: a };
  const m = a.match(/^(\d+(?:\.\d+)?)([km]?)$/);
  if (!m) return undefined;
  const window = String(Math.round(Number(m[1]) * (m[2] === "k" ? THOUSAND : m[2] === "m" ? MILLION : 1)));
  return RIG_WINDOW.test(window) ? { window } : { refused: true };
}

const HUB_COMMANDS: readonly HubCommand["name"][] = ["run", "stop", "cleanup", "mode", "info", "compact", "rename", "pwsh", "cmd", "bash"];

function isHubCommandName(name: string): name is HubCommand["name"] {
  return HUB_COMMANDS.some(n => n === name);
}

export function hubCommandOf(text: string, botUsername: string | undefined): HubCommand | undefined {
  const c = parseCommand(text, botUsername);
  return c && isHubCommandName(c.name) ? { name: c.name, args: c.args } : undefined;
}

function parseCommand(text: string, botUsername: string | undefined): { name: string; args: string } | undefined {
  const m = text.match(/^\/(\w+)(?:@(\w+))?(?:\s+([\s\S]*))?$/);
  if (!m?.[1]) return undefined;
  if (m[2] && botUsername && m[2].toLowerCase() !== botUsername.toLowerCase()) return undefined;
  return { name: m[1].toLowerCase(), args: (m[3] ?? "").trim() };
}

export function machineCommandOf(text: string, botUsername?: string): MachineCommand | undefined {
  const command = parseCommand(text, botUsername);
  return command && command.name === "rig" ? { name: command.name, args: command.args } : undefined;
}

function ignore(reason: string): Route {
  return { action: "ignore", reason };
}

function hasContent(m: Message): boolean {
  return Boolean(m.text || m.caption || m.rich_message || m.photo || m.document || m.voice || m.audio || m.video || m.video_note || m.sticker);
}
