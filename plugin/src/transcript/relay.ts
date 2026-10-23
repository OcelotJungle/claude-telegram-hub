import type { TurnEnd } from "../hook/turn-end.ts";
import type { TranscriptEvent } from "./parse.ts";

// How long the transcript must stay quiet after the Stop hook's decision, so
// the last records of the turn have been read.
export const TURN_SETTLE_MS = 1500;
// How long a turn that ended in the transcript waits for the decision before
// it is closed as a final one.
export const TURN_DECISION_MS = 5000;
const REMEMBERED_ENDS = 50;

export type Outgoing = { text: string; notify: boolean };

// Decides which assistant text goes to the topic and whether it notifies.
// A text followed by a tool call is intermediate (silent, sent at once); the
// last text of a turn is held until the Stop hook's decision arrives: a final
// turn sends it with a notification, any other turn end sends it silently.
//
// Every record of an end_turn message carries the stop reason, including the
// thinking record written before the final text, so a turn end is only closed
// on idle() (a poll that brought no new records, after the decision and the
// quiet period) or when an event of another message arrives.
export class Relay {
  private enabled = false;
  private pending: string | undefined;
  private ending: string | undefined;
  private endingAt = 0;
  private ended: string[] = [];
  private decision: { d: TurnEnd; at: number } | undefined;
  private lastRecordAt = 0;
  private now: () => number;

  constructor(private opts: { isOwnTool(name: string): boolean; now?: () => number }) {
    this.now = opts.now ?? Date.now;
  }

  // Turning off returns the text written while the mode was on and not sent
  // yet: the final text of a turn that ended, or the latest text mid-turn.
  setEnabled(on: boolean): Outgoing[] {
    let out: Outgoing[] = [];
    if (!on && this.enabled) {
      if (this.ending !== undefined) out = this.close(this.decision?.d.final === true);
      else if (this.pending !== undefined) out = [{ text: this.pending, notify: false }];
    }
    this.enabled = on;
    if (!on) {
      this.pending = undefined;
      this.decision = undefined;
    }
    return out;
  }

  // The Stop hook's verdict on how the turn ended. A later one replaces an
  // earlier one (another Stop hook can continue the turn).
  decide(d: TurnEnd): void {
    this.decision = { d, at: this.now() };
  }

  feed(ev: TranscriptEvent): Outgoing[] {
    this.lastRecordAt = this.now();
    const out: Outgoing[] = [];
    if (this.ending !== undefined && ("messageId" in ev ? ev.messageId !== this.ending : ev.kind === "terminal_input")) {
      out.push(...this.close(false));
    }
    switch (ev.kind) {
      case "terminal_input":
      case "channel_seen":
      case "interrupted":
        // A decision made for a turn the user has already left is stale.
        this.decision = undefined;
        if (this.ending !== undefined) out.push(...this.close(false));
        break;
      case "text":
        if (!this.enabled) break;
        if (this.pending !== undefined) out.push({ text: this.pending, notify: false });
        this.pending = ev.text;
        break;
      case "tool_use":
        if (this.opts.isOwnTool(ev.name) || this.pending === undefined) break;
        out.push({ text: this.pending, notify: false });
        this.pending = undefined;
        break;
      case "turn_end":
        if (!this.ended.includes(ev.messageId)) {
          this.ending = ev.messageId;
          this.endingAt = this.now();
        }
        break;
    }
    return out;
  }

  // A tool of ours that posts to the topic is about to run: the text written
  // before the call goes first. A turn that ended before it is closed silently.
  textBeforeToolCall(): Outgoing[] {
    const out = this.ending !== undefined ? this.close(false) : [];
    if (this.enabled && this.pending !== undefined) out.push({ text: this.pending, notify: false });
    this.pending = undefined;
    return out;
  }

  // Closes an ended turn once its decision has settled, or once the decision
  // is overdue (then the turn counts as a final one).
  idle(): Outgoing[] {
    if (this.ending === undefined) return [];
    const now = this.now();
    if (this.decision) {
      return now - Math.max(this.decision.at, this.lastRecordAt) >= TURN_SETTLE_MS ? this.close(this.decision.d.final) : [];
    }
    return now - this.endingAt >= TURN_DECISION_MS ? this.close(true) : [];
  }

  // The window is going away or the session changes: nothing more will come,
  // so the turn is closed by its decision if there is one, else silently.
  endTurn(): Outgoing[] {
    if (this.ending === undefined && this.decision === undefined) return [];
    return this.close(this.decision?.d.final === true);
  }

  // Sends the pending text (loud for a final turn) and forgets the turn.
  private close(final: boolean): Outgoing[] {
    if (this.ending !== undefined) {
      this.ended.push(this.ending);
      if (this.ended.length > REMEMBERED_ENDS) this.ended.shift();
    }
    this.ending = undefined;
    const out: Outgoing[] = this.enabled && this.pending !== undefined ? [{ text: this.pending, notify: final }] : [];
    this.pending = undefined;
    this.decision = undefined;
    return out;
  }
}
