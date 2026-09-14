const { net } = require("electron");
const crypto = require("crypto");
const debugLogger = require("./debugLogger");
const { getCortiToken } = require("./cortiAuth");

async function request(token, tenant, url, options = {}) {
  const response = await net.fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Tenant-Name": tenant,
      ...options.headers,
    },
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Corti API Error: ${response.status} ${errorText}`.trim());
  }
  return response;
}

async function requestJson(token, tenant, url, options) {
  return (await request(token, tenant, url, options)).json();
}

// The interaction cleanup in transcribeAudio's finally runs on its own
// bounded time (never the already-aborted upload signal), so a cancel still
// waits out a slow DELETE instead of dropping it silently.
const CORTI_CLEANUP_TIMEOUT_MS = 10_000;

// Corti's WSS /transcribe endpoint is a strictly real-time engine — replaying a
// finished recording faster than real time drops audio. Pre-recorded dictation
// goes through the interaction REST flow instead: create → upload → transcribe.
async function transcribeAudio({
  environment,
  tenant,
  clientId,
  clientSecret,
  audioBuffer,
  language,
  signal,
}) {
  const token = await getCortiToken({ environment, tenant, clientId, clientSecret, signal });
  const base = `https://api.${environment}.corti.app/v2`;

  debugLogger.debug(
    "Corti transcription starting",
    { environment, tenant, audioBytes: audioBuffer.byteLength, language },
    "transcription"
  );

  const { interactionId } = await requestJson(token, tenant, `${base}/interactions/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      encounter: {
        identifier: `openhercules-${crypto.randomUUID()}`,
        status: "completed",
        type: "consultation",
      },
    }),
    signal,
  });

  try {
    const { recordingId } = await requestJson(
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

    const transcript = await requestJson(
      token,
      tenant,
      `${base}/interactions/${interactionId}/transcripts/`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordingId, primaryLanguage: language, isDictation: true }),
        signal,
      }
    );

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
        { interactionId, error: error.message },
        "transcription"
      )
    );
  }
}

module.exports = { transcribeAudio };
