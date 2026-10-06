import { z } from "zod";
import { formatTimestamp } from "./speakerMerge.js";
import type { RemoteTranscriptionResult } from "../contracts/uploadTranscription.js";

export const ELEVENLABS_TRANSCRIPTION_URL = new URL("https://api.elevenlabs.io/v1/speech-to-text");

const elevenLabsWordSchema = z
  .looseObject({
    text: z.string().optional(),
    type: z.string().optional(),
    start: z.number().optional(),
    end: z.number().optional(),
    speaker_id: z.string().optional(),
  })
  .catch({});

const elevenLabsResponseSchema = z
  .looseObject({
    text: z.string().optional(),
    // A non-array words payload is handled below via the same
    // "no speaker data" branch the previous Array.isArray check produced.
    words: z.array(elevenLabsWordSchema).catch([]).optional(),
  })
  .catch({});

// ponytail: the field bag stays Record<string, string> because the package-3
// transport appends it to a form body verbatim; the open-dictionary lint rule
// is overridden for this exact seam (override: no-known-value-widening).
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
  // `raw: unknown` is kept because the IPC caller (package-3 transport) hands
  // over JSON.parse output typed unknown; this function IS the parse boundary
  // (override: no-unknown-parameters).
  raw: unknown,
  diarize: boolean
): RemoteTranscriptionResult {
  const response = elevenLabsResponseSchema.parse(raw);

  if (response.text === undefined) {
    return {
      success: false,
      error: "ElevenLabs returned no transcript",
      code: "ELEVENLABS_INVALID_RESPONSE",
    };
  }

  if (!response.text.trim()) return { success: true, text: response.text };

  if (response.words === undefined) {
    return diarize
      ? {
          success: false,
          error: "ElevenLabs returned no speaker data",
          code: "ELEVENLABS_DIARIZATION_MISSING",
        }
      : { success: true, text: response.text };
  }

  const segments: NonNullable<RemoteTranscriptionResult["segments"]> = [];

  for (const word of response.words) {
    if (word.text === undefined || word.type === undefined) {
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
      word.start === undefined ||
      !Number.isFinite(word.start) ||
      word.start < 0 ||
      word.end === undefined ||
      !Number.isFinite(word.end) ||
      word.end < word.start
    ) {
      return {
        success: false,
        error: "ElevenLabs returned invalid timing data",
        code: "ELEVENLABS_INVALID_RESPONSE",
      };
    }

    let speakerId = "";

    if (diarize) {
      if (!word.speaker_id) {
        return {
          success: false,
          error: "ElevenLabs returned no speaker data",
          code: "ELEVENLABS_DIARIZATION_MISSING",
        };
      }

      speakerId = word.speaker_id;
    }

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
