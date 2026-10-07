// Registers the Yowza brand faces when their files are present in the build.
//
// Yowza is a licensed typeface (Blaze Type), so the .otf files are not in git:
// Licensed fonts are supplied locally and Vite bundles
// them into app.asar as hashed assets. In a build without them the glob below is
// empty, nothing is registered, and every `--font-family-*` token falls through
// to Noto Sans. Nothing is ever fetched at runtime.
const FACES = {
  "yowza-std-regular": { family: "Yowza", weight: "400" },
  // Medium covers 500–600: the family has no Semibold, and letting
  // `font-semibold` fall to Bold made labels and card titles read heavy.
  "yowza-std-medium": { family: "Yowza", weight: "500 600" },
  "yowza-std-bold": { family: "Yowza", weight: "700" },
  "yowza-soft-std-regular": { family: "Yowza Soft", weight: "400" },
  "yowza-soft-std-medium": { family: "Yowza Soft", weight: "500" },
} satisfies Record<string, { family: string; weight: string }>;

// SAFETY: Vite's import.meta.glob with `eager` + `?url` + `import: "default"`
// resolves every match to its hashed URL string, which is the Record shape here.
const fontUrls = import.meta.glob("./assets/fonts/yowza/*.otf", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

// Yowza ships ascent 0.94 / descent 0.24, which paints lowercase about 1px above
// the centre of a 16px icon beside it (measured from rendered pixels, not font
// tables). Rebalancing the same 1.18em content area to 0.965 / 0.215 drops the
// baseline one pixel at UI sizes without changing any line height, so icon +
// label rows centre optically app-wide.
const METRICS = "ascent-override:96.5%;descent-override:21.5%;line-gap-override:0%";

function isKnownFace(name: string): name is keyof typeof FACES {
  return Object.prototype.hasOwnProperty.call(FACES, name);
}

const rules = Object.entries(fontUrls).flatMap(([file, url]) => {
  const name = file.slice(file.lastIndexOf("/") + 1, -".otf".length);
  const face = isKnownFace(name) ? FACES[name] : undefined;

  return face
    ? [
        `@font-face{font-family:"${face.family}";font-style:normal;font-weight:${face.weight};font-display:swap;${METRICS};src:url("${url}") format("opentype")}`,
      ]
    : [];
});

if (rules.length) {
  const style = document.createElement("style");
  style.textContent = rules.join("\n");
  document.head.append(style);
}
