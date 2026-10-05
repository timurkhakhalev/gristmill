const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const path: typeof import("node:path") = require("node:path");

const test: typeof import("node:test") = require("node:test");

const src = path.join(__dirname, "..", "..", "src");

const read = (file: string): string => fs.readFileSync(path.join(src, file), "utf8");

test("renderer keeps only cleanup, note formatting, and chat inference scopes", () => {
  const source = read("config/inferenceScopes.ts");
  assert.deepEqual(
    [...source.matchAll(/^\s{2}(\w+): \{/gm)].map((match) => match[1]),
    ["cleanup", "noteFormatting", "chatIntelligence"]
  );
  assert.doesNotMatch(source, /dictation|translation|vision/i);
});

test("renderer prompt helpers do not expose screen context or translation substitution", () => {
  const source = read("config/prompts/index.ts");
  assert.doesNotMatch(source, /screenContextSuffix|targetLanguageLabel|targetLanguage/);
});

test("renderer inference uses direct providers instead of the retired hosted route", () => {
  const settings = read("stores/settingsStore.ts");
  const notes = read("components/notes/PersonalNotesView.tsx");
  assert.doesNotMatch(
    settings,
    /openwhispr|selectIsCloud|isCloud(?:Cleanup|ChatAgent|NoteFormatting)/i
  );
  assert.doesNotMatch(notes, /mode\s*===\s*["']openwhispr["']/i);
});

test("model switch and cleanup toasts do not reopen the removed assistant panel", () => {
  for (const file of [
    "components/CleanupFailureToastListener.tsx",
    "components/TinfoilModelSwitchToastListener.tsx",
  ]) {
    assert.doesNotMatch(read(file), /showDictationPanel|isDictationPanelWindow/);
  }
});
