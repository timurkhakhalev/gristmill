import i18n, { normalizeUiLanguage } from "../../i18n";
import { useSettingsStore } from "../../stores/settingsStore";
import { en as enPrompts } from "../../locales/prompts";
import { getLanguageInstruction, getLanguageLabel } from "../../utils/languageSupport";
import { PROMPT_KINDS, type PromptKind } from "./registry";

export { PROMPT_KINDS, PROMPT_KIND_LIST, type PromptKind } from "./registry";

export interface ResolvePromptOptions {
  agentName: string | null;
  uiLanguage?: string;
  language?: string;
  customDictionary?: string[];
}

export function resolvePrompt(kind: PromptKind, opts: ResolvePromptOptions): string {
  const custom = useSettingsStore.getState().customPrompts[kind];
  const template = custom || getDefaultPromptText(kind, opts.uiLanguage);

  return applySubstitutions(kind, template, opts);
}

export function getDefaultPromptText(kind: PromptKind, uiLanguage?: string): string {
  const def = PROMPT_KINDS[kind];

  if (!def.i18nKey) return def.fallback;
  const locale = normalizeUiLanguage(uiLanguage || "en");
  const t = i18n.getFixedT(locale, "prompts");

  return t(def.i18nKey, { defaultValue: def.fallback });
}

// The cleanup prompt tells the model its input arrives between <transcript>
// tags; the trailing line re-anchors the output contract right after the
// transcript, where models weight instructions most. Keep this aligned with
// the cleanup request contract.
export function wrapCleanupTranscript(text: string): string {
  return `<transcript>\n${escapeTranscriptContent(text)}\n</transcript>\n\nOutput only the cleaned transcript.`;
}

export function escapeTranscriptContent(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Decode only the entities escaped by escapeTranscriptContent, exactly once. */
export function decodeCleanupTranscriptEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/gi, (entity) => {
    switch (entity.toLowerCase()) {
      case "&amp;":
        return "&";
      case "&lt;":
        return "<";
      case "&gt;":
        return ">";
      case "&quot;":
        return '"';
      default:
        return "'";
    }
  });
}

export function appendDictionarySuffix(
  prompt: string,
  customDictionary?: string[],
  uiLanguage?: string
): string {
  const words = (customDictionary ?? []).map((word) => word.trim()).filter(Boolean);

  if (!words.length) return prompt;
  const locale = normalizeUiLanguage(uiLanguage || "en");

  const suffix = i18n.getFixedT(locale, "prompts")("dictionarySuffix", {
    defaultValue: enPrompts.dictionarySuffix,
  });

  return prompt + suffix + JSON.stringify(words);
}

function applySubstitutions(
  kind: PromptKind,
  template: string,
  opts: ResolvePromptOptions
): string {
  const name = opts.agentName?.trim() || "Assistant";
  let prompt = template.replace(/\{\{agentName\}\}/g, name);

  const langInstruction =
    kind === "cleanup"
      ? cleanupLanguageInstruction(opts.language)
      : getLanguageInstruction(opts.language);

  if (langInstruction) prompt += "\n\n" + langInstruction;

  return appendDictionarySuffix(prompt, opts.customDictionary, opts.uiLanguage);
}

function cleanupLanguageInstruction(language: string | undefined): string {
  const selected = language?.trim();

  if (!selected || selected === "auto") {
    return "LANGUAGE: Detect the actual language or language mix in the transcript. Preserve it without translating or forcing the whole output into one language.";
  }

  const label = getLanguageLabel(selected);

  return `LANGUAGE: The selected transcription language is ${label} (${selected}). Use its spelling and punctuation conventions for speech in that language, while preserving any other spoken languages without translation.`;
}
