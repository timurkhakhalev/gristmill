/**
 * Dictionary import/export format.
 *
 * Export writes one entry per line, CSV-quoting only an entry that would
 * otherwise be split on import — it contains a comma, a double quote or a
 * newline — and escaping `"` as `""`.
 *
 * Import mirrors that contract per field: a leading quote is unwrapped only
 * when the exporter would have produced it, i.e. the decoded content contains a
 * comma/newline or an escaped quote. A plain paste therefore keeps the
 * historical comma/newline semantics byte-for-byte — `"hello"` stays the
 * literal entry `"hello"` and `""` stays `""` — while an exported
 * `"Acme, Inc."` round-trips as one entry.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseDictionaryImportText(text: unknown): string[] {
  const raw = String(text ?? "");
  // An unbalanced quote is not the export shape; fall back to the plain split
  // rather than silently swallowing the rest of the paste.
  const quoted = parseFields(raw);

  return normalizeFields(quoted === null ? raw.split(/[,\n]/) : quoted);
}

/** Serializes entries for export, quoting those a plain split would corrupt. */
export function serializeDictionaryEntries(words: readonly string[]): string {
  return words.map(quoteField).join("\n");
}

function normalizeFields(fields: readonly string[]): string[] {
  return fields.map((word) => word.trim()).filter(Boolean);
}

function quoteField(word: string): string {
  if (!/[",\n\r]/.test(word)) return word;

  return `"${word.replace(/"/g, '""')}"`;
}

// Single scan that both splits fields and decodes the exported quoting. A field
// is unwrapped only when its decoded content needed quoting (a comma, newline
// or escape); otherwise the literal slice survives, so plain pastes are
// unchanged. Returns null when a quote is left open.
function parseFields(text: string): string[] | null {
  const fields: string[] = [];
  let decoded = "";
  let literal = "";
  let inQuotes = false;
  let quoteOpened = false;
  let hadEscape = false;
  let closed = false;
  // True while the field holds only whitespace, so spaces before an opening
  // quote are allowed.
  let quoteMayOpen = true;

  const endField = () => {
    const exportQuoted = quoteOpened && closed && (hadEscape || /[,\n\r]/.test(decoded));
    fields.push(exportQuoted ? decoded : literal);
    decoded = "";
    literal = "";
    quoteOpened = false;
    hadEscape = false;
    closed = false;
    quoteMayOpen = true;
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      literal += char;

      if (char === '"') {
        if (text[i + 1] === '"') {
          literal += '"';
          decoded += '"';
          hadEscape = true;
          i += 1;
        } else {
          inQuotes = false;
          closed = true;
        }
      } else {
        decoded += char;
      }

      continue;
    }

    if (char === '"' && quoteMayOpen) {
      inQuotes = true;
      quoteOpened = true;
      literal += char;
      quoteMayOpen = false;
      continue;
    }

    if (char === "," || char === "\n" || char === "\r") {
      endField();
      continue;
    }

    literal += char;

    if (char !== " " && char !== "\t") {
      quoteMayOpen = false;
      closed = false;
    }
  }

  if (inQuotes) return null;
  endField();

  return fields;
}
