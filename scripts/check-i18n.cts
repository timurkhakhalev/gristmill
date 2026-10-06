#!/usr/bin/env node

// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const fs = require("fs") as typeof import("fs");

// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const path = require("path") as typeof import("path");

const LOCALES_DIR = path.join(__dirname, "..", "src", "locales");

const BASE_LANG = "en";

const NAMESPACES = ["translation", "prompts"];

// Locale files are nested string dictionaries. The JSON is external input, so
// readJson validates the whole tree into StringTree before any key is read.
interface StringTree {
  [key: string]: string | StringTree;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringTree(value: unknown): value is StringTree {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  for (const child of Object.values(value)) {
    if (!isString(child) && !isStringTree(child)) return false;
  }

  return true;
}

function readJson(filePath: string): StringTree {
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));

  if (!isStringTree(parsed)) throw new Error(`Locale file is not a string tree: ${filePath}`);

  return parsed;
}

function flatten(obj: StringTree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();

  for (const [key, value] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${key}` : key;

    if (isString(value)) out.set(next, value);
    else for (const [nestedKey, nested] of flatten(value, next)) out.set(nestedKey, nested);
  }

  return out;
}

function getPlaceholders(value: string) {
  const matches = value.match(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g) || [];

  return [...new Set(matches.map((match) => match.replace(/\{\{|\}\}/g, "").trim()))].sort();
}

function arraysEqual(a: string[], b: string[]) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

const PLURAL_SUFFIX = /^(.*)_(zero|one|two|few|many|other)$/;

// Counts a leaderboard, a member list or a streak can realistically carry.
// Spanish, French, Italian and Portuguese reserve "many" for millions, and no
// key here ever renders one, so requiring that form would fail every locale
// file over a case no user reaches.
const PROBE_LIMIT = 200;

// Which counts each of a locale's plural categories actually selects.
function pluralProbe(lang: string) {
  const rules = new Intl.PluralRules(lang);
  const selected = new Map<string, number[]>();

  for (let count = 0; count <= PROBE_LIMIT; count++) {
    const category = rules.select(count);
    const counts = selected.get(category);

    if (counts) counts.push(count);
    else selected.set(category, [count]);
  }

  return selected;
}

/**
 * i18next resolves a plural form with the locale's own CLDR rules and then falls
 * back to English when that form is missing, so an absent form ships English
 * text rather than a grammar slip. And a category is not always "exactly one":
 * Russian's `one` also covers 21 and 31, French's covers 0, so a form for one of
 * those has to interpolate the count instead of writing the digit.
 */
function checkPlurals(lang: string, namespace: string, flat: Map<string, string>) {
  const selected = pluralProbe(lang);
  const forms = new Map<string, Set<string>>();

  for (const key of flat.keys()) {
    const match = key.match(PLURAL_SUFFIX);

    if (!match) continue;

    const categories = forms.get(match[1]);

    if (categories) categories.add(match[2]);
    else forms.set(match[1], new Set([match[2]]));
  }

  let missing = false;

  for (const [base, categories] of forms) {
    for (const [category, counts] of selected) {
      if (!categories.has(category)) {
        console.error(
          `[i18n] Missing plural form ${lang}/${namespace}: ${base}_${category} (${lang} uses it for ${counts.slice(0, 3).join(", ")})`
        );
        missing = true;
      }
    }

    for (const category of categories) {
      const counts = selected.get(category);

      if (!counts || counts.every((count) => count === 1)) continue;

      const value = flat.get(`${base}_${category}`);

      if (value !== undefined && !value.includes("{{count}}")) {
        console.error(
          `[i18n] Hardcoded count ${lang}/${namespace}: ${base}_${category} also renders for ${counts
            .filter((count) => count !== 1)
            .slice(0, 3)
            .join(", ")}, so it must interpolate {{count}}`
        );
        missing = true;
      }
    }
  }

  return missing;
}

const languages = fs
  .readdirSync(LOCALES_DIR)
  .filter((entry) => fs.statSync(path.join(LOCALES_DIR, entry)).isDirectory())
  .sort();

let failed = false;

for (const namespace of NAMESPACES) {
  const baseFile = path.join(LOCALES_DIR, BASE_LANG, `${namespace}.json`);

  if (!fs.existsSync(baseFile)) {
    console.error(`[i18n] Missing base file: ${baseFile}`);
    process.exit(1);
  }

  const baseFlat = flatten(readJson(baseFile));

  if (checkPlurals(BASE_LANG, namespace, baseFlat)) failed = true;

  for (const lang of languages) {
    if (lang === BASE_LANG) continue;

    const file = path.join(LOCALES_DIR, lang, `${namespace}.json`);

    if (!fs.existsSync(file)) {
      console.error(`[i18n] Missing file: ${file}`);
      failed = true;
      continue;
    }

    const flat = flatten(readJson(file));

    if (checkPlurals(lang, namespace, flat)) failed = true;

    for (const [key, baseValue] of baseFlat) {
      const langValue = flat.get(key);

      if (langValue === undefined) {
        console.error(`[i18n] Missing key ${lang}/${namespace}: ${key}`);
        failed = true;
        continue;
      }

      const basePlaceholders = getPlaceholders(baseValue);
      const langPlaceholders = getPlaceholders(langValue);

      if (!arraysEqual(basePlaceholders, langPlaceholders)) {
        console.error(
          `[i18n] Placeholder mismatch ${lang}/${namespace}: ${key} (expected ${basePlaceholders.join(", ")}, got ${langPlaceholders.join(", ")})`
        );
        failed = true;
      }
    }
  }
}

if (failed) {
  process.exit(1);
}

console.log("[i18n] Locale keys and placeholders are consistent.");

export type {};
