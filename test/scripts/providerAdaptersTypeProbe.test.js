// Strict compiler probes for the provider-factory/adapter boundary: mapped
// error unions, catalog shapes, retry/abort option contracts and the
// connection-test surface. Codes verified against an actual strict tsc run.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "../..");
const configPath = path.join(root, "tsconfig.main.json");

function probeDiagnostics(source) {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.equal(parsed.options.strict, true);
  const probe = path.join(root, "provider-adapters-type-probe.ts");
  const host = ts.createCompilerHost(parsed.options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, ...args) =>
    file === probe
      ? ts.createSourceFile(file, source, languageVersion, true)
      : readSource(file, languageVersion, ...args);
  const program = ts.createProgram([probe], { ...parsed.options, noEmit: true }, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  return {
    codes: diagnostics.map((d) => d.code).sort((a, b) => a - b),
    cleanup: () => {
      if (fs.existsSync(probe)) fs.rmSync(probe, { force: true });
    },
  };
}

test("wrong factory/adapter/catalog usage fails compilation", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { getEnterpriseAIModel, type EnterpriseRuntimeConfig } from "./src/helpers/enterpriseAiProviders.ts";
import {
  mapEnterpriseError,
  runBedrockRequest,
  runAbortableOperation,
  validateEnterpriseEndpoint,
  type MappedEnterpriseError,
} from "./src/helpers/enterpriseProviderErrors.ts";
import { normalizeBedrockCatalog } from "./src/helpers/bedrockCatalog.ts";
import { testProviderConnection, resolveProviderRequest } from "./src/helpers/providerConnectionTest.ts";
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
`);

  try {
    assert.ok(codes.length > 0, "wrong usage must not compile");
    // Verified against an actual strict run: TS2345 ×2 + TS2559 (arg shapes),
    // TS2554 ×4 (missing args), TS2322 ×2 (buffer/union misuse), TS2352.
    assert.equal(codes.filter((code) => code === 2345).length, 2);
    assert.equal(codes.filter((code) => code === 2554).length, 4);
    assert.equal(codes.filter((code) => code === 2322).length, 2);
    assert.ok(codes.includes(2559), `no-common-properties misuse must fail, got ${codes.join(",")}`);
  } finally {
    cleanup();
  }
});

test("the full provider adapter graph compiles under strict settings", () => {
  const { codes, cleanup } = probeDiagnostics(`
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
`);
  try {
    assert.deepEqual(codes, []);
  } finally {
    cleanup();
  }
});
