// Runtime checks of the protocol messages, typed against protocol.ts: a
// message type changed on one side and not here fails the type check.
// protocol.ts itself has no imports, so the function hooks module can use it.
import type { AskQuestion, CleanupReport, CommandReply, EnableResult, HookBody, HubToPlugin, LimitsPost, PluginToHub, QuestionBody, QuestionDecision, QueuedFile, RateLimit, TerminateRequest, TurnEndBody } from "./protocol.ts";

import { z } from "zod";

const queuedFile: z.ZodType<QueuedFile> = z.object({ path: z.string(), name: z.string(), size: z.number() });

export const sendFilesMessage = z.object({
  type: z.literal("sendFiles"),
  id: z.string(),
  sessionId: z.string(),
  files: z.array(queuedFile),
  caption: z.string(),
  notify: z.boolean(),
  asDocument: z.boolean().optional(),
});

export const sendMessage = z.object({ type: z.literal("send"), id: z.string(), sessionId: z.string().optional(), text: z.string(), notify: z.boolean() });

export const pluginToHub: z.ZodType<PluginToHub> = z.union([
  z.object({ type: z.literal("hello"), v: z.number(), windowKey: z.string(), sessionId: z.string(), cwd: z.string(), configDir: z.string().optional(), busy: z.boolean().optional(), reportsSeen: z.boolean().optional(), entrypoint: z.string().optional(), title: z.string().optional() }),
  z.object({ type: z.literal("session"), sessionId: z.string(), cwd: z.string(), configDir: z.string().optional(), entrypoint: z.string().optional(), title: z.string().optional() }),
  z.object({ type: z.literal("req"), id: z.string(), op: z.literal("enable"), title: z.string() }),
  z.object({ type: z.literal("req"), id: z.string(), op: z.literal("disable") }),
  z.object({ type: z.literal("req"), id: z.string(), op: z.literal("download"), fileId: z.string() }),
  sendMessage,
  sendFilesMessage,
  z.object({ type: z.literal("permission"), requestId: z.string().optional(), toolName: z.string(), description: z.string(), inputPreview: z.string().optional() }),
  z.object({ type: z.literal("title"), title: z.string() }),
  z.object({ type: z.literal("card"), id: z.string(), sessionId: z.string(), text: z.string(), final: z.boolean(), reopen: z.boolean().optional(), replyTo: z.string().optional() }),
  z.object({ type: z.literal("seen"), messageIds: z.array(z.number()) }),
  z.object({ type: z.literal("busy"), busy: z.boolean() }),
  z.object({ type: z.literal("exiting"), pid: z.number() }),
  z.object({ type: z.literal("caughtUp"), id: z.string() }),
]);

export const hubToPlugin: z.ZodType<HubToPlugin> = z.union([
  z.object({ type: z.literal("state"), enabled: z.boolean(), topicTitle: z.string().optional() }),
  z.object({ type: z.literal("inbound"), content: z.string(), meta: z.record(z.string(), z.string()), interrupt: z.literal(true).optional() }),
  z.object({ type: z.literal("res"), id: z.string(), ok: z.boolean(), result: z.unknown().optional(), error: z.string().optional() }),
  z.object({ type: z.literal("ack"), id: z.string() }),
  z.object({ type: z.literal("filesSent"), id: z.string(), error: z.string().optional() }),
  z.object({ type: z.literal("switchSession"), sessionId: z.string(), transcriptPath: z.string(), cwd: z.string() }),
  z.object({ type: z.literal("permissionReply"), requestId: z.string(), behavior: z.enum(["allow", "deny"]) }),
  z.object({ type: z.literal("terminate") }),
  z.object({ type: z.literal("turnEnd"), final: z.boolean(), kind: z.enum(["ask", "done"]).optional() }),
  z.object({ type: z.literal("catchUp"), id: z.string() }),
]);

export const enableResult: z.ZodType<EnableResult> = z.object({ topicTitle: z.string(), created: z.boolean() });

export const hookBody: z.ZodType<HookBody> = z.object({
  messagingSocket: z.string(),
  session_id: z.string(),
  transcript_path: z.string(),
  cwd: z.string(),
  source: z.string().optional(),
});

export const turnEndBody: z.ZodType<TurnEndBody> = z.object({
  messagingSocket: z.string(),
  session_id: z.string(),
  final: z.boolean(),
  kind: z.enum(["ask", "done"]).optional(),
});

const askQuestion: z.ZodType<AskQuestion> = z.object({
  question: z.string(),
  header: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string(), preview: z.string().optional() })).min(1),
  multiSelect: z.boolean().catch(false),
});

export const questionBody: z.ZodType<QuestionBody> = z.object({
  messagingSocket: z.string().optional(),
  session_id: z.string(),
  tool_input: z.object({ questions: z.array(askQuestion).min(1) }),
});

export const questionDecision: z.ZodType<QuestionDecision> = z.union([
  z.object({ decision: z.literal("allow"), answers: z.record(z.string(), z.string()) }),
  z.object({ decision: z.literal("deny"), reason: z.string() }),
  z.object({ decision: z.literal("none") }),
]);

// A reply without notify is sent silently.
export const commandReply: z.ZodType<CommandReply> = z.object({ sessionId: z.string(), id: z.string(), text: z.string(), notify: z.boolean().catch(false), replaces: z.object({ id: z.string(), kind: z.enum(["success", "warning"]) }).optional(), awaitsResult: z.literal(true).optional() });

export const terminateRequest: z.ZodType<TerminateRequest> = z.object({ sessionId: z.string(), id: z.string() });

export const cleanupReport: z.ZodType<CleanupReport> = z.object({
  sessionId: z.string(),
  id: z.string(),
  before: z.number().optional(),
  after: z.number().optional(),
  error: z.string().optional(),
});

const rateLimit: z.ZodType<RateLimit> = z.object({ kind: z.string(), percentUsed: z.number(), resetsAt: z.string().optional() });

export const limitsPost: z.ZodType<LimitsPost> = z.object({ sessionId: z.string(), at: z.number(), rateLimits: z.array(rateLimit) });
