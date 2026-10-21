import type { Logger } from "../shared/log.ts";
import type { HubRequest, HubToPlugin, PluginToHub } from "../shared/protocol.ts";

import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { homedir } from "os";
import { hubToPlugin } from "../shared/protocol-schema.ts";

const SPAWN_COOLDOWN_MS = 2000;
const REQUEST_TIMEOUT_MS = 15_000;
const DRAIN_POLL_MS = 25;
const MIN_RECONNECT_DELAY_MS = 100;
const MAX_RECONNECT_DELAY_MS = 5000;
// A reconnect delay varies by this share either way, so windows that lost the
// hub together do not knock at the same moment.
const RECONNECT_JITTER = 0.25;
// How much of a message the plugin cannot read goes into the log.
const LOGGED_MESSAGE_CHARS = 200;

type Hello = Extract<PluginToHub, { type: "hello" }>;
export type SendFiles = Extract<PluginToHub, { type: "sendFiles" }>;
// What the hub must ack: text and files for a topic.
export type Queued = Extract<PluginToHub, { type: "send" }> | SendFiles;
type Pending = { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> };

// Starts the hub as a detached process: not tied to this window, so closing
// the window that started it leaves the hub running for the others.
export function spawnHubDetached(hubMain: string, env?: Record<string, string>): void {
  const child = spawn(process.execPath, [hubMain], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: homedir(),
    env: { ...process.env, ...env },
  });
  child.on("error", () => {});
  child.unref();
}

// The plugin's link to the hub. Reconnects forever with backoff; when nobody
// listens it starts a hub (losers of a start race exit on EADDRINUSE). Text to
// send is kept until the hub acks it (the hub acks once the text is in its
// queue on disk) and is re-sent after a reconnect, so nothing is lost when the
// hub dies.
export class HubClient {
  private ws: WebSocket | undefined;
  private stopped = true;
  private attempt = 0;
  private lastSpawn = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private outbox: Queued[] = [];
  private pending = new Map<string, Pending>();
  private fileWaiters = new Map<string, (r: { error?: string }) => void>();
  private waiters: (() => void)[] = [];

  constructor(
    private opts: {
      port: number;
      hello: () => Hello;
      spawnHub: () => void;
      onMessage(m: HubToPlugin): void;
      log: Logger;
      minDelayMs?: number;
      maxDelayMs?: number;
    },
  ) {}

  get connected(): boolean {
    return this.ws !== undefined;
  }

  // Messages the hub has not acked yet, oldest first.
  get unacked(): readonly Queued[] {
    return this.outbox;
  }

  // Starts a hub now, for text left behind by a closing window.
  spawnHubNow(): void {
    this.lastSpawn = 0;
    this.maybeSpawn();
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
  }

  send(msg: PluginToHub): void {
    if (!this.ws) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {}
  }

  enqueue(sessionId: string, text: string, notify: boolean): void {
    this.push({ type: "send", id: randomUUID(), sessionId, text, notify });
  }

  // Resolves with the hub's result once every send of the files is done, or
  // with undefined after timeoutMs; the files stay queued either way.
  sendFiles(msg: SendFiles, timeoutMs: number): Promise<{ error?: string } | undefined> {
    const result = new Promise<{ error?: string } | undefined>(resolve => {
      const timer = setTimeout(() => {
        this.fileWaiters.delete(msg.id);
        resolve(undefined);
      }, timeoutMs);
      this.fileWaiters.set(msg.id, r => {
        clearTimeout(timer);
        this.fileWaiters.delete(msg.id);
        resolve(r);
      });
    });
    this.push(msg);
    return result;
  }

  private push(item: Queued): void {
    this.outbox.push(item);
    this.send(item);
  }

  // Resolves once every queued text is acked by the hub, or after timeoutMs.
  async drain(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.outbox.length > 0 && Date.now() < deadline) await Bun.sleep(DRAIN_POLL_MS);
  }

  async request(req: HubRequest, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    if (!this.ws) await this.waitConnected(timeoutMs);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("hub did not answer in time"));
      }, Math.max(1, deadline - Date.now()));
      this.pending.set(id, { resolve, reject, timer });
      this.send({ type: "req", id, ...req });
    });
  }

  private waitConnected(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w !== done);
        reject(new Error("tg-hub: the hub is not reachable"));
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(done);
    });
  }

  private connect(): void {
    if (this.stopped) return;
    let opened = false;
    const ws = new WebSocket(`ws://127.0.0.1:${this.opts.port}/ws`);
    ws.onopen = () => {
      if (this.stopped) return ws.close();
      opened = true;
      this.attempt = 0;
      this.ws = ws;
      this.opts.log.info("connected to hub");
      this.send(this.opts.hello());
      for (const item of this.outbox) this.send(item);
      for (const w of this.waiters.splice(0)) w();
    };
    ws.onmessage = e => this.onMessage(String(e.data));
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws === ws) {
        this.ws = undefined;
        this.opts.log.warn("hub connection lost");
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error("hub connection lost"));
          this.pending.delete(id);
        }
      }
      if (this.stopped) return;
      if (!opened) this.maybeSpawn();
      this.scheduleReconnect();
    };
  }

  private maybeSpawn(): void {
    if (Date.now() - this.lastSpawn < SPAWN_COOLDOWN_MS) return;
    this.lastSpawn = Date.now();
    this.opts.log.info("no hub listening — starting one");
    try {
      this.opts.spawnHub();
    } catch (e) {
      this.opts.log.error(`starting hub failed: ${e}`);
    }
  }

  private scheduleReconnect(): void {
    const min = this.opts.minDelayMs ?? MIN_RECONNECT_DELAY_MS;
    const max = this.opts.maxDelayMs ?? MAX_RECONNECT_DELAY_MS;
    const delay = Math.min(min * 2 ** this.attempt, max) * (1 + RECONNECT_JITTER * (2 * Math.random() - 1));
    this.attempt++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private onMessage(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = hubToPlugin.safeParse(json);
    if (!parsed.success) {
      this.opts.log.warn(`unknown message from the hub: ${raw.slice(0, LOGGED_MESSAGE_CHARS)}`);
      return;
    }
    const m = parsed.data;
    if (m.type === "ack") {
      this.outbox = this.outbox.filter(o => o.id !== m.id);
      return;
    }
    if (m.type === "filesSent") {
      const waiter = this.fileWaiters.get(m.id);
      // Nobody waits any more: the call ended before the hub was done.
      if (!waiter) this.opts.onMessage(m);
      else waiter({ ...(m.error ? { error: m.error } : {}) });
      return;
    }
    if (m.type === "res") {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error ?? "hub error"));
      return;
    }
    this.opts.onMessage(m);
  }
}
