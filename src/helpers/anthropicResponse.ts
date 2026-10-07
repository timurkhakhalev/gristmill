// Text extraction for Anthropic Messages API responses. `content` is a block
// array whose shape varies run to run: it can be empty (max_tokens hit before
// any text), or lead with non-text blocks (thinking, tool_use), so
// `content[0].text` is not a safe read (#1653).
import { z } from "zod";

const anthropicContentSchema = z.looseObject({
  content: z.array(z.unknown()).optional(),
});

const anthropicTextBlockSchema = z.looseObject({
  type: z.literal("text"),
  text: z.string(),
});

const anthropicStopReasonSchema = z.looseObject({
  stop_reason: z.string().optional(),
});

// Returns the trimmed concatenation of all text blocks, or null when the
// response contains no text block at all.
export function extractAnthropicText<T>(data: T): string | null {
  const parsed = anthropicContentSchema.safeParse(data);

  if (!parsed.success) return null;

  const blocks = parsed.data.content ?? [];

  const parts = blocks.flatMap((block) => {
    const textBlock = anthropicTextBlockSchema.safeParse(block);

    return textBlock.success ? [textBlock.data.text] : [];
  });

  if (parts.length === 0) return null;

  return parts.join("").trim();
}

export function describeMissingAnthropicText<T>(data: T): string {
  const parsed = anthropicStopReasonSchema.safeParse(data);
  const stopReason = parsed.success ? parsed.data.stop_reason : undefined;

  if (stopReason === "max_tokens") {
    return "Anthropic returned no text before hitting the max_tokens limit";
  }

  return stopReason !== undefined
    ? `Anthropic response contained no text content (stop_reason: ${stopReason})`
    : "Anthropic response contained no text content";
}
