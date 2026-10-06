import type { MeetingProcessingConfig } from "../contracts/meetingRecording.js";
import { resolveSelfHostedOpenAIBase } from "../services/ai/openaiBaseCore.js";

export interface SummaryGenerateTextOptions {
  model: unknown;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxOutputTokens: number;
  temperature: number;
  maxRetries: number;
  abortSignal: AbortSignal;
  // The injected generateText is the ai SDK wrapper whose options bag is
  // Record-based (see ipcHandlers GenerateTextOptions, package-3 seam); the
  // index signature keeps that seam compatible. Override: no-unsafe-dictionary-type.
  [key: string]: unknown;
}

export interface MeetingSummaryDeps {
  getAIModel: (
    provider: string,
    model: string,
    apiKey: string,
    baseUrl?: string,
    options?: { disableThinking?: boolean; omitAuthorization?: boolean }
  ) => Promise<import("ai").LanguageModel>;
  generateText: (
    options: SummaryGenerateTextOptions
  ) => Promise<{ text: string; finishReason?: string }>;
  processLocalText: (
    input: string,
    model: string,
    config: import("../contracts/reasoning.js").LocalReasoningConfig,
    signal: AbortSignal
  ) => Promise<string>;
  getCredential: (reference: string | undefined, provider: string) => string;
  getEnterpriseAIModel?: (
    provider: string,
    model: string,
    apiKey: string,
    enterprise: import("./enterpriseAiProviders.js").EnterpriseRuntimeConfig
  ) => Promise<import("ai").LanguageModel>;
  validateEnterpriseEndpoint?: (endpoint: string | undefined) => void;
  runBedrockRequest?: <T>(
    operation: () => Promise<T>,
    options: { signal: AbortSignal }
  ) => Promise<T>;
}

export interface MeetingTextTurn {
  text: string;
  refusal: boolean;
}

export interface MeetingTextConversation {
  send(prompt: string): Promise<MeetingTextTurn>;
}

export async function createMeetingTextConversation(
  summary: NonNullable<MeetingProcessingConfig["summary"]>,
  deps: MeetingSummaryDeps,
  signal: AbortSignal
): Promise<MeetingTextConversation> {
  const model = summary.model || "";

  if (!model) throw codedError("reasoning-model-missing");

  const shared = {
    systemPrompt: summary.instruction,
    maxTokens: 4096,
    temperature: 0.3,
    disableThinking: summary.options?.disableThinking,
    requireCompleteOutput: true,
  };

  if (summary.reasoningMode === "local") {
    const history: Array<{ role: "user" | "assistant"; text: string }> = [];

    return {
      send: async (prompt) => {
        history.push({ role: "user", text: prompt });

        const conversation = history
          .map((turn) => `${turn.role.toUpperCase()}:\n${turn.text}`)
          .join("\n\n");

        const text = await deps.processLocalText(conversation, model, shared, signal);
        history.push({ role: "assistant", text });

        return { text, refusal: false };
      },
    };
  }

  if (summary.reasoningMode === "agent") throw codedError("bb-summary-route-unavailable");

  let languageModel: import("ai").LanguageModel | null = null;
  const provider = summary.provider;

  if (summary.reasoningMode === "enterprise") {
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

    const apiKey =
      provider === "azure" || provider === "vertex"
        ? deps.getCredential(summary.credentialRef, provider)
        : "";

    if (provider === "azure" && !apiKey) throw codedError("api-key-missing");
    languageModel = await deps.getEnterpriseAIModel(provider, model, apiKey, enterprise);
  } else if (summary.reasoningMode === "self-hosted") {
    if (!summary.remoteUrl) throw codedError("reasoning-endpoint-missing");
    languageModel = await deps.getAIModel(
      "local",
      model,
      "",
      resolveSelfHostedOpenAIBase(summary.remoteUrl),
      {
        disableThinking: summary.options?.disableThinking,
        omitAuthorization: true,
      }
    );
  } else {
    if (!provider) throw codedError("reasoning-provider-missing");

    if (
      ![
        "openai",
        "groq",
        "gemini",
        "anthropic",
        "tinfoil",
        "custom",
        "openrouter",
        "corti",
      ].includes(provider)
    ) {
      throw codedError("unsupported-reasoning-provider");
    }

    if (provider === "custom" && !summary.cloudBaseUrl)
      throw codedError("reasoning-endpoint-missing");
    const apiKey = deps.getCredential(summary.credentialRef, provider);

    if (!apiKey) throw codedError("api-key-missing");
    languageModel = await deps.getAIModel(provider, model, apiKey, summary.cloudBaseUrl, {
      disableThinking: summary.options?.disableThinking,
    });
  }

  const history: Array<{ role: "user" | "assistant"; content: string }> = [];

  return {
    send: async (prompt) => {
      history.push({ role: "user", content: prompt });

      const generate = () =>
        deps.generateText({
          model: languageModel,
          system: summary.instruction,
          messages: history.map(({ role, content }) => ({ role, content })),
          maxOutputTokens: 4096,
          temperature: 0.3,
          maxRetries: 0,
          abortSignal: signal,
        });

      const result =
        summary.reasoningMode === "enterprise" && provider === "bedrock" && deps.runBedrockRequest
          ? await deps.runBedrockRequest(generate, { signal })
          : await generate();

      const turn = { text: result.text, refusal: result.finishReason === "content-filter" };

      if (!turn.refusal) history.push({ role: "assistant", content: turn.text });

      return turn;
    },
  };
}

export async function generateMeetingSummary(
  input: string,
  summary: NonNullable<MeetingProcessingConfig["summary"]>,
  deps: MeetingSummaryDeps,
  signal: AbortSignal
): Promise<string> {
  const conversation = await createMeetingTextConversation(summary, deps, signal);
  const result = await conversation.send(input);

  if (result.refusal) throw codedError("meeting-model-refused");

  return result.text;
}

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
