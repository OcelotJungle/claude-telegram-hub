import type { TranscriptEvent } from "../src/transcript/parse.ts";

import { describe, expect, test } from "bun:test";
import { Relay, TURN_CLOSE_WAIT_MS, TURN_DECISION_MS } from "../src/transcript/relay.ts";

const own = (name: string) => /(^|__)tg_(enable|disable)$/.test(name);
const text = (t: string, m = "m1"): TranscriptEvent => ({ kind: "text", text: t, messageId: m });
const tool = (name: string, m = "m1"): TranscriptEvent => ({ kind: "tool_use", name, messageId: m });
const end = (m: string): TranscriptEvent => ({ kind: "turn_end", messageId: m });
const CLOSED: TranscriptEvent = { kind: "turn_closed" };
const DONE = { final: true, kind: "done" } as const;
const ASK = { final: true, kind: "ask" } as const;
const PAUSE = { final: false } as const;

// A relay with a clock the test moves by hand; final closes are recorded.
function makeRelay(enabled = true) {
  const clock = { t: 1_000_000 };
  const finals: string[] = [];
  const r = new Relay({ isOwnTool: own, onFinalClose: kind => finals.push(kind), now: () => clock.t });
  r.setEnabled(enabled);
  return { r, clock, finals };
}

describe("relay: closing a turn", () => {
  test("text before a tool call is sent silently right away", () => {
    const { r } = makeRelay();
    expect(r.feed(text("looking"))).toEqual([]);
    expect(r.feed(tool("Bash"))).toEqual([{ text: "looking", notify: false }]);
  });

  test("turn_closed after the decision closes at once, loud", () => {
    const { r, finals } = makeRelay();
    r.feed(text("B", "m2"));
    r.feed(end("m2"));
    expect(r.decide(DONE)).toEqual([]);
    expect(r.feed(CLOSED)).toEqual([{ text: "B", notify: true }]);
    expect(finals).toEqual(["done"]);
    expect(r.idle()).toEqual([]);
  });

  test("the decision after turn_closed closes at once", () => {
    const { r, clock, finals } = makeRelay();
    r.feed(text("B", "m2"));
    r.feed(end("m2"));
    expect(r.feed(CLOSED)).toEqual([]);
    clock.t += 100;
    expect(r.idle()).toEqual([]);
    expect(r.decide(ASK)).toEqual([{ text: "B", notify: true }]);
    expect(finals).toEqual(["ask"]);
  });

  test("the latest decision wins", () => {
    const { r, finals } = makeRelay();
    r.feed(text("B", "m2"));
    r.feed(end("m2"));
    r.decide(PAUSE);
    r.decide(DONE);
    expect(r.feed(CLOSED)).toEqual([{ text: "B", notify: true }]);
    expect(finals).toEqual(["done"]);
  });

  test("turn_closed with no decision: closed loud 5 s later, nothing reported", () => {
    const { r, clock, finals } = makeRelay();
    r.feed(text("B", "m2"));
    r.feed(end("m2"));
    r.feed(CLOSED);
    clock.t += TURN_DECISION_MS - 1;
    expect(r.idle()).toEqual([]);
    clock.t += 1;
    expect(r.idle()).toEqual([{ text: "B", notify: true }]);
    expect(finals).toEqual([]);
    expect(r.idle()).toEqual([]);
  });

  test("no turn_closed: closed by the decision after 30 s of quiet", () => {
    const { r, clock, finals } = makeRelay();
    r.feed(text("B", "m2"));
    r.feed(end("m2"));
    clock.t += 1000;
    r.decide(DONE);
    // A prompt-type Stop hook may still continue the turn after 5 s.
    clock.t += TURN_DECISION_MS;
    expect(r.idle()).toEqual([]);
    clock.t += TURN_CLOSE_WAIT_MS - TURN_DECISION_MS - 1;
    expect(r.idle()).toEqual([]);
    clock.t += 1;
    expect(r.idle()).toEqual([{ text: "B", notify: true }]);
    expect(finals).toEqual(["done"]);
  });

  test("no turn_closed: a record of the same message restarts the quiet period", () => {
    const { r, clock } = makeRelay();
    r.feed(text("B", "m2"));
    r.feed(end("m2"));
    r.decide(DONE);
    clock.t += TURN_CLOSE_WAIT_MS - 1;
    r.feed(end("m2"));
    clock.t += TURN_CLOSE_WAIT_MS - 1;
    expect(r.idle()).toEqual([]);
    clock.t += 1;
    expect(r.idle()).toEqual([{ text: "B", notify: true }]);
  });

  test("no turn_closed and no decision: closed loud after 30 s of quiet, nothing reported", () => {
    const { r, clock, finals } = makeRelay();
    r.feed(text("B", "m2"));
    r.feed(end("m2"));
    clock.t += TURN_CLOSE_WAIT_MS - 1;
    expect(r.idle()).toEqual([]);
    clock.t += 1;
    expect(r.idle()).toEqual([{ text: "B", notify: true }]);
    expect(finals).toEqual([]);
  });

  test("a final turn without text sends nothing but is reported", () => {
    const { r, finals } = makeRelay();
    r.feed(end("m1"));
    r.decide(DONE);
    expect(r.feed(CLOSED)).toEqual([]);
    expect(finals).toEqual(["done"]);
  });

  test("an intermediate turn end sends its text silently and is not reported", () => {
    const { r, finals } = makeRelay();
    r.feed(text("жду монитор", "m1"));
    r.feed(end("m1"));
    r.decide(PAUSE);
    expect(r.feed(CLOSED)).toEqual([{ text: "жду монитор", notify: false }]);
    expect(finals).toEqual([]);
  });

  test("an intermediate turn end without text sends nothing", () => {
    const { r } = makeRelay();
    r.feed(end("m1"));
    r.decide(PAUSE);
    expect(r.feed(CLOSED)).toEqual([]);
  });

  test("a turn continued by another message: closed silently, its decision dropped", () => {
    const { r, clock, finals } = makeRelay();
    r.feed(text("A", "m1"));
    r.feed(end("m1"));
    r.decide(DONE);
    expect(r.feed(text("B", "m2"))).toEqual([{ text: "A", notify: false }]);
    expect(finals).toEqual([]);
    r.feed(end("m2"));
    // The dropped decision does not close the new turn.
    expect(r.feed(CLOSED)).toEqual([]);
    clock.t += TURN_DECISION_MS;
    expect(r.idle()).toEqual([{ text: "B", notify: true }]);
    expect(finals).toEqual([]);
  });

  test("terminal input clears a decision made for nothing", () => {
    const { r, clock } = makeRelay();
    r.decide(DONE);
    r.feed({ kind: "terminal_input" });
    r.feed(text("next", "m3"));
    r.feed(end("m3"));
    r.feed(CLOSED);
    // No decision for this turn: it waits for the limit instead of using the old one.
    expect(r.idle()).toEqual([]);
    clock.t += TURN_DECISION_MS;
    expect(r.idle()).toEqual([{ text: "next", notify: true }]);
  });

  test("terminal input, a channel message and an interrupt close an ended turn silently", () => {
    const events: TranscriptEvent[] = [{ kind: "terminal_input" }, { kind: "channel_seen", messageIds: [1] }, { kind: "interrupted" }];
    for (const ev of events) {
      const { r, finals } = makeRelay();
      r.feed(text("final", "m1"));
      r.feed(end("m1"));
      r.decide(DONE);
      expect(r.feed(ev)).toEqual([{ text: "final", notify: false }]);
      expect(r.idle()).toEqual([]);
      expect(finals).toEqual([]);
    }
  });

  test("turn_end from the thinking record before the text record keeps the text final", () => {
    const { r } = makeRelay();
    r.feed(end("m2"));
    r.feed(text("final", "m2"));
    r.feed(end("m2"));
    r.decide(DONE);
    expect(r.feed(CLOSED)).toEqual([{ text: "final", notify: true }]);
  });

  test("own tool call between text and turn end keeps the text final", () => {
    const { r } = makeRelay();
    expect(r.feed(text("summary", "m1"))).toEqual([]);
    expect(r.feed(tool("mcp__plugin_tg-hub_tg-hub__tg_enable", "m1"))).toEqual([]);
    r.feed(end("m2"));
    r.decide(DONE);
    expect(r.feed(CLOSED)).toEqual([{ text: "summary", notify: true }]);
  });

  test("two texts in one message: first silent, second final", () => {
    const { r } = makeRelay();
    const out = [...r.feed(text("one", "m1")), ...r.feed(text("two", "m1"))];
    r.feed(end("m1"));
    r.decide(DONE);
    expect([...out, ...r.feed(CLOSED)]).toEqual([
      { text: "one", notify: false },
      { text: "two", notify: true },
    ]);
  });

  test("a repeated turn_end for a closed message is handled once", () => {
    const { r, clock } = makeRelay();
    r.feed(text("B", "m1"));
    r.feed(end("m1"));
    r.decide(DONE);
    expect(r.feed(CLOSED)).toEqual([{ text: "B", notify: true }]);
    r.feed(end("m1"));
    clock.t += TURN_DECISION_MS;
    expect(r.idle()).toEqual([]);
  });
});

