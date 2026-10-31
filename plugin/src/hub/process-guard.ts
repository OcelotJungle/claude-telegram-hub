// Process-level handlers of the hub entry point, with the process and callbacks passed in so they can be tested.
import type { Logger } from "../shared/log.ts";

export type CrashEvent = "unhandledRejection" | "uncaughtException";
export type StopSignal = "SIGTERM" | "SIGINT";

export type CrashSource = {
  on(event: CrashEvent, listener: (error: unknown) => void): unknown;
};
export type SignalSource = {
  once(event: StopSignal, listener: () => void): unknown;
};

// A rejection or exception nobody handled is logged and the hub keeps running.
export function installCrashLogging(source: CrashSource, log: Logger): void {
  source.on("unhandledRejection", e => log.error(`unhandled rejection: ${e}`));
  source.on("uncaughtException", e => log.error(`uncaught exception: ${e}`));
}

// A failing stop is logged, and the process still ends: a signal that leaves it running would hang the service stop.
export function makeStop(stopHub: () => Promise<void>, exit: (code: number) => void, log: Logger): () => void {
  return () => { void stopHub().catch(error => log.error(`stop failed: ${error}`)).then(() => exit(0)); };
}

export function installStopSignals(source: SignalSource, stop: () => void): void {
  source.once("SIGTERM", stop);
  source.once("SIGINT", stop);
}
