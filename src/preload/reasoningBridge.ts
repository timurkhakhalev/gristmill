// Renderer-facing reasoning bridge: the one-shot operations (invoke), the
// Bedrock cleanup cancel (send) and the enterprise stream lifecycle
// (invoke + listener). The listener validates the envelope before the callback
// and returns an unsubscribe; malformed envelopes never reach the chat model
// shim. The sandboxed preload can't require local modules, so build-main.js
// bundles the final preload with esbuild before packaging.
import {
  reasoningChannels,
  localReasoningResultSchema,
  anthropicReasoningResultSchema,
  enterpriseReasoningResultSchema,
  enterpriseStreamStartResultSchema,
  enterpriseStreamEnvelopeSchema,
  type LocalReasoningConfig,
  type LocalReasoningResult,
  type AnthropicReasoningConfig,
  type AnthropicReasoningResult,
  type EnterpriseReasoningConfig,
  type EnterpriseReasoningResult,
  type EnterpriseStreamStartRequest,
  type EnterpriseStreamStartResult,
  type EnterpriseStreamEnvelope,
  type ReasoningApi,
} from "../contracts/reasoning.js";
import type { ZodType } from "zod";

interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
}

function parseResult<T>(schema: ZodType<T>, raw: unknown, channel: string): T {
  const result = schema.safeParse(raw);

  if (!result.success) {
    throw new Error(`Unexpected response shape from ${channel}`);
  }

  return result.data;
}

// The return type is the shared ReasoningApi, so any drift between this
// implementation and the contract fails compilation.
export function createReasoningBridge(ipcRenderer: IpcRendererLike): ReasoningApi {
  return {
    processLocalReasoning: (
      text: string,
      modelId: string,
      agentName: string | null,
      config?: LocalReasoningConfig
    ): Promise<LocalReasoningResult> =>
      ipcRenderer
        .invoke(reasoningChannels.processLocalReasoning, text, modelId, agentName, config)
        .then((raw) =>
          parseResult(localReasoningResultSchema, raw, reasoningChannels.processLocalReasoning)
        ),

    checkLocalReasoningAvailable: (): Promise<boolean> =>
      ipcRenderer.invoke(reasoningChannels.checkLocalReasoningAvailable).then((raw) => {
        if (typeof raw !== "boolean") {
          throw new Error(
            `Unexpected response shape from ${reasoningChannels.checkLocalReasoningAvailable}`
          );
        }

        return raw;
      }),

    processAnthropicReasoning: (
      text: string,
      modelId: string,
      agentName: string | null,
      config?: AnthropicReasoningConfig
    ): Promise<AnthropicReasoningResult> =>
      ipcRenderer
        .invoke(reasoningChannels.processAnthropicReasoning, text, modelId, agentName, config)
        .then((raw) =>
          parseResult(
            anthropicReasoningResultSchema,
            raw,
            reasoningChannels.processAnthropicReasoning
          )
        ),

    processEnterpriseReasoning: (
      text: string,
      modelId: string,
      agentName: string | null,
      config: EnterpriseReasoningConfig
    ): Promise<EnterpriseReasoningResult> =>
      ipcRenderer
        .invoke(reasoningChannels.processEnterpriseReasoning, text, modelId, agentName, config)
        .then((raw) =>
          parseResult(
            enterpriseReasoningResultSchema,
            raw,
            reasoningChannels.processEnterpriseReasoning
          )
        ),

    cancelEnterpriseReasoning: (): void => {
      ipcRenderer.send(reasoningChannels.cancelEnterpriseReasoning);
    },

    enterpriseStreamStart: (
      request: EnterpriseStreamStartRequest
    ): Promise<EnterpriseStreamStartResult> =>
      ipcRenderer
        .invoke(reasoningChannels.enterpriseStreamStart, request)
        .then((raw) =>
          parseResult(
            enterpriseStreamStartResultSchema,
            raw,
            reasoningChannels.enterpriseStreamStart
          )
        ),

    enterpriseStreamCancel: (streamId: string): Promise<void> =>
      ipcRenderer.invoke(reasoningChannels.enterpriseStreamCancel, streamId).then(() => undefined),

    onEnterpriseStreamPart: (
      callback: (envelope: EnterpriseStreamEnvelope) => void
    ): (() => void) => {
      const listener = (_event: unknown, ...args: unknown[]) => {
        const parsed = enterpriseStreamEnvelopeSchema.safeParse(args[0]);

        if (!parsed.success) return;
        callback(parsed.data);
      };

      ipcRenderer.on(reasoningChannels.enterpriseStreamPart, listener);

      return () => {
        ipcRenderer.removeListener(reasoningChannels.enterpriseStreamPart, listener);
      };
    },
  };
}
