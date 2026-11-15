import { plural } from "../plural.ts";

// Every text the hub or a window's plugin shows a person in Telegram. A message with
// values is a function of named parameters, so the catalog owns the word order.
// ru.ts has the same type: a missing or extra key fails the type check.
const LANGUAGE = "en";

export const en = {
  // Units in durations and sizes.
  unitSecond: "s",
  unitMinute: "min",
  unitHour: "h",
  unitDay: "d",
  unitMegabyte: "MB",

  // The bot command menu (setMyCommands).
  commandInfo: "Session limits and context",
  commandCompact: "Compact the context; /compact <instructions> adds instructions",
  commandRename: "Rename the session and its topic; /rename <name> is the new name",
  commandRun: "Start the session; /run N starts it on account N",
  commandStop: "End the session",
  commandCleanup: "Compact the context, remove accumulated skills and end the session",
  commandMode: "Show or change the permission mode",
  commandPwsh: "Run a command in PowerShell in the session folder",
  commandCmd: "Run a command in cmd in the session folder",
  commandBash: ({ shell }: { shell: string }) => `Run a command in ${shell} in the session folder`,
  commandRig: "Machine state, features and update: /rig status|update|feature|language",

  // Topic and session.
  untitledTopic: "untitled",
  sessionLaunched: "✅ Session started",
  sessionEnded: "⏹ Session ended",
  sessionNotRunning: "Session is not running",
  sessionAlreadyStarting: "Session is already starting",
  sessionEnding: "Session is being stopped or cleaned up",
  sessionAlreadyRunning: "Session is already running",
  launching: ({ account }: { account: string | undefined }) => account ? `🚀 Starting the session (account ${account})…` : "🚀 Starting the session…",
  noAccounts: "This machine has no cswap accounts. Use /run without a number.",
  sessionDidNotStart: ({ seconds }: { seconds: number }) => `⚠️ The session did not start within ${seconds} s`,
  restartingInMode: ({ mode }: { mode: string }) => `🔁 Restarting the session in ${mode} mode…`,
  modeList: ({ modes }: { modes: string }) => `Modes: ${modes}`,
  modeAlready: ({ mode }: { mode: string }) => `Mode is already ${mode}`,
  modeUnknown: "mode unknown",
  modeCurrent: ({ mode }: { mode: string }) => `Current mode: ${mode}`,
  modeLastKnown: ({ mode }: { mode: string }) => `Last known mode: ${mode}`,
  telegramRejected: ({ reason }: { reason: string }) => `⚠️ Telegram did not accept the message: ${reason}. The text is in hub.log.`,
  pendingDelivery: ({ count }: { count: number }) => `⏳ Waiting for delivery: ${count}. The messages are kept until the next start`,

  // /cleanup.
  cleanupDone: ({ before, after }: { before: string; after: string }) => `🧹 Cleanup done: ${before} → ${after} tokens.`,
  cleanupDoneSkills: ({ before, after, skills }: { before: string; after: string; skills: number }) =>
    `🧹 Cleanup done: ${before} → ${after} tokens, skills removed: ${skills}.`,

  // Permission prompts.
  permissionNeeded: ({ toolName }: { toolName: string }) => `🔐 Confirmation needed: ${toolName}`,
  permissionAllow: "✅ Allow",
  permissionDeny: "❌ Deny",
  permissionAllowed: "✅ Allowed",
  permissionDenied: "❌ Denied",
  permissionStale: "The request is outdated",
  permissionNotDelivered: "⚠️ The session is not active, the answer was not delivered",

  // Polls (AskUserQuestion).
  pollCustomHint: "Write the answer in the next message",
  pollStale: "The poll is outdated",
  pollPickOne: "Pick at least one option",
  pollCancelled: "✖️ Poll cancelled",
  pollMovedToTerminal: "⌛ The poll was moved to the terminal",
  pollHead: ({ index, total, header }: { index: number; total: number; header: string | undefined }) =>
    total > 1 ? `Question ${index} of ${total}${header ? `: ${header}` : ""}` : header ?? "",
  pollDone: "✅ Done",
  pollCustom: "✏️ Own option",
  pollCancel: "✖️ Cancel",

  // Rig: confirmation, lifecycle, status.
  rigDisableAsk: "Turn Telegram off on this machine?",
  rigDisableButton: "Turn Telegram off",
  rigConfirmHandled: "The confirmation was already handled or is outdated",
  rigConfirmOutdated: "The confirmation is outdated, send the command again",
  rigConfirmed: "Confirmed",
  rigRecovery: "Turn Telegram back on at the server: `rig feature telegram enable`",
  rigMissing: "rig is not installed on this machine",
  rigFeaturesLoading: "The rig feature state is still loading",
  rigFeatureUsage: "Use /rig feature or /rig feature <name> enable|disable",
  rigUsage: "Use /rig status, /rig update, /rig language [en|ru], /rig feature or /rig feature <name> enable|disable",
  rigPercentPath: ({ file }: { file: string }) => `rig: a path with "%" cannot be passed to cmd.exe: ${file}`,
  rigTimeout: ({ seconds }: { seconds: number }) => `rig: the query took longer than ${seconds} s`,
  rigExitCode: ({ code, output }: { code: number; output: string }) => `rig: exit code ${code}: ${output}`,
  rigInvalidJson: ({ message }: { message: string }) => `rig: invalid JSON: ${message}`,
  rigFailure: ({ message }: { message: string }) => `rig: ${message}`,
  commandUnavailable: ({ name }: { name: string }) => `/${name} is not available on this platform`,
  commandDisabled: ({ name }: { name: string }) => `/${name} is off or unavailable. Turn it on: /rig feature ${name} enable`,
  featureNotOnPlatform: "(not available on this platform)",
  featuresEmpty: "The feature list is empty",
  statusMode: ({ mode }: { mode: string }) => `Mode: ${mode}`,
  statusLastUpdate: ({ text }: { text: string }) => `Last update: ${text}`,
  statusPendingRestart: ({ text }: { text: string }) => `Expected restart: ${text}`,
  commitUnknown: "The hub could not determine the commit of its code, so it cannot handle the update. It keeps trying.",
  codeChanged: "The hub is running with different code. Windows will pick it up on their next start.",

  // Shell commands from the topic.
  execUsage: ({ name }: { name: string }) => `Write the command: \`/${name} npm run migrate\``,
  execCmdOneLine: "/cmd runs one line. For several use /pwsh or /bash",
  execCwdUnsafe: "The folder name has a quote or a percent sign, which a Windows command line cannot carry",
  execNoCwd: "⚠️ I do not know which folder to run the command in: it is neither in the hub's record nor in the transcript",
  execNotSet: "⚠️ Shell commands are not set up in this hub",
  execNotFound: "Run not found",
  execAlreadyEnded: "The command has already ended",
  execAlreadyRunning: "The command is already running",
  execStarting: "Starting",
  execNotStarted: "The command has not started yet",
  execStopping: "Stopping",
  execStopButton: "⏹ Stop",
  execRunButton: "▶ Run",
  execLogTrimmed: ({ limit, size }: { limit: string; size: string }) => `[log trimmed: the last ${limit} of ${size}]`,
  execOutcomeStopped: "⏹ stopped",
  execOutcomeLost: ({ reason }: { reason: string }) => `⚠️ interrupted: ${reason}`,
  execOutcomeOk: "✅ code 0",
  execOutcomeCode: ({ code }: { code: number | undefined }) => `❌ code ${code}`,
  execLostProcessGone: "the process disappeared",
  execRigNoResult: ({ reason }: { reason: string }) => `rig printed no usable answer (${reason})`,
  execOutcomeFailed: ({ error }: { error: string }) => `❌ did not start: ${error}`,
  execRigSilent: ({ reason }: { reason: string }) => `⚠️ rig is not answering about this command (${reason}); still waiting`,
  execStartUnknown: "⚠️ The hub restarted while starting this command: it is not known whether it started",
  execPending: ({ minutes }: { minutes: number }) => `⏸ The command arrived ${minutes} min ago while the hub was off`,

  // Session actions run by rig: what the topic sees while and after rig works.
  renameHint: "Write the name: /rename new name",
  sessionWaiting: "⏳ Waiting for the turn to end…",
  sessionRestartHint: "Restart the session so that it loads the hooks module, then try again.",
  compactRunning: "🗜 Compaction is running…",
  autocompactUnavailable: "Setting the autocompact window from the topic is not available yet.",
  compactDoneTokens: ({ before, after }: { before: string; after: string }) => `✅ Compaction done: ${before} → ${after} tokens.`,
  compactFailed: ({ error }: { error: string }) => `⚠️ Compaction failed: ${error}`,
  compactSkipped: ({ reason }: { reason: string }) => `⚠️ Compaction skipped: ${reason}`,
  renameRunning: "🏷 Renaming…",
  renameDone: ({ name }: { name: string }) => `✅ Renamed: ${name}`,
  cleanupRunning: "🧹 Cleanup is running…",
  stopRunning: "⏹ Ending the session…",
  limitFiveHour: "5 hours",
  limitSevenDay: "Week",
  infoClaudeNoData: "Claude limits: no data, they appear after the model's first reply",
  infoClaudeLimits: ({ age }: { age: string | undefined }) => age ? `**Claude limits** (data ${age} old)` : "**Claude limits**",
  infoCodexLimits: ({ age }: { age: string | undefined }) => age ? `**Codex limits** (data ${age} old)` : "**Codex limits**",
  infoVolunteerLimits: ({ age }: { age: string | undefined }) => age ? `**Volunteer limits** (data ${age} old)` : "**Volunteer limits**",
  infoLimitLine: ({ name, percent, resetIn }: { name: string; percent: number; resetIn: string | undefined }) =>
    `${name}: ${percent}%${resetIn ? ` (resets in ${resetIn})` : ""}`,
  infoVolunteerDay: ({ percent, resetIn }: { percent: number; resetIn: string | undefined }) => resetIn ? `Day: ${percent}% (resets in ${resetIn})` : `Day: ${percent}%`,
  // A block of /info whose source failed: rig's own message follows.
  infoClaudeUnavailable: ({ reason }: { reason: string }) => `Claude limits: unavailable, ${reason}`,
  infoVolunteerUnavailable: ({ reason }: { reason: string }) => `Volunteer limits: unavailable, ${reason}`,
  infoCodexUnavailable: ({ reason }: { reason: string }) => `Codex limits: unavailable, ${reason}`,
  infoContextUnavailable: ({ reason }: { reason: string }) => `unavailable, ${reason}`,
  infoContext: ({ age }: { age: string | undefined }) => age ? `**Context** (data ${age} old)` : "**Context**",
  infoNoData: "no data",
  // The words of a rig card: its progress lines and its result.
  rigProgressLockWaiting: "waiting for rig to be free",
  rigProgressProgramInstall: ({ name, command }: { name: string; command: string }) => `installing ${name}: ${command}`,
  rigProgressServiceStopping: "stopping the service",
  // A step of rig this hub has no words for yet: its code is all there is to show.
  rigProgressUnknown: ({ code }: { code: string }) => `rig: ${code}`,
  rigFeatureEnabled: ({ name }: { name: string }) => `Feature ${name} enabled`,
  rigFeatureDisabled: ({ name }: { name: string }) => `Feature ${name} disabled`,
  rigUpdateComplete: ({ pending }: { pending: boolean }): string => pending ? "Pending update complete" : "Update complete",
  rigUpdateChecked: ({ pending }: { pending: boolean }): string => pending ? "Pending update checked" : "Update checked",
  rigUpdateDeferred: ({ pending }: { pending: boolean }): string => pending ? "Pending update check deferred: rig is busy" : "Update deferred: rig is busy",
  rigLanguageIs: ({ language }: { language: string }) => `Language: ${language}`,
  rigLanguageChanged: ({ language }: { language: string }) => `Language: ${language} (changed)`,
  rigLanguageUnchanged: ({ language }: { language: string }) => `Language: ${language} (already set)`,
  rigBadSession: "rig: the session id is not valid",
  rigControlChar: "rig: the text has a character a Windows command line cannot carry (a line break or a null)",
  rigBadAccount: "rig: the account name is not valid",
  rigBadMode: "rig: the permission mode is not valid",
  execNotRecorded: "the hub could not save the run, so it did not start it",

  // Subagent cards and API failures.
  subagentContinued: "⬇️ continued below",
  subagentName: "Subagent",
  subagentActions: ({ count }: { count: number }) => `${count} ${plural(LANGUAGE, count, { one: "action", other: "actions" })}`,
  subagentAsking: ({ name }: { name: string }) => `❓ ${name} is waiting for an answer`,
  subagentEventAt: ({ clock }: { clock: string }) => `event ${clock}`,
  subagentWaitingForJob: ({ duration }: { duration: string }) => `waiting for a background task ${duration}`,
  apiFailure: ({ count }: { count: number }) =>
    `⚠️ The API connection failed ${count} ${plural(LANGUAGE, count, { one: "time", other: "times" })} in a row, the agent stopped.`,
};

export type Messages = typeof en;
