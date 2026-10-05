// Single source of truth for the main-owned reasoning IPC boundary: local
// one-shot reasoning, its availability probe, the Anthropic one-shot proxy,
// enterprise (Bedrock/Azure/Vertex) one-shot reasoning, the Bedrock cleanup
// cancel, and the enterprise stream lifecycle (start/cancel/part). The
// renderer's BYOK/LAN streaming stays in ReasoningService + AI SDK — only the
// Node-owned operations cross here.
//
// Configs keep their per-provider shapes: every schema is a loose passthrough
// object with the fields each executor actually reads, so unknown extension
// fields survive exactly as they did in the JS handlers. Raw renderer payloads
// stay unknown until the schema parse.
import { z } from "zod";

// --- Channels and events ----------------------------------------------------

export const reasoningChannels = {
  processLocalReasoning: "process-local-reasoning",
  checkLocalReasoningAvailable: "check-local-reasoning-available",
  processAnthropicReasoning: "process-anthropic-reasoning",
  processEnterpriseReasoning: "process-enterprise-reasoning",
  cancelEnterpriseReasoning: "enterprise-reasoning-cancel",
  enterpriseStreamStart: "enterprise-stream-start",
  enterpriseStreamCancel: "enterprise-stream-cancel",
  enterpriseStreamPart: "enterprise-stream-part",
} as const;

// --- Request configs --------------------------------------------------------

// Screenshot context attached to voice-agent requests (Anthropic path only).
const screenContextSchema = z.object({
  mediaType: z.string(),
  data: z.string(),
});

export type ScreenContextImage = z.infer<typeof screenContextSchema>;

const baseRequestConfigSchema = z.object({
  systemPrompt: z.string().optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  requireCompleteOutput: z.boolean().optional(),
});

export const localReasoningConfigSchema = baseRequestConfigSchema
  .extend({
    topK: z.number().optional(),
    topP: z.number().optional(),
    repeatPenalty: z.number().optional(),
    disableThinking: z.boolean().optional(),
    contextSize: z.number().optional(),
  })
  .passthrough();

export type LocalReasoningConfig = z.infer<typeof localReasoningConfigSchema>;

export const anthropicReasoningConfigSchema = baseRequestConfigSchema
  .extend({
    supportsTemperature: z.boolean().optional(),
    screenContext: screenContextSchema.optional(),
  })
  .passthrough();

export type AnthropicReasoningConfig = z.infer<typeof anthropicReasoningConfigSchema>;

// Enterprise requests carry the provider id plus the per-provider credential
///config subset the runtime picks out (see pickEnterpriseConfig).
export const enterpriseReasoningConfigSchema = baseRequestConfigSchema
  .extend({
    provider: z.string(),
    apiKey: z.string().optional(),
    inferenceScope: z.string().optional(),
    timeoutMs: z.number().optional(),
    supportsTemperature: z.boolean().optional(),
    bedrockRegion: z.string().optional(),
    bedrockProfile: z.string().optional(),
    bedrockAccessKeyId: z.string().optional(),
    bedrockSecretAccessKey: z.string().optional(),
    bedrockSessionToken: z.string().optional(),
    azureEndpoint: z.string().optional(),
    azureApiVersion: z.string().optional(),
    vertexProject: z.string().optional(),
    vertexLocation: z.string().optional(),
  })
  .passthrough();

export type EnterpriseReasoningConfig = z.infer<typeof enterpriseReasoningConfigSchema>;

// Positional one-shot arguments, preserved from the JS handlers: the agent
// name is unused by main but keeps the public signature stable.
export const localReasoningArgsSchema = z.tuple([
  z.string(),
  z.string(),
  z.unknown(),
  localReasoningConfigSchema.optional(),
]);

export const anthropicReasoningArgsSchema = z.tuple([
  z.string(),
  z.string(),
  z.unknown(),
  anthropicReasoningConfigSchema.optional(),
]);

export const enterpriseReasoningArgsSchema = z.tuple([
  z.string(),
  z.string(),
  z.unknown(),
  enterpriseReasoningConfigSchema,
]);

// --- Results ----------------------------------------------------------------

// Discriminated success/failure arms: the renderer can never read `text` off
// a failure or mapping fields off a success at compile time.

