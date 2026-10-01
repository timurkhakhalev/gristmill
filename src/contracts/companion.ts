import { z } from "zod";

export const COMPANION_MAX_MESSAGE_BYTES = 64 * 1024;
const uuid = z.string().uuid();
const ns = z.string().regex(/^\d{1,20}$/);
const sequence = z.number().int().nonnegative().safe();
export const companionCallRefSchema = z.object({
  platform: z.literal("google-meet"), installationId: uuid, sessionId: uuid,
  tabId: z.number().int().nonnegative(), documentId: uuid,
  callId: z.string().regex(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/),
}).strict();
export type CompanionCallRef = z.infer<typeof companionCallRefSchema>;
export const companionParticipantSchema = z.object({
  id: z.string().min(1).max(100), name: z.string().max(200),
  self: z.enum(["local", "remote", "unknown"]),
}).strict();
export const companionContextSchema = z.object({
  sourceNs: ns, presence: z.enum(["in-call", "not-in-call", "unknown"]),
  health: z.enum(["recognized", "unrecognized", "unreadable"]),
  reason: z.string().max(100).nullable(),
  micMuted: z.boolean().nullable(),
  mode: z.enum(["standard", "companion", "unknown"]),
  participants: z.array(companionParticipantSchema).max(100),
  activeParticipantIds: z.array(z.string().min(1).max(100)).max(100),
  rosterComplete: z.boolean(),
  confirmedLeave: z.boolean(),
}).strict();
export type CompanionContext = z.infer<typeof companionContextSchema>;
export const companionBrowserMessageSchema = z.discriminatedUnion("type", [
  z.object({ version: z.literal(1), type: z.literal("hello"), installationId: uuid, sessionId: uuid }).strict(),
  z.object({ version: z.literal(1), type: z.literal("context"), sequence, ref: companionCallRefSchema, context: companionContextSchema }).strict(),
  z.object({ version: z.literal(1), type: z.literal("clock-probe"), sequence, ref: companionCallRefSchema, nonce: uuid, sourceSendNs: ns }).strict(),
  z.object({ version: z.literal(1), type: z.literal("clock-confirm"), sequence, ref: companionCallRefSchema, nonce: uuid, sourceReceiveNs: ns }).strict(),
]);
export type CompanionBrowserMessage = z.infer<typeof companionBrowserMessageSchema>;
export const companionDesktopMessageSchema = z.discriminatedUnion("type", [
  z.object({ version: z.literal(1), type: z.literal("snapshot"), connectionId: uuid,
    recordingState: z.enum(["idle", "recording", "paused"]), recordingId: uuid.nullable(),
    binding: companionCallRefSchema.nullable(), manualMuted: z.boolean(), platformMuted: z.boolean(),
  }).strict(),
  z.object({ version: z.literal(1), type: z.literal("clock-reply"), nonce: uuid,
    helperReceiveNs: ns, helperSendNs: ns, helperGeneration: uuid, helperFrame: sequence,
  }).strict(),
  z.object({ version: z.literal(1), type: z.literal("unavailable"), reason: z.enum(["app-unavailable", "version-mismatch", "clock-unavailable", "connection-rejected"]) }).strict(),
]);
export type CompanionDesktopMessage = z.infer<typeof companionDesktopMessageSchema>;
export const companionAuthenticationSchema = z.object({ version: z.literal(1), type: z.literal("authenticate"),
  credential: z.string().regex(/^[a-f0-9]{64}$/), origin: z.string().max(128),
}).strict();
