import { z } from "zod";
import { BYOK_API_KEYS } from "../config/secretKeys.js";

export const meetingRecordingIdSchema = z.string().uuid();
export const meetingSourceSchema = z.enum(["mic", "system"]);
export type MeetingSource = z.infer<typeof meetingSourceSchema>;
export const meetingCaptureStateSchema = z.enum(["recording", "finalizing", "ready", "incomplete"]);
export type MeetingCaptureState = z.infer<typeof meetingCaptureStateSchema>;
export const meetingAudioStateSchema = z.enum(["available", "deleting", "deleted"]);
export type MeetingAudioState = z.infer<typeof meetingAudioStateSchema>;
export const meetingRunStageSchema = z.enum(["prepare", "asr", "normalize", "summary"]);
export type MeetingRunStage = z.infer<typeof meetingRunStageSchema>;
export const meetingRunStatusSchema = z.enum([
  "pending",
  "running",
  "blocked",
  "failed",
  "cancelled",
  "complete",
]);
export type MeetingRunStatus = z.infer<typeof meetingRunStatusSchema>;

const inferenceOptionsSchema = z.object({
  disableThinking: z.boolean().optional(),
  cloudMode: z.string().max(100).optional(),
});

const credentialRefs = new Set<string>([
  ...BYOK_API_KEYS.map((entry) => entry.env),
  "CORTI_CLIENT_ID",
  "CORTI_CLIENT_SECRET",
  "CUSTOM_TRANSCRIPTION_API_KEY",
  "CUSTOM_CLEANUP_API_KEY",
  "BEDROCK_ACCESS_KEY_ID",
  "BEDROCK_SECRET_ACCESS_KEY",
  "BEDROCK_SESSION_TOKEN",
  "AZURE_OPENAI_API_KEY",
  "VERTEX_API_KEY",
]);
const credentialRefSchema = z.string().refine((value) => credentialRefs.has(value), {
  message: "Unknown credential slot",
});
const secretFreeEndpointSchema = z.string().max(2048).refine((value) => {
  if (!value.trim()) return true;
  try {
    const url = new URL(value);
    return !url.username && !url.password && ![...url.searchParams.keys()].some((key) =>
      /^(api[-_]?key|token|secret|password)$/i.test(key)
    );
  } catch {
    return false;
  }
});

const localTranscriptionConfigSchema = z.object({
  provider: z.enum(["whisper", "nvidia", "cohere"]),
  model: z.string().min(1).max(200),
  options: z.object({
    language: z.string().max(50).optional(),
    translate: z.boolean().optional(),
    diarize: z.boolean().optional(),
  }).optional(),
});

const transcriptionConfigSchema = z.object({
  // `providers` is the existing settings name for direct cloud/BYOK routes.
  mode: z.enum(["providers", "local"]),
  provider: z.string().min(1).max(100).optional(),
  model: z.string().min(1).max(200).optional(),
  language: z.string().min(1).max(50),
  vocabularyHints: z.array(z.string().max(200)).max(500).optional(),
  dictionaryHints: z.array(z.string().max(200)).max(500).optional(),
  baseUrl: secretFreeEndpointSchema.optional(),
  local: localTranscriptionConfigSchema.optional(),
  credentialRef: credentialRefSchema.optional(),
}).superRefine((config, context) => {
  if (config.mode === "providers" && !config.provider) {
    context.addIssue({ code: "custom", path: ["provider"], message: "Provider route is required" });
  }
  if (config.mode === "local" && !config.local) {
    context.addIssue({ code: "custom", path: ["local"], message: "Local model route is required" });
  }
  if (config.mode === "local" && config.baseUrl) {
    context.addIssue({ code: "custom", path: ["baseUrl"], message: "Local routes do not use a remote endpoint" });
  }
  if (config.baseUrl && config.provider !== "custom") {
    context.addIssue({ code: "custom", path: ["baseUrl"], message: "Only the configured custom route accepts a base URL" });
  }
});

