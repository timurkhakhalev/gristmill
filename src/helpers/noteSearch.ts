// Builds the FTS5 MATCH expression for note search: NFC-normalized word
// tokens, quoted with doubled quotes, suffixed with the prefix operator.
export function buildNoteSearchQuery(input: unknown): string {
  const tokens = noteSearchTokens(input);

  if (!tokens.length) return "";

  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(" ");
}

export function noteSearchTokens(input: unknown): string[] {
  if (typeof input !== "string") return [];

  return (
    input
      .normalize("NFC")
      .match(/[\p{L}\p{N}_][\p{L}\p{M}\p{N}_]*/gu)
      ?.filter((token) => /[\p{L}\p{N}]/u.test(token)) ?? []
  );
}