describe("relay: late decisions", () => {
  test("a decision after the turn closed is dropped", () => {
    const { r, clock, finals } = makeRelay();
    r.feed(text("B", "m1"));
    r.feed(end("m1"));
    r.feed(CLOSED);
    clock.t += TURN_DECISION_MS;
    expect(r.idle()).toEqual([{ text: "B", notify: true }]);
    expect(r.decide(ASK)).toEqual([]);
    expect(finals).toEqual([]);
    // It does not close the next turn either.
    r.feed(text("C", "m2"));
    r.feed(end("m2"));
    expect(r.feed(CLOSED)).toEqual([]);
  });

  test("a decision after a turn closed silently by terminal input is dropped", () => {
    const { r, finals } = makeRelay();
    r.feed(text("B", "m1"));
    r.feed(end("m1"));
    r.feed({ kind: "terminal_input" });
    expect(r.decide(DONE)).toEqual([]);
    expect(finals).toEqual([]);
  });

  test("a decision once the next turn has started counts for that turn", () => {
    const { r } = makeRelay();
    r.feed(text("B", "m1"));
    r.feed(end("m1"));
    r.decide(DONE);
    r.feed(CLOSED);
    r.feed(text("C", "m2"));
    r.decide(DONE);
    r.feed(end("m2"));
    expect(r.feed(CLOSED)).toEqual([{ text: "C", notify: true }]);
  });

  test("turn_closed with no turn end makes a later decision stale", () => {
    const { r, finals } = makeRelay();
    r.feed(CLOSED);
    expect(r.decide(DONE)).toEqual([]);
    expect(finals).toEqual([]);
  });
});

