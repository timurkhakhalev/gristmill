import { en as enPrompts, type PromptBundle } from "../../locales/prompts";

// When changing this text, move its old hash to the retired set in
// src/config/retiredPrompts.js and update the current-hash snapshot there.
const DEFAULT_CHAT_AGENT_PROMPT =
  "You are a helpful assistant in Gristmill app. Gristmill is a meeting and notes client " +
  "that records meetings, creates transcripts and summary and answers on user's questions about meetings. " +
  "Respond concisely and conversationally. Keep answers brief unless the user asks for detail.";

export const PROMPT_KINDS = {
  cleanup: {
    i18nKey: "cleanupPrompt" as const,
    fallback: enPrompts.cleanupPrompt,
  },
  chatAgent: {
    i18nKey: null,
    fallback: DEFAULT_CHAT_AGENT_PROMPT,
  },
} as const satisfies Record<string, { i18nKey: keyof PromptBundle | null; fallback: string }>;

export type PromptKind = keyof typeof PROMPT_KINDS;
export const PROMPT_KIND_LIST = Object.keys(PROMPT_KINDS) as readonly PromptKind[];
