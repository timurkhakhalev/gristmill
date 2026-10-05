// Text extraction for Gemini generateContent API responses. `content.parts`
// is an array that may contain multiple text parts or lead with thought
// blocks (Gemini thinking), so `parts[0].text` is not safe.

/**
 * Extract user-facing text from a Gemini generateContent response candidate.
 * Concatenates all text parts while ignoring thought parts (from Gemini thinking).
 * Returns trimmed text, or null if no valid text parts exist.
 *
 * @param {object} [candidate]
 * @returns {string | null}
 */
export function extractGeminiText(candidate: unknown): string | null {
  const parts = (candidate as { content?: { parts?: unknown } } | null | undefined)?.content?.parts;

  if (!Array.isArray(parts)) return null;

  const textParts = (parts as Array<{ thought?: unknown; text?: unknown }>)
    .filter(
      (part) => !part?.thought && typeof part?.text === "string" && (part.text as string).length > 0
    )
    .map((part) => part.text as string);

  if (textParts.length === 0) return null;

  return textParts.join("").trim();
}