// code/details carry the machine-readable local failure across to the
// renderer, which owns the translation keys.
export const localReasoningResultSchema = z.union([
  z.object({ success: z.literal(true), text: z.string().optional() }),
  z.object({
    success: z.literal(false),
    error: z.string().optional(),
    code: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
]);

export type LocalReasoningResult = z.infer<typeof localReasoningResultSchema>;

export const anthropicReasoningResultSchema = z.union([
  z.object({ success: z.literal(true), text: z.string().optional() }),
  z.object({ success: z.literal(false), error: z.string().optional() }),
]);

export type AnthropicReasoningResult = z.infer<typeof anthropicReasoningResultSchema>;

const enterpriseTechnicalDetailsSchema = z.object({
  status: z.number().optional(),
  exceptionType: z.string().optional(),
  requestId: z.string().optional(),
  underlyingError: z.string().optional(),
});

export type EnterpriseTechnicalDetails = z.infer<typeof enterpriseTechnicalDetailsSchema>;

export const enterpriseReasoningResultSchema = z.union([
  z.object({ success: z.literal(true), text: z.string().optional() }),
  z.object({
    success: z.literal(false),
    error: z.string().optional(),
    messageKey: z.string().optional(),
    messageParams: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
    action: z.string().optional(),
    actionKey: z.string().optional(),
    copyCommand: z.string().optional(),
    retryable: z.boolean().optional(),
    technicalDetails: enterpriseTechnicalDetailsSchema.optional(),
  }),
]);

export type EnterpriseReasoningResult = z.infer<typeof enterpriseReasoningResultSchema>;

// --- Enterprise stream lifecycle ---------------------------------------------

// The stream start payload carries the provider id at the top level; its
// config is the same credential subset without a provider of its own.
const enterpriseStreamConfigSchema = baseRequestConfigSchema
  .extend({
    apiKey: z.string().optional(),
    timeoutMs: z.number().optional(),
    supportsTemperature: z.boolean().optional(),
    bedrockRegion: z.string().optional(),
    bedrockProfile: z.string().optional(),
    bedrockAccessKeyId: z.string().optional(),
    bedrockSecretAccessKey: z.string().optional(),
    bedrockSessionToken: z.string().optional(),
    azureEndpoint: z.string().optional(),
    azureApiVersion: z.string().optional(),
    vertexProject: z.string().optional(),
    vertexLocation: z.string().optional(),
  })
  .passthrough();

export const enterpriseStreamStartRequestSchema = z.object({
  streamId: z.string().min(1),
  provider: z.string(),
  modelId: z.string(),
  config: enterpriseStreamConfigSchema.optional(),
  options: z.record(z.string(), z.unknown()),
});

export type EnterpriseStreamStartRequest = z.infer<typeof enterpriseStreamStartRequestSchema>;

export const enterpriseStreamStartResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

export type EnterpriseStreamStartResult = z.infer<typeof enterpriseStreamStartResultSchema>;

// The stream envelope: streamId plus exactly one of a relayed SDK part, the
// done marker or a terminal error message. Envelope validation never claims
// the part itself is a valid SDK stream part — that stays the SDK's contract
// on the send side and the shim's cast on the receive side.
export const enterpriseStreamEnvelopeSchema = z
  .object({
    streamId: z.string().min(1),
    part: z.unknown().optional(),
    done: z.boolean().optional(),
    error: z.string().optional(),
  })
  .refine(
    (envelope) =>
      (envelope.part !== undefined ? 1 : 0) +
        (envelope.done !== undefined ? 1 : 0) +
        (envelope.error !== undefined ? 1 : 0) ===
      1,
    { message: "exactly one of part/done/error must be present" }
  );

export type EnterpriseStreamEnvelope = z.infer<typeof enterpriseStreamEnvelopeSchema>;

// --- Renderer-facing API -----------------------------------------------------

export interface ReasoningApi {
  processLocalReasoning(
    text: string,
    modelId: string,
    agentName: string | null,
    config?: LocalReasoningConfig
  ): Promise<LocalReasoningResult>;
  checkLocalReasoningAvailable(): Promise<boolean>;
  processAnthropicReasoning(
    text: string,
    modelId: string,
    agentName: string | null,
    config?: AnthropicReasoningConfig
  ): Promise<AnthropicReasoningResult>;
  processEnterpriseReasoning(
    text: string,
    modelId: string,
    agentName: string | null,
    config: EnterpriseReasoningConfig
  ): Promise<EnterpriseReasoningResult>;
  cancelEnterpriseReasoning(): void;
  enterpriseStreamStart(
    request: EnterpriseStreamStartRequest
  ): Promise<EnterpriseStreamStartResult>;
  enterpriseStreamCancel(streamId: string): Promise<void>;
  onEnterpriseStreamPart(callback: (envelope: EnterpriseStreamEnvelope) => void): () => void;
}
