import type { HubToPlugin } from "../src/shared/protocol.ts";

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "net";
import { z } from "zod";
import { TelegramApi } from "../src/hub/telegram.ts";
import { hubToPlugin } from "../src/shared/protocol-schema.ts";
import { trackTempDir } from "./temp-cleanup.ts";

// A group pace that never holds a call, for tests that are not about it.
export const NO_PACE = { count: 1_000_000, perMs: 1 };

export function tempDir(prefix = "telegramhub-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  trackTempDir(dir);
  return dir;
}

export async function waitFor<T>(
  pred: () => T | undefined | false | null | Promise<T | undefined | false | null>,
  timeoutMs = 3000,
  label = "condition",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(20);
  }
}

// The value a test cannot go on without.
// A client for tests that replace its methods: a method left real fails at once on a closed local
// port instead of reaching Telegram. Port 1 is reserved and nothing listens on it.
export function offlineApi(): TelegramApi {
  return new TelegramApi({ token: "fake", base: "http://127.0.0.1:1", maxAttempts: 1, networkRetryMs: 0, deadlineMs: 0 });
}

export function must<T>(v: T | null | undefined, what = "value"): T {
  if (v == null) throw new Error(`no ${what}`);
  return v;
}

export function memLogger() {
  const lines: string[] = [];
  return {
    lines,
    info: (m: string) => void lines.push(`INFO ${m}`),
    warn: (m: string) => void lines.push(`WARN ${m}`),
    error: (m: string) => void lines.push(`ERROR ${m}`),
  };
}

// A raw WebSocket "plugin" for hub tests.
export async function wsClient(port: number, hello?: object) {
  const messages: HubToPlugin[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.onmessage = e => messages.push(hubToPlugin.parse(JSON.parse(String(e.data))));
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("ws connect failed"));
  });
  let sent = 0;
  const client = {
    ws,
    messages,
    send: (o: object) => {
      sent++;
      ws.send(JSON.stringify(o));
    },
    // Search all received messages, including messages received before this call.
    next: <K extends HubToPlugin["type"]>(type: K, pred: (m: Extract<HubToPlugin, { type: K }>) => boolean = () => true, timeoutMs = 3000) => {
      const ofType = (m: HubToPlugin): m is Extract<HubToPlugin, { type: K }> => m.type === type;
      return waitFor(() => messages.filter(ofType).find(pred), timeoutMs, `hub message ${type}`);
    },
    // The first matching message received after this wait starts.
    nextNew: <K extends HubToPlugin["type"]>(type: K, pred: (m: Extract<HubToPlugin, { type: K }>) => boolean = () => true, timeoutMs = 3000) => {
      const start = messages.length;
      const ofType = (m: HubToPlugin): m is Extract<HubToPlugin, { type: K }> => m.type === type;
      return waitFor(() => messages.slice(start).filter(ofType).find(pred), timeoutMs, `new hub message ${type}`);
    },
    close: () => ws.close(),
  };
  const open = windowsOf(port);
  const entry: WindowSent = { sent: () => sent, received: () => messages.length, isOpen: () => ws.readyState === WebSocket.OPEN };
  open.add(entry);
  ws.addEventListener("close", () => open.delete(entry));
  if (hello) client.send(hello);
  return client;
}

// What each test window has sent and received, per hub port, so `settled` can tell when the hub has taken all it was sent and the window has all the hub wrote.
type WindowSent = { sent(): number; received(): number; isOpen(): boolean };
const windowsByPort = new Map<number, Set<WindowSent>>();

function windowsOf(port: number): Set<WindowSent> {
  const existing = windowsByPort.get(port);
  if (existing) return existing;
  const created = new Set<WindowSent>();
  windowsByPort.set(port, created);
  return created;
}

// HTTP requests a test sent to each hub through `hubFetch` (per hub object: a hub restarted on a port counts from zero).
const requestsByHub = new WeakMap<object, number>();

// An HTTP request to the hub that `settled` counts: it is settled only once the hub has taken it.
export async function hubFetch(hub: { port: number }, path: string, init?: RequestInit): Promise<Response> {
  requestsByHub.set(hub, (requestsByHub.get(hub) ?? 0) + 1);
  return fetch(`http://127.0.0.1:${hub.port}${path}`, init);
}

