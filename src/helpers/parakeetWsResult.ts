import { z } from "zod";

// Parser for sherpa-onnx WebSocket result messages. The wire payload is text:
// offline mode sends one JSON or plain-text result, online mode streams
// per-segment JSON frames that the accumulator folds latest-wins per segment.
// The frames are untrusted external input, so each is validated through a
// tolerant schema before any field is read.
//
// Offline `text` is consumed only when it is a JSON string; a non-string text
// leaves the whole raw frame as the result (the pre-existing fallback). Online
// `text`/`segment` accept any JSON scalar and are stringified, so numeric and
// boolean fields still yield text while non-scalar fields degrade to absent.
const onlineFrameSchema = z.looseObject({
  text: z.union([z.string(), z.number(), z.boolean()]).optional(),
  is_final: z.unknown().optional(),
  segment: z.union([z.string(), z.number()]).optional(),
});

type OnlineFrame = z.infer<typeof onlineFrameSchema>;

const offlineResultSchema = z.looseObject({ text: z.string() });

// SAFETY: JSON.parse returns unknown; the schema above is the parse that
// narrows it to the frame shape, and the caller branches on success.
function parseJson(raw: string): { frame: OnlineFrame } | { scalar: unknown } | { invalid: true } {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return { invalid: true };
  }

  const result = onlineFrameSchema.safeParse(parsed);

  return result.success ? { frame: result.data } : { scalar: parsed };
}

function frameText(frame: OnlineFrame): string {
  return frame.text === undefined ? "" : String(frame.text);
}

export function parseOfflineMessage(message: string | null | undefined): string {
  const text = (message ?? "").trim();
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }

  const result = offlineResultSchema.safeParse(parsed);

  return result.success ? result.data.text.trim() : text;
}

// Latest-wins per finalized segment id (the server refines a segment before its
// endpoint); text() joins segments in first-arrival order plus the trailing partial.
export interface OnlineAccumulator {
  push(message: string): string;
  text(): string;
}

export function createOnlineAccumulator(): OnlineAccumulator {
  const finalizedSegments = new Map<string, string>();
  let partialText = "";
  let partialSegment: string | null = null;
  let fallbackKey = 0;

  const text = (): string => {
    const finalizedText = Array.from(finalizedSegments.values()).join(" ");

    return finalizedText && partialText
      ? `${finalizedText} ${partialText}`
      : finalizedText || partialText;
  };

  return {
    push(message: string): string {
      const parsed = parseJson(message);

      // A scalar control frame ("null", "true") carries no text and is ignored;
      // a non-JSON payload is used verbatim as one text frame.
      if ("scalar" in parsed) return text();

      const frame: OnlineFrame = "frame" in parsed ? parsed.frame : { text: message };
      const messageText = frameText(frame).trim();

      if (!messageText) return text();

      const segmentValue = frame.segment;
      const segment = segmentValue === undefined ? null : String(segmentValue);

      if (!frame.is_final) {
        partialText = segment !== null && finalizedSegments.has(segment) ? "" : messageText;
        partialSegment = segment;

        return text();
      }

      const finalSegment = segment ?? `fallback:${fallbackKey++}`;

      finalizedSegments.set(finalSegment, messageText);

      if (partialSegment === null || partialSegment === finalSegment) {
        partialText = "";
        partialSegment = null;
      }

      return text();
    },
    text,
  };
}

export function parseOnlineMessages(messages: string[]): string {
  const accumulator = createOnlineAccumulator();

  for (const message of messages) {
    accumulator.push(message);
  }

  return accumulator.text();
}