describe("relay: the mode", () => {
  test("disabled relay sends nothing but reports a final close", () => {
    const { r, finals } = makeRelay(false);
    r.feed(text("A"));
    r.feed(tool("Bash"));
    r.feed(text("B", "m2"));
    r.feed(end("m2"));
    r.decide(DONE);
    expect(r.feed(CLOSED)).toEqual([]);
    expect(finals).toEqual(["done"]);
    expect(r.endTurn()).toEqual([]);
  });

  test("enabling mid-turn relays only later text", () => {
    const { r } = makeRelay(false);
    r.feed(text("before"));
    r.setEnabled(true);
    expect(r.feed(tool("mcp__plugin_tg-hub_tg-hub__tg_enable"))).toEqual([]);
    r.feed(text("after", "m2"));
    r.feed(end("m2"));
    r.decide(DONE);
    expect(r.feed(CLOSED)).toEqual([{ text: "after", notify: true }]);
  });

  // Everything written while the mode was on reaches the topic.
  test("disabling mid-turn sends the pending text silently, later text is dropped", () => {
    const { r } = makeRelay();
    r.feed(text("pending", "m1"));
    expect(r.setEnabled(false)).toEqual([{ text: "pending", notify: false }]);
    r.feed(text("after", "m1"));
    r.feed(end("m1"));
    r.decide(DONE);
    expect(r.feed(CLOSED)).toEqual([]);
  });

  test("disabling after a turn ended sends its final text as the decision says, nothing reported", () => {
    const { r, finals } = makeRelay();
    r.feed(text("final", "m1"));
    r.feed(end("m1"));
    r.decide(DONE);
    expect(r.setEnabled(false)).toEqual([{ text: "final", notify: true }]);
    expect(r.idle()).toEqual([]);
    expect(finals).toEqual([]);
  });

  test("disabling after a turn ended with no decision sends the text silently", () => {
    const { r } = makeRelay();
    r.feed(text("final", "m1"));
    r.feed(end("m1"));
    expect(r.setEnabled(false)).toEqual([{ text: "final", notify: false }]);
  });

  test("disabling with nothing pending sends nothing, twice too", () => {
    const { r } = makeRelay();
    expect(r.setEnabled(false)).toEqual([]);
    expect(r.setEnabled(false)).toEqual([]);
  });
});

