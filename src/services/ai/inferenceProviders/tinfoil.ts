import { refreshTinfoilCatalogAndReconcileSelections } from "../../../models/tinfoilModels";
import type { InferenceProvider } from "./types";
import type { TinfoilAI } from "tinfoil";
import { TOKEN_LIMITS } from "../../../config/constants.mts";
import { withRetry, createApiRetryStrategy } from "../../../utils/retry";
import logger from "../../../utils/logger";
import { applyChatCompletionsParams, isTruncatedFinishReason } from "../chatRequestBody";
import type { ProviderRequestBody } from "../thinkingSuppressionDialects";
import { getTinfoilChatClient } from "../tinfoilClient";
import { getLlmRequestTimeoutSeconds } from "../../../helpers/llmRequestTimeout.js";
import { wrapCleanupTranscript } from "../../../config/prompts";

type TinfoilChatParams = TinfoilAI.Chat.ChatCompletionCreateParamsNonStreaming;

export const tinfoilProvider: InferenceProvider = {
  id: "tinfoil",
  async call({ text, model, agentName, config, ctx }) {
    logger.logReasoning("TINFOIL_START", { model, agentName });

    const apiKey = await ctx.getApiKey("tinfoil");

    if (!apiKey?.trim()) throw new Error("Tinfoil API key not configured");
    // A fresh persisted cache is applied synchronously; a network refresh is
    // background work for later operations. Shape this request before SDK setup.
    void refreshTinfoilCatalogAndReconcileSelections().catch(() => {});

    const systemPrompt = config.systemPrompt || ctx.getSystemPrompt(agentName);
    const userContent = config.systemPrompt ? text : wrapCleanupTranscript(text);

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ];

    const maxTokens =
      config.maxTokens ||
      Math.max(
        4096,
        ctx.calculateMaxTokens(
          text.length,
          TOKEN_LIMITS.MIN_TOKENS,
          TOKEN_LIMITS.MAX_TOKENS,
          TOKEN_LIMITS.TOKEN_MULTIPLIER
        )
      );

    const requestBody: ProviderRequestBody = { model, messages };
    applyChatCompletionsParams(requestBody, { model, provider: "tinfoil", config, maxTokens });

    // The client verifies enclave attestation before every request and
    // refuses to send anything over an unverified transport.
    const client = await getTinfoilChatClient(apiKey);

    // Keep SDK-internal retries off so withRetry stays the single retry layer.
    const timeoutMs = getLlmRequestTimeoutSeconds() * 1000;

    const response = await withRetry(
      () =>
        // SAFETY: the SDK sends this body verbatim as JSON; the OpenAI params
        // it requires (model, messages) are present, and the suppression params
        // this provider adds are valid OpenAI-compatible chat fields.
        client.chat.completions.create(requestBody as TinfoilChatParams, {
          timeout: timeoutMs,
          maxRetries: 0,
        }),
      createApiRetryStrategy()
    );

    const responseText =
      response.choices
        ?.map((choice) => choice.message?.content)
        .find((content): content is string => typeof content === "string" && content.trim() !== "")
        ?.trim() || "";

    if (
      config.requireCompleteOutput &&
      response.choices?.some((choice) => isTruncatedFinishReason(choice.finish_reason ?? undefined))
    ) {
      throw new Error("Model output was truncated before the selection edit completed");
    }

    logger.logReasoning("TINFOIL_RESPONSE", {
      model,
      responseLength: responseText.length,
      tokensUsed: response.usage?.total_tokens || 0,
      success: true,
      isEmpty: responseText.length === 0,
    });

    if (!responseText) {
      if (config.requireCompleteOutput) {
        throw new Error("Model returned an empty selection edit");
      }

      logger.logReasoning("TINFOIL_EMPTY_RESPONSE_FALLBACK", {
        model,
        originalTextLength: text.length,
      });

      return text;
    }

    return responseText;
  },
};
