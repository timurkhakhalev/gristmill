// Text extraction for Anthropic Messages API responses. `content` is a block
// array whose shape varies run to run: it can be empty (max_tokens hit before
// any text), or lead with non-text blocks (thinking, tool_use), so
// `content[0].text` is not a safe read (#1653).

// Returns the trimmed concatenation of all text blocks, or null when the
// response contains no text block at all.
export function extractAnthropicText(data: unknown): string | null {
  const blocks = Array.isArray((data as { content?: unknown })?.content)
    ? ((data as { content: unknown[] }).content as unknown[])
    : [];
  const parts = blocks
    .filter(
      (block) =>
        (block as { type?: unknown })?.type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
    )
    .map((block) => (block as { text: string }).text);
  if (parts.length === 0) return null;
  return parts.join("").trim();
}

export function describeMissingAnthropicText(data: unknown): string {
  const stopReason = (data as { stop_reason?: unknown })?.stop_reason;
  if (stopReason === "max_tokens") {
    return "Anthropic returned no text before hitting the max_tokens limit";
  }
  return typeof stopReason === "string"
    ? `Anthropic response contained no text content (stop_reason: ${stopReason})`
    : "Anthropic response contained no text content";
}
