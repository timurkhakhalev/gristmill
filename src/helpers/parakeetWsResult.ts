export function parseOfflineMessage(message: unknown): string {
  const text = String(message || "").trim();
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.text === "string" ? parsed.text.trim() : text;
  } catch {
    return text;
  }
}

// Latest-wins per finalized segment id (the server refines a segment before its
// endpoint); text() joins segments in first-arrival order plus the trailing partial.
interface OnlineMessage {
  text?: unknown;
  is_final?: unknown;
  segment?: unknown;
}

export interface OnlineAccumulator {
  push(message: string): string;
  text(): string;
}

export function createOnlineAccumulator(): OnlineAccumulator {
  const finalizedSegments = new Map<string, string>();
  let partialText = "";
  let partialSegment: unknown = null;
  let fallbackKey = 0;

  const text = (): string => {
    const finalizedText = Array.from(finalizedSegments.values()).join(" ");
    return finalizedText && partialText
      ? `${finalizedText} ${partialText}`
      : finalizedText || partialText;
  };

  return {
    push(message: string): string {
      let parsed: OnlineMessage;
      try {
        parsed = JSON.parse(message) as OnlineMessage;
      } catch {
        parsed = { text: message };
      }
      if (!parsed || typeof parsed !== "object") return text();

      const messageText = String(parsed.text ?? "").trim();
      if (!messageText) return text();

      if (!parsed.is_final) {
        partialText = finalizedSegments.has(String(parsed.segment)) ? "" : messageText;
        partialSegment = parsed.segment !== undefined ? String(parsed.segment) : null;
        return text();
      }

      const segment = parsed.segment !== undefined ? String(parsed.segment) : `fallback:${fallbackKey++}`;
      finalizedSegments.set(segment, messageText);
      if (partialSegment === null || partialSegment === segment) {
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
