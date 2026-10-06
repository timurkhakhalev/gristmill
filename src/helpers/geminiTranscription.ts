import { net } from "electron";
import { z } from "zod";

import debugLogger from "./debugLogger.js";

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
// omits it — joining the steps' text content is the safe fallback. Every node
// tolerates or drops individually, mirroring the previous per-field guards.
const geminiResponseSchema = z
  .looseObject({
    status: z.string().nullish().catch(undefined),
    error: z
      .looseObject({ message: z.string().nullish().catch(undefined) })
      .nullish()
      .catch(null),
    output_text: z.string().nullish().catch(undefined),
    steps: z
      .array(
        z
          .looseObject({
            content: z
              .array(
                z
                  .looseObject({
                    type: z.string().nullish().catch(undefined),
                    text: z.string().nullish().catch(undefined),
                  })
                  .nullish()
                  .catch(undefined)
              )
              .nullish()
              .catch(null),
          })
          .nullish()
          .catch(undefined)
      )
      .nullish()
      .catch(null),
  })
  .nullish()
  .catch(undefined);

type GeminiResponsePayload = z.infer<typeof geminiResponseSchema>;

// SAFETY: GeminiRequestInit only carries fields that also exist on RequestInit.
async function defaultFetch(url: string, init?: GeminiRequestInit): Promise<MinimalGeminiResponse> {
  // SAFETY: GeminiRequestInit only carries fields that also exist on RequestInit.
  const response = await net.fetch(url, init as RequestInit);

  // SAFETY: the response payload is untyped; the schema parses it at the caller.
  return response as MinimalGeminiResponse;
}

function extractText(data: GeminiResponsePayload): string {
  const outputText = data?.output_text;

  if (outputText?.trim()) {
    return outputText;
  }

  const steps = data?.steps ?? [];

  const texts: string[] = [];

  for (const step of steps) {
    for (const part of step?.content ?? []) {
      if (part?.type === "text" && part.text) texts.push(part.text);
    }
  }

  return texts.join(" ");
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
  json(): Promise<GeminiResponsePayload | undefined>;
}

export interface GeminiRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type GeminiFetch = (url: string, init?: GeminiRequestInit) => Promise<MinimalGeminiResponse>;

interface GeminiTranscriptionConfig {
  language_codes?: string[];
  custom_vocabulary?: string[];
}

interface GeminiInputPart {
  type: string;
  data: string;
  mime_type: string;
}

interface GeminiRequestBody {
  model: string;
  input: GeminiInputPart[];
  generation_config?: { transcription_config: GeminiTranscriptionConfig };
}

export async function transcribeWithGemini(
  {
    audioBuffer,
    model,
    contentType,
    language,
    keyterms,
    apiKey,
    signal,
  }: GeminiTranscriptionRequest,
  fetchImpl?: GeminiFetch
): Promise<{ text: string; model: string }> {
  if (!apiKey?.trim()) {
    throw Object.assign(new Error("Gemini API key not configured. Add your key in Settings."), {
      code: "API_KEY_MISSING",
    });
  }

  const resolvedModel = model || "gemini-3.5-transcribe";
  const transcriptionConfig: GeminiTranscriptionConfig = {};

  if (language && language !== "auto") {
    transcriptionConfig.language_codes = [language];
  }

  if (keyterms && keyterms.length > 0) {
    transcriptionConfig.custom_vocabulary = keyterms;
  }

  const input: GeminiInputPart[] = [
    {
      type: "audio",
      data: (Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer)).toString(
        "base64"
      ),
      // SAFETY: Object.hasOwn above proves the key exists in the literal.
      mime_type: Object.hasOwn(GEMINI_MIME_TYPES, contentType)
        ? (GEMINI_MIME_TYPES[contentType as keyof typeof GEMINI_MIME_TYPES] ?? contentType)
        : contentType,
    },
  ];

  const requestBody: GeminiRequestBody = {
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

  // SAFETY: GeminiRequestInit only carries fields that also exist on RequestInit.
  const doFetch: GeminiFetch = fetchImpl ?? defaultFetch;

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
      });
    }

    const error: { code?: string; messageKey?: string } & Error = Object.assign(
      new Error(`Gemini API Error: ${response.status} ${errorText}`.trim()),
      {
        code: undefined,
        messageKey: undefined,
      }
    );

    if (response.status === 429) {
      error.code = "PROVIDER_RATE_LIMITED";
      error.messageKey = "hooks.audioRecording.errorDescriptions.providerRateLimited";
    } else if (response.status >= 500) {
      error.code = "SERVER_ERROR";
    }

    throw error;
  }

  // SAFETY: .catch(undefined) keeps every field optional and tolerates junk.
  const data = geminiResponseSchema.parse(await response.json()) as GeminiResponsePayload;

  // Anything short of "completed" (failed, cancelled, budget_exceeded, ...) must
  // not fall through to extractText, which would return empty or truncated text
  // as a successful transcription.
  if (data?.status && data.status !== "completed") {
    const detail = data.error?.message;
    throw new Error(
      detail
        ? `Gemini transcription failed: ${detail}`
        : `Gemini transcription did not complete (status: ${data.status})`
    );
  }

  return { text: extractText(data), model: resolvedModel };
}
