import { formatTimestamp } from "./speakerMerge.js";
import type { RemoteTranscriptionResult } from "../contracts/uploadTranscription.js";

export const ELEVENLABS_TRANSCRIPTION_URL = new URL("https://api.elevenlabs.io/v1/speech-to-text");

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function elevenLabsFields(
  model: string,
  language: string | undefined,
  diarize: boolean
): Record<string, string> {
  if (language && !/^[a-z]{2,3}$/i.test(language)) {
    throw new Error("Invalid ElevenLabs language code");
  }
  return {
    model_id: model,
    diarize: String(diarize),
    timestamps_granularity: "word",
    ...(language ? { language_code: language } : {}),
  };
}

export function parseElevenLabsFileResponse(
  raw: unknown,
  diarize: boolean
): RemoteTranscriptionResult {
  const response = record(raw);
  if (typeof response?.text !== "string") {
    return {
      success: false,
      error: "ElevenLabs returned no transcript",
      code: "ELEVENLABS_INVALID_RESPONSE",
    };
  }
  if (!response.text.trim()) return { success: true, text: response.text };
  if (!Array.isArray(response.words)) {
    return diarize
      ? {
          success: false,
          error: "ElevenLabs returned no speaker data",
          code: "ELEVENLABS_DIARIZATION_MISSING",
        }
      : { success: true, text: response.text };
  }

  const segments: NonNullable<RemoteTranscriptionResult["segments"]> = [];
  for (const value of response.words) {
    const word = record(value);
    if (!word || typeof word.text !== "string" || typeof word.type !== "string") {
      return {
        success: false,
        error: "ElevenLabs returned invalid word data",
        code: "ELEVENLABS_INVALID_RESPONSE",
      };
    }
    if (word.type === "spacing") {
      if (segments.length) segments[segments.length - 1].text += word.text;
      continue;
    }
    if (word.type === "audio_event") continue;
    if (word.type !== "word") {
      return {
        success: false,
        error: "ElevenLabs returned invalid word data",
        code: "ELEVENLABS_INVALID_RESPONSE",
      };
    }
    if (
      typeof word.start !== "number" ||
      !Number.isFinite(word.start) ||
      word.start < 0 ||
      typeof word.end !== "number" ||
      !Number.isFinite(word.end) ||
      word.end < word.start
    ) {
      return {
        success: false,
        error: "ElevenLabs returned invalid timing data",
        code: "ELEVENLABS_INVALID_RESPONSE",
      };
    }
    if (diarize && (typeof word.speaker_id !== "string" || !word.speaker_id)) {
      return {
        success: false,
        error: "ElevenLabs returned no speaker data",
        code: "ELEVENLABS_DIARIZATION_MISSING",
      };
    }
    const speakerId = diarize ? (word.speaker_id as string) : "";
    const speakerNumber = /^speaker_(\d+)$/.exec(speakerId);
    const speaker = diarize
      ? speakerNumber
        ? `Speaker ${Number(speakerNumber[1]) + 1}`
        : speakerId
      : undefined;
    const previous = segments.at(-1);
    if (previous && previous.speaker === speaker && word.start - previous.end < 0.75) {
      previous.text += word.text;
      previous.end = word.end;
    } else {
      segments.push({
        ...(speaker ? { speaker } : {}),
        text: word.text,
        start: word.start,
        end: word.end,
      });
    }
  }
  if (segments.length === 0) {
    return diarize
      ? {
          success: false,
          error: "ElevenLabs returned no speaker data",
          code: "ELEVENLABS_DIARIZATION_MISSING",
        }
      : { success: true, text: response.text };
  }
  return {
    success: true,
    text: diarize
      ? segments
          .map(
            (s) =>
              `[${s.speaker}] ${formatTimestamp(s.start)} - ${formatTimestamp(s.end)}\n${s.text.trim()}`
          )
          .join("\n\n")
      : response.text,
    diarized: diarize,
    segments,
  };
}
