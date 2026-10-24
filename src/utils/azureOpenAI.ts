const AZURE_HOST_SUFFIXES = [
  ".openai.azure.com",
  ".cognitiveservices.azure.com",
  ".services.ai.azure.com",
];

// API version that supports the gpt-4o-transcribe / gpt-4o-mini-transcribe audio
// models (and remains compatible with whisper-1). Used when the user doesn't
// pin their own api-version in the endpoint URL.
export const DEFAULT_AZURE_TRANSCRIPTION_API_VERSION = "2025-03-01-preview";

export function isAzureOpenAIEndpoint(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();

    return AZURE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  } catch {
    return false;
  }
}

// Azure OpenAI doesn't expose the plain OpenAI `{base}/audio/transcriptions`
// shape — it routes by deployment in the path and requires an `api-version`
// query string. Given the user's resource endpoint and the deployment name
// (the "model" field), build the deployment-style URL Azure actually expects.
//
// If the user already pasted a full `.../audio/transcriptions` URL, it's
// respected as-is so they can pin a custom path / api-version.
export function buildAzureTranscriptionUrl(
  base: string,
  deployment: string,
  apiVersion?: string
): string | null {
  try {
    const parsed = new URL(base);
    const path = parsed.pathname.replace(/\/+$/, "");

    if (/\/audio\/(transcriptions|translations)$/i.test(path)) {
      return parsed.toString();
    }

    const name = (deployment || "").trim();

    if (!name) return null;

    const version =
      parsed.searchParams.get("api-version") ||
      (apiVersion || "").trim() ||
      DEFAULT_AZURE_TRANSCRIPTION_API_VERSION;

    return `${parsed.origin}/openai/deployments/${encodeURIComponent(
      name
    )}/audio/transcriptions?api-version=${encodeURIComponent(version)}`;
  } catch {
    return null;
  }
}
