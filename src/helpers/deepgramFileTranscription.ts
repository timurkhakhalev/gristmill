import { formatTimestamp } from "./speakerMerge.js";
import type { RemoteTranscriptionResult } from "../contracts/uploadTranscription.js";

export function deepgramFileUrl(
  model: string,
  language: string | undefined,
  diarize: boolean,
  multichannel = false
): URL {
  const url = new URL("https://api.deepgram.com/v1/listen");
  url.searchParams.set("model", model);
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("utterances", "true");
  if (multichannel) url.searchParams.set("multichannel", "true");
  if (diarize) url.searchParams.set("diarize_model", "latest");
  if (language) url.searchParams.set("language", language);
  else url.searchParams.set("detect_language", "true");
  return url;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function parseDeepgramFileResponse(
  raw: unknown,
  diarize: boolean,
  multichannel = false
): RemoteTranscriptionResult {
  const results = record(raw)?.results;
  const channels = record(results)?.channels;
  if (multichannel && (!Array.isArray(channels) || channels.length !== 2)) {
    return { success: false, code: "DEEPGRAM_CHANNELS_MISSING", error: "Deepgram did not return both audio channels" };
  }
  const channelTranscripts = (Array.isArray(channels) ? channels : []).map((channel) => {
    const alternatives = record(channel)?.alternatives;
    return Array.isArray(alternatives) ? record(alternatives[0])?.transcript : undefined;
  });
  if (multichannel && channelTranscripts.some((text) => typeof text !== "string")) {
    return { success: false, code: "DEEPGRAM_INVALID_RESPONSE", error: "Deepgram returned an invalid channel transcript" };
  }
  const transcript = multichannel ? channelTranscripts.join("\n") : channelTranscripts[0];
  if (typeof transcript !== "string") {
    return {
      success: false,
      error: "Deepgram returned no transcript",
      code: "DEEPGRAM_INVALID_RESPONSE",
    };
  }

  const utterances = record(results)?.utterances;
  if (!Array.isArray(utterances)) {
    return diarize && transcript.trim()
      ? {
          success: false,
          error: "Deepgram returned no speaker data",
          code: "DEEPGRAM_DIARIZATION_MISSING",
        }
      : { success: true, text: transcript };
  }

  const segments: NonNullable<RemoteTranscriptionResult["segments"]> = [];
  for (const value of utterances) {
    const item = record(value);
    if (
      !item ||
      (multichannel && item.channel !== 0 && item.channel !== 1) ||
      typeof item.transcript !== "string" ||
      typeof item.start !== "number" ||
      !Number.isFinite(item.start) ||
      typeof item.end !== "number" ||
      !Number.isFinite(item.end) ||
      item.start < 0 ||
      item.end < item.start ||
      (diarize && (!Number.isInteger(item.speaker) || (item.speaker as number) < 0))
    ) {
      return {
        success: false,
        error: "Deepgram returned invalid speaker or timing data",
        code: "DEEPGRAM_INVALID_RESPONSE",
      };
    }
    segments.push({
      ...(diarize ? { speaker: multichannel ? (item.channel === 0 ? "mic" : `system:Speaker ${(item.speaker as number) + 1}`) : `Speaker ${(item.speaker as number) + 1}` } : {}),
      text: item.transcript,
      start: item.start,
      end: item.end,
    });
  }

  if (diarize && transcript.trim() && segments.length === 0) {
    return {
      success: false,
      error: "Deepgram returned no speaker data",
      code: "DEEPGRAM_DIARIZATION_MISSING",
    };
  }

  if (multichannel && channelTranscripts.some((text, channel) =>
    typeof text === "string" && text.trim() && !utterances.some((value) => record(value)?.channel === channel)
  )) {
    return { success: false, code: "DEEPGRAM_DIARIZATION_MISSING", error: "Deepgram omitted utterances for a nonempty channel" };
  }
  segments.sort((a, b) => a.start - b.start);
  return {
    success: true,
    text: diarize
      ? segments
          .map(
            (s) =>
              `[${s.speaker}] ${formatTimestamp(s.start)} - ${formatTimestamp(s.end)}\n${s.text}`
          )
          .join("\n\n")
      : transcript,
    diarized: diarize && segments.length > 0,
    segments,
  };
}
