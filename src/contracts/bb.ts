import { z } from "zod";

export const bbProviderSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  available: z.boolean(),
  reasoningLevels: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
});
export const bbModelSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })).optional(),
});
export const bbEventSchema = z.object({
  seq: z.number(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export const bbSelectionSchema = z.object({
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  reasoningLevel: z.string().min(1).max(40),
});

export type BbProvider = z.infer<typeof bbProviderSchema>;
export type BbModel = z.infer<typeof bbModelSchema>;
export type BbSelection = z.infer<typeof bbSelectionSchema>;

export const bbChannels = {
  catalog: "bb-catalog",
  models: "bb-models",
  streamStart: "bb-stream-start",
  streamCancel: "bb-stream-cancel",
  streamPart: "bb-stream-part",
  generate: "bb-generate",
} as const;

export const bbStreamStartSchema = z.object({
  streamId: z.string().uuid(),
  prompt: z.string().min(1).max(500_000),
  selection: bbSelectionSchema,
});
export const bbStreamEnvelopeSchema = z.object({
  streamId: z.string().uuid(),
  text: z.string().optional(),
  done: z.boolean().optional(),
  error: z.string().optional(),
});
export type BbStreamEnvelope = z.infer<typeof bbStreamEnvelopeSchema>;

export interface BbApi {
  bbCatalog(): Promise<BbProvider[]>;
  bbModels(provider: string): Promise<BbModel[]>;
  bbStreamStart(request: z.infer<typeof bbStreamStartSchema>): Promise<void>;
  bbStreamCancel(streamId: string): Promise<void>;
  onBbStreamPart(callback: (part: BbStreamEnvelope) => void): () => void;
  bbGenerate(prompt: string, selection: BbSelection): Promise<string>;
}
