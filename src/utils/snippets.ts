export interface Snippet {
  trigger: string;
  replacement: string;
}

export const MAX_SNIPPET_TRIGGER_LENGTH = 100;

/**
 * Dictionary words plus snippet triggers — the hint list fed to the STT
 * prompt and cleanup-model dictionary suffix so triggers survive both.
 */
export function getDictionaryHintWords(
  settings?: {
    customDictionary?: string[] | null;
    snippets?: Snippet[] | null;
  } | null
): string[] {
  const dictionary = Array.isArray(settings?.customDictionary) ? settings.customDictionary : [];
  const snippets = Array.isArray(settings?.snippets) ? settings.snippets : [];

  if (snippets.length === 0) return [...dictionary];

  const triggers = snippets
    .map((s) => s?.trigger)
    .filter((t): t is string => typeof t === "string" && t.length > 0);

  return [...dictionary, ...triggers];
}
