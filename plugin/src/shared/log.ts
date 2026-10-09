import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export type Logger = {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
};

export function createLogger(file: string, tag: string): Logger {
  const write = (level: string, msg: string) => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${new Date().toISOString()} ${level} [${tag} ${process.pid}] ${msg}\n`);
    } catch {}
  };
  return {
    info: m => write("INFO", m),
    warn: m => write("WARN", m),
    error: m => write("ERROR", m),
  };
}

export const nullLogger: Logger = { info() {}, warn() {}, error() {} };
