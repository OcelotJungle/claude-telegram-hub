import { describe, expect, test } from "bun:test";
import { installCrashLogging, installStopSignals, makeStop } from "../src/hub/process-guard.ts";
import { memLogger } from "./helpers.ts";

// A process stand-in that records listeners and lets a test fire the event.
function fakeProcess() {
  const listeners = new Map<string, ((arg?: unknown) => void)[]>();
  const add = (event: string, listener: (arg?: unknown) => void) => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    return undefined;
  };
  return {
    on: add,
    once: add,
    count: (event: string) => (listeners.get(event) ?? []).length,
    emit: (event: string, arg?: unknown) => { for (const listener of listeners.get(event) ?? []) listener(arg); },
  };
}

describe("hub process handlers", () => {
  test("an unhandled rejection is logged and the process is not stopped", () => {
    const proc = fakeProcess();
    const log = memLogger();
    const exits: number[] = [];
    installCrashLogging(proc, log);
    installStopSignals(proc, makeStop(async () => {}, code => { exits.push(code); }, log));
    proc.emit("unhandledRejection", new Error("boom"));
    proc.emit("uncaughtException", new Error("bang"));
    expect(log.lines).toEqual(["ERROR unhandled rejection: Error: boom", "ERROR uncaught exception: Error: bang"]);
    expect(exits).toEqual([]);
  });

  test("SIGTERM and SIGINT take the stop path: hub stopped, then exit 0", async () => {
    for (const signal of ["SIGTERM", "SIGINT"]) {
      const proc = fakeProcess();
      const order: string[] = [];
      const exited = new Promise<number>(resolve => {
        installStopSignals(proc, makeStop(async () => { order.push("stop"); }, code => { order.push("exit"); resolve(code); }, memLogger()));
      });
      proc.emit(signal);
      expect(await exited).toBe(0);
      expect(order).toEqual(["stop", "exit"]);
    }
  });

  test("a failing stop is logged and the process still exits 0", async () => {
    const proc = fakeProcess();
    const log = memLogger();
    const exited = new Promise<number>(resolve => {
      installStopSignals(proc, makeStop(() => Promise.reject(new Error("stuck")), resolve, log));
    });
    proc.emit("SIGTERM");
    expect(await exited).toBe(0);
    expect(log.lines).toEqual(["ERROR stop failed: Error: stuck"]);
  });

  test("both signals are registered once each", () => {
    const proc = fakeProcess();
    installStopSignals(proc, () => {});
    expect(proc.count("SIGTERM")).toBe(1);
    expect(proc.count("SIGINT")).toBe(1);
  });
});
