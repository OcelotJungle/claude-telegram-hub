// Hub entry point. Started detached by a plugin that found no hub; exits at
// once if another hub already holds the port.
import { apiBase, hubPort, idleMs, loadConfig, loadToken, paths } from '../shared/config.ts'
import { createLogger } from '../shared/log.ts'
import { Hub } from './hub.ts'
import { TelegramApi } from './telegram.ts'

const p = paths()
const log = createLogger(p.logFile, 'hub')

process.on('unhandledRejection', e => log.error(`unhandled rejection: ${e}`))
process.on('uncaughtException', e => log.error(`uncaught exception: ${e}`))

const token = loadToken()
const hub = new Hub({
  port: hubPort(),
  sessionsFile: p.sessionsFile,
  outboxFile: p.outboxFile,
  spoolDir: p.spoolDir,
  filesDir: p.filesDir,
  inboxDir: p.inboxDir,
  api: token ? new TelegramApi({ token, base: apiBase(), log }) : undefined,
  config: loadConfig,
  idleMs: idleMs(),
  pollTimeoutSec: Number(process.env.TG_HUB_POLL_TIMEOUT) || 25,
  log,
  onExit: () => process.exit(0),
})

if (!hub.start()) process.exit(0)
