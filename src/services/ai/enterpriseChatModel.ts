import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import type { EnterpriseProvider } from "../../models/ModelRegistry";
import { getEnterpriseCallSettings } from "./enterpriseSettings";

// Enterprise SDKs (Bedrock/Azure/Vertex) must run in the main process — SigV4
// signing and CORS rule out renderer fetches. This LanguageModelV3 shim keeps
// streamText and tool execution in the renderer while proxying doStream over
// IPC: main runs the provider stream and relays each part verbatim.

// Structured-clone whitelist — abortSignal and other non-serializable call
// options must not cross the IPC boundary.
const SERIALIZABLE_OPTION_KEYS = [
  "prompt",
  "maxOutputTokens",
  "temperature",
  "stopSequences",
  "topP",
  "topK",
  "presencePenalty",
  "frequencyPenalty",
  "responseFormat",
  "seed",
  "tools",
  "toolChoice",
  "providerOptions",
] as const;

function pickSerializableOptions(options: LanguageModelV3CallOptions) {
  const picked: Record<string, unknown> = {};
  for (const key of SERIALIZABLE_OPTION_KEYS) {
    const value = options[key];
    if (value !== undefined) picked[key] = value;
  }
  return picked;
}

export function createEnterpriseChatModel(
  provider: EnterpriseProvider,
  modelId: string
): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: `enterprise.${provider}`,
    modelId,
    supportedUrls: {},

    async doGenerate() {
      throw new Error("Enterprise chat models are streaming-only; use doStream.");
    },

    async doStream(options: LanguageModelV3CallOptions) {
      const api = window.electronAPI;
      if (
        !api ||
        typeof api.enterpriseStreamStart !== "function" ||
        typeof api.onEnterpriseStreamPart !== "function"
      ) {
        throw new Error("Enterprise streaming is not available in this environment");
      }

      // An already-aborted caller must never start a billable provider
      // request; error the local stream immediately instead.
      if (options.abortSignal?.aborted) {
        const aborted = new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.error(
              options.abortSignal?.reason instanceof Error
                ? options.abortSignal.reason
                : new Error("Aborted")
            );
          },
        });
        return { stream: aborted };
      }

      const streamId = crypto.randomUUID();
      const config = getEnterpriseCallSettings(provider);
      let unsubscribe: (() => void) | undefined;
      let settled = false;
      // Assigned once the stream exists; abort cannot fire before that
      // (the listener is registered inside start), the initial no-op only
      // keeps the binding total.
      let errorLocally: (message: string) => void = () => {};
      // Removes both the envelope listener and the abort listener; safe to
      // call repeatedly and used by every terminal outcome (done/error
      // envelope, failed invoke, consumer cancel, pre-start abort).
      const cleanup = () => {
        unsubscribe?.();
        unsubscribe = undefined;
        options.abortSignal?.removeEventListener("abort", onAbort);
      };

      const onAbort = () => {
        void api.enterpriseStreamCancel(streamId);
        // Renderer cancellation must complete independently of the main
        // terminal event (#33): settle the local stream and clean up now,
        // while the start invoke may still be pending.
        errorLocally("Aborted");
      };

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start: (controller) => {
          const fail = (message: string) => {
            if (settled) return;
            settled = true;
            cleanup();
            controller.error(new Error(message));
          };
          errorLocally = fail;
          const finish = () => {
            if (settled) return;
            settled = true;
            cleanup();
            controller.close();
          };

          // Subscribed before start, so no part can be missed; the bridge
          // only forwards well-formed envelopes, filtered again by stream id.
          unsubscribe = api.onEnterpriseStreamPart((envelope) => {
            if (envelope.streamId !== streamId) return;
            if (envelope.error !== undefined) {
              fail(envelope.error);
            } else if (envelope.done) {
              finish();
            } else if (envelope.part !== undefined) {
              controller.enqueue(envelope.part as LanguageModelV3StreamPart);
            }
          });

          options.abortSignal?.addEventListener("abort", onAbort, { once: true });

          api
            .enterpriseStreamStart({
              streamId,
              provider,
              modelId,
              config,
              options: pickSerializableOptions(options),
            })
            .then((result) => {
              // The abort may have landed between subscribe and start: the
              // cancel op above found no registered stream yet, so cancel the
              // now-started one instead of streaming for a dead consumer.
              if (options.abortSignal?.aborted) {
                void api.enterpriseStreamCancel(streamId);
                fail("Aborted");
                return;
              }
              if (result && !result.success) fail(result.error || "Enterprise stream failed");
            })
            .catch((error: Error) => fail(error.message));
        },
        cancel: () => {
          // Explicit cancel settles the local stream without waiting for a
          // main terminal event, then aborts the provider request.
          cleanup();
          void api.enterpriseStreamCancel(streamId);
        },
      });

      return { stream };
    },
  };
}
