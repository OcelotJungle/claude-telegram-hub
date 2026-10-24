// What a topic message replies to, quotes or forwards, as plain lines around
// its text for the agent. The forward mark goes before the text and the reply
// after it, so a message that starts with "!" still starts with it.
import type { TelegramChat, TelegramMessageOrigin, TelegramUser } from "@gramio/types";
import type { Message } from "./telegram.ts";

import { richToMarkdown } from "./rich.ts";

// Longest original text shown for a reply without a quote.
export const MAX_REPLY_CHARS = 300;

// The media fields a message and an external reply share.
type Media = Pick<Message, "photo" | "document" | "voice" | "audio" | "video" | "video_note" | "sticker">;

export function withContext(m: Message, content: string): string {
  const forward = m.forward_origin ? `${forwardMark(m.forward_origin)}\n` : "";
  const reply = replyBlock(m);
  return `${forward}${content}${reply ? `\n\n${reply}` : ""}`;
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

function replyBlock(m: Message): string | undefined {
  if (m.external_reply) {
    const name = originName(m.external_reply.origin);
    const head = name ? `[reply to a message from another chat: ${name}]` : "[reply to a message from another chat]";
    const body = m.quote?.text ?? mediaMark(m.external_reply);
    return body ? `${head}\n${quoted(body)}` : head;
  }
  const r = m.reply_to_message;
  // Every message in a topic replies to the topic's service message.
  if (!r || r.forum_topic_created || r.message_id === m.message_thread_id) return undefined;
  const label = authorLabel(r, m);
  if (m.quote) return `[quote from ${label}]\n${quoted(m.quote.text)}`;
  const full = originalText(r);
  const short = full.length > MAX_REPLY_CHARS;
  const body = short ? full.slice(0, MAX_REPLY_CHARS) : full;
  return [`[reply to ${label}]`, ...(body ? [quoted(body)] : []), ...(short ? ["(message shortened)"] : [])].join("\n");
}

function authorLabel(r: Message, m: Message): string {
  if (r.from?.is_bot) return "your message";
  if (r.from && r.from.id === m.from?.id) return "the user's own message";
  const name = r.from ? userName(r.from) : r.sender_chat ? chatName(r.sender_chat) : undefined;
  return name ? `a message from ${name}` : "a message";
}

// The text, caption or rich text of the original, after a mark of its media.
// Nothing is downloaded: a rich photo is named by its file_id.
function originalText(r: Message): string {
  const text = r.text ?? r.caption ?? (r.rich_message ? richToMarkdown(r.rich_message) : undefined);
  return [mediaMark(r), text].filter(Boolean).join(" ");
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
