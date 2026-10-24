// What a topic message replies to, quotes or forwards, as plain lines before
// its text for the agent, the way Telegram shows them: the reply first, then
// a blank line, then the forward mark and the text.
import type { TelegramChat, TelegramMessageOrigin, TelegramUser } from "@gramio/types";
import type { Message } from "./telegram.ts";

import { richToMarkdown } from "./rich.ts";

// Longest original text shown for a reply without a quote.
export const MAX_REPLY_CHARS = 300;

// The media fields a message and an external reply share.
type Media = Pick<Message, "photo" | "document" | "voice" | "audio" | "video" | "video_note" | "sticker">;

// botId is this bot's own user id: only its messages are "your message".
export function withContext(m: Message, content: string, botId: number | undefined): string {
  const forward = m.forward_origin ? `${forwardMark(m.forward_origin)}\n` : "";
  const reply = replyBlock(m, botId);
  const body = `${forward}${content}`;
  // A lone "!" leaves no text: then the reply is all there is.
  if (!reply) return body;
  return body ? `${reply}\n\n${body}` : reply;
}

function forwardMark(o: TelegramMessageOrigin): string {
  const name = originName(o);
  return name ? `[forwarded from ${name}]` : "[forwarded]";
}

// Origin types newer than this code give no name.
function originName(o: TelegramMessageOrigin): string | undefined {
  switch (o.type) {
    case "user":
      return userName(o.sender_user);
    case "hidden_user":
      return o.sender_user_name;
    case "chat":
      return signed(chatName(o.sender_chat), o.author_signature);
    case "channel":
      return signed(chatName(o.chat), o.author_signature);
    default:
      return undefined;
  }
}

function replyBlock(m: Message, botId: number | undefined): string | undefined {
  if (m.external_reply) {
    const name = originName(m.external_reply.origin);
    const head = name ? `[reply to a message from another chat: ${name}]` : "[reply to a message from another chat]";
    const body = m.quote?.text ?? mediaMark(m.external_reply);
    return body ? `${head}\n${quoted(body)}` : head;
  }
  const r = m.reply_to_message;
  // Every message in a topic replies to the topic's service message.
  if (!r || r.forum_topic_created || r.message_id === m.message_thread_id) return undefined;
  const label = authorLabel(r, m, botId);
  if (m.quote) return `[quote from ${label}]\n${quoted(m.quote.text)}`;
  // Cut by code points so an emoji is never split; the mark is not counted.
  const chars = Array.from(originalText(r) ?? "");
  const short = chars.length > MAX_REPLY_CHARS;
  const text = chars.slice(0, MAX_REPLY_CHARS).join("");
  const body = [mediaMark(r), text].filter(Boolean).join(" ");
  return [`[reply to ${label}]`, ...(body ? [quoted(body)] : []), ...(short ? ["(message shortened)"] : [])].join("\n");
}

function authorLabel(r: Message, m: Message, botId: number | undefined): string {
  if (r.from && r.from.id === botId) return "your message";
  if (r.from && r.from.id === m.from?.id) return "the user's own message";
  const name = r.from ? userName(r.from) : r.sender_chat ? chatName(r.sender_chat) : undefined;
  return name ? `a message from ${name}` : "a message";
}

// The text, caption or rich text of the original.
// Nothing is downloaded: a rich photo is named by its file_id.
function originalText(r: Message): string | undefined {
  return r.text ?? r.caption ?? (r.rich_message ? richToMarkdown(r.rich_message) : undefined);
}

function mediaMark(m: Media): string | undefined {
  if (m.photo) return "(photo)";
  if (m.document) return `(document: ${m.document.file_name ?? "file"})`;
  if (m.voice) return "(voice message)";
  if (m.audio) return `(audio: ${m.audio.title ?? m.audio.file_name ?? "audio"})`;
  if (m.video) return "(video)";
  if (m.video_note) return "(video note)";
  if (m.sticker) return `(sticker${m.sticker.emoji ? ` ${m.sticker.emoji}` : ""})`;
  return undefined;
}

function quoted(body: string): string {
  return body
    .split("\n")
    .map(l => (l ? `> ${l}` : ">"))
    .join("\n");
}

function userName(u: TelegramUser): string {
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ");
  return u.username ? `${name} (@${u.username})` : name;
}

function chatName(c: TelegramChat): string {
  return c.title ?? ([c.first_name, c.last_name].filter(Boolean).join(" ") || (c.username ? `@${c.username}` : String(c.id)));
}

function signed(name: string, signature: string | undefined): string {
  return signature ? `${name} (${signature})` : name;
}
