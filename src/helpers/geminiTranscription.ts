const { net } = require("electron");
const debugLogger = require("./debugLogger");

// gemini-3.5-transcribe is only served by the Interactions API; there is no
// generateContent or OpenAI-compatible endpoint for it.
const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

// Gemini documents audio/mp3 and audio/aac instead of the audio/mpeg and
// audio/mp4 types the rest of the pipeline uses.
const GEMINI_MIME_TYPES = {
  "audio/mpeg": "audio/mp3",
  "audio/mp4": "audio/aac",
};

// The full transcript lives in output_text, but the documented sample response
// omits it — joining the steps' text content is the safe fallback.
function extractText(data: unknown): string {
  const outputText = (data as { output_text?: unknown })?.output_text;
  if (typeof outputText === "string" && outputText.trim()) {
    return outputText;
  }
  const steps = (data as { steps?: Array<{ content?: Array<{ type?: unknown; text?: unknown }> }> | null })
    ?.steps;
  return (steps || [])
    .flatMap((step) => step?.content || [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join(" ");
}

interface GeminiTranscriptionRequest {
  audioBuffer: Buffer | ArrayBuffer;
  model: string | null;
  contentType: string;
  language?: string;
  keyterms?: string[];
  apiKey: string | null | undefined;
  signal?: AbortSignal;
}

interface MinimalGeminiResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export type GeminiFetch = (
  url: string,
  init?: Record<string, unknown>
) => Promise<MinimalGeminiResponse>;

interface CodedGeminiError extends Error {
  code?: string;
  messageKey?: string;
}

export async function transcribeWithGemini(
  { audioBuffer, model, contentType, language, keyterms, apiKey, signal }: GeminiTranscriptionRequest,
  fetchImpl?: GeminiFetch
): Promise<{ text: string; model: string }> {
  if (!apiKey?.trim()) {
    throw Object.assign(new Error("Gemini API key not configured. Add your key in Settings."), {
      code: "API_KEY_MISSING",
    }) as CodedGeminiError;
  }

  const resolvedModel = model || "gemini-3.5-transcribe";
  const transcriptionConfig: { language_codes?: string[]; custom_vocabulary?: string[] } = {};
  if (language && language !== "auto") {
    transcriptionConfig.language_codes = [language];
  }
  if (keyterms && keyterms.length > 0) {
    transcriptionConfig.custom_vocabulary = keyterms;
  }
  const input: Array<Record<string, unknown>> = [
    {
      type: "audio",
      data: (Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer)).toString(
        "base64"
      ),
      mime_type: (GEMINI_MIME_TYPES as Record<string, string>)[contentType] || contentType,
    },
  ];
  const requestBody: Record<string, unknown> = {
    model: resolvedModel,
    input,
  };
  if (Object.keys(transcriptionConfig).length > 0) {
    requestBody.generation_config = { transcription_config: transcriptionConfig };
  }

  debugLogger.debug(
    "Gemini batch transcription starting",
    { model: resolvedModel, language, audioBytes: audioBuffer.byteLength },
    "transcription"
  );

  const doFetch: GeminiFetch = fetchImpl || ((url, init) => net.fetch(url, init as RequestInit));
  const response = await doFetch(GEMINI_INTERACTIONS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(requestBody),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    // Google rejects a bad key with 400 + reason API_KEY_INVALID rather than 401,
    // so status alone would surface the raw JSON instead of a fixable message.
    if (
      response.status === 401 ||
      response.status === 403 ||
      errorText.includes("API_KEY_INVALID")
    ) {
      throw Object.assign(new Error("Invalid Gemini API key. Check your key in Settings."), {
        code: "INVALID_KEY",
      }) as CodedGeminiError;
    }
    const error = Object.assign(
      new Error(`Gemini API Error: ${response.status} ${errorText}`.trim()),
      {} as Record<string, unknown>
    ) as CodedGeminiError;
    if (response.status === 429) {
      error.code = "PROVIDER_RATE_LIMITED";
      error.messageKey = "hooks.audioRecording.errorDescriptions.providerRateLimited";
    } else if (response.status >= 500) {
      error.code = "SERVER_ERROR";
    }
    throw error;
  }

  const data = await response.json();
  const record = data as { status?: string; error?: { message?: string } } | null;
  // Anything short of "completed" (failed, cancelled, budget_exceeded, ...) must
  // not fall through to extractText, which would return empty or truncated text
  // as a successful transcription.
  if (record?.status && record.status !== "completed") {
    const detail = record?.error?.message;
    throw new Error(
      detail
        ? `Gemini transcription failed: ${detail}`
        : `Gemini transcription did not complete (status: ${record.status})`
    );
  }
  return { text: extractText(data), model: resolvedModel };
}
