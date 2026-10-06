import { net } from "electron";

import crypto from "crypto";

import debugLogger from "./debugLogger.js";

import { getCortiToken } from "./cortiAuth.js";

interface CortiRequestOptions {
  headers?: Record<string, string>;
  method?: string;
  body?: string | Buffer | Uint8Array;
  signal?: AbortSignal;
}

async function request(
  token: string,
  tenant: string,
  url: string,
  options: CortiRequestOptions = {}
): Promise<Response> {
  // SAFETY: our option bag widens body beyond the DOM RequestInit union;
  // net.fetch accepts ArrayBufferView bodies at runtime.
  const response = await net.fetch(url, {
    ...options,
    body:
      options.body === undefined ? undefined : (options.body as NonNullable<RequestInit["body"]>),
    headers: {
      Authorization: `Bearer ${token}`,
      "Tenant-Name": tenant,
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Corti API Error: ${response.status} ${errorText}`.trim());
  }

  return response;
}

async function requestJson<T>(
  token: string,
  tenant: string,
  url: string,
  options?: CortiRequestOptions
): Promise<T> {
  // SAFETY: this parses the JSON body into the caller-specified schema at the
  // HTTP boundary; each call site passes the expected response shape.
  return (await request(token, tenant, url, options)).json() as Promise<T>;
}

// The interaction cleanup in transcribeAudio's finally runs on its own
// bounded time (never the already-aborted upload signal), so a cancel still
// waits out a slow DELETE instead of dropping it silently.
const CORTI_CLEANUP_TIMEOUT_MS = 10_000;

// Corti's WSS /transcribe endpoint is a strictly real-time engine — replaying a
// finished recording faster than real time drops audio. Pre-recorded dictation
// goes through the interaction REST flow instead: create → upload → transcribe.
interface CortiTranscriptionRequest {
  environment: string;
  tenant: string;
  clientId: string;
  clientSecret: string;
  audioBuffer: Buffer;
  language?: string;
  signal?: AbortSignal;
}

export async function transcribeAudio({
  environment,
  tenant,
  clientId,
  clientSecret,
  audioBuffer,
  language,
  signal,
}: CortiTranscriptionRequest): Promise<{ text: string }> {
  const token = await getCortiToken({ environment, tenant, clientId, clientSecret, signal });
  const base = `https://api.${environment}.corti.app/v2`;

  debugLogger.debug(
    "Corti transcription starting",
    { environment, tenant, audioBytes: audioBuffer.byteLength, language },
    "transcription"
  );

  const { interactionId } = await requestJson<{ interactionId: string }>(
    token,
    tenant,
    `${base}/interactions/`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        encounter: {
          identifier: `gristmill-${crypto.randomUUID()}`,
          status: "completed",
          type: "consultation",
        },
      }),
      signal,
    }
  );

  try {
    const { recordingId } = await requestJson<{ recordingId: string }>(
      token,
      tenant,
      `${base}/interactions/${interactionId}/recordings/`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: Buffer.from(audioBuffer),
        signal,
      }
    );

    const transcript = await requestJson<{
      transcripts?: Array<{ text?: string }>;
    }>(token, tenant, `${base}/interactions/${interactionId}/transcripts/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recordingId, primaryLanguage: language, isDictation: true }),
      signal,
    });

    return { text: (transcript.transcripts || []).map((utterance) => utterance.text).join(" ") };
  } finally {
    // Dictation audio must not persist on Corti's servers — deleting the
    // interaction cascades to its recordings and transcripts.
    request(token, tenant, `${base}/interactions/${interactionId}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(CORTI_CLEANUP_TIMEOUT_MS),
    }).catch((error) =>
      debugLogger.error(
        "Failed to delete Corti interaction",
        { interactionId, error: error instanceof Error ? error.message : String(error) },
        "transcription"
      )
    );
  }
}
