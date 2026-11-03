// An AskUserQuestion poll in a topic: the message text and buttons of each
// question, and the callback data the buttons carry.
import type { Messages } from "../shared/i18n/index.ts";
import type { Entity, Formatted } from "../shared/markdown.ts";
import type { AskQuestion, QuestionDecision } from "../shared/protocol.ts";
import type { Button } from "./telegram.ts";

import { chunk, MAX_MESSAGE } from "../shared/chunk.ts";
import { MAX_REPLY_CHARS } from "./reply-context.ts";

// A preview longer than this is cut; a text longer than TEXT_LIMIT goes
// without previews, and is cut if still longer, leaving room for the
// outcome line under it.
const PREVIEW_CHARS = 700;
const TEXT_LIMIT = 3700;
const BUTTON_CHARS = 64;
const ELLIPSIS = "…";

export const POLL_PREFIX = "q:";
// Goes to the agent, so always English.
export const CANCEL_REASON = "The user cancelled the question in Telegram. Do not ask it again; end your turn and wait for their message.";

// An open poll. Questions go one at a time: index is the one shown now.
// Each shown question has its message id once sent and its outcome line
// once answered; an outcome set before the send goes with the send.
export type Poll = {
  key: string;
  sessionId: string;
  questions: AskQuestion[];
  answers: Record<string, string>;
  index: number;
  checked: Set<number>;
  messageIds: (number | undefined)[];
  outcomes: (string | undefined)[];
  // Topic messages taken as answers: their ✍ comes off once the agent has them.
  taken: number[];
  done: boolean;
  resolve(d: QuestionDecision): void;
};

export type PollAction = number | "done" | "custom" | "cancel";
export type PollPress = { key: string; index: number; action: PollAction };

// The text of question i: its header in bold (numbered when there are
// several), the question, then the numbered options with their previews.
export function questionText(m: Messages, questions: AskQuestion[], i: number): Formatted {
  const full = build(m, questions, i, true);
  return full.text.length > TEXT_LIMIT ? cutText(build(m, questions, i, false), TEXT_LIMIT) : full;
}

function build(m: Messages, questions: AskQuestion[], i: number, previews: boolean): Formatted {
  const q = questions[i];
  const entities: Entity[] = [];
  let text = "";
  const head = m.pollHead({ index: i + 1, total: questions.length, header: q.header });
  if (head) {
    entities.push({ type: "bold", offset: 0, length: head.length });
    text = `${head}\n`;
  }
  text += `${q.question}\n`;
  q.options.forEach((o, n) => {
    text += `\n${n + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`;
    if (previews && o.preview) {
      const preview = cut(o.preview, PREVIEW_CHARS);
      entities.push({ type: "pre", offset: text.length + 1, length: preview.length });
      text += `\n${preview}`;
    }
  });
  return { text, entities };
}

// The message with its outcome line under it, within one Telegram message.
export function withOutcome(f: Formatted, outcome: string): Formatted {
  const body = cutText(f, MAX_MESSAGE - outcome.length - 2);
  return { text: `${body.text}\n\n${outcome}`, entities: body.entities };
}

// A formatted text cut to max characters, the ellipsis included, at a
// paragraph, line or word boundary where it can.
function cutText(f: Formatted, max: number): Formatted {
  if (f.text.length <= max) return f;
  const head = chunk(f, max - ELLIPSIS.length)[0] ?? { text: "", entities: [] };
  return { text: `${head.text}${ELLIPSIS}`, entities: head.entities };
}

export function questionButtons(m: Messages, p: Poll): Button[][] {
  const q = p.questions[p.index];
  const data = (a: PollAction) => `${POLL_PREFIX}${p.key}:${p.index}:${a}`;
  const rows = q.options.map((o, n) => [{ text: cut(`${p.checked.has(n + 1) ? "☑️ " : ""}${n + 1}. ${o.label}`, BUTTON_CHARS), data: data(n + 1) }]);
  if (q.multiSelect) rows.push([{ text: m.pollDone, data: data("done") }]);
  rows.push([
    { text: m.pollCustom, data: data("custom") },
    { text: m.pollCancel, data: data("cancel") },
  ]);
  return rows;
}

export function parsePollPress(data: string): PollPress | undefined {
  const m = /^q:([0-9a-f]+):(\d+):(\d+|done|custom|cancel)$/.exec(data);
  if (!m) return undefined;
  const a = m[3];
  const action: PollAction = a === "done" || a === "custom" || a === "cancel" ? a : Number(a);
  return { key: m[1], index: Number(m[2]), action };
}

// The labels checked in a multiple choice, in option order.
export function checkedLabels(q: AskQuestion, checked: Set<number>): string {
  return q.options
    .filter((_, n) => checked.has(n + 1))
    .map(o => o.label)
    .join(", ");
}

// An answer as the outcome line shows it: cut like a reply's quote.
export function answerLine(answer: string): string {
  return `✅ ${cut(answer, MAX_REPLY_CHARS)}`;
}

// Cuts by code points, so an emoji is never split.
function cut(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max).join("")}${ELLIPSIS}` : s;
}
