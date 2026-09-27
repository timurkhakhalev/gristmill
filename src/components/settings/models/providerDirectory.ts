// Every BYOK cloud provider in one place: its credentials, where to get them and
// which tasks it can serve. Keys are app-wide, so they are edited once here
// rather than inside each task's picker.

export type ProviderCapability = "speech" | "language";

export type CredentialKey =
  | "openaiApiKey"
  | "anthropicApiKey"
  | "geminiApiKey"
  | "groqApiKey"
  | "xaiApiKey"
  | "mistralApiKey"
  | "openrouterApiKey"
  | "tinfoilApiKey"
  | "cortiApiKey"
  | "cortiClientId"
  | "cortiClientSecret"
  | "cortiEnvironment"
  | "cortiTenant"
  | "deepgramApiKey"
  | "elevenLabsApiKey"
  | "assemblyaiApiKey";

export type CredentialSetterName = `set${Capitalize<CredentialKey>}`;

export const credentialSetterName = (key: CredentialKey): CredentialSetterName =>
  `set${key[0].toUpperCase()}${key.slice(1)}` as CredentialSetterName;

export interface CredentialField {
  key: CredentialKey;
  input: "secret" | "text" | "select";
  /** Which capability this credential unlocks; Corti uses separate speech and language credentials. */
  capability: ProviderCapability;
  labelKey?: string;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
}

export interface ProviderEntry {
  id: string;
  name: string;
  consoleUrl: string;
  capabilities: ProviderCapability[];
  fields: CredentialField[];
  noteKey?: string;
}

const secret = (key: CredentialKey, capability: ProviderCapability, labelKey?: string): CredentialField => ({
  key,
  input: "secret",
  capability,
  labelKey,
});

export const PROVIDER_DIRECTORY: ProviderEntry[] = [
  {
    id: "openai",
    name: "OpenAI",
    consoleUrl: "https://platform.openai.com/api-keys",
    capabilities: ["speech", "language"],
    fields: [secret("openaiApiKey", "speech")],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    consoleUrl: "https://console.anthropic.com/settings/keys",
    capabilities: ["language"],
    fields: [secret("anthropicApiKey", "language")],
  },
  {
    id: "gemini",
    name: "Google Gemini",
    consoleUrl: "https://aistudio.google.com/app/api-keys",
    capabilities: ["speech", "language"],
    fields: [secret("geminiApiKey", "speech")],
  },
  {
    id: "groq",
    name: "Groq",
    consoleUrl: "https://console.groq.com/keys",
    capabilities: ["speech", "language"],
    fields: [secret("groqApiKey", "speech")],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    consoleUrl: "https://openrouter.ai/keys",
    capabilities: ["language"],
    fields: [secret("openrouterApiKey", "language")],
  },
  {
    id: "xai",
    name: "xAI",
    consoleUrl: "https://console.x.ai",
    capabilities: ["speech"],
    fields: [secret("xaiApiKey", "speech")],
  },
  {
    id: "mistral",
    name: "Mistral",
    consoleUrl: "https://console.mistral.ai/api-keys",
    capabilities: ["speech"],
    fields: [secret("mistralApiKey", "speech")],
  },
  {
    id: "deepgram",
    name: "Deepgram",
    consoleUrl: "https://console.deepgram.com/",
    capabilities: ["speech"],
    fields: [secret("deepgramApiKey", "speech")],
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    consoleUrl: "https://elevenlabs.io/app/settings/api-keys",
    capabilities: ["speech"],
    fields: [secret("elevenLabsApiKey", "speech")],
  },
  {
    id: "assemblyai",
    name: "AssemblyAI",
    consoleUrl: "https://www.assemblyai.com/dashboard/api-keys",
    capabilities: ["speech"],
    fields: [secret("assemblyaiApiKey", "speech")],
  },
  {
    id: "tinfoil",
    name: "Tinfoil",
    consoleUrl: "https://tinfoil.sh/inference?utm_source=referral&utm_campaign=openhercules",
    capabilities: ["speech", "language"],
    fields: [secret("tinfoilApiKey", "speech")],
  },
  {
    id: "corti",
    name: "Corti",
    consoleUrl: "https://www.corti.ai/?utm_source=referral&utm_content=&utm_campaign=openhercules",
    capabilities: ["speech", "language"],
    noteKey: "reasoning.corti.euOnly",
    fields: [
      secret("cortiApiKey", "language", "modelsSettings.providers.corti.languageKey"),
      secret("cortiClientId", "speech", "transcription.corti.clientId"),
      secret("cortiClientSecret", "speech", "transcription.corti.clientSecret"),
      {
        key: "cortiEnvironment",
        input: "select",
        capability: "speech",
        labelKey: "transcription.corti.environment",
        options: [
          { value: "us", label: "US" },
          { value: "eu", label: "EU" },
        ],
      },
      { key: "cortiTenant", input: "text", capability: "speech", labelKey: "transcription.corti.tenant", placeholder: "base" },
    ],
  },
];

export function findProvider(id: string): ProviderEntry | undefined {
  return PROVIDER_DIRECTORY.find((entry) => entry.id === id);
}

/**
 * A capability is ready when every secret it needs is present. Shared keys (one
 * key for speech and language) are declared once under "speech" and count for both.
 */
export function isProviderReady(
  entry: ProviderEntry,
  capability: ProviderCapability,
  values: Partial<Record<CredentialKey, string>>
): boolean {
  const secrets = entry.fields.filter((field) => field.input === "secret");
  const own = secrets.filter((field) => field.capability === capability);
  const required = own.length ? own : secrets;
  return required.length > 0 && required.every((field) => !!values[field.key]?.trim());
}
