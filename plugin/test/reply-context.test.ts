import type { Message } from "../src/hub/telegram.ts";

import { describe, expect, test } from "bun:test";
import { MAX_REPLY_CHARS, withContext } from "../src/hub/reply-context.ts";
import { topicMsg } from "./fake-telegram.ts";
import { must } from "./helpers.ts";

const TOPIC = 100;
const USER = { id: 7, is_bot: false, first_name: "User", username: "user" };
const BOT = { id: 1, is_bot: true, first_name: "Hub", username: "test_bot" };
const OTHER = { id: 9, is_bot: false, first_name: "Ivan", last_name: "Petrov", username: "ivan" };
const CHAT = { id: -1001, type: "supergroup" as const, title: "Group" };

let nextId = 200;

function msg(extra: Partial<Message> = {}): Message {
  return { message_id: nextId++, date: 0, chat: CHAT, message_thread_id: TOPIC, is_topic_message: true, ...extra };
}

function replyTo(original: Partial<Message>, extra: Partial<Message> = {}): Message {
  return msg({ from: USER, text: "answer", reply_to_message: msg(original), ...extra });
}

describe("reply context", () => {
  test("a reply to the bot's message goes after the text, after a blank line", () => {
    expect(withContext(replyTo({ from: BOT, text: "line 1\nline 2" }), "answer")).toBe("answer\n\n[reply to your message]\n> line 1\n> line 2");
  });

  test("a reply to the user's own message", () => {
    expect(withContext(replyTo({ from: USER, text: "earlier" }), "answer")).toBe("answer\n\n[reply to the user's own message]\n> earlier");
  });

  test("a reply to another person names them", () => {
    expect(withContext(replyTo({ from: OTHER, text: "hi" }), "answer")).toBe("answer\n\n[reply to a message from Ivan Petrov (@ivan)]\n> hi");
  });

  test("a quote is shown whole, however long", () => {
    const long = "q".repeat(MAX_REPLY_CHARS + 50);
    const m = replyTo({ from: BOT, text: `${long} and more` }, { quote: { text: `${long}\n\nend`, position: 0 } });
    expect(withContext(m, "answer")).toBe(`answer\n\n[quote from your message]\n> ${long}\n>\n> end`);
  });

  test("a long original is shortened with a marker", () => {
    const m = replyTo({ from: BOT, text: "a".repeat(MAX_REPLY_CHARS + 1) });
    expect(withContext(m, "answer")).toBe(`answer\n\n[reply to your message]\n> ${"a".repeat(MAX_REPLY_CHARS)}\n(message shortened)`);
  });

  test("an original of exactly the limit has no marker", () => {
    const m = replyTo({ from: BOT, text: "a".repeat(MAX_REPLY_CHARS) });
    expect(withContext(m, "answer")).not.toContain("(message shortened)");
  });

  test("a media original gives its mark and caption, nothing downloaded", () => {
    const photo = replyTo({ from: OTHER, photo: [{ file_id: "p1", file_unique_id: "u1", width: 1, height: 1 }], caption: "sunset" });
    expect(withContext(photo, "answer")).toBe("answer\n\n[reply to a message from Ivan Petrov (@ivan)]\n> (photo) sunset");
    const doc = replyTo({ from: USER, document: { file_id: "d1", file_unique_id: "u2", file_name: "plan.pdf" } });
    expect(withContext(doc, "answer")).toBe("answer\n\n[reply to the user's own message]\n> (document: plan.pdf)");
    const voice = replyTo({ from: USER, voice: { file_id: "v1", file_unique_id: "u3", duration: 3 } });
    expect(withContext(voice, "answer")).toBe("answer\n\n[reply to the user's own message]\n> (voice message)");
  });

  test("a rich original gives its text with files named by file_id", () => {
    // Built as an update: the Bot API types want rich text as objects, Telegram also sends strings.
    const rich = must(topicMsg({ chatId: CHAT.id, fromId: BOT.id, extra: { from: BOT, rich_message: { blocks: [{ type: "paragraph", text: "rich" }] } } }).message);
    const m = msg({ from: USER, text: "answer", reply_to_message: rich });
    expect(withContext(m, "answer")).toBe("answer\n\n[reply to your message]\n> rich");
  });

  test("the topic's service message is not a reply", () => {
    const root = msg({ from: USER, text: "answer", reply_to_message: msg({ message_id: TOPIC, forum_topic_created: { name: "t", icon_color: 0 } }) });
    expect(withContext(root, "answer")).toBe("answer");
    const byId = msg({ from: USER, text: "answer", reply_to_message: msg({ message_id: TOPIC, from: USER }) });
    expect(withContext(byId, "answer")).toBe("answer");
  });

  test("a reply to another chat names the origin and shows the quote", () => {
    const m = msg({
      from: USER,
      text: "answer",
      external_reply: { origin: { type: "channel", date: 0, chat: { id: -100, type: "channel", title: "News" }, message_id: 5 } },
      quote: { text: "quoted", position: 0 },
    });
    expect(withContext(m, "answer")).toBe("answer\n\n[reply to a message from another chat: News]\n> quoted");
    const bare = msg({ from: USER, text: "answer", external_reply: { origin: { type: "hidden_user", date: 0, sender_user_name: "Anon" } } });
    expect(withContext(bare, "answer")).toBe("answer\n\n[reply to a message from another chat: Anon]");
  });

  test("a '!' reply still starts with the user's text", () => {
    expect(withContext(replyTo({ from: BOT, text: "earlier" }, { text: "!stop" }), "!stop").startsWith("!stop")).toBe(true);
  });
});

describe("forward mark", () => {
  const fwd = (origin: Message["forward_origin"]) => withContext(msg({ from: USER, text: "body", forward_origin: origin }), "body");

  test("from a user, with the username", () => {
    expect(fwd({ type: "user", date: 0, sender_user: OTHER })).toBe("[forwarded from Ivan Petrov (@ivan)]\nbody");
  });

  test("from a hidden user", () => {
    expect(fwd({ type: "hidden_user", date: 0, sender_user_name: "Someone" })).toBe("[forwarded from Someone]\nbody");
  });

  test("from a chat, with the author's signature", () => {
    expect(fwd({ type: "chat", date: 0, sender_chat: { id: -5, type: "supergroup", title: "Team" }, author_signature: "Anna" })).toBe("[forwarded from Team (Anna)]\nbody");
  });

  test("from a channel", () => {
    expect(fwd({ type: "channel", date: 0, chat: { id: -6, type: "channel", title: "News" }, message_id: 3 })).toBe("[forwarded from News]\nbody");
  });

  test("of an unknown origin type", () => {
    // Only an update from Telegram can carry a type the Bot API types lack.
    const m = must(topicMsg({ chatId: CHAT.id, threadId: TOPIC, fromId: USER.id, text: "body", extra: { forward_origin: { type: "future", date: 0 } } }).message);
    expect(withContext(m, "body")).toBe("[forwarded]\nbody");
  });
});
