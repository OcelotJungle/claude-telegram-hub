import type { TranscriptEvent } from "../src/transcript/parse.ts";

import { describe, expect, test } from "bun:test";
import { Relay, TURN_DECISION_MS, TURN_SETTLE_MS } from "../src/transcript/relay.ts";

const own = (name: string) => /(^|__)tg_(enable|disable)$/.test(name);
const text = (t: string, m = "m1"): TranscriptEvent => ({ kind: "text", text: t, messageId: m });
const tool = (name: string, m = "m1"): TranscriptEvent => ({ kind: "tool_use", name, messageId: m });
const end = (m: string): TranscriptEvent => ({ kind: "turn_end", messageId: m });
const DONE = { final: true, kind: "done" } as const;
const ASK = { final: true, kind: "ask" } as const;
const PAUSE = { final: false } as const;

// A relay with a clock the test moves by hand.
function enabledRelay() {
  const clock = { t: 1_000_000 };
  const r = new Relay({ isOwnTool: own, now: () => clock.t });
  r.setEnabled(true);
  return { r, clock };
}

describe("relay", () => {
  test("text before a tool call is sent silently right away", () => {
    const { r } = enabledRelay();
    expect(r.feed(text("looking"))).toEqual([]);
    expect(r.feed(tool("Bash"))).toEqual([{ text: "looking", notify: false }]);
  });

  test("the decision before the turn end: sent loud after the quiet period", () => {
    const { r, clock } = enabledRelay();
    r.feed(text("B", "m2"));
    r.decide(DONE);
    r.feed(end("m2"));
    expect(r.idle()).toEqual([]);
    clock.t += TURN_SETTLE_MS - 1;
    expect(r.idle()).toEqual([]);
    clock.t += 1;
    expect(r.idle()).toEqual([{ text: "B", notify: true }]);
    expect(r.idle()).toEqual([]);
  });

  test("the turn end before the decision: sent loud after the quiet period", () => {
    const { r, clock } = enabledRelay();
    r.feed(text("B", "m2"));
    r.feed(end("m2"));
    clock.t += 100;
    expect(r.idle()).toEqual([]);
    r.decide(ASK);
    clock.t += TURN_SETTLE_MS - 1;
    expect(r.idle()).toEqual([]);
    clock.t += 1;
    expect(r.idle()).toEqual([{ text: "B", notify: true }]);
  });

  test("no decision within the limit: closed as a final turn", () => {
    const { r, clock } = enabledRelay();
    r.feed(text("B", "m2"));
    r.feed(end("m2"));
    clock.t += TURN_DECISION_MS - 1;
    expect(r.idle()).toEqual([]);
    clock.t += 1;
    expect(r.idle()).toEqual([{ text: "B", notify: true }]);
  });

  test("a final turn without text sends nothing", () => {
    const { r, clock } = enabledRelay();
    r.feed(end("m1"));
    r.decide(DONE);
    clock.t += TURN_SETTLE_MS;
    expect(r.idle()).toEqual([]);
    expect(r.idle()).toEqual([]);
  });

  test("an intermediate turn end sends its text silently", () => {
    const { r, clock } = enabledRelay();
    r.feed(text("жду монитор", "m1"));
    r.feed(end("m1"));
    r.decide(PAUSE);
    clock.t += TURN_SETTLE_MS;
    expect(r.idle()).toEqual([{ text: "жду монитор", notify: false }]);
  });

  test("an intermediate turn end without text sends nothing", () => {
    const { r, clock } = enabledRelay();
    r.feed(end("m1"));
    r.decide(PAUSE);
    clock.t += TURN_SETTLE_MS;
    expect(r.idle()).toEqual([]);
  });

  test("a turn continued by another message: the earlier text is silent, the last turn end is loud", () => {
    const { r, clock } = enabledRelay();
    r.feed(text("A", "m1"));
    r.feed(end("m1"));
    r.decide(PAUSE);
    // The continuation starts before the quiet period is over.
    clock.t += 100;
    expect(r.feed(text("B", "m2"))).toEqual([{ text: "A", notify: false }]);
    r.feed(end("m2"));
    r.decide(DONE);
    clock.t += TURN_SETTLE_MS;
    expect(r.idle()).toEqual([{ text: "B", notify: true }]);
  });

  test("a stale decision does not hold the next turn: terminal input clears it", () => {
    const { r, clock } = enabledRelay();
    r.decide(DONE);
    r.feed({ kind: "terminal_input" });
    r.feed(text("next", "m3"));
    r.feed(end("m3"));
    clock.t += TURN_SETTLE_MS;
    // No decision for this turn: it waits for the limit instead of using the old one.
    expect(r.idle()).toEqual([]);
    clock.t += TURN_DECISION_MS;
    expect(r.idle()).toEqual([{ text: "next", notify: true }]);
  });

  test("terminal input, a channel message and an interrupt close an ended turn silently", () => {
    const events: TranscriptEvent[] = [{ kind: "terminal_input" }, { kind: "channel_seen", messageIds: [1] }, { kind: "interrupted" }];
    for (const ev of events) {
      const { r } = enabledRelay();
      r.feed(text("final", "m1"));
      r.feed(end("m1"));
      r.decide(DONE);
      expect(r.feed(ev)).toEqual([{ text: "final", notify: false }]);
      expect(r.idle()).toEqual([]);
    }
  });

  test("every record restarts the quiet period", () => {
    const { r, clock } = enabledRelay();
    r.feed(text("B", "m2"));
    r.feed(end("m2"));
    r.decide(DONE);
    clock.t += TURN_SETTLE_MS - 1;
    r.feed({ kind: "title", source: "ai", title: "x" });
    clock.t += TURN_SETTLE_MS - 1;
    expect(r.idle()).toEqual([]);
    clock.t += 1;
    expect(r.idle()).toEqual([{ text: "B", notify: true }]);
  });

  test("turn_end from the thinking record before the text record keeps the text final", () => {
    const { r, clock } = enabledRelay();
    r.feed(end("m2"));
    r.feed(text("final", "m2"));
    r.feed(end("m2"));
    r.decide(DONE);
    clock.t += TURN_SETTLE_MS;
    expect(r.idle()).toEqual([{ text: "final", notify: true }]);
  });

  test("own tool call between text and turn end keeps the text final", () => {
    const { r, clock } = enabledRelay();
    expect(r.feed(text("summary", "m1"))).toEqual([]);
    expect(r.feed(tool("mcp__plugin_tg-hub_tg-hub__tg_enable", "m1"))).toEqual([]);
    r.feed(end("m2"));
    r.decide(DONE);
    clock.t += TURN_SETTLE_MS;
    expect(r.idle()).toEqual([{ text: "summary", notify: true }]);
  });

  test("two texts in one message: first silent, second final", () => {
    const { r, clock } = enabledRelay();
    const out = [...r.feed(text("one", "m1")), ...r.feed(text("two", "m1"))];
    r.feed(end("m1"));
    r.decide(DONE);
    clock.t += TURN_SETTLE_MS;
    expect([...out, ...r.idle()]).toEqual([
      { text: "one", notify: false },
      { text: "two", notify: true },
    ]);
  });

  test("a repeated turn_end for a closed message is handled once", () => {
    const { r, clock } = enabledRelay();
    r.feed(text("B", "m1"));
    r.feed(end("m1"));
    r.decide(DONE);
    clock.t += TURN_SETTLE_MS;
    expect(r.idle()).toEqual([{ text: "B", notify: true }]);
    r.feed(end("m1"));
    clock.t += TURN_DECISION_MS;
    expect(r.idle()).toEqual([]);
  });

  test("an event from another message closes the pending turn silently", () => {
    const { r } = enabledRelay();
    r.feed(text("final", "m1"));
    r.feed(end("m1"));
    r.decide(DONE);
    expect(r.feed(text("next turn", "m2"))).toEqual([{ text: "final", notify: false }]);
  });

  test("disabled relay drops everything", () => {
    const clock = { t: 0 };
    const r = new Relay({ isOwnTool: own, now: () => clock.t });
    r.feed(text("A"));
    r.feed(tool("Bash"));
    r.feed(text("B", "m2"));
    r.feed(end("m2"));
    r.decide(DONE);
    clock.t += TURN_DECISION_MS;
    expect(r.idle()).toEqual([]);
    expect(r.endTurn()).toEqual([]);
  });

  test("enabling mid-turn relays only later text", () => {
    const clock = { t: 0 };
    const r = new Relay({ isOwnTool: own, now: () => clock.t });
    r.feed(text("before"));
    r.setEnabled(true);
    expect(r.feed(tool("mcp__plugin_tg-hub_tg-hub__tg_enable"))).toEqual([]);
    r.feed(text("after", "m2"));
    r.feed(end("m2"));
    r.decide(DONE);
    clock.t += TURN_SETTLE_MS;
    expect(r.idle()).toEqual([{ text: "after", notify: true }]);
  });

  // Everything written while the mode was on reaches the topic.
  test("disabling mid-turn sends the pending text silently, later text is dropped", () => {
    const { r } = enabledRelay();
    r.feed(text("pending", "m1"));
    expect(r.setEnabled(false)).toEqual([{ text: "pending", notify: false }]);
    r.feed(text("after", "m1"));
    r.feed(end("m1"));
    expect(r.idle()).toEqual([]);
  });

  test("disabling after a turn ended sends its final text as the decision says", () => {
    const { r } = enabledRelay();
    r.feed(text("final", "m1"));
    r.feed(end("m1"));
    r.decide(DONE);
    expect(r.setEnabled(false)).toEqual([{ text: "final", notify: true }]);
    expect(r.idle()).toEqual([]);
  });

  test("disabling after a turn ended with no decision sends the text silently", () => {
    const { r } = enabledRelay();
    r.feed(text("final", "m1"));
    r.feed(end("m1"));
    expect(r.setEnabled(false)).toEqual([{ text: "final", notify: false }]);
  });

  test("disabling with nothing pending sends nothing, twice too", () => {
    const { r } = enabledRelay();
    expect(r.setEnabled(false)).toEqual([]);
    expect(r.setEnabled(false)).toEqual([]);
  });

  test("endTurn closes by the decision when there is one", () => {
    const { r } = enabledRelay();
    r.feed(text("итог", "m1"));
    r.feed(end("m1"));
    r.decide(ASK);
    expect(r.endTurn()).toEqual([{ text: "итог", notify: true }]);
    expect(r.endTurn()).toEqual([]);
  });

  test("endTurn without a decision closes silently", () => {
    const { r } = enabledRelay();
    r.feed(text("итог", "m1"));
    r.feed(end("m1"));
    expect(r.endTurn()).toEqual([{ text: "итог", notify: false }]);
  });

  test("endTurn in the middle of a turn leaves the text alone", () => {
    const { r } = enabledRelay();
    r.feed(text("working", "m1"));
    expect(r.endTurn()).toEqual([]);
  });

  test("a tool of ours posting to the topic takes the text written before it", () => {
    const { r } = enabledRelay();
    r.feed(text("вот скрин"));
    expect(r.textBeforeToolCall()).toEqual([{ text: "вот скрин", notify: false }]);
    // The tool_use record read later finds nothing left to send.
    expect(r.feed(tool("mcp__plugin_tg-hub_tg-hub__tg_send_file"))).toEqual([]);
    expect(r.idle()).toEqual([]);
  });

  test("a tool call after a turn ended closes that turn silently first", () => {
    const { r } = enabledRelay();
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
    const { r } = enabledRelay();
    expect(r.feed({ kind: "title", source: "ai", title: "x" })).toEqual([]);
    expect(r.feed({ kind: "terminal_input" })).toEqual([]);
  });
});