// What the hub exposes so a test can tell it has handled everything sent to it.
export type Settleable = {
  port: number;
  intake(): { windows: number; messages: number; sent: number; requests: number };
  busy(): string[];
};

const SETTLE_TIMEOUT_MS = 5000;
// Two quiet looks in a row, a turn of the event loop apart: work a handler started after the first look shows in the second.
const QUIET_LOOKS = 2;

// Resolves once the hub has fully handled everything the test sent so far: every WS message from the test
// windows, every HTTP request made through `hubFetch`, every update pushed to the fake Telegram, and all work
// those started; and every message the hub wrote to a window has reached it. Use it before a "nothing happened" assertion instead of sleeping. It is a proof, not a pause:
// when something stays unfinished it throws and names it.
export async function settled(hub: Settleable, o: { fake?: { unconfirmedUpdates: number }; timeoutMs?: number } = {}): Promise<void> {
  const deadline = Date.now() + (o.timeoutMs ?? SETTLE_TIMEOUT_MS);
  let quiet = 0;
  for (;;) {
    const unmet = unmetCondition(hub, o.fake);
    if (unmet === undefined) {
      quiet++;
      if (quiet >= QUIET_LOOKS) return;
    } else {
      quiet = 0;
      if (Date.now() > deadline) throw new Error(`hub did not settle: ${unmet}`);
    }
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

function unmetCondition(hub: Settleable, fake: { unconfirmedUpdates: number } | undefined): string | undefined {
  const windows = [...windowsOf(hub.port)].filter(w => w.isOpen());
  const intake = hub.intake();
  if (intake.windows !== windows.length) return `hub counts ${intake.windows} windows, the test has ${windows.length} open`;
  const sent = windows.reduce((sum, w) => sum + w.sent(), 0);
  if (intake.messages < sent) return `hub took ${intake.messages} of ${sent} window messages`;
  const received = windows.reduce((sum, w) => sum + w.received(), 0);
  if (received < intake.sent) return `windows received ${received} of ${intake.sent} hub messages`;
  const requests = requestsByHub.get(hub) ?? 0;
  if (intake.requests < requests) return `hub took ${intake.requests} of ${requests} http requests`;
  if (fake && fake.unconfirmedUpdates > 0) return `${fake.unconfirmedUpdates} telegram updates not handled`;
  const busy = hub.busy();
  if (busy.length > 0) return `unfinished work: ${busy.join(", ")}`;
  return undefined;
}

const healthSchema = z.object({ pid: z.number() });

// The pid of the hub listening on the port, or undefined when none answers.
export async function hubHealth(port: number): Promise<{ pid: number } | undefined> {
  try {
    return healthSchema.parse(await (await fetch(`http://127.0.0.1:${port}/health`)).json());
  } catch {
    return undefined;
  }
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") return reject(new Error("no TCP port"));
      srv.close(() => resolve(addr.port));
    });
  });
}

export const hasFfmpeg = !!Bun.which("ffmpeg") && !!Bun.which("ffprobe");

// A real H.264 clip made by ffmpeg, like the screen recordings the hub sends.
export function makeVideo(path: string, o: { width?: number; height?: number; seconds?: number; rotation?: number } = {}): void {
  const size = `${o.width ?? 640}x${o.height ?? 360}`;
  const args = ["-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", `testsrc=size=${size}:rate=25:duration=${o.seconds ?? 3}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];
  const plain = o.rotation ? `${path}.plain.mp4` : path;
  const run = (a: string[]) => {
    const r = Bun.spawnSync(["ffmpeg", ...a], { stderr: "pipe", windowsHide: true });
    if (r.exitCode !== 0) throw new Error(`ffmpeg failed: ${r.stderr.toString()}`);
  };
  run([...args, plain]);
  if (o.rotation) {
    run(["-v", "error", "-nostdin", "-y", "-display_rotation", String(o.rotation), "-i", plain, "-c", "copy", path]);
    rmSync(plain);
  }
}
