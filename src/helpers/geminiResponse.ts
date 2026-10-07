// Text extraction for Gemini generateContent API responses. `content.parts`
// is an array that may contain multiple text parts or lead with thought
// blocks (Gemini thinking), so `parts[0].text` is not safe.
import { z } from "zod";

const geminiPartSchema = z.looseObject({
  thought: z.unknown().optional(),
  text: z.string().optional(),
});

const geminiCandidateSchema = z.looseObject({
  content: z.looseObject({ parts: z.array(z.unknown()).optional() }).optional(),
});

/**
 * Extract user-facing text from a Gemini generateContent response candidate.
 * Concatenates all text parts while ignoring thought parts (from Gemini thinking).
 * Returns trimmed text, or null if no valid text parts exist.
 *
 * @param {object} [candidate]
 * @returns {string | null}
 */
export function extractGeminiText<T>(candidate: T): string | null {
  const parsed = geminiCandidateSchema.safeParse(candidate);

  if (!parsed.success) return null;

  const parts = parsed.data.content?.parts ?? [];

  const textParts = parts.flatMap((part) => {
    const parsedPart = geminiPartSchema.safeParse(part);
    const text = parsedPart.success ? parsedPart.data.text : undefined;

    return parsedPart.success && !parsedPart.data.thought && text && text.length > 0 ? [text] : [];
  });

  if (textParts.length === 0) return null;

  return textParts.join("").trim();
}
