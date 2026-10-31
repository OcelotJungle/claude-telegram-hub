import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { HubClient } from "../src/plugin/hub-client.ts";
import { paths } from "../src/shared/config.ts";
import { PROTOCOL_VERSION } from "../src/shared/protocol.ts";
import { freePort, memLogger, tempDir, waitFor } from "./helpers.ts";

const RECONNECT_MS = 5;
const WAIT_MS = 5000;
const FAILED_ATTEMPTS = 3;

const clients: HubClient[] = [];
const servers: { stop(close?: boolean): void }[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.stop();
  for (const server of servers.splice(0)) server.stop(true);
});

function setup(port: number, managed: () => boolean, spawnHub: () => void) {
  const client = new HubClient({
    port,
    hello: () => ({ type: "hello", v: PROTOCOL_VERSION, windowKey: "win", sessionId: "s", cwd: "C:\\work" }),
    spawnHub,
    serviceManaged: managed,
    onMessage: () => {},
    log: memLogger(),
    minDelayMs: RECONNECT_MS,
    maxDelayMs: RECONNECT_MS,
  });
  clients.push(client);
  return client;
}

describe("a hub owned by a service", () => {
  test("a window that finds no hub waits and connects, it never starts one", async () => {
    const port = await freePort();
    let checks = 0;
    let spawned = 0;
    const client = setup(port, () => { checks++; return true; }, () => { spawned++; });
    client.start();
    await waitFor(() => checks >= FAILED_ATTEMPTS, WAIT_MS, "failed connection attempts");
    expect(spawned).toBe(0);
    // The service brings the hub up later: the window connects to it.
    servers.push(Bun.serve({ port, fetch: (request, server) => server.upgrade(request) ? undefined : new Response("no"), websocket: { message() {} } }));
    await waitFor(() => client.connected, WAIT_MS, "connected");
    expect(spawned).toBe(0);
  });

  test("without the marker a window starts a hub when none listens", async () => {
    const port = await freePort();
    let spawned = 0;
    const client = setup(port, () => false, () => { spawned++; });
    client.start();
    await waitFor(() => spawned >= 1, WAIT_MS, "hub start");
  });

  test("the marker is a file in the state directory, found through paths()", () => {
    const previous = process.env.TELEGRAM_HUB_STATE_DIR;
    const dir = tempDir();
    process.env.TELEGRAM_HUB_STATE_DIR = dir;
    try {
      const file = paths().serviceManagedFile;
      expect(file).toBe(join(dir, "service-managed"));
      expect(existsSync(file)).toBe(false);
      writeFileSync(file, "");
      expect(existsSync(paths().serviceManagedFile)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.TELEGRAM_HUB_STATE_DIR;
      else process.env.TELEGRAM_HUB_STATE_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
