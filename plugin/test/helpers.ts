import type { HubToPlugin } from "../src/shared/protocol.ts";

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "net";
import { z } from "zod";
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
  const client = {
    ws,
    messages,
    send: (o: object) => ws.send(JSON.stringify(o)),
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
  if (hello) client.send(hello);
  return client;
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
