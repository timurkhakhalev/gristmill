const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const localesDir = path.join(__dirname, "..", "..", "src", "locales");
const locales = fs
  .readdirSync(localesDir)
  .filter((locale) => fs.existsSync(path.join(localesDir, locale, "translation.json")));

const readJson = (locale, file) =>
  JSON.parse(fs.readFileSync(path.join(localesDir, locale, file), "utf8"));

const getPath = (value, dottedPath) => {
  let current = value;
  for (const part of dottedPath.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
};

test("calendar integrations provide an OAuth not-configured state in every locale", () => {
  for (const locale of locales) {
    const translation = readJson(locale, "translation.json");
    for (const provider of ["googleCalendar", "microsoftCalendar"]) {
      assert.equal(
        typeof translation.integrations?.[provider]?.notConfigured,
        "string",
        `${locale}: integrations.${provider}.notConfigured`
      );
    }
  }
});

test("renderer locales do not retain removed account, dictation, or cloud-paywall branches", () => {
  const removed = [
    "auth",
    "emailVerification",
    "forgotPassword",
    "dictationAgent",
    "dictationTranslation",
    "assistant",
    "insights",
    "workspaces",
    "referral",
    "integrations.api",
    "integrations.mcp",
    "integrations.cli",
    "apiKeysSection",
    "controlPanel.update",
    "controlPanel.history",
    "onboarding.activation",
    "onboarding.connectivity",
    "onboarding.requiredModels",
    "notes.realtimeBanner",
    "settingsPage.general.hotkey",
    "settingsPage.general.floatingIcon",
    "settingsPage.general.clipboard",
    "settingsPage.general.updates",
    "settingsPage.transcription.openwhisprCloud",
    "settingsPage.transcription.description",
    "settingsPage.transcription.modes.openwhispr",
    "settingsPage.transcription.modes.openwhisprDesc",
    "settingsPage.transcription.toasts.switchedCloud",
  ];

  for (const locale of locales) {
    const translation = readJson(locale, "translation.json");
    for (const key of removed) {
      assert.equal(getPath(translation, key), undefined, `${locale}: ${key}`);
    }
  }
});

test("prompt locale bundles expose cleanup and dictionary only", () => {
  for (const locale of locales) {
    const prompts = readJson(locale, "prompts.json");
    assert.deepEqual(Object.keys(prompts).sort(), ["cleanupPrompt", "dictionarySuffix"]);
  }
});

test("supported locale values use the OpenHercules brand", () => {
  const visit = (value, path) => {
    if (typeof value === "string") {
      assert.doesNotMatch(value, /OpenWhispr|OpenWispr|Whispr/i, path);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
    }
  };

  for (const locale of locales) visit(readJson(locale, "translation.json"), locale);
});
