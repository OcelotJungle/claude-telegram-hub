import type { Server } from "net";

import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { sendInterrupt } from "../src/plugin/interrupt.ts";
import { waitFor } from "./helpers.ts";

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

function socketPath(): string {
  const name = `telegram-hub-test-${randomUUID()}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

// An inbox that keeps the lines of each connection.
function inbox(path: string, got: unknown[][]): Promise<void> {
  server = createServer(c => {
    let data = "";
    c.on("data", d => (data += d));
    c.on("end", () => void got.push(data.trim().split("\n").map(l => JSON.parse(l))));
  });
  const s = server;
  return new Promise(resolve => s.listen(path, resolve));
}

describe("sendInterrupt", () => {
  test("authenticates and sends the note with priority now", async () => {
    const path = socketPath();
    const got: unknown[][] = [];
    await inbox(path, got);
    await sendInterrupt(path, "tok-1", "\u0441\u0442\u043e\u0439");
    await waitFor(() => got.length === 1, 3000, "the note");
    expect(got[0]).toEqual([
      { type: "auth", token: "tok-1" },
      { type: "user", message: { role: "user", content: "\u0441\u0442\u043e\u0439" }, priority: "now", from_plugin: "telegram-hub" },
    ]);
  });

  test("fails when nobody listens", async () => {
    await expect(sendInterrupt(socketPath(), "tok-1", "\u0441\u0442\u043e\u0439")).rejects.toThrow();
  });
});