const summaryConfigSchema = z.object({
  actionId: z.union([z.string().min(1).max(128), z.number().int().positive()]).optional(),
  templateId: z.union([z.string().min(1).max(128), z.number().int().positive()]).optional(),
  instruction: z.string().max(100_000),
  reasoningMode: z.enum(["providers", "local", "self-hosted", "enterprise", "agent"]),
  provider: z.string().min(1).max(100).optional(),
  model: z.string().min(1).max(200).optional(),
  agentProvider: z.string().min(1).max(100).optional(),
  agentReasoningLevel: z.string().min(1).max(40).optional(),
  cloudBaseUrl: secretFreeEndpointSchema.optional(),
  remoteUrl: secretFreeEndpointSchema.optional(),
  options: inferenceOptionsSchema.optional(),
  credentialRef: credentialRefSchema.optional(),
  enterprise: z.object({
    bedrockRegion: z.string().max(200).optional(),
    bedrockProfile: z.string().max(200).optional(),
    bedrockAccessKeyRef: credentialRefSchema.optional(),
    bedrockSecretAccessKeyRef: credentialRefSchema.optional(),
    bedrockSessionTokenRef: credentialRefSchema.optional(),
    azureEndpoint: secretFreeEndpointSchema.optional(),
    azureApiVersion: z.string().max(100).optional(),
    vertexProject: z.string().max(200).optional(),
    vertexLocation: z.string().max(200).optional(),
  }).optional(),
}).superRefine((config, context) => {
  if (config.reasoningMode === "providers" && !config.provider) {
    context.addIssue({ code: "custom", path: ["provider"], message: "Provider route is required" });
  }
  if (config.cloudBaseUrl && config.reasoningMode !== "providers") {
    context.addIssue({ code: "custom", path: ["cloudBaseUrl"], message: "Cloud endpoint requires a provider route" });
  }
  if (config.remoteUrl && config.reasoningMode !== "self-hosted") {
    context.addIssue({ code: "custom", path: ["remoteUrl"], message: "Remote endpoint requires a self-hosted route" });
  }
  if (config.reasoningMode === "enterprise" && !["bedrock", "azure", "vertex"].includes(config.provider ?? "")) {
    context.addIssue({ code: "custom", path: ["provider"], message: "An existing enterprise reasoning provider is required" });
  }
  if (config.reasoningMode === "enterprise" && !config.enterprise) {
    context.addIssue({ code: "custom", path: ["enterprise"], message: "Enterprise reasoning settings are required" });
  }
  if (config.reasoningMode === "agent" && (!config.agentProvider || !config.model || !config.agentReasoningLevel)) {
    context.addIssue({ code: "custom", path: ["agentProvider"], message: "bb provider, model and reasoning level are required" });
  }
});

// Zod objects strip unknown fields at every level. Secret values are therefore
// never part of the persisted snapshot; credentialRef names a secure-store slot.
export const meetingProcessingConfigSchema = z.object({
  transcription: transcriptionConfigSchema,
  selfDisplayName: z.string().trim().max(200).optional(),
  summary: summaryConfigSchema.nullable().optional(),
  generateSummary: z.boolean().optional(),
  generateTitle: z.boolean().optional(),
});
export type MeetingProcessingConfig = z.infer<typeof meetingProcessingConfigSchema>;

export const meetingProcessingConfigErrorSchema = z.object({
  code: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
  messageKey: z.string().regex(/^[A-Za-z0-9_.-]{1,200}$/).optional(),
});
export type MeetingProcessingConfigError = z.infer<typeof meetingProcessingConfigErrorSchema>;

export const meetingRecordingConfigInputSchema = z.object({
  config: meetingProcessingConfigSchema.nullable(),
  configError: meetingProcessingConfigErrorSchema.nullable().optional(),
});

