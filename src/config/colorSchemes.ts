// Colour schemes the user can pick in Settings → General. The colours
// themselves live in src/index.css ([data-color-scheme="…"] blocks); this list
// drives the picker and validates the stored value.

export const COLOR_SCHEME_IDS = [
  "lavender",
  "indigo",
  "amethyst",
  "magenta",
  "lime",
  "graphite",
] as const;

export type ColorSchemeId = (typeof COLOR_SCHEME_IDS)[number];

export const DEFAULT_COLOR_SCHEME: ColorSchemeId = "lavender";

/** Picker swatch: the scheme's dark background with its accent on top. */
export const COLOR_SCHEME_SWATCHES: Record<ColorSchemeId, { background: string; accent: string }> =
  {
    lavender: { background: "oklch(0.22 0.007 260)", accent: "oklch(0.62 0.17 288)" },
    indigo: { background: "oklch(0.22 0.012 270)", accent: "oklch(0.64 0.16 276)" },
    amethyst: { background: "oklch(0.22 0.013 315)", accent: "oklch(0.72 0.19 305)" },
    magenta: { background: "oklch(0.22 0.011 340)", accent: "oklch(0.72 0.18 345)" },
    lime: { background: "oklch(0.22 0.008 105)", accent: "oklch(0.84 0.17 130)" },
    graphite: { background: "oklch(0.22 0.002 260)", accent: "oklch(0.58 0.19 263)" },
  };

export function normalizeColorScheme(value: unknown): ColorSchemeId {
  return COLOR_SCHEME_IDS.includes(value as ColorSchemeId)
    ? (value as ColorSchemeId)
    : DEFAULT_COLOR_SCHEME;
}