describe("relay: forced closes", () => {
  test("endTurn after a turn end closes by the decision, nothing reported", () => {
    const { r, finals } = makeRelay();
    r.feed(text("итог", "m1"));
    r.feed(end("m1"));
    r.decide(ASK);
    expect(r.endTurn()).toEqual([{ text: "итог", notify: true }]);
    expect(r.endTurn()).toEqual([]);
    expect(finals).toEqual([]);
  });

  test("endTurn after a turn end without a decision closes silently", () => {
    const { r } = makeRelay();
    r.feed(text("итог", "m1"));
    r.feed(end("m1"));
    expect(r.endTurn()).toEqual([{ text: "итог", notify: false }]);
  });

  test("endTurn in the middle of a turn sends the text silently, even with a decision", () => {
    const { r } = makeRelay();
    r.feed(text("working", "m1"));
    r.decide(DONE);
    expect(r.endTurn()).toEqual([{ text: "working", notify: false }]);
    expect(r.endTurn()).toEqual([]);
  });

  test("the decision is gone after endTurn mid-turn", () => {
    const { r, clock } = makeRelay();
    r.decide(DONE);
    r.endTurn();
    r.feed(text("next", "m2"));
    r.feed(end("m2"));
    expect(r.feed(CLOSED)).toEqual([]);
    clock.t += TURN_DECISION_MS;
    expect(r.idle()).toEqual([{ text: "next", notify: true }]);
  });
});

describe("relay: tools of ours", () => {
  test("a tool of ours posting to the topic takes the text written before it", () => {
    const { r } = makeRelay();
    r.feed(text("вот скрин"));
    expect(r.textBeforeToolCall()).toEqual([{ text: "вот скрин", notify: false }]);
    // The tool_use record read later finds nothing left to send.
    expect(r.feed(tool("mcp__plugin_tg-hub_tg-hub__tg_send_file"))).toEqual([]);
    expect(r.idle()).toEqual([]);
  });

  test("a tool call after a turn ended closes that turn silently first", () => {
    const { r } = makeRelay();
    r.feed(text("итог", "m1"));
    r.feed(end("m1"));
    r.decide(DONE);
    expect(r.textBeforeToolCall()).toEqual([{ text: "итог", notify: false }]);
    expect(r.idle()).toEqual([]);
  });

  test("with the mode off nothing is taken", () => {
    const r = new Relay({ isOwnTool: own });
    r.feed(text("x"));
    expect(r.textBeforeToolCall()).toEqual([]);
  });

  test("title and terminal input alone produce nothing", () => {
    const { r } = makeRelay();
    expect(r.feed({ kind: "title", source: "ai", title: "x" })).toEqual([]);
    expect(r.feed({ kind: "terminal_input" })).toEqual([]);
  });
});
