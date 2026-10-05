const debugLogger = require("./debugLogger");

import modelRegistryData from "../models/modelRegistryData.json";
import { tinfoilSecureFetch } from "./tinfoilSecureClient.js";

const TINFOIL_TRANSCRIPTION_PATH = "/v1/audio/transcriptions";

// "Voxtral" is one picker choice but two Tinfoil models: the realtime one streams
// over /v1/realtime; this batch model handles every non-streaming path.
function getBatchModel(): string {
  const provider = (modelRegistryData.transcriptionProviders || []).find((p) => p.id === "tinfoil");
  const model = provider?.batchModel;

  if (!model) {
    throw new Error("No batch transcription model configured for Tinfoil");
  }

  return model;
}

// Batch transcription over the attested transport, sharing the per-session
// SecureClient with realtime dictation so the enclave is verified once.
interface TinfoilTranscriptionRequest {
  audioBuffer: Buffer;
  fileName: string;
  contentType: string;
  language?: string;
  prompt?: string;
  apiKey: string | null | undefined;
  signal?: AbortSignal;
}

interface CodedTranscriptionError extends Error {
  code?: string;
  messageKey?: string;
}

export async function transcribeWithTinfoil({
  audioBuffer,
  fileName,
  contentType,
  language,
  prompt,
  apiKey,
  signal,
}: TinfoilTranscriptionRequest): Promise<{ text: string; model: string }> {
  if (!apiKey?.trim()) {
    const error = Object.assign(
      new Error("Tinfoil API key not configured. Add your key in Settings."),
      { code: "API_KEY_MISSING" }
    ) as CodedTranscriptionError;

    throw error;
  }

  const model = getBatchModel();
  const formData = new FormData();
  formData.append("file", new Blob([new Uint8Array(audioBuffer)], { type: contentType }), fileName);
  formData.append("model", model);

  if (language && language !== "auto") {
    formData.append("language", language);
  }

  if (prompt?.trim()) {
    formData.append("prompt", prompt.trim());
  }

  debugLogger.debug("Tinfoil batch transcription starting", { model, language }, "transcription");

  const response = await tinfoilSecureFetch(TINFOIL_TRANSCRIPTION_PATH, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
    signal,
  });

  if (response.status === 401) {
    throw Object.assign(new Error("Invalid Tinfoil API key. Check your key in Settings."), {
      code: "INVALID_KEY",
    }) as CodedTranscriptionError;
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");

    const error = Object.assign(
      new Error(`Tinfoil API Error: ${response.status} ${errorText}`.trim()),
      {} as Record<string, unknown>
    ) as CodedTranscriptionError;

    if (response.status === 429) {
      error.code = "PROVIDER_RATE_LIMITED";
      error.messageKey = "hooks.audioRecording.errorDescriptions.providerRateLimited";
    } else if (response.status >= 500) {
      error.code = "SERVER_ERROR";
    }

    throw error;
  }

  const data = (await response.json()) as { text?: string } | null;

  return { text: data?.text || "", model };
}
