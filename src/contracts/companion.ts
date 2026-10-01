import { z } from "zod";

export const COMPANION_MAX_MESSAGE_BYTES = 64 * 1024;
const uuid = z.string().uuid();
// Chrome documentId is an UnguessableToken serialized as 32 hexadecimal digits.
export const companionDocumentIdSchema = z.string().regex(/^[A-Fa-f0-9]{32}$/).refine(value => !/^0{32}$/.test(value));
const ns = z.string().regex(/^\d{1,20}$/);
const sequence = z.number().int().nonnegative().safe();
export const companionCallRefSchema = z.object({
  platform: z.literal("google-meet"), installationId: uuid, sessionId: uuid,
  tabId: z.number().int().nonnegative(), documentId: companionDocumentIdSchema,
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
  z.object({ version: z.literal(1), type: z.literal("manual-mute"), sequence, ref: companionCallRefSchema, recordingId: uuid, muted: z.boolean() }).strict(),
  z.object({ version: z.literal(1), type: z.literal("context"), sequence, ref: companionCallRefSchema, context: companionContextSchema }).strict(),
  z.object({ version: z.literal(1), type: z.literal("clock-probe"), sequence, ref: companionCallRefSchema, nonce: uuid, sourceSendNs: ns }).strict(),
  z.object({ version: z.literal(1), type: z.literal("clock-confirm"), sequence, ref: companionCallRefSchema, nonce: uuid, sourceReceiveNs: ns }).strict(),
]);
export type CompanionBrowserMessage = z.infer<typeof companionBrowserMessageSchema>;
export const companionDesktopMessageSchema = z.discriminatedUnion("type", [
  z.object({ version: z.literal(1), type: z.literal("snapshot"), connectionId: uuid,
    recordingState: z.enum(["idle", "recording", "paused"]), recordingId: uuid.nullable(),
    contextState: z.enum(["disabled", "unbound", "recognized", "unavailable"]),
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

export const companionCandidateKeySchema = z.object({ connectionId: uuid, ref: companionCallRefSchema }).strict();
export type CompanionCandidateKey = z.infer<typeof companionCandidateKeySchema>;
export const companionRecordingScopeSchema = z.object({ recordingId: uuid, sessionId: uuid }).strict();
export type CompanionRecordingScope = z.infer<typeof companionRecordingScopeSchema>;
export const companionCandidateSchema = companionCandidateKeySchema.extend({ context: companionContextSchema, receivedAt: z.number() });
export type CompanionCandidate = z.infer<typeof companionCandidateSchema>;
export const companionBindingSchema = companionCandidateKeySchema.extend({ recordingId: uuid, sessionId: uuid, id: uuid, generation: sequence });
export type CompanionBinding = z.infer<typeof companionBindingSchema>;
export const companionStatusSchema = z.object({ enabled: z.boolean(), candidates: z.array(companionCandidateSchema).max(128),
  binding: companionBindingSchema.nullable(), contextUnavailableSince: z.number().nullable(), contextReason: z.string().nullable(), reminderShown: z.boolean() }).strict();
export type CompanionStatus = z.infer<typeof companionStatusSchema>;
export const companionSelectionSchema = z.object({ expected: companionRecordingScopeSchema, candidate: companionCandidateKeySchema }).strict();
export const companionPlatformMuteSchema = companionRecordingScopeSchema.extend({ muted: z.boolean() });

export const companionSetupSchema = z.object({ enabled: z.boolean(), installed: z.boolean(), extensionPath: z.string() }).strict();
export type CompanionSetup = z.infer<typeof companionSetupSchema>;
