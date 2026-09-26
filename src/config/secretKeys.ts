// Single source of truth for the uniform BYOK cloud-LLM API-key secrets:
// environment.js, ipcHandlers.js and the settings store all derive their
// per-key plumbing from this list, so adding a provider is one entry.
// Pure data so both the main process and the Vite renderer share it.
// `base` yields the IPC channels `get-<base>-key` / `save-<base>-key`.
// The desktop settings bridge (src/preload/desktopSettingsBridge.ts) derives
// its renderer-side methods from this manifest, so a new provider is one
// entry on both sides of the bridge (guarded by test/helpers/secretKeys.test.js).
//
// Secret values never appear here — this catalog is only key *names* and
// their per-surface plumbing identifiers.
export interface ByokApiKeyEntry {
  /** IPC channel base: `get-<base>-key` / `save-<base>-key`. */
  base: string;
  /** Environment variable the main process persists under. */
  env: string;
  /** EnvironmentManager getter name (taken verbatim, never derived). */
  get: string;
  /** EnvironmentManager setter name (taken verbatim, never derived). */
  save: string;
  /** settingsStore key the renderer reads. */
  storeKey: string;
}

export const BYOK_API_KEYS = [
  {
    base: "openai",
    env: "OPENAI_API_KEY",
    get: "getOpenAIKey",
    save: "saveOpenAIKey",
    storeKey: "openaiApiKey",
  },
  {
    base: "anthropic",
    env: "ANTHROPIC_API_KEY",
    get: "getAnthropicKey",
    save: "saveAnthropicKey",
    storeKey: "anthropicApiKey",
  },
  {
    base: "gemini",
    env: "GEMINI_API_KEY",
    get: "getGeminiKey",
    save: "saveGeminiKey",
    storeKey: "geminiApiKey",
  },
  {
    base: "groq",
    env: "GROQ_API_KEY",
    get: "getGroqKey",
    save: "saveGroqKey",
    storeKey: "groqApiKey",
  },
  {
    base: "xai",
    env: "XAI_API_KEY",
    get: "getXaiKey",
    save: "saveXaiKey",
    storeKey: "xaiApiKey",
  },
  {
    base: "mistral",
    env: "MISTRAL_API_KEY",
    get: "getMistralKey",
    save: "saveMistralKey",
    storeKey: "mistralApiKey",
  },
  {
    base: "openrouter",
    env: "OPENROUTER_API_KEY",
    get: "getOpenrouterKey",
    save: "saveOpenrouterKey",
    storeKey: "openrouterApiKey",
  },
  {
    base: "tinfoil",
    env: "TINFOIL_API_KEY",
    get: "getTinfoilKey",
    save: "saveTinfoilKey",
    storeKey: "tinfoilApiKey",
  },
  {
    base: "corti",
    env: "CORTI_API_KEY",
    get: "getCortiKey",
    save: "saveCortiKey",
    storeKey: "cortiApiKey",
  },
  // `get`/`save` are taken verbatim, never derived from `base`, so these keep
  // the capitalisation realtimeTokenProviders.ts already calls them by.
  {
    base: "deepgram",
    env: "DEEPGRAM_API_KEY",
    get: "getDeepgramKey",
    save: "saveDeepgramKey",
    storeKey: "deepgramApiKey",
  },
  {
    base: "elevenlabs",
    env: "ELEVENLABS_API_KEY",
    get: "getElevenLabsKey",
    save: "saveElevenLabsKey",
    storeKey: "elevenLabsApiKey",
  },
  {
    base: "assemblyai",
    env: "ASSEMBLYAI_API_KEY",
    get: "getAssemblyAIKey",
    save: "saveAssemblyAIKey",
    storeKey: "assemblyaiApiKey",
  },
  // Per-scope custom-endpoint keys used by the remaining inference scopes.
  {
    base: "note-formatting-custom",
    env: "NOTE_FORMATTING_CUSTOM_API_KEY",
    get: "getNoteFormattingCustomKey",
    save: "saveNoteFormattingCustomKey",
    storeKey: "noteFormattingCustomApiKey",
  },
  {
    base: "chat-agent-custom",
    env: "CHAT_AGENT_CUSTOM_API_KEY",
    get: "getChatAgentCustomKey",
    save: "saveChatAgentCustomKey",
    storeKey: "chatAgentCustomApiKey",
  },
] as const satisfies readonly ByokApiKeyEntry[];

// Environment variables that must never be read from or written to a plaintext
// .env file. Values outside the active secret store are discarded at cutover.
export const SECRET_ENV_KEYS = [
  ...BYOK_API_KEYS.map((key) => key.env),
  "CORTI_CLIENT_ID",
  "CORTI_CLIENT_SECRET",
  "CUSTOM_TRANSCRIPTION_API_KEY",
  "CUSTOM_CLEANUP_API_KEY",
  "BEDROCK_ACCESS_KEY_ID",
  "BEDROCK_SECRET_ACCESS_KEY",
  "BEDROCK_SESSION_TOKEN",
  "AZURE_OPENAI_API_KEY",
  "VERTEX_API_KEY",
  "VOICE_AGENT_KEY",
  "TRANSLATION_KEY",
  "CUSTOM_REASONING_API_KEY",
  "CHAT_AGENT_KEY",
] as const;
