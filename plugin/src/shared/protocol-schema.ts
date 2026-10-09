// Runtime checks of the protocol messages, typed against protocol.ts: a
// message type changed on one side and not here fails the type check.
// protocol.ts itself has no imports, so the function hooks module can use it.
import type { CommandReply, EnableResult, HookBody, HubToPlugin, PluginToHub, QueuedFile } from "./protocol.ts";

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
  z.object({ type: z.literal("hello"), v: z.number(), windowKey: z.string(), sessionId: z.string(), cwd: z.string() }),
  z.object({ type: z.literal("session"), sessionId: z.string(), cwd: z.string() }),
  z.object({ type: z.literal("req"), id: z.string(), op: z.literal("enable"), title: z.string() }),
  z.object({ type: z.literal("req"), id: z.string(), op: z.literal("disable") }),
  z.object({ type: z.literal("req"), id: z.string(), op: z.literal("download"), fileId: z.string() }),
  sendMessage,
  sendFilesMessage,
  z.object({ type: z.literal("permission"), requestId: z.string().optional(), toolName: z.string(), description: z.string(), inputPreview: z.string().optional() }),
  z.object({ type: z.literal("title"), title: z.string() }),
  z.object({ type: z.literal("terminalInput") }),
]);

export const hubToPlugin: z.ZodType<HubToPlugin> = z.union([
  z.object({ type: z.literal("state"), enabled: z.boolean(), topicTitle: z.string().optional() }),
  z.object({ type: z.literal("inbound"), content: z.string(), meta: z.record(z.string(), z.string()) }),
  z.object({ type: z.literal("res"), id: z.string(), ok: z.boolean(), result: z.unknown().optional(), error: z.string().optional() }),
  z.object({ type: z.literal("ack"), id: z.string() }),
  z.object({ type: z.literal("filesSent"), id: z.string(), error: z.string().optional() }),
  z.object({ type: z.literal("switchSession"), sessionId: z.string(), transcriptPath: z.string(), cwd: z.string() }),
  z.object({ type: z.literal("permissionReply"), requestId: z.string(), behavior: z.enum(["allow", "deny"]) }),
]);

export const enableResult: z.ZodType<EnableResult> = z.object({ topicTitle: z.string(), created: z.boolean() });

export const hookBody: z.ZodType<HookBody> = z.object({
  messagingSocket: z.string(),
  session_id: z.string(),
  transcript_path: z.string(),
  cwd: z.string(),
  source: z.string().optional(),
});

// A reply without notify is sent silently.
export const commandReply: z.ZodType<CommandReply> = z.object({ sessionId: z.string(), id: z.string(), text: z.string(), notify: z.boolean().catch(false) });
