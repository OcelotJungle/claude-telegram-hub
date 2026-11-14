import type { TurnEnd } from "../hook/turn-end.ts";
import type { TranscriptEvent } from "./parse.ts";

// How long a turn waits for the decision after turn_closed.
export const TURN_DECISION_MS = 5000;
// How long an ended turn with no turn_closed waits with no main-agent records
// and no new decision. Claude Code writes turn_closed after all Stop hooks, so
// this is a fallback; it outlasts a prompt-type Stop hook that may still
// continue the turn.
export const TURN_CLOSE_WAIT_MS = 30_000;
const REMEMBERED_ENDS = 50;

export type Outgoing = { text: string; notify: boolean };
type FinalKind = Extract<TurnEnd, { final: true }>["kind"];

// Decides which assistant text goes to the topic and whether it notifies.
// A text followed by a tool call is intermediate (silent, sent at once); the
// last text of a turn is held until the turn is really over: a final turn
// sends it with a notification, any other turn end sends it silently.
//
// Every record of an end_turn message carries the stop reason, including the
// thinking record written before the final text, so turn_end only marks the
// turn as ending. It closes on turn_closed (written once, after all Stop
// hooks) together with the Stop hook's decision, on idle() when one of them
// is overdue, or silently when a record of another message shows the turn
// went on.
export class Relay {
  private enabled = false;
  private pending: string | undefined;
  private ending: string | undefined;
  // When turn_closed came for the ending turn.
  private closedAt: number | undefined;
  // Background subagents still running when the turn closed: the agent waits
  // for them and goes on, so a turn without a question is only a pause.
  private pendingAgents = 0;
  // The user's own message (terminal or topic) started or joined this turn:
  // its end answers them, so it is final even with background work left.
  private byUser = false;
  private ended: string[] = [];
  private decision: { d: TurnEnd; at: number } | undefined;
  // When the last record of a main-agent message came.
  private lastMessageAt = 0;
  // The last turn is closed and no new message has started since.
  private closed = false;
  // The last turn closed with its decision. Each turn gets one decision, before
  // Claude Code writes its turn_closed; so a decision coming after a decided
  // turn is for the next one, whose records Claude Code has not written yet (a
  // one-shot answer is written only after the Stop hook). After a turn closed
  // without a decision, a decision is that turn's, late, and is dropped.
  private lastCloseDecided = true;
  private now: () => number;

  constructor(
    private opts: {
      isOwnTool(name: string): boolean;
      // A turn closed as final by the Stop hook's decision, whatever the mode.
      onFinalClose?(kind: FinalKind): void;
      now?: () => number;
    },
  ) {
    this.now = opts.now ?? Date.now;
  }

  // Turning off returns the text written while the mode was on and not sent
  // yet: the final text of a turn that ended, or the latest text mid-turn.
  setEnabled(on: boolean): Outgoing[] {
    let out: Outgoing[] = [];
    if (!on && this.enabled) {
      if (this.ending !== undefined) out = this.close(this.decision !== undefined && this.effective(this.decision.d)?.final === true);
      else if (this.pending !== undefined) out = [{ text: this.pending, notify: false }];
    }
    this.enabled = on;
    if (!on) this.pending = undefined;
    return out;
  }

  // The Stop hook's verdict on how the turn ended. A later one replaces an
  // earlier one (another Stop hook can continue the turn); a late one for a
  // turn already closed without it is dropped.
  decide(d: TurnEnd): Outgoing[] {
    if (this.closed && !this.lastCloseDecided) return [];
    this.decision = { d, at: this.now() };
    return this.ending !== undefined && this.closedAt !== undefined ? this.closeBy(d) : [];
  }

  feed(ev: TranscriptEvent): Outgoing[] {
    const out: Outgoing[] = [];
    if (this.ending !== undefined && ("messageId" in ev ? ev.messageId !== this.ending : ev.kind === "terminal_input")) {
      out.push(...this.close(false));
    }
    if ("messageId" in ev) {
      this.lastMessageAt = this.now();
      if (!this.ended.includes(ev.messageId)) this.closed = false;
    }
    switch (ev.kind) {
      case "tool_result":
        break;
      case "terminal_input":
      case "channel_seen":
      case "interrupted":
        // A decision made for a turn the user has already left is stale.
        this.decision = undefined;
        if (this.ending !== undefined) out.push(...this.close(false));
        if (ev.kind !== "interrupted") this.byUser = true;
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
          this.closedAt = undefined;
        }
        break;
      case "turn_closed":
        if (this.ending === undefined) {
          this.closed = true;
          this.lastCloseDecided = this.decision !== undefined;
          this.decision = undefined;
          this.byUser = false;
        } else {
          this.pendingAgents = ev.pendingAgents;
          if (this.decision) out.push(...this.closeBy(this.decision.d));
          else this.closedAt = this.now();
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

  // Closes an ended turn whose decision is overdue: 5 s after turn_closed, or,
  // with no turn_closed, 30 s with no main-agent records and no new decision.
  idle(): Outgoing[] {
    if (this.ending === undefined) return [];
    const now = this.now();
    if (this.closedAt !== undefined) return now - this.closedAt >= TURN_DECISION_MS ? this.closeBy(undefined) : [];
    const quietSince = Math.max(this.lastMessageAt, this.decision?.at ?? 0);
    return now - quietSince >= TURN_CLOSE_WAIT_MS ? this.closeBy(this.decision?.d) : [];
  }

  // The window is going away or the session changes: nothing more will come.
  // An ended turn is closed by its decision, if any; text mid-turn goes
  // silently and its decision is dropped. Nothing chimes.
  endTurn(): Outgoing[] {
    if (this.ending !== undefined) return this.close(this.decision !== undefined && this.effective(this.decision.d)?.final === true);
    const out: Outgoing[] = this.enabled && this.pending !== undefined ? [{ text: this.pending, notify: false }] : [];
    this.pending = undefined;
    this.decision = undefined;
    return out;
  }

  // The decision as the relay applies it. A question is final. A turn the
  // user's own message started answers them: final even when background work
  // made the hook call it a pause. Any other turn with background subagents
  // still running is a pause.
  private effective(given: TurnEnd | undefined): TurnEnd | undefined {
    if (given?.final === true && given.kind === "ask") return given;
    if (this.byUser) return given?.final === false ? { final: true, kind: "done" } : given;
    return this.pendingAgents > 0 ? { final: false } : given;
  }

  // The turn is really over: by the decision, or, with none, as a final one
  // that does not report (a broken hook must not chime on every turn).
  private closeBy(given: TurnEnd | undefined): Outgoing[] {
    const d = this.effective(given);
    if (d === undefined) return this.close(true);
    const out = this.close(d.final);
    if (d.final) this.opts.onFinalClose?.(d.kind);
    return out;
  }

  // Sends the pending text (loud for a final turn) and forgets the turn.
  private close(final: boolean): Outgoing[] {
    if (this.ending !== undefined) {
      this.ended.push(this.ending);
      if (this.ended.length > REMEMBERED_ENDS) this.ended.shift();
    }
    this.ending = undefined;
    this.closedAt = undefined;
    this.pendingAgents = 0;
    this.byUser = false;
    this.closed = true;
    this.lastCloseDecided = this.decision !== undefined;
    const out: Outgoing[] = this.enabled && this.pending !== undefined ? [{ text: this.pending, notify: final }] : [];
    this.pending = undefined;
    this.decision = undefined;
    return out;
  }
}
