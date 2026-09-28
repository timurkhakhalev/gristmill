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
  "terracotta",
  "mauve",
  "emerald",
  "ocean",
  "solar-dusk",
  "mocha",
  "aurora",
  "cosmic",
  "sage",
  "tangerine",
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
    terracotta: { background: "oklch(0.22 0.008 70)", accent: "oklch(0.64 0.14 40)" },
    mauve: { background: "oklch(0.22 0.03 285)", accent: "oklch(0.8 0.12 300)" },
    emerald: { background: "oklch(0.22 0.004 160)", accent: "oklch(0.77 0.15 160)" },
    ocean: { background: "oklch(0.22 0.022 230)", accent: "oklch(0.74 0.14 230)" },
    "solar-dusk": { background: "oklch(0.22 0.012 55)", accent: "oklch(0.72 0.16 50)" },
    mocha: { background: "oklch(0.22 0.012 60)", accent: "oklch(0.7 0.07 50)" },
    aurora: { background: "oklch(0.22 0.022 250)", accent: "oklch(0.78 0.12 175)" },
    cosmic: { background: "oklch(0.22 0.03 280)", accent: "oklch(0.62 0.17 285)" },
    sage: { background: "oklch(0.22 0.01 130)", accent: "oklch(0.72 0.06 145)" },
    tangerine: { background: "oklch(0.22 0.01 260)", accent: "oklch(0.7 0.19 45)" },
  };

export function normalizeColorScheme(value: unknown): ColorSchemeId {
  return COLOR_SCHEME_IDS.includes(value as ColorSchemeId)
    ? (value as ColorSchemeId)
    : DEFAULT_COLOR_SCHEME;
}
