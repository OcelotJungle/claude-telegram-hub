// Hub entry point. Started detached by a plugin that found no hub; exits at
// once if another hub already holds the port.
import { homedir } from "os";
import { join } from "path";
import { apiBase, hubPort, idleMs, loadConfig, loadToken, paths } from "../shared/config.ts";
import { createLogger } from "../shared/log.ts";
import { Hub } from "./hub.ts";
import { installCrashLogging, installStopSignals, makeStop } from "./process-guard.ts";
import { TelegramApi } from "./telegram.ts";

const p = paths();
const log = createLogger(p.logFile, "hub");

installCrashLogging(process, log);

const token = loadToken();
const hub = new Hub({
  port: hubPort(),
  sessionsFile: p.sessionsFile,
  outboxFile: p.outboxFile,
  cardsFile: p.cardsFile,
  pollOffsetFile: p.pollOffsetFile,
  spoolDir: p.spoolDir,
  filesDir: p.filesDir,
  inboxDir: p.inboxDir,
  execDir: p.execDir,
  execsFile: p.execsFile,
  rigDir: join(homedir(), ".agent-rig"),
  repository: join(import.meta.dir, "..", "..", ".."),
  // Every cswap profile links its projects/ here.
  projectsDir: join(homedir(), ".claude", "projects"),
  api: token ? new TelegramApi({ token, base: apiBase(), log }) : undefined,
  config: loadConfig,
  // --always-on: started by the Task Scheduler (scripts/install-hub-task.ps1).
  idleMs: process.argv.includes("--always-on") ? 0 : idleMs(),
  pollTimeoutSec: Number(process.env.TELEGRAM_HUB_POLL_TIMEOUT) || undefined,
  log,
  onExit: (code = 0) => process.exit(code),
});

if (!hub.start()) process.exit(0);

installStopSignals(process, makeStop(() => hub.stop(), code => process.exit(code), log));
