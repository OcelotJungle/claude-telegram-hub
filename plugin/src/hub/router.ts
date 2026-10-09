import type { Config } from "../shared/config.ts"
import type { TopicCommand } from "../shared/protocol.ts"
import type { SessionStore } from "./sessions.ts"
import type { Message, Update } from "./telegram.ts"

export type Route =
  | { action: "ignore"; reason: string }
  | { action: "inactive"; topicId: number }
  | { action: "deliver"; sessionId: string; topicId: number }

// Only topic messages from allowed senders in the configured group reach a
// session; General, DMs, other chats and strangers are ignored.
export function routeUpdate(u: Update, cfg: Config, sessions: SessionStore, isConnected: (sessionId: string) => boolean): Route {
  const m = u.message
  if (!m) return ignore("no message")
  if (!cfg.groupId || String(m.chat.id) !== cfg.groupId) return ignore(`chat ${m.chat.id} is not the group`)
  if (!m.from || m.from.is_bot) return ignore("bot or anonymous sender")
  if (!cfg.allowFrom.includes(String(m.from.id))) return ignore(`sender ${m.from.id} not allowed`)
  if (m.is_topic_message !== true || m.message_thread_id == null) return ignore("not in a topic")
  if (!hasContent(m)) return ignore(`service message (fields: ${Object.keys(m).filter(k => !ENVELOPE.has(k)).join(", ")})`)
  const topicId = m.message_thread_id
  const sessionId = sessions.findByTopic(topicId)
  if (!sessionId) return ignore(`topic ${topicId} has no session`)
  if (!isConnected(sessionId)) return { action: "inactive", topicId }
  return { action: "deliver", sessionId, topicId }
}

// A command the plugin's function hooks module runs instead of the agent:
// `/info` or `/compact`, maybe `@<this bot>`, then arguments. Anything else,
// a command for another bot included, is a plain message.
export function commandOf(text: string, botUsername: string | undefined): Omit<TopicCommand, "id"> | undefined {
  const m = text.match(/^\/(info|compact)(?:@(\w+))?(?:\s+([\s\S]*))?$/i)
  if (!m) return undefined
  if (m[2] && botUsername && m[2].toLowerCase() !== botUsername.toLowerCase()) return undefined
  return { name: m[1]!.toLowerCase() as TopicCommand["name"], args: (m[3] ?? "").trim() }
}

// Fields every message may carry, whatever its kind.
const ENVELOPE = new Set([
  "message_id", "date", "edit_date", "chat", "from", "sender_chat", "message_thread_id", "is_topic_message",
  "reply_to_message", "external_reply", "quote", "forward_origin", "via_bot", "author_signature", "has_protected_content",
])

function ignore(reason: string): Route {
  return { action: "ignore", reason }
}

function hasContent(m: Message): boolean {
  return Boolean(m.text || m.caption || m.rich_message || m.photo || m.document || m.voice || m.audio || m.video || m.video_note || m.sticker)
}
