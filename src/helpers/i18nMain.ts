import i18next from "i18next";

import debugLogger from "./debugLogger.js";

import enTranslation from "../locales/en/translation.json";
import arTranslation from "../locales/ar/translation.json";
import esTranslation from "../locales/es/translation.json";
import frTranslation from "../locales/fr/translation.json";
import deTranslation from "../locales/de/translation.json";
import ptTranslation from "../locales/pt/translation.json";
import itTranslation from "../locales/it/translation.json";
import ruTranslation from "../locales/ru/translation.json";
import jaTranslation from "../locales/ja/translation.json";
import zhCNTranslation from "../locales/zh-CN/translation.json";
import zhTWTranslation from "../locales/zh-TW/translation.json";

import enPrompts from "../locales/en/prompts.json";
import arPrompts from "../locales/ar/prompts.json";
import esPrompts from "../locales/es/prompts.json";
import frPrompts from "../locales/fr/prompts.json";
import dePrompts from "../locales/de/prompts.json";
import ptPrompts from "../locales/pt/prompts.json";
import itPrompts from "../locales/it/prompts.json";
import ruPrompts from "../locales/ru/prompts.json";
import jaPrompts from "../locales/ja/prompts.json";
import zhCNPrompts from "../locales/zh-CN/prompts.json";
import zhTWPrompts from "../locales/zh-TW/prompts.json";

export const SUPPORTED_UI_LANGUAGES: readonly string[] = [
  "en",
  "ar",
  "es",
  "fr",
  "de",
  "pt",
  "it",
  "ru",
  "ja",
  "zh-CN",
  "zh-TW",
];

export function normalizeUiLanguage(language: string | null | undefined): string {
  const candidate = (language || "").trim();

  // Check full language-region code first (e.g. "zh-CN", "zh-TW")
  const normalized = candidate.replace(/_/g, "-");

  const fullMatch = SUPPORTED_UI_LANGUAGES.find(
    (lang) => lang.toLowerCase() === normalized.toLowerCase()
  );

  if (fullMatch) return fullMatch;

  // Chinese is the only UI language that is not the primary subtag. OS/browser
  // tags are zh-Hans-CN, zh-Hant-TW, zh-HK, zh_Hant_TW, or bare zh — none of
  // those equal zh-CN/zh-TW, and falling through to "zh" is not in the list.
  const lower = normalized.toLowerCase();

  if (lower === "zh" || lower.startsWith("zh-")) {
    const parts = lower.split("-");

    if (parts.some((part) => part === "hant" || part === "tw" || part === "hk" || part === "mo")) {
      return "zh-TW";
    }

    return "zh-CN";
  }

  // Fall back to base language code (e.g. "en" from "en-US")
  const base = lower.split("-")[0];

  return SUPPORTED_UI_LANGUAGES.includes(base) ? base : "en";
}

// This module also compiles into the renderer shared graph, where Node's
// `process` does not exist. The startup language still comes from the
// main-process environment; anywhere else the lookup resolves to undefined
// and the normalizer falls back to "en".
// SAFETY: this module is shared with the renderer, where Node's `process` is
// absent; the cast only names the optional global the lookup tolerates.
const processEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process?.env;

export const i18nMain = i18next.createInstance();

// Fire-and-forget by contract: initAsync:false resolves synchronously from the
// bundled resources, and a failure here has no recovery path beyond the
// fallback language already configured, so the rejection is observed here.
i18nMain
  .init({
    initAsync: false,
    resources: {
      en: {
        translation: enTranslation,
        prompts: enPrompts,
      },
      ar: {
        translation: arTranslation,
        prompts: arPrompts,
      },
      es: {
        translation: esTranslation,
        prompts: esPrompts,
      },
      fr: {
        translation: frTranslation,
        prompts: frPrompts,
      },
      de: {
        translation: deTranslation,
        prompts: dePrompts,
      },
      pt: {
        translation: ptTranslation,
        prompts: ptPrompts,
      },
      it: {
        translation: itTranslation,
        prompts: itPrompts,
      },
      ru: {
        translation: ruTranslation,
        prompts: ruPrompts,
      },
      ja: {
        translation: jaTranslation,
        prompts: jaPrompts,
      },
      "zh-CN": {
        translation: zhCNTranslation,
        prompts: zhCNPrompts,
      },
      "zh-TW": {
        translation: zhTWTranslation,
        prompts: zhTWPrompts,
      },
    },
    lng: normalizeUiLanguage(processEnv?.UI_LANGUAGE),
    fallbackLng: "en",
    ns: ["translation", "prompts"],
    defaultNS: "translation",
    interpolation: {
      escapeValue: false,
    },
    returnEmptyString: false,
    returnNull: false,
  })
  .catch((error) => {
    debugLogger.error("i18nMain init failed", { error: String(error) }, "i18n");
  });

export function changeLanguage(language: string | null | undefined): string {
  const normalized = normalizeUiLanguage(language);

  if (i18nMain.language !== normalized) {
    // Fire-and-forget by contract: the bundled resources are already in memory,
    // the synchronous language switch is observable via i18nMain.language, and
    // callers only read the returned normalized code.
    i18nMain.changeLanguage(normalized).catch((error) => {
      debugLogger.error("i18nMain changeLanguage failed", { error: String(error) }, "i18n");
    });
  }

  return normalized;
}
