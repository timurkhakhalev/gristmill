import type { MeetingProcessingConfig } from "../contracts/meetingRecording.js";
import { resolveSelfHostedOpenAIBase } from "../services/ai/openaiBaseCore.js";

export interface MeetingSummaryDeps {
  getAIModel: (provider: string, model: string, apiKey: string, baseUrl?: string, options?: { disableThinking?: boolean; omitAuthorization?: boolean }) => Promise<unknown>;
  generateText: (options: Record<string, unknown>) => Promise<{ text: string }>;
  processLocalText: (input: string, model: string, config: Record<string, unknown>, signal: AbortSignal) => Promise<string>;
  getCredential: (reference: string | undefined, provider: string) => string;
  getEnterpriseAIModel?: (
    provider: string,
    model: string,
    apiKey: string,
    enterprise: Record<string, unknown>
  ) => Promise<unknown>;
  validateEnterpriseEndpoint?: (endpoint: string | undefined) => void;
  runBedrockRequest?: <T>(operation: () => Promise<T>, options: { signal: AbortSignal }) => Promise<T>;
}

export async function generateMeetingSummary(
  input: string,
  summary: NonNullable<MeetingProcessingConfig["summary"]>,
  deps: MeetingSummaryDeps,
  signal: AbortSignal
): Promise<string> {
  const model = summary.model || "";
  if (!model) throw codedError("reasoning-model-missing");
  const shared = {
    systemPrompt: summary.instruction,
    maxTokens: 4096,
    temperature: 0.3,
    disableThinking: summary.options?.disableThinking,
  };
  if (summary.reasoningMode === "local") {
    return deps.processLocalText(input, model, shared, signal);
  }

  if (summary.reasoningMode === "enterprise") {
    const provider = summary.provider;
    const saved = summary.enterprise;
    if (!provider || !saved || !["bedrock", "azure", "vertex"].includes(provider)) {
      throw codedError("unsupported-enterprise-reasoning-route");
    }
    if (!deps.getEnterpriseAIModel) throw codedError("enterprise-reasoning-unavailable");
    const enterprise = {
      ...(saved.bedrockRegion ? { bedrockRegion: saved.bedrockRegion } : {}),
      ...(saved.bedrockProfile ? { bedrockProfile: saved.bedrockProfile } : {}),
      ...(saved.bedrockAccessKeyRef
        ? { bedrockAccessKeyId: deps.getCredential(saved.bedrockAccessKeyRef, provider) }
        : {}),
      ...(saved.bedrockSecretAccessKeyRef
        ? { bedrockSecretAccessKey: deps.getCredential(saved.bedrockSecretAccessKeyRef, provider) }
        : {}),
      ...(saved.bedrockSessionTokenRef
        ? { bedrockSessionToken: deps.getCredential(saved.bedrockSessionTokenRef, provider) }
        : {}),
      ...(saved.azureEndpoint ? { azureEndpoint: saved.azureEndpoint } : {}),
      ...(saved.azureApiVersion ? { azureApiVersion: saved.azureApiVersion } : {}),
      ...(saved.vertexProject ? { vertexProject: saved.vertexProject } : {}),
      ...(saved.vertexLocation ? { vertexLocation: saved.vertexLocation } : {}),
    };
    if (provider === "azure") {
      if (!saved.azureEndpoint) throw codedError("reasoning-endpoint-missing");
      try {
        deps.validateEnterpriseEndpoint?.(saved.azureEndpoint);
      } catch {
        throw codedError("reasoning-endpoint-invalid");
      }
    }
    const apiKey = provider === "azure" || provider === "vertex"
      ? deps.getCredential(summary.credentialRef, provider)
      : "";
    if (provider === "azure" && !apiKey) throw codedError("api-key-missing");
    const languageModel = await deps.getEnterpriseAIModel(provider, model, apiKey, enterprise);
    const generate = () => deps.generateText({
      model: languageModel,
      system: summary.instruction,
      prompt: input,
      maxOutputTokens: 4096,
      maxRetries: 0,
      abortSignal: signal,
    });
    const result = provider === "bedrock" && deps.runBedrockRequest
      ? await deps.runBedrockRequest(generate, { signal })
      : await generate();
    return result.text;
  }

  if (summary.reasoningMode === "self-hosted") {
    if (!summary.remoteUrl) throw codedError("reasoning-endpoint-missing");
    const baseUrl = resolveSelfHostedOpenAIBase(summary.remoteUrl);
    const languageModel = await deps.getAIModel("local", model, "", baseUrl, {
      disableThinking: summary.options?.disableThinking,
      omitAuthorization: true,
    });
    return (await deps.generateText({
      model: languageModel,
      system: summary.instruction,
      prompt: input,
      maxOutputTokens: 4096,
      temperature: 0.3,
      maxRetries: 0,
      abortSignal: signal,
    })).text;
  }

  const provider = summary.provider;
  if (!provider) throw codedError("reasoning-provider-missing");
  if (!["openai", "groq", "gemini", "anthropic", "tinfoil", "custom", "openrouter", "corti"].includes(provider)) {
    throw codedError("unsupported-reasoning-provider");
  }
  if (provider === "custom" && !summary.cloudBaseUrl) throw codedError("reasoning-endpoint-missing");
  const apiKey = deps.getCredential(summary.credentialRef, provider);
  if (!apiKey) throw codedError("api-key-missing");
  const languageModel = await deps.getAIModel(provider, model, apiKey, summary.cloudBaseUrl, {
    disableThinking: summary.options?.disableThinking,
  });
  return (await deps.generateText({
    model: languageModel,
    system: summary.instruction,
    prompt: input,
    maxOutputTokens: 4096,
    temperature: 0.3,
    maxRetries: 0,
    abortSignal: signal,
  })).text;
}

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
