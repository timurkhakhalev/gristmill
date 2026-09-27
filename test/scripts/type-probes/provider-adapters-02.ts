// @probe-name "the full provider adapter graph compiles under strict settings"
// @probe-codes []
// @probe-origin test/scripts/providerAdaptersTypeProbe.test.js
import { getEnterpriseAIModel } from "./src/helpers/enterpriseAiProviders.ts";
import {
  mapEnterpriseError,
  runBedrockRequest,
  runAbortableOperation,
  validateEnterpriseEndpoint,
  isEnterpriseProvider,
  pickEnterpriseConfig,
  unwrapRetryError,
  type MappedEnterpriseError,
  type EnterpriseProvider,
} from "./src/helpers/enterpriseProviderErrors.ts";
import { normalizeBedrockCatalog } from "./src/helpers/bedrockCatalog.ts";
import { getTinfoilChatModels } from "./src/helpers/tinfoilCatalog.ts";
import { testProviderConnection, resolveProviderRequest, type ConnectionTestOutcome } from "./src/helpers/providerConnectionTest.ts";
import { transcribeWithGemini } from "./src/helpers/geminiTranscription.ts";
import { transcribeWithTinfoil } from "./src/helpers/tinfoilTranscription.ts";
import { transcribeAudio } from "./src/helpers/cortiTranscription.ts";
import { assertValidTarget, getCortiToken } from "./src/helpers/cortiAuth.ts";
import { tinfoilSecureFetch, createTinfoilRealtimeSocket } from "./src/helpers/tinfoilSecureClient.ts";
import { extractAnthropicText, describeMissingAnthropicText } from "./src/helpers/anthropicResponse.ts";
import { classifyNetworkError, classifyAndLog } from "./src/helpers/networkErrors.ts";
import { extractGeminiText } from "./src/helpers/geminiResponse.ts";
import { isSelfHostedTranscription, resolveSelfHostedTranscriptionModel } from "./src/helpers/selfHostedTranscription.ts";

async function useAll(): Promise<string> {
  const model = await getEnterpriseAIModel("bedrock", "anthropic.claude", "key", {
    bedrockRegion: "eu-west-1",
    bedrockAccessKeyId: "a",
    bedrockSecretAccessKey: "b",
  });
  void model;
  validateEnterpriseEndpoint("https://acme.openai.azure.com");
  assertValidTarget("us", "tenant");
  await getCortiToken({ environment: "us", tenant: "t", clientId: "id", clientSecret: "secret" });

  const outcome: ConnectionTestOutcome = await testProviderConnection({
    provider: "openai",
    apiKey: "k",
    model: "gpt-4o",
  });
  const request = resolveProviderRequest({ provider: "custom", baseUrl: "http://10.0.0.5:8080/v1", apiKey: "k" });
  void request.endpoints[0];

  await runBedrockRequest(async () => "ok", { maxAttempts: 2, initialDelayMs: 1 });
  await runAbortableOperation(async () => 1);
  const mapped: MappedEnterpriseError = mapEnterpriseError("bedrock", new Error("x"), {});
  void mapped.message;
  void unwrapRetryError(new Error("x"));
  void isEnterpriseProvider("azure");
  void pickEnterpriseConfig({ bedrockRegion: "us-east-1" });
  const provider: EnterpriseProvider = "bedrock";
  void provider;

  void normalizeBedrockCatalog([], []);
  void getTinfoilChatModels;
  await transcribeWithGemini({ audioBuffer: Buffer.from("a"), model: null, contentType: "audio/mpeg", apiKey: "k" });
  await transcribeWithTinfoil({ audioBuffer: Buffer.from("a"), fileName: "a.mp3", contentType: "audio/mpeg", apiKey: "k" });
  await transcribeAudio({ environment: "us", tenant: "t", clientId: "id", clientSecret: "s", audioBuffer: Buffer.from("a") });
  void tinfoilSecureFetch;
  void createTinfoilRealtimeSocket;

  void extractAnthropicText({ content: [{ type: "text", text: "hi" }] });
  void describeMissingAnthropicText({});
  void classifyNetworkError({ code: "ENOTFOUND" });
  void classifyAndLog({ code: "ETIMEDOUT" }, "https://x");
  void extractGeminiText({ content: { parts: [{ text: "hi" }] } });
  void isSelfHostedTranscription({ transcriptionMode: "self-hosted", remoteTranscriptionUrl: "https://x" });
  void resolveSelfHostedTranscriptionModel({});

  return [outcome.success ? "1" : "0", String(request.endpoints.length)].join();
}
void useAll;
