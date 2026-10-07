import type { InferenceProvider } from "./types";
import { getOpenAiApiConfig, isEnterpriseProvider } from "../../../models/ModelRegistry";
import { getSettings } from "../../../stores/settingsStore";
import { getEnterpriseCallSettings } from "../enterpriseSettings";
import { wrapCleanupTranscript } from "../../../config/prompts";
import logger from "../../../utils/logger";

// The failure arm's structured fields are attached to the thrown Error so
// upstream toast handling can read them; every field is optional.
interface EnterpriseReasoningError extends Error {
  messageKey?: string;
  messageParams?: Record<string, string | number>;
  action?: string;
  actionKey?: string;
  copyCommand?: string;
  retryable?: boolean;
  technicalDetails?: {
    status?: number;
    exceptionType?: string;
    requestId?: string;
    underlyingError?: string;
  };
}

export const enterpriseProvider: InferenceProvider = {
  id: "enterprise",
  async call({ text, model, agentName, config, ctx }) {
    if (typeof window === "undefined" || !window.electronAPI) {
      throw new Error("Enterprise reasoning is not available in this environment");
    }

    const provider = config.provider || getSettings().cleanupProvider;

    if (!isEnterpriseProvider(provider)) {
      throw new Error(`Unsupported enterprise provider: ${provider}`);
    }

    const enterpriseId = provider;

    logger.logReasoning("ENTERPRISE_START", { provider: enterpriseId, model, agentName });

    const systemPrompt = config.systemPrompt || ctx.getSystemPrompt(agentName);
    const userContent = config.systemPrompt ? text : wrapCleanupTranscript(text);
    const { supportsTemperature } = getOpenAiApiConfig(model);

    const startTime = Date.now();

    const result = await window.electronAPI.processEnterpriseReasoning(
      userContent,
      model,
      agentName,
      {
        ...config,
        systemPrompt,
        provider: enterpriseId,
        supportsTemperature,
        ...getEnterpriseCallSettings(enterpriseId),
      }
    );

    const processingTimeMs = Date.now() - startTime;

    if (result.success === false) {
      logger.logReasoning("ENTERPRISE_ERROR", {
        provider: enterpriseId,
        model,
        processingTimeMs,
        error: result.error,
      });

      const enhanced: EnterpriseReasoningError = new Error(
        result.error || `${enterpriseId} reasoning failed`
      );

      enhanced.messageKey = result.messageKey;
      enhanced.messageParams = result.messageParams;
      enhanced.action = result.action;
      enhanced.actionKey = result.actionKey;
      enhanced.copyCommand = result.copyCommand;
      enhanced.retryable = result.retryable ?? false;
      enhanced.technicalDetails = result.technicalDetails;
      throw enhanced;
    }

    logger.logReasoning("ENTERPRISE_SUCCESS", {
      provider: enterpriseId,
      model,
      processingTimeMs,
      resultLength: result.text?.length || 0,
    });

    return result.text || "";
  },
};
