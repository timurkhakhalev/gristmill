// Main-process AI SDK factory for enterprise providers (Bedrock, Azure,
// Vertex). These SDKs depend on Node-only APIs (fs, process, AWS/Azure/Google
// credential chains) and can't run in a Vite-bundled renderer, which is why
// they live here and not in `src/services/ai/providers.ts`. The renderer's
// counterpart handles cloud + local providers only.
//
// Each enterprise SDK is required lazily inside its create*Model function so
// app startup doesn't eager-load ~100 MB of AWS/Azure/Google SDKs for users
// who never select an enterprise provider.

export interface EnterpriseRuntimeConfig {
  bedrockRegion?: string;
  bedrockProfile?: string;
  bedrockAccessKeyId?: string;
  bedrockSecretAccessKey?: string;
  bedrockSessionToken?: string;
  azureEndpoint?: string;
  azureApiVersion?: string;
  vertexProject?: string;
  vertexLocation?: string;
}

interface StaticAwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | null;
}

interface AwsCredentialChain {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

// The model factories return an AI SDK LanguageModel; the narrow call surface
// (generateText/doStream) is what callers consume.
// SAFETY: every branch returns an AI SDK LanguageModel (@ai-sdk/* factories);
// callers feed it straight into generateText's `model` option.
type ProviderModel = import("ai").LanguageModel;

export async function getEnterpriseAIModel(
  provider: string,
  model: string,
  apiKey: string,
  enterprise: EnterpriseRuntimeConfig
): Promise<ProviderModel> {
  switch (provider) {
    case "bedrock":
      return createBedrockModel(model, enterprise);
    case "azure":
      return createAzureModel(model, apiKey, enterprise);
    case "vertex":
      return createVertexModel(model, apiKey, enterprise);
    default:
      throw new Error(`Unsupported enterprise provider: ${provider}`);
  }
}

function hasUsableCredentials(
  source: string | null,
  credentials: AwsCredentialChain | StaticAwsCredentials | null
): boolean {
  return !(
    source &&
    (!credentials ||
      !isNonEmptyString(credentials.accessKeyId) ||
      !isNonEmptyString(credentials.secretAccessKey))
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

async function createBedrockModel(
  model: string,
  enterprise: EnterpriseRuntimeConfig
): Promise<ProviderModel> {
  // SAFETY: lazy CommonJS seam fixed by build-main bundling; the assertion
  // only names the SDK module's own static import type across the seam.
  const { createAmazonBedrock } =
    require("@ai-sdk/amazon-bedrock") as typeof import("@ai-sdk/amazon-bedrock");

  const region = enterprise?.bedrockRegion || "us-east-1";

  const explicitCredentialSource = enterprise?.bedrockProfile
    ? "profile credential provider"
    : enterprise?.bedrockAccessKeyId || enterprise?.bedrockSecretAccessKey
      ? "static credentials"
      : null;

  const credentials: AwsCredentialChain | StaticAwsCredentials | null = enterprise?.bedrockProfile
    ? // SAFETY: lazy CommonJS seam; the SDK's own static import type names the
      // credential chain across it, no wire data crosses.
      await (
        require("@aws-sdk/credential-providers") as typeof import("@aws-sdk/credential-providers")
      ).fromNodeProviderChain({
        profile: enterprise.bedrockProfile,
      })()
    : explicitCredentialSource
      ? {
          accessKeyId: enterprise.bedrockAccessKeyId ?? "",
          secretAccessKey: enterprise.bedrockSecretAccessKey ?? "",
          sessionToken: enterprise.bedrockSessionToken,
        }
      : null;

  if (!hasUsableCredentials(explicitCredentialSource, credentials)) {
    const error = new Error(
      `AWS ${explicitCredentialSource} returned invalid credentials. Expected accessKeyId and secretAccessKey.`
    );

    error.name = "CredentialsProviderError";
    throw error;
  }

  return createAmazonBedrock({
    region,
    ...(credentials
      ? {
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
          sessionToken: credentials.sessionToken ?? undefined,
        }
      : {}),
  })(model);
}

function createAzureModel(
  model: string,
  apiKey: string,
  enterprise: EnterpriseRuntimeConfig
): ProviderModel {
  // SAFETY: lazy CommonJS seam fixed by build-main bundling; names the SDK's
  // own static import type across it.
  const { createAzure } = require("@ai-sdk/azure") as typeof import("@ai-sdk/azure");

  return createAzure({
    apiKey,
    baseURL: enterprise?.azureEndpoint,
    apiVersion: enterprise?.azureApiVersion || "2024-10-21",
  })(model);
}

function createVertexModel(
  model: string,
  apiKey: string,
  enterprise: EnterpriseRuntimeConfig
): ProviderModel {
  // SAFETY: lazy CommonJS seam fixed by build-main bundling; names the SDK's
  // own static import type across it.
  const { createVertex } =
    require("@ai-sdk/google-vertex") as typeof import("@ai-sdk/google-vertex");

  if (apiKey) {
    return createVertex({ apiKey })(model);
  }

  return createVertex({
    project: enterprise?.vertexProject,
    location: enterprise?.vertexLocation || "us-central1",
  })(model);
}