export const meetingRecordingDtoSchema = z.object({
  id: meetingRecordingIdSchema,
  groupId: meetingRecordingIdSchema,
  noteId: z.number().int().positive(),
  captureState: meetingCaptureStateSchema,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  sourceMetadata: z.record(z.string(), z.unknown()),
  config: meetingProcessingConfigSchema.nullable(),
  configError: meetingProcessingConfigErrorSchema.nullable(),
  captureErrorCode: z.string().nullable(),
  audioState: meetingAudioStateSchema,
  audioErrorCode: z.string().nullable(),
  currentRunId: meetingRecordingIdSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MeetingRecordingDto = z.infer<typeof meetingRecordingDtoSchema>;

export const meetingRecordingEpochDtoSchema = z.object({
  recordingId: meetingRecordingIdSchema,
  source: meetingSourceSchema,
  epochIndex: z.number().int().nonnegative(),
  startFrame: z.number().int().nonnegative(),
  sampleRate: z.literal(24_000),
  channels: z.literal(1),
  encoding: z.literal("opus"),
  state: z.enum(["open", "finalized", "incomplete"]),
  frameCount: z.number().int().nonnegative(),
  ignoredTrailingBytes: z.number().int().min(0),
  errorCode: z.string().nullable(),
});
export type MeetingRecordingEpochDto = z.infer<typeof meetingRecordingEpochDtoSchema>;

export const meetingIntentionalIntervalSchema = z.object({
  id: z.string().uuid(),
  recordingId: meetingRecordingIdSchema,
  source: meetingSourceSchema,
  startFrame: z.number().int().nonnegative(),
  endFrame: z.number().int().nonnegative().nullable(),
  reason: z.enum(["manual-muted", "platform-muted"]),
}).superRefine((interval, context) => {
  if (interval.endFrame !== null && interval.endFrame < interval.startFrame) {
    context.addIssue({ code: "custom", path: ["endFrame"], message: "Interval end precedes its start" });
  }
});
export type MeetingIntentionalInterval = z.infer<typeof meetingIntentionalIntervalSchema>;

export const meetingProcessingRunDtoSchema = z.object({
  id: meetingRecordingIdSchema,
  recordingId: meetingRecordingIdSchema,
  sourceRecordingIds: z.array(meetingRecordingIdSchema).min(1),
  kind: z.enum(["initial", "reprocess", "summary"]),
  sourceRunId: meetingRecordingIdSchema.nullable(),
  bbThreadId: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  config: meetingProcessingConfigSchema.nullable(),
  configError: meetingProcessingConfigErrorSchema.nullable(),
  stage: meetingRunStageSchema,
  status: meetingRunStatusSchema,
  errorCode: z.string().nullable(),
  speakerNamingErrorCode: z.string().nullable(),
  retryAt: z.string().nullable(),
  retryCount: z.number().int().nonnegative(),
  hasRawProviderResponse: z.boolean(),
  hasTranscript: z.boolean(),
  hasSummary: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MeetingProcessingRunDto = z.infer<typeof meetingProcessingRunDtoSchema>;

export const MEETING_ASR_GATE_MS = 15_000;

export const meetingTranscriptArtifactSchema = z.object({
  text: z.string(),
  segments: z.array(z.object({
    speaker: z.string().optional(),
    text: z.string(),
    start: z.number().finite(),
    end: z.number().finite(),
  })).optional(),
  diarized: z.boolean().optional(),
});
export type MeetingTranscriptArtifact = z.infer<typeof meetingTranscriptArtifactSchema>;

export const meetingSummaryArtifactSchema = z.object({
  text: z.string(),
  speakerCorrectionRevision: z.number().int().nonnegative().optional(),
  manualNoteRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  taskStatus: z.enum(["running", "complete", "zero", "provider-error", "format-error", "section-error", "conflict"]).optional(),
  taskErrorCode: z.string().max(128).nullable().optional(),
});
export type MeetingSummaryArtifact = z.infer<typeof meetingSummaryArtifactSchema>;

export const meetingSpeakerCorrectionSourceSchema = z.enum(["voice", "platform", "model", "user"]);
export const meetingSpeakerCorrectionSchema = z.object({
  speakerId: z.string().min(1).max(200),
  profileId: z.number().int().positive().nullable(),
  displayName: z.string().min(1).max(200),
  participantEmail: z.string().email().nullable(),
  source: meetingSpeakerCorrectionSourceSchema,
  revision: z.number().int().positive(),
});
export type MeetingSpeakerCorrection = z.infer<typeof meetingSpeakerCorrectionSchema>;

export const meetingProcessingResultDtoSchema = z.object({
  run: meetingProcessingRunDtoSchema,
  transcript: meetingTranscriptArtifactSchema.nullable(),
  summary: meetingSummaryArtifactSchema.nullable(),
  speakerCorrections: z.array(meetingSpeakerCorrectionSchema),
});
export type MeetingProcessingResultDto = z.infer<typeof meetingProcessingResultDtoSchema>;

export const meetingDeletionIntentDtoSchema = z.object({
  id: meetingRecordingIdSchema,
  kind: z.enum(["audio", "note"]),
  noteId: z.number().int().positive(),
  recordingId: meetingRecordingIdSchema.nullable(),
  status: z.enum(["pending", "failed"]),
  errorCode: z.string().nullable(),
  requestedAt: z.string(),
});
export type MeetingDeletionIntentDto = z.infer<typeof meetingDeletionIntentDtoSchema>;

export const meetingRunArtifactSchema = z.enum(["provider-response", "transcript", "summary"]);
export type MeetingRunArtifact = z.infer<typeof meetingRunArtifactSchema>;

// Host time is decimal nanoseconds from mach_absolute_time, never delivery time.
const validHostNs = (value: string): boolean => /^\d{1,20}$/.test(value);
const hostNsSchema = z.string().regex(/^\d{1,20}$/);
export const zoomSpeakerObservationSchema = z.object({
  id: z.string().uuid(), recordingId: meetingRecordingIdSchema,
  sessionId: z.string().uuid(), instanceKey: z.string().min(1).max(100), nameRevision: z.number().int().positive(),
  episodeId: z.string().uuid(), displayName: z.string().max(200),
  windowMode: z.enum(["full", "compact", "unknown"]),
  activity: z.enum(["explicit", "end", "clear", "candidate", "ambiguous", "unavailable"]),
  // Explicit/end cover bounded, continued read confirmations of one episode;
  // other states cover the actual transition read. Never hold beyond this end.
  readStartHostNs: hostNsSchema, readEndHostNs: hostNsSchema,
  self: z.enum(["remote", "local", "unknown"]),
  singleSpeaker: z.boolean().nullable(),
  provenance: z.enum(["zoom-only", "system-wide", "unknown"]),
  reason: z.string().max(100).nullable(),
}).refine((value) => validHostNs(value.readStartHostNs) && validHostNs(value.readEndHostNs) && BigInt(value.readEndHostNs) >= BigInt(value.readStartHostNs));
export type ZoomSpeakerObservation = z.infer<typeof zoomSpeakerObservationSchema>;
export const meetingAudioClockMessageSchema = z.object({
  type: z.literal("clock"), generation: z.string().uuid(),
  startFrame: z.number().int().nonnegative().safe(), endFrame: z.number().int().positive().safe(),
  hostStartNs: hostNsSchema.nullable(), hostEndNs: hostNsSchema.nullable(),
  timebaseNumer: z.number().int().positive(), timebaseDenom: z.number().int().positive(),
  conversion: z.literal("uncalibrated"), reason: z.string().max(100).nullable(),
}).refine((value) => value.endFrame > value.startFrame &&
  ((value.hostStartNs === null && value.hostEndNs === null) ||
    value.hostStartNs !== null && value.hostEndNs !== null && validHostNs(value.hostStartNs) && validHostNs(value.hostEndNs) && BigInt(value.hostEndNs) > BigInt(value.hostStartNs)));
export type MeetingAudioClockMessage = z.infer<typeof meetingAudioClockMessageSchema>;
export const meetingAudioClockAnchorSchema = z.object({
  id: z.string().uuid(), recordingId: meetingRecordingIdSchema, epochIndex: z.number().int().nonnegative(),
  epochStartFrame: z.number().int().nonnegative().safe(), clock: meetingAudioClockMessageSchema,
});
export type MeetingAudioClockAnchor = z.infer<typeof meetingAudioClockAnchorSchema>;
// A fixed initial heuristic, not a measured calibration or a verified identity.
export const zoomSpeakerTimingPolicySchema = z.object({
  version: z.literal("zoom-activity-v1"),
  origin: z.literal("initial-lag-hypothesis"),
  indicatorDelaySeconds: z.literal(0.5),
  boundaryGuardSeconds: z.literal(0.5),
  clockContinuitySeconds: z.literal(0.001),
  clockRateToleranceSeconds: z.literal(0.002),
  minimumSpeechSeconds: z.literal(1),
  minimumIndependentEpisodes: z.literal(3),
});
export type ZoomSpeakerTimingPolicy = z.infer<typeof zoomSpeakerTimingPolicySchema>;
export const zoomSpeakerDecisionSchema = z.object({
  speakerId: z.string().nullable(), displayName: z.string().nullable(),
  status: z.enum(["accepted", "rejected"]), reason: z.string().min(1).max(100),
  observationIds: z.array(z.string().uuid()), clockAnchorIds: z.array(z.string().uuid()),
  intervals: z.array(z.object({ start: z.number().finite(), end: z.number().finite() }).refine((v) => v.end > v.start)),
  // Null only for preserved decisions made before this policy existed.
  timingPolicy: zoomSpeakerTimingPolicySchema.nullable(),
});
export type ZoomSpeakerDecision = z.infer<typeof zoomSpeakerDecisionSchema>;
export const meetingPlatformCoverageSchema = z.object({
  reads: z.number().int().nonnegative(), samples: z.number().int().nonnegative(),
  state: z.enum(["collecting", "complete", "incomplete"]), reason: z.string().max(100).nullable(),
});
export type MeetingPlatformCoverage = z.infer<typeof meetingPlatformCoverageSchema>;
