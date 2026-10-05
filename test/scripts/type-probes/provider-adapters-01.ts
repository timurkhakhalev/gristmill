// @probe-name "wrong factory/adapter/catalog usage fails compilation"
// @probe-codes [2322,2322,2345,2345,2352,2554,2554,2554,2554,2559]
// @probe-origin test/scripts/providerAdaptersTypeProbe.test.js
import {
  getEnterpriseAIModel,
  type EnterpriseRuntimeConfig,
} from "./src/helpers/enterpriseAiProviders.ts";
import {
  mapEnterpriseError,
  runBedrockRequest,
  runAbortableOperation,
  validateEnterpriseEndpoint,
  type MappedEnterpriseError,
} from "./src/helpers/enterpriseProviderErrors.ts";
import { normalizeBedrockCatalog } from "./src/helpers/bedrockCatalog.ts";
import {
  testProviderConnection,
  resolveProviderRequest,
} from "./src/helpers/providerConnectionTest.ts";
import { transcribeWithGemini } from "./src/helpers/geminiTranscription.ts";
import { transcribeWithTinfoil } from "./src/helpers/tinfoilTranscription.ts";
import { getCortiToken } from "./src/helpers/cortiAuth.ts";

async function misuse(): Promise<void> {
  // The factory takes (provider, model, apiKey, enterprise).
  await getEnterpriseAIModel("bedrock");

  // runBedrockRequest retries an operation, not a value.
  await runBedrockRequest("just a string");

  // Abortable operation needs the function.
  await runAbortableOperation();

  // testProviderConnection config is an object.
  await testProviderConnection("openai");

  // Gemini transcription needs the audio buffer.
  await transcribeWithGemini({ audioBuffer: "not-a-buffer" });

  // Tinfoil takes its request object.
  await transcribeWithTinfoil();

  // Corti token request requires all credential fields.
  await getCortiToken({ environment: "us" });
}
void misuse;

// normalizeBedrockCatalog takes two SDK summary lists.
normalizeBedrockCatalog("models");

// Mapped errors are a typed union — copyCommand does not exist on all arms.
declare const mapped: MappedEnterpriseError;
const copyCommand: string = mapped.copyCommand;
void copyCommand;
void validateEnterpriseEndpoint;
void resolveProviderRequest;
void {} as EnterpriseRuntimeConfig;
void mapEnterpriseError;
