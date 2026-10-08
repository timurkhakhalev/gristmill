#!/usr/bin/env node
// Vendors the Nucleo outline React components (core 24px by default) named in
// src/components/icons/nucleo-map.json into src/components/icons/nucleo/ and
// regenerates src/components/icons/index.ts. Nucleo is a paid library; the
// source install lives outside the repo (~/.nucleo/skills, set NUCLEO_SKILLS_ROOT
// to override) and only the icons the app actually uses are committed, so the
// bundle works offline and without a Nucleo license on the build machine.

// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const fs = require("fs") as typeof import("fs");

// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const os = require("os") as typeof import("os");

// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const path = require("path") as typeof import("path");

// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const { execFileSync } = require("child_process") as typeof import("child_process");

const NUCLEO_ROOT = process.env.NUCLEO_SKILLS_ROOT || path.join(os.homedir(), ".nucleo", "skills");

const ICONS_DIR = path.join(__dirname, "..", "src", "components", "icons");

const VENDOR_DIR = path.join(ICONS_DIR, "nucleo");

const FILL = "outline";

// A map entry is either a core 24px label ("calendar") or, for icons that only
// exist elsewhere, { family, label, size } (e.g. { family: "ui", label: "redo-2", size: "18px" }).
const DEFAULT_FAMILY = "core";

const DEFAULT_SIZE = "24px";

interface Spec {
  family: string;
  label: string;
  size: string;
}

interface Icon {
  component: string;
  componentPath: string;
  label: string;
  sizes?: string[];
  fills?: string[];
}

interface IconSpec {
  label: string;
  family?: string;
  size?: string;
}

// Raw shapes read from the local Nucleo install before validation.
interface RawIconSpec {
  label?: unknown;
  family?: unknown;
  size?: unknown;
}

interface RawIcon {
  component?: unknown;
  componentPath?: unknown;
  label?: unknown;
  sizes?: unknown;
  fills?: unknown;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => isString(item));
}

function isIcon(value: unknown): value is Icon {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  // SAFETY: only RawIcon's declared keys are read, each validated before the
  // value is exposed as an Icon.
  const icon = value as RawIcon;

  return (
    isString(icon.component) &&
    isString(icon.componentPath) &&
    isString(icon.label) &&
    (icon.sizes === undefined || isStringArray(icon.sizes)) &&
    (icon.fills === undefined || isStringArray(icon.fills))
  );
}

function isIconSpec(value: unknown): value is IconSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  // SAFETY: only RawIconSpec's declared keys are read, each validated before
  // the value is exposed as an IconSpec.
  const spec = value as RawIconSpec;

  return (
    isString(spec.label) &&
    (spec.family === undefined || isString(spec.family)) &&
    (spec.size === undefined || isString(spec.size))
  );
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readMap(): Array<[string, string | IconSpec]> {
  const parsed: unknown = JSON.parse(
    fs.readFileSync(path.join(ICONS_DIR, "nucleo-map.json"), "utf8")
  );

  if (!isObject(parsed)) throw new Error("nucleo-map.json must be an object");

  const out: Array<[string, string | IconSpec]> = [];

  for (const [name, value] of Object.entries(parsed)) {
    if (isString(value)) out.push([name, value]);
    else if (isIconSpec(value)) out.push([name, value]);
    else throw new Error(`Invalid nucleo-map entry: ${name}`);
  }

  return out;
}

function readCatalog(family: string): Icon[] {
  const parsed: unknown = JSON.parse(
    fs.readFileSync(path.join(NUCLEO_ROOT, family, "icons.json"), "utf8")
  );

  if (!isObject(parsed)) throw new Error(`Invalid catalog: ${family}`);

  const icons: unknown = Reflect.get(parsed, "icons");

  if (!Array.isArray(icons)) throw new Error(`Invalid catalog icons: ${family}`);

  return icons.map((icon) => {
    if (!isIcon(icon)) throw new Error(`Invalid catalog icon in ${family}`);

    return icon;
  });
}

const entries: [string, Spec][] = readMap().map(([name, raw]) => {
  const spec: IconSpec = isString(raw)
    ? { label: raw, family: DEFAULT_FAMILY, size: DEFAULT_SIZE }
    : { family: DEFAULT_FAMILY, size: DEFAULT_SIZE, ...raw };

  return [
    name,
    { family: spec.family ?? DEFAULT_FAMILY, label: spec.label, size: spec.size ?? DEFAULT_SIZE },
  ];
});

const catalogs = new Map<string, Map<string, Icon>>();

function lookup({ family, label, size }: Spec): Icon | undefined {
  if (!catalogs.has(family)) {
    const icons = readCatalog(family);

    catalogs.set(
      family,
      new Map(
        icons
          .filter((icon) => icon.fills?.includes(FILL))
          .map((icon) => [`${icon.label}@${icon.sizes?.[0]}`, icon])
      )
    );
  }

  return catalogs.get(family)?.get(`${label}@${size}`);
}

const missing = entries
  .filter(([, spec]) => !lookup(spec))
  .map(([name, spec]) => `${name} -> ${spec.family}/${spec.label}@${spec.size}`);

if (missing.length) {
  console.error(`Not found as ${FILL}: ${missing.join(", ")}`);
  process.exit(1);
}

fs.rmSync(VENDOR_DIR, { recursive: true, force: true });

fs.mkdirSync(VENDOR_DIR, { recursive: true });

const components = new Set<string>();

for (const [, spec] of entries) {
  const icon = lookup(spec);

  if (!icon) throw new Error(`Icon disappeared after validation: ${spec.label}`);

  if (components.has(icon.component)) continue;
  components.add(icon.component);

  // Core components default to butt caps; the app's soft geometry wants round.
  const source = fs
    .readFileSync(path.join(NUCLEO_ROOT, icon.componentPath), "utf8")
    .replace('corners = "square"', 'corners = "round"');

  fs.writeFileSync(path.join(VENDOR_DIR, `${icon.component}.tsx`), source);
}

const kebab = (name: string) =>
  name
    .replace(/([a-z])([A-Z0-9])/g, "$1-$2")
    .replace(/([0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();

const exportLines = entries
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, spec]) => {
    const icon = lookup(spec);

    if (!icon) throw new Error(`Icon disappeared after validation: ${spec.label}`);

    return `export const ${name} = createIcon("${kebab(name)}", Nucleo.${icon.component});`;
  });

const index = `// Generated by scripts/sync-nucleo-icons.cts from nucleo-map.json. Do not edit by hand.
import { createIcon } from "./createIcon";
import * as Nucleo from "./nucleo";

export type { IconComponent, IconProps } from "./createIcon";
export { Circle, Square } from "./primitives";

${exportLines.join("\n")}
`;

fs.writeFileSync(path.join(ICONS_DIR, "index.ts"), index);

const barrel = [...components]
  .sort()
  .map((component) => `export { ${component} } from "./${component}";`)
  .join("\n");

fs.writeFileSync(path.join(VENDOR_DIR, "index.ts"), `${barrel}\n`);

execFileSync("pnpm", ["exec", "oxfmt", "--write", ICONS_DIR], { stdio: "ignore" });

console.log(`Vendored ${components.size} Nucleo components for ${entries.length} icons.`);

export type {};
