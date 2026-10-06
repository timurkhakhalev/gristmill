import { z } from "zod";
import { formatTimestamp } from "./speakerMerge.js";
import type { RemoteTranscriptionResult } from "../contracts/uploadTranscription.js";

const deepgramAlternativeSchema = z.looseObject({ transcript: z.string().optional() }).catch({});

const deepgramChannelSchema = z
  .looseObject({ alternatives: z.array(deepgramAlternativeSchema).optional() })
  .catch({});

const deepgramWordSchema = z
  .looseObject({
    word: z.string().optional(),
    punctuated_word: z.string().optional(),
    speaker: z.number().optional(),
    start: z.number().optional(),
    end: z.number().optional(),
  })
  .catch({});

const deepgramUtteranceSchema = z
  .looseObject({
    transcript: z.string().optional(),
    start: z.number().optional(),
    end: z.number().optional(),
    channel: z.number().optional(),
    speaker: z.number().optional(),
    // A junk words payload degrades to "no words", exactly like the previous
    // record()-based reader treated a non-array words field.
    words: z.array(deepgramWordSchema).catch([]).optional(),
  })
  .catch({});

export const deepgramProviderResponseSchema = z
  .looseObject({
    results: z
      .looseObject({
        channels: z.array(deepgramChannelSchema).optional(),
        utterances: z.array(deepgramUtteranceSchema).optional(),
      })
      .optional(),
  })
  .catch({});

// Tolerant by construction: the schema's catch fallbacks mirror the previous
// record()-based reader, so any junk payload still parses. `raw: unknown` is
// kept because both IPC callers (package-3 transport) hand over JSON.parse
// output typed unknown; this function IS the parse boundary
// (override: no-unknown-parameters).

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

export function parseDeepgramFileResponse(
  raw: unknown,
  diarize: boolean,
  multichannel = false,
  audioDurationSeconds?: number
): RemoteTranscriptionResult {
  const results = deepgramProviderResponseSchema.parse(raw).results;
  const channels = results?.channels;

  if (multichannel && channels?.length !== 2) {
    return {
      success: false,
      code: "DEEPGRAM_CHANNELS_MISSING",
      error: "Deepgram did not return both audio channels",
    };
  }

  const channelTranscripts = (channels ?? []).map(
    (channel) => channel.alternatives?.[0]?.transcript
  );

  if (multichannel && channelTranscripts.some((text) => text === undefined)) {
    return {
      success: false,
      code: "DEEPGRAM_INVALID_RESPONSE",
      error: "Deepgram returned an invalid channel transcript",
    };
  }

  const transcript = multichannel ? channelTranscripts.join("\n") : channelTranscripts[0];

  if (transcript === undefined) {
    return {
      success: false,
      error: "Deepgram returned no transcript",
      code: "DEEPGRAM_INVALID_RESPONSE",
    };
  }

  const utterances = results?.utterances;

  if (utterances === undefined) {
    return diarize && transcript.trim()
      ? {
          success: false,
          error: "Deepgram returned no speaker data",
          code: "DEEPGRAM_DIARIZATION_MISSING",
        }
      : { success: true, text: transcript };
  }

  const segments: NonNullable<RemoteTranscriptionResult["segments"]> = [];

  for (const item of utterances) {
    const words = diarize && item.words?.length ? item.words : null;

    let itemSpeaker: number | undefined;

    if (diarize && !words) {
      const speaker = item.speaker;

      if (speaker === undefined || !Number.isInteger(speaker) || speaker < 0) {
        return {
          success: false,
          error: "Deepgram returned invalid speaker or timing data",
          code: "DEEPGRAM_INVALID_RESPONSE",
        };
      }

      itemSpeaker = speaker;
    }

    if (
      (multichannel && item.channel !== 0 && item.channel !== 1) ||
      item.transcript === undefined ||
      item.start === undefined ||
      !Number.isFinite(item.start) ||
      item.end === undefined ||
      !Number.isFinite(item.end) ||
      item.start < 0 ||
      item.end < item.start ||
      (audioDurationSeconds !== undefined && item.start > audioDurationSeconds)
    ) {
      return {
        success: false,
        error: "Deepgram returned invalid speaker or timing data",
        code: "DEEPGRAM_INVALID_RESPONSE",
      };
    }

    const speakerLabel = (speaker: number) =>
      multichannel
        ? item.channel === 0
          ? "mic"
          : `system:Speaker ${speaker + 1}`
        : `Speaker ${speaker + 1}`;

    if (words) {
      let turn: (typeof segments)[number] | undefined;

      for (const word of words) {
        const text = word.punctuated_word ?? word.word;

        if (
          text === undefined ||
          !text.trim() ||
          word.speaker === undefined ||
          !Number.isInteger(word.speaker) ||
          word.speaker < 0 ||
          word.start === undefined ||
          !Number.isFinite(word.start) ||
          word.start < 0 ||
          word.end === undefined ||
          !Number.isFinite(word.end) ||
          word.end < word.start ||
          (audioDurationSeconds !== undefined && word.start > audioDurationSeconds)
        ) {
          return {
            success: false,
            code: "DEEPGRAM_INVALID_RESPONSE",
            error: "Deepgram returned invalid word speaker or timing data",
          };
        }

        const speaker = speakerLabel(word.speaker);

        const end =
          audioDurationSeconds === undefined ? word.end : Math.min(word.end, audioDurationSeconds);

        if (turn?.speaker === speaker) {
          turn.text += ` ${text.trim()}`;
          turn.start = Math.min(turn.start, word.start);
          turn.end = Math.max(turn.end, end);
        } else {
          turn = { speaker, text: text.trim(), start: word.start, end };
          segments.push(turn);
        }
      }

      continue;
    }

    segments.push({
      ...(itemSpeaker !== undefined ? { speaker: speakerLabel(itemSpeaker) } : {}),
      text: item.transcript,
      start: item.start,
      end: audioDurationSeconds === undefined ? item.end : Math.min(item.end, audioDurationSeconds),
    });
  }

  if (diarize && transcript.trim() && segments.length === 0) {
    return {
      success: false,
      error: "Deepgram returned no speaker data",
      code: "DEEPGRAM_DIARIZATION_MISSING",
    };
  }

  if (
    multichannel &&
    channelTranscripts.some(
      (text, channel) =>
        text !== undefined && text.trim() && !utterances.some((value) => value.channel === channel)
    )
  ) {
    return {
      success: false,
      code: "DEEPGRAM_DIARIZATION_MISSING",
      error: "Deepgram omitted utterances for a nonempty channel",
    };
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
