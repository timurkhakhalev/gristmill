import { create } from "zustand";
import { API_ENDPOINTS } from "../config/constants.mts";
import i18n, { normalizeUiLanguage } from "../i18n";
import { ensureAgentNameInDictionary } from "../utils/agentName";
import { chooseDictionaryStartupAction } from "../helpers/dictionaryStartup";
import logger from "../utils/logger";
import whisperVadConstants from "../constants/whisperVad.json";
import type { ChineseScriptPreference } from "../types/electron";
import type {
  BbAgentPreferences,
  LocalTranscriptionProvider,
  InferenceMode,
  SelfHostedType,
} from "../contracts/inferenceSettings";
import { parseBbAgentPreferences } from "../config/bbAgentPreferences";
import type { CalendarAccount } from "../contracts/calendar";
import { PROMPT_KIND_LIST, type PromptKind } from "../config/prompts/registry";
import { sweepRetiredPromptOverrides } from "../config/retiredPrompts";
import { sweepRetiredCloudModelSelections } from "../config/retiredCloudModels";
import {
  DEFAULT_COLOR_SCHEME,
  normalizeColorScheme,
  type ColorSchemeId,
} from "../config/colorSchemes";
import { buildReasoningScopePatches, inheritsFallbackEndpoint } from "../helpers/reasoningRouting";
import {
  selectResolvedMeetingTranscription,
  selectResolvedUploadTranscription,
  selectResolvedLLMConfig,
  selectResolvedNoteFormatting,
  type ResolvedLLMConfig,
} from "../config/settingsSelectors";
import { DEFAULT_CLOUD_TRANSCRIPTION_PROVIDER } from "../config/transcriptionCapabilities";
import { findStaleLocalModelKeys } from "../helpers/localModelSelections";
import { isMeetingFilePickerModel } from "../helpers/meetingFileTranscription";
import {
  INFERENCE_SCOPES,
  type InferenceScope,
  type InferenceScopeDefinition,
  type InferenceScopeStoreKeys,
} from "../config/inferenceScopes";
import { normalizeChineseScriptPreference } from "../utils/chineseScript";
import type { DateFormat, TimeFormat } from "../utils/dateFormatting";
import modelRegistryData from "../models/modelRegistryData.json";
import { pickDefaultModelId } from "../models/providerDefaultModel";
// Both are leaves: tinfoilModelCache imports only a type from ModelRegistry and
// the switch store only zustand, so neither reopens the ModelRegistry cycle.
import { readCachedTinfoilModels } from "../models/tinfoilModelCache";
import { recordTinfoilModelSwitch } from "./tinfoilModelSwitchStore";
import type {
  TranscriptionSettings,
  CleanupSettings,
  HotkeySettings,
  OnboardingSettings,
  MicrophoneSettings,
  ApiKeySettings,
  PrivacySettings,
  ThemeSettings,
  ChatAgentSettings,
} from "../hooks/useSettings";
import type { Snippet } from "../utils/snippets";
type EnterpriseSetupMode = "auto" | "managed" | "manual";
type TranscriptionContext = "dictation" | "meeting" | "upload";

let _ReasoningService: typeof import("../services/ReasoningService").default | null = null;

// Requires localStorage as well as window: the module-scope migrations below
// dereference the bare localStorage global, and test harnesses import this
// store with partial window stubs that don't define it.
const isBrowser = typeof window !== "undefined" && typeof localStorage !== "undefined";

const localLlmProviderIds = new Set(
  modelRegistryData.localProviders.map((provider) => provider.id)
);

function transcriptionProviderModels(
  providerId: string,
  context: TranscriptionContext
): Array<{ id: string; streaming?: boolean }> {
  const models =
    modelRegistryData.transcriptionProviders.find((provider) => provider.id === providerId)
      ?.models ?? [];
  return context === "meeting"
    ? models.filter((model) => isMeetingFilePickerModel(providerId, model.id))
    : models;
}

function defaultTranscriptionModel(
  providerId: string,
  context: TranscriptionContext
): string {
  return transcriptionProviderModels(providerId, context)[0]?.id ?? "whisper-1";
}

function transcriptionModelBelongsToProvider(
  providerId: string,
  modelId: string,
  context: TranscriptionContext
): boolean {
  if (providerId === "custom") return Boolean(modelId);
  return transcriptionProviderModels(providerId, context).some((model) => model.id === modelId);
}

function reasoningModelBelongsToProvider(providerId: string, modelId: string): boolean {
  if (!modelId) return false;
  // Custom and OpenRouter ids are free-form; any remembered id is valid.
  // Tinfoil's registry entry is refreshed in place from its live catalog.
  if (providerId === "custom" || providerId === "openrouter") return true;
  return (
    modelRegistryData.cloudProviders
      .find((provider) => provider.id === providerId)
      ?.models.some((model) => model.id === modelId) ?? false
  );
}

function readString(key: string, fallback: string): string {
  if (!isBrowser) return fallback;
  return localStorage.getItem(key) ?? fallback;
}

// Literal rather than an import from ModelRegistry: ModelRegistry imports this
// store, so importing back would create a require cycle.
const DEFAULT_COHERE_MODEL = "cohere-transcribe-03-2026";

function readLocalProvider(key: string): LocalTranscriptionProvider {
  const stored = readString(key, "whisper");
  return stored === "nvidia" || stored === "cohere" ? stored : "whisper";
}

function readBoolean(key: string, fallback: boolean): boolean {
  if (!isBrowser) return fallback;
  const stored = localStorage.getItem(key);
  if (stored === null) return fallback;
  if (fallback === true) return stored !== "false";
  return stored === "true";
}

function readNumber(key: string, fallback: number): number {
  if (!isBrowser) return fallback;
  const parsed = parseInt(localStorage.getItem(key) ?? "", 10);
  return isNaN(parsed) ? fallback : parsed;
}

// Durations offered by the mic warm-hold select; unknown values snap to 0 (off)
// so a hand-edited localStorage entry can never hold the mic open indefinitely.
export const MIC_WARM_HOLD_CHOICES = [0, 10, 60, 900] as const;

function snapMicWarmHold(value: number): number {
  return (MIC_WARM_HOLD_CHOICES as readonly number[]).includes(value) ? value : 0;
}

function readStringArray(key: string, fallback: string[]): string[] {
  if (!isBrowser) return fallback;
  const stored = localStorage.getItem(key);
  if (stored === null) return fallback;
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

type MicrophoneSelectionMode = "system" | "built-in" | "specific";

function migrateMicrophoneSelectionMode() {
  if (!isBrowser) return;
  const current = localStorage.getItem("microphoneSelectionMode");
  if (current === "system" || current === "built-in" || current === "specific") return;

  const selectedDeviceId = localStorage.getItem("selectedMicDeviceId") || "";
  const legacyBuiltIn = localStorage.getItem("preferBuiltInMic");
  const mode: MicrophoneSelectionMode =
    legacyBuiltIn === "true"
      ? "built-in"
      : selectedDeviceId && selectedDeviceId !== "default"
        ? "specific"
        : "system";
  localStorage.setItem("microphoneSelectionMode", mode);
}

migrateMicrophoneSelectionMode();

const BOOLEAN_SETTINGS = new Set([
  "useLocalWhisper",
  "meetingUseLocalWhisper",
  "uploadUseLocalWhisper",
  "allowOpenAIFallback",
  "allowLocalFallback",
  "assemblyAiStreaming",
  "autoGenerateNoteTitle",
  "useCleanupModel",
  "preferBuiltInMic",
  "telemetryEnabled",
  "audioCuesEnabled",
  "floatingIconAutoHide",
  "startMinimized",
  "meetingProcessDetection",
  "speakerDiarizationEnabled",
  "noteRecordingSileroEnabled",
  "meetingSileroEnabled",
  "isSignedIn",
  "autoPasteEnabled",
  "keepTranscriptionInClipboard",
  "dataRetentionEnabled",
  "saveDiscardedTranscriptions",
  "noteFilesEnabled",
  "cleanupDisableThinking",
  "noteFormattingDisableThinking",
  "chatAgentDisableThinking",
  "notificationsEnabled",
  "notifyMeetingDetection",
  "notifyCalendarReminders",
  "meetingCompanionEnabled",
  "gcalPrimaryOnly",
  "mcalPrimaryOnly",
  "appleCalendarConnected",
]);

const ARRAY_SETTINGS = new Set([
  "customDictionary",
  "snippets",
  "gcalAccounts",
  "mcalAccounts",
  "onboardingUseCases",
  "spokenLanguages",
]);

const NUMERIC_SETTINGS = new Set([
  "micWarmHoldSeconds",
  "audioRetentionDays",
  "transcriptRetentionDays",
  "whisperVadThreshold",
  "whisperVadMinSpeechDurationMs",
  "whisperVadMinSilenceDurationMs",
  "whisperVadMaxSpeechDurationS",
  "whisperVadSpeechPadMs",
  "whisperVadSamplesOverlap",
]);

const WHISPER_VAD_DEFAULTS = whisperVadConstants.DEFAULTS;
const WHISPER_VAD_LIMITS = whisperVadConstants.LIMITS;

type WhisperVadKey = keyof typeof WHISPER_VAD_DEFAULTS;

const clampVadValue = (key: WhisperVadKey, raw: unknown): number => {
  const fallback = WHISPER_VAD_DEFAULTS[key];
  const n = raw === null || raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const { min, max, round } = WHISPER_VAD_LIMITS[key];
  const clamped = Math.min(max, Math.max(min, n));
  return round ? Math.round(clamped) : clamped;
};

const LANGUAGE_MIGRATIONS: Record<string, string> = { zh: "zh-CN" };

function migratePreferredLanguage() {
  if (!isBrowser) return;
  const stored = localStorage.getItem("preferredLanguage");
  if (stored && LANGUAGE_MIGRATIONS[stored]) {
    localStorage.setItem("preferredLanguage", LANGUAGE_MIGRATIONS[stored]);
  }
}

migratePreferredLanguage();

// Map the underlying transcription fields to the InferenceMode the Settings
// tabs select on. Single source of truth shared by the provider-settings
// migration and the onboarding "use this provider everywhere" action.
function deriveTranscriptionMode(
  useLocalWhisper: boolean,
  cloudTranscriptionProvider: string | null
): InferenceMode {
  if (useLocalWhisper) return "local";
  return cloudTranscriptionProvider === "custom" ? "self-hosted" : "providers";
}

// Map a legacy cloud-routing pair to the direct InferenceMode the Settings tabs
// select on. Shared by provider migrations and healSkippedMeetingFollowModes().
function deriveLegacyReasoningMode(
  cloudMode: string | null,
  provider: string | null
): InferenceMode {
  if (cloudMode === "local") return "local";
  if (cloudMode === "enterprise") return "enterprise";
  if (cloudMode !== "byok") {
    if (provider === "bedrock" || provider === "azure" || provider === "vertex") {
      return "enterprise";
    }
    if (provider && localLlmProviderIds.has(provider)) return "local";
    return "providers";
  }
  if (provider === "custom") return "self-hosted";
  if (provider === "bedrock" || provider === "azure" || provider === "vertex") {
    return "enterprise";
  }
  if (provider && localLlmProviderIds.has(provider)) return "local";
  return "providers";
}

type DirectInferenceMode = "providers" | "local" | "self-hosted" | "enterprise" | "agent";

function isDirectInferenceMode(value: string): value is DirectInferenceMode {
  return value === "providers" || value === "local" || value === "self-hosted" || value === "enterprise" || value === "agent";
}

function readTranscriptionMode(
  modeKey: string,
  useLocalKey: string,
  providerKey: string,
  providerFallback = ""
): InferenceMode {
  const stored = readString(modeKey, "");
  if (stored === "providers" || stored === "local" || stored === "self-hosted") return stored;
  return deriveTranscriptionMode(
    readBoolean(useLocalKey, false),
    readString(providerKey, providerFallback)
  );
}

function readReasoningMode(modeKey: string, cloudModeKey: string, providerKey: string): InferenceMode {
  const stored = readString(modeKey, "");
  if (isDirectInferenceMode(stored)) return stored;
  return deriveLegacyReasoningMode(
    readString(cloudModeKey, "byok"),
    readString(providerKey, "")
  );
}

function readDirectCloudMode(key: string, fallback = "byok"): string {
  const stored = readString(key, fallback);
  return stored === "byok" || stored === "local" || stored === "enterprise" ? stored : fallback;
}

function migrateProviderSettings() {
  if (!isBrowser) return;
  if (localStorage.getItem("_providerSettingsMigrated") === "1") return;

  const cloudMode = localStorage.getItem("cloudTranscriptionMode");
  const useLocal = localStorage.getItem("useLocalWhisper") === "true";
  const provider = localStorage.getItem("cloudTranscriptionProvider");

  const transcriptionMode = deriveTranscriptionMode(useLocal, provider);
  localStorage.setItem("transcriptionMode", transcriptionMode);

  if (provider === "custom" && cloudMode === "byok") {
    localStorage.setItem("remoteTranscriptionType", "openai-compatible");
    const legacyBaseUrl = localStorage.getItem("cloudTranscriptionBaseUrl");
    const existingRemoteUrl = localStorage.getItem("remoteTranscriptionUrl");
    if (!existingRemoteUrl && legacyBaseUrl && legacyBaseUrl !== API_ENDPOINTS.TRANSCRIPTION_BASE) {
      localStorage.setItem("remoteTranscriptionUrl", legacyBaseUrl);
    }
  }

  const reasoningMode = localStorage.getItem("cloudReasoningMode");
  const reasoningProvider = localStorage.getItem("reasoningProvider");
  localStorage.setItem(
    "reasoningMode",
    deriveLegacyReasoningMode(reasoningMode, reasoningProvider)
  );

  if (reasoningProvider === "custom" && reasoningMode === "byok") {
    localStorage.setItem("remoteReasoningType", "openai-compatible");
  }

  localStorage.setItem("_providerSettingsMigrated", "1");
}

migrateProviderSettings();

// One-time migration for legacy `meetingFollows{Transcription,Reasoning}` flags.
// When the flag was true (the default), meeting/note recordings inherited the
// main transcription/intelligence settings. We've removed the toggle; copy the
// effective values into the dedicated meeting fields so post-migration reads
// (which always go through meeting fields) preserve every existing user's
// behavior. After migration the flag stays at "false" as a marker so this
// never runs again. Safe to delete after a few releases.
const MEETING_TRANSCRIPTION_PAIRS: ReadonlyArray<[string, string]> = [
  ["useLocalWhisper", "meetingUseLocalWhisper"],
  ["whisperModel", "meetingWhisperModel"],
  ["localTranscriptionProvider", "meetingLocalTranscriptionProvider"],
  ["parakeetModel", "meetingParakeetModel"],
  ["cohereModel", "meetingCohereModel"],
  ["cloudTranscriptionProvider", "meetingCloudTranscriptionProvider"],
  ["cloudTranscriptionModel", "meetingCloudTranscriptionModel"],
  ["cloudTranscriptionBaseUrl", "meetingCloudTranscriptionBaseUrl"],
  ["cloudTranscriptionMode", "meetingCloudTranscriptionMode"],
  ["transcriptionMode", "meetingTranscriptionMode"],
  ["remoteTranscriptionType", "meetingRemoteTranscriptionType"],
  ["remoteTranscriptionUrl", "meetingRemoteTranscriptionUrl"],
];
const MEETING_REASONING_PAIRS: ReadonlyArray<[string, string]> = [
  ["reasoningProvider", "meetingReasoningProvider"],
  ["reasoningModel", "meetingReasoningModel"],
  ["reasoningMode", "meetingReasoningMode"],
  ["cloudReasoningMode", "meetingCloudReasoningMode"],
  ["cloudReasoningBaseUrl", "meetingCloudReasoningBaseUrl"],
  ["remoteReasoningType", "meetingRemoteReasoningType"],
  ["remoteReasoningUrl", "meetingRemoteReasoningUrl"],
];

function migrateMeetingFollowFlags() {
  if (!isBrowser) return;
  for (const [flag, pairs] of [
    ["meetingFollowsTranscription", MEETING_TRANSCRIPTION_PAIRS],
    ["meetingFollowsReasoning", MEETING_REASONING_PAIRS],
  ] as const) {
    if (localStorage.getItem(flag) === "false") continue;
    for (const [src, dst] of pairs) {
      const v = localStorage.getItem(src);
      if (v !== null) localStorage.setItem(dst, v);
    }
    localStorage.setItem(flag, "false");
  }
}

// Runs after migrateProviderSettings() so the mode keys it derives and persists
// (`transcriptionMode`, `reasoningMode`, the `remote*` keys) exist to be copied.
// Before 1.10.0 it ran first, skipped those pairs, and latched — see
// healSkippedMeetingFollowModes() for the profiles that already did.
migrateMeetingFollowFlags();

// One-time seed of the dedicated audio-upload transcription settings. Runs
// after migrateProviderSettings() so the `transcriptionMode` it derives and
// persists is available to copy. Before this context existed the upload page
// used the base transcription settings, so copy each value the user actually set
// into the matching `upload*` key. Fresh installs have no base keys persisted,
// so nothing is copied and the upload context uses the direct provider defaults.
const UPLOAD_TRANSCRIPTION_PAIRS: ReadonlyArray<[string, string]> = [
  ["useLocalWhisper", "uploadUseLocalWhisper"],
  ["whisperModel", "uploadWhisperModel"],
  ["localTranscriptionProvider", "uploadLocalTranscriptionProvider"],
  ["parakeetModel", "uploadParakeetModel"],
  ["cohereModel", "uploadCohereModel"],
  ["cloudTranscriptionProvider", "uploadCloudTranscriptionProvider"],
  ["cloudTranscriptionModel", "uploadCloudTranscriptionModel"],
  ["cloudTranscriptionBaseUrl", "uploadCloudTranscriptionBaseUrl"],
  ["cloudTranscriptionMode", "uploadCloudTranscriptionMode"],
  ["transcriptionMode", "uploadTranscriptionMode"],
];

function migrateUploadTranscription() {
  if (!isBrowser) return;
  if (localStorage.getItem("uploadTranscriptionMigrated") === "true") return;
  for (const [src, dst] of UPLOAD_TRANSCRIPTION_PAIRS) {
    const v = localStorage.getItem(src);
    if (v !== null) localStorage.setItem(dst, v);
  }
  localStorage.setItem("uploadTranscriptionMigrated", "true");
}

migrateUploadTranscription();

// Transcription and upload render `*TranscriptionMode` in their picker but route on
// `*UseLocalWhisper` (audioManager, fileTranscription) and `*CloudTranscriptionMode`
// (the cloud-routing test), so routing can disagree with what the user sees
// (#2086). Must run after the upload one-shot copy, which mirrors the transcription
// keys desync-and-all and then latches.
//
// Note Recording is excluded: resolveMeetingTranscriptionOptions branches on
// `meetingTranscriptionMode`, the key the Models page edits, so it cannot
// disagree, and no router reads `meetingUseLocalWhisper`.
//
// Never complete either rule symmetrically — it would start uploading audio from
// profiles that exist: the mode-less Settings toggle wrote the local flag alone
// until 6fb0c906, and ProviderSetupStep writes `cloudTranscriptionMode` before the
// commit that derives the mode.
const TRANSCRIPTION_ROUTING_KEYS: ReadonlyArray<{
  mode: keyof SettingsState;
  useLocal: keyof SettingsState;
  cloudMode: keyof SettingsState;
}> = [
  { mode: "transcriptionMode", useLocal: "useLocalWhisper", cloudMode: "cloudTranscriptionMode" },
  {
    mode: "uploadTranscriptionMode",
    useLocal: "uploadUseLocalWhisper",
    cloudMode: "uploadCloudTranscriptionMode",
  },
];

function reconcileTranscriptionRouting(): void {
  if (!isBrowser) return;
  const repaired: string[] = [];
  for (const keys of TRANSCRIPTION_ROUTING_KEYS) {
    const mode = localStorage.getItem(keys.mode);
    if (mode === "local" && localStorage.getItem(keys.useLocal) !== "true") {
      localStorage.setItem(keys.useLocal, "true");
      repaired.push(keys.useLocal);
    }
    // Stored value, not the upload resolver's inherited one: direct provider
    // modes need an explicit BYOK route in their own scope.
    if (
      (mode === "providers" || mode === "self-hosted") &&
      localStorage.getItem(keys.cloudMode) !== "byok"
    ) {
      localStorage.setItem(keys.cloudMode, "byok");
      repaired.push(keys.cloudMode);
    }
  }
  if (repaired.length === 0) return;

  logger.info(
    "Repaired transcription routing that disagreed with the selected mode",
    { keys: repaired },
    "settings"
  );
}

reconcileTranscriptionRouting();

function migrateAgentMode() {
  if (!isBrowser) return;
  if (localStorage.getItem("_agentModeMigrated") === "1") return;

  localStorage.setItem(
    "agentInferenceMode",
    deriveLegacyReasoningMode(
      localStorage.getItem("cloudAgentMode"),
      localStorage.getItem("agentProvider")
    )
  );

  localStorage.setItem("_agentModeMigrated", "1");
}

migrateAgentMode();

function migrateCustomPrompts() {
  if (!isBrowser) return;
  if (localStorage.getItem("_promptsMigrated") === "1") return;

  const legacyUnified = localStorage.getItem("customUnifiedPrompt");
  if (legacyUnified) {
    try {
      const parsed = JSON.parse(legacyUnified);
      if (typeof parsed === "string" && parsed.length > 0) {
        if (!localStorage.getItem("customPrompt.cleanup")) {
          localStorage.setItem("customPrompt.cleanup", parsed);
        }
      }
    } catch {}
    localStorage.removeItem("customUnifiedPrompt");
  }

  const legacyChat = localStorage.getItem("agentSystemPrompt");
  if (legacyChat && legacyChat.length > 0 && !localStorage.getItem("customPrompt.chatAgent")) {
    localStorage.setItem("customPrompt.chatAgent", legacyChat);
  }
  if (legacyChat !== null) localStorage.removeItem("agentSystemPrompt");

  localStorage.setItem("_promptsMigrated", "1");
}

migrateCustomPrompts();

// Overrides that byte-match a retired shipped default were persisted defaults,
// not user customizations; clear them so current defaults apply again.
function sweepRetiredCustomPrompts() {
  if (!isBrowser) return;
  void sweepRetiredPromptOverrides(localStorage, PROMPT_KIND_LIST)
    .then((swept) => {
      if (swept.length === 0) return;
      useSettingsStore.setState((s) => ({
        customPrompts: {
          ...s.customPrompts,
          ...Object.fromEntries(swept.map((kind) => [kind, ""])),
        },
      }));
      logger.info("Cleared retired default prompt overrides", { kinds: swept }, "settings");
    })
    .catch((error) => {
      logger.warn(
        "Retired prompt sweep failed",
        { error: error instanceof Error ? error.message : String(error) },
        "settings"
      );
    });
}

sweepRetiredCustomPrompts();

// One-time migration of legacy LLM-scope localStorage keys. Safe to delete
// after a few releases.
const LLM_SCOPE_KEY_PAIRS: ReadonlyArray<[string, string]> = [
  ["reasoningModel", "cleanupModel"],
  ["reasoningProvider", "cleanupProvider"],
  ["reasoningMode", "cleanupMode"],
  ["useReasoningModel", "useCleanupModel"],
  ["cloudReasoningMode", "cleanupCloudMode"],
  ["cloudReasoningBaseUrl", "cleanupCloudBaseUrl"],
  ["customReasoningApiKey", "cleanupCustomApiKey"],
  ["remoteReasoningUrl", "cleanupRemoteUrl"],
  ["meetingReasoningMode", "noteFormattingMode"],
  ["meetingReasoningProvider", "noteFormattingProvider"],
  ["meetingReasoningModel", "noteFormattingModel"],
  ["meetingCloudReasoningMode", "noteFormattingCloudMode"],
  ["meetingCloudReasoningBaseUrl", "noteFormattingCloudBaseUrl"],
  ["meetingRemoteReasoningUrl", "noteFormattingRemoteUrl"],
  ["agentInferenceMode", "chatAgentMode"],
  ["agentProvider", "chatAgentProvider"],
  ["agentModel", "chatAgentModel"],
  ["cloudAgentMode", "chatAgentCloudMode"],
  ["remoteAgentUrl", "chatAgentRemoteUrl"],
];

function migrateLLMScopeKeys() {
  if (!isBrowser) return;
  if (localStorage.getItem("_llmScopeKeysMigrated") === "1") return;

  for (const [oldKey, newKey] of LLM_SCOPE_KEY_PAIRS) {
    const value = localStorage.getItem(oldKey);
    if (value === null) continue;
    if (localStorage.getItem(newKey) === null) {
      localStorage.setItem(newKey, value);
    }
    localStorage.removeItem(oldKey);
  }

  localStorage.setItem("_llmScopeKeysMigrated", "1");
}

migrateLLMScopeKeys();

// Builds before 1.10.0 ran migrateMeetingFollowFlags() before
// migrateProviderSettings() had created `transcriptionMode` / `reasoningMode`,
// so a profile upgrading straight from ≤1.6.7 copied every Note Recording key
// except the two modes and then latched the follow flags.
//
// The two modes fail differently when absent, so they are healed differently.
// `meetingTranscriptionMode` has no fallback: selectResolvedMeetingTranscription
// passes it straight through, so every mode is reconstructed from the snapshot
// the copy did write — with the same functions migrateProviderSettings() uses,
// not from today's transcription keys, which the user may have changed since.
// `noteFormattingMode` has a fallback to cleanup; a local snapshot is therefore
// healed local-ward only so it cannot be replaced by a stale remote choice.
//
// Runs after migrateLLMScopeKeys() so a pre-1.7.0 profile's reasoning snapshot
// is under its final `noteFormatting*` names. `noteFormattingCloudMode` is the
// reasoning-side signal: the scope editor can write the provider alone but only
// ever writes cloudMode together with mode. Idempotent — writing a mode retires
// its own guard — and it never touches `meetingUseLocalWhisper`, which no router
// reads but which rule two below depends on.
function healSkippedMeetingFollowModes(): Record<string, InferenceMode> {
  if (!isBrowser) return {};
  const healed: Record<string, InferenceMode> = {};

  const meetingUseLocal = localStorage.getItem("meetingUseLocalWhisper");
  const meetingCloudMode = localStorage.getItem("meetingCloudTranscriptionMode");
  if (
    localStorage.getItem("meetingTranscriptionMode") === null &&
    (meetingUseLocal !== null || meetingCloudMode !== null)
  ) {
    const mode = deriveTranscriptionMode(
      meetingUseLocal === "true",
      localStorage.getItem("meetingCloudTranscriptionProvider")
    );
    localStorage.setItem("meetingTranscriptionMode", mode);
    healed.meetingTranscriptionMode = mode;
  }

  // v1.6.8–v1.6.9's since-removed mode-less toggle wrote `useLocalWhisper` alone,
  // so a deliberate Local choice could sit under a stale cloud mode; v1.6.10's
  // wholesale copy carried both into Note Recording, where the mode is what
  // routes. The UI writes the flag as `mode === "local"`, so this pair can only
  // be that copy. Follow the flag — local-ward only.
  const meetingMode = localStorage.getItem("meetingTranscriptionMode");
  if (meetingUseLocal === "true" && meetingMode !== null && meetingMode !== "local") {
    localStorage.setItem("meetingTranscriptionMode", "local");
    healed.meetingTranscriptionMode = "local";
  }

  const noteFormattingCloudMode = localStorage.getItem("noteFormattingCloudMode");
  if (localStorage.getItem("noteFormattingMode") === null && noteFormattingCloudMode !== null) {
    const mode = deriveLegacyReasoningMode(
      noteFormattingCloudMode,
      localStorage.getItem("noteFormattingProvider")
    );
    // Local-ward only — see the header. Any other snapshot is left absent so
    // note formatting keeps following cleanup, as it does today.
    if (mode === "local") {
      localStorage.setItem("noteFormattingMode", mode);
      healed.noteFormattingMode = mode;
    }
  }

  return healed;
}

const healedMeetingFollowModes = healSkippedMeetingFollowModes();
if (Object.keys(healedMeetingFollowModes).length > 0) {
  logger.info(
    "Re-derived Note Recording modes the follow-flag migration had skipped",
    healedMeetingFollowModes,
    "settings"
  );
}

// Resolved offline, so a retired model's name survives only in the user's own
// catalog cache and a replacement's only if we seed it. The raw-id fallback is
// what the live-catalog reconcile shows too.
function tinfoilModelName(modelId: string): string {
  const named =
    readCachedTinfoilModels().models.find((model) => model.id === modelId) ??
    modelRegistryData.cloudProviders
      .find((provider) => provider.id === "tinfoil")
      ?.models.find((model) => model.id === modelId);
  return named?.name ?? modelId;
}

// A scope still pointing at a model its provider has retired 404s on every
// request. Runs after migrateLLMScopeKeys so scope values live under their
// final keys, and before the store reads them, so the first request of the
// session already carries a model the provider serves.
function migrateRetiredCloudModels() {
  if (!isBrowser) return;
  const swept = sweepRetiredCloudModelSelections(
    localStorage,
    Object.values(INFERENCE_SCOPES).map(({ storeKeys }) => storeKeys)
  );
  if (swept.length === 0) return;

  logger.info(
    "Repointed retired cloud model selections",
    { scopes: swept.map(({ storeKey }) => storeKey) },
    "settings"
  );

  // Tinfoil is the one provider that tells the user their model was switched
  // out, and getting here first means reconcileSelectedModels no longer will.
  const announced = new Set<string>();
  for (const { provider, from, to } of swept) {
    if (provider !== "tinfoil" || announced.has(from)) continue;
    announced.add(from);
    recordTinfoilModelSwitch({ from: tinfoilModelName(from), to: tinfoilModelName(to) });
  }
}

migrateRetiredCloudModels();

export interface SettingsState
  extends
    TranscriptionSettings,
    CleanupSettings,
    HotkeySettings,
    OnboardingSettings,
    MicrophoneSettings,
    ApiKeySettings,
    PrivacySettings,
    ThemeSettings,
    ChatAgentSettings {
  profileName: string;
  setProfileName: (name: string) => void;
  isSignedIn: boolean;
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
  setDateFormat: (format: DateFormat) => void;
  setTimeFormat: (format: TimeFormat) => void;
  audioCuesEnabled: boolean;
  floatingIconAutoHide: boolean;
  startMinimized: boolean;
  gcalAccounts: CalendarAccount[];
  gcalConnected: boolean;
  gcalEmail: string;
  mcalAccounts: CalendarAccount[];
  mcalConnected: boolean;
  notificationsEnabled: boolean;
  notifyMeetingDetection: boolean;
  notifyCalendarReminders: boolean;
  /** Floating recording bubble while Gristmill is in the background. */
  meetingCompanionEnabled: boolean;
  gcalPrimaryOnly: boolean;
  mcalPrimaryOnly: boolean;
  appleCalendarConnected: boolean;
  meetingProcessDetection: boolean;
  speakerDiarizationEnabled: boolean;
  noteRecordingSileroEnabled: boolean;
  meetingSileroEnabled: boolean;
  whisperVadThreshold: number;
  whisperVadMinSpeechDurationMs: number;
  whisperVadMinSilenceDurationMs: number;
  whisperVadMaxSpeechDurationS: number;
  whisperVadSpeechPadMs: number;
  whisperVadSamplesOverlap: number;
  panelStartPosition: "bottom-right" | "center" | "bottom-left";
  autoPasteEnabled: boolean;
  keepTranscriptionInClipboard: boolean;
  noteFilesEnabled: boolean;
  noteFilesPath: string;

  transcriptionMode: InferenceMode;
  remoteTranscriptionType: SelfHostedType;
  remoteTranscriptionUrl: string;
  remoteTranscriptionModel: string;
  cleanupMode: InferenceMode;
  cleanupRemoteUrl: string;

  meetingTranscriptionMode: InferenceMode;
  meetingUseLocalWhisper: boolean;
  meetingWhisperModel: string;
  meetingLocalTranscriptionProvider: LocalTranscriptionProvider;
  meetingParakeetModel: string;
  meetingCohereModel: string;
  meetingCloudTranscriptionProvider: string;
  meetingCloudTranscriptionModel: string;
  meetingCloudTranscriptionBaseUrl: string;
  meetingCloudTranscriptionMode: string;
  meetingRemoteTranscriptionType: SelfHostedType;
  meetingRemoteTranscriptionUrl: string;

  uploadTranscriptionMode: InferenceMode;
  uploadUseLocalWhisper: boolean;
  uploadWhisperModel: string;
  uploadLocalTranscriptionProvider: LocalTranscriptionProvider;
  uploadParakeetModel: string;
  uploadCohereModel: string;
  uploadCloudTranscriptionProvider: string;
  uploadCloudTranscriptionModel: string;
  uploadCloudTranscriptionBaseUrl: string;
  uploadCloudTranscriptionMode: string;

  /** Last model used per scope+provider (`"<context>:<providerId>"`), so switching providers restores it. */
  transcriptionModelByProvider: Record<string, string>;

  /** LLM twin of transcriptionModelByProvider, keyed `"<scope>:<providerId>"`. */
  reasoningModelByProvider: Record<string, string>;

  noteFormattingMode: InferenceMode;
  noteFormattingProvider: string;
  noteFormattingModel: string;
  noteFormattingCloudMode: string;
  noteFormattingCloudBaseUrl: string;
  noteFormattingRemoteUrl: string;
  noteFormattingCustomApiKey: string;
  noteFormattingBbProvider: string;
  noteFormattingBbModel: string;
  noteFormattingBbReasoningLevel: string;
  bbAgentPreferences: BbAgentPreferences | null;
  setBbAgentPreferences: (preferences: BbAgentPreferences) => void;

  cleanupDisableThinking: boolean;
  noteFormattingDisableThinking: boolean;
  chatAgentDisableThinking: boolean;

  customPrompts: Record<PromptKind, string>;
  setCustomPrompt: (kind: PromptKind, value: string) => void;

  setTranscriptionMode: (mode: InferenceMode) => void;
  setRemoteTranscriptionType: (type: SelfHostedType) => void;
  setRemoteTranscriptionUrl: (url: string) => void;
  setRemoteTranscriptionModel: (model: string) => void;
  setCleanupMode: (mode: InferenceMode) => void;
  setCleanupRemoteUrl: (url: string) => void;

  setMeetingTranscriptionMode: (mode: InferenceMode) => void;
  setMeetingUseLocalWhisper: (value: boolean) => void;
  setMeetingWhisperModel: (value: string) => void;
  setMeetingLocalTranscriptionProvider: (value: LocalTranscriptionProvider) => void;
  setMeetingParakeetModel: (value: string) => void;
  setMeetingCohereModel: (value: string) => void;
  setMeetingCloudTranscriptionProvider: (value: string) => void;
  setMeetingCloudTranscriptionModel: (value: string) => void;
  setMeetingCloudTranscriptionBaseUrl: (value: string) => void;
  setMeetingCloudTranscriptionMode: (value: string) => void;
  setMeetingRemoteTranscriptionType: (type: SelfHostedType) => void;
  setMeetingRemoteTranscriptionUrl: (url: string) => void;

  setUploadTranscriptionMode: (mode: InferenceMode) => void;
  setUploadUseLocalWhisper: (value: boolean) => void;
  setUploadWhisperModel: (value: string) => void;
  setUploadLocalTranscriptionProvider: (value: LocalTranscriptionProvider) => void;
  setUploadParakeetModel: (value: string) => void;
  setUploadCohereModel: (value: string) => void;
  setUploadCloudTranscriptionProvider: (value: string) => void;
  setUploadCloudTranscriptionModel: (value: string) => void;
  setUploadCloudTranscriptionBaseUrl: (value: string) => void;
  setUploadCloudTranscriptionMode: (value: string) => void;

  setNoteFormattingMode: (mode: InferenceMode) => void;
  setNoteFormattingProvider: (value: string) => void;
  setNoteFormattingModel: (value: string) => void;
  setNoteFormattingCloudMode: (value: string) => void;
  setNoteFormattingCloudBaseUrl: (value: string) => void;
  setNoteFormattingRemoteUrl: (url: string) => void;
  setNoteFormattingCustomApiKey: (key: string) => void;

  setCleanupDisableThinking: (value: boolean) => void;
  setNoteFormattingDisableThinking: (value: boolean) => void;
  setChatAgentDisableThinking: (value: boolean) => void;

  setUseLocalWhisper: (value: boolean) => void;
  setWhisperModel: (value: string) => void;
  setLocalTranscriptionProvider: (value: LocalTranscriptionProvider) => void;
  setParakeetModel: (value: string) => void;
  setCohereModel: (value: string) => void;
  setAllowOpenAIFallback: (value: boolean) => void;
  setAllowLocalFallback: (value: boolean) => void;
  setFallbackWhisperModel: (value: string) => void;
  setPreferredLanguage: (value: string) => void;
  setChineseScriptPreference: (value: ChineseScriptPreference) => void;
  setCloudTranscriptionProvider: (value: string) => void;
  setCloudTranscriptionModel: (value: string) => void;
  setCloudTranscriptionBaseUrl: (value: string) => void;
  setCloudTranscriptionMode: (value: string) => void;
  switchCloudTranscriptionProvider: (
    context: TranscriptionContext,
    providerId: string
  ) => void;
  switchReasoningProvider: (
    scope: InferenceScope,
    providerId: string,
    fallbackModel?: string
  ) => void;
  setCleanupCloudMode: (value: string) => void;
  setCleanupCloudBaseUrl: (value: string) => void;
  setCustomDictionary: (words: string[]) => void;
  updateCustomDictionary: (changes: { add?: string[]; remove?: string[] }) => void;
  applyCustomDictionaryFromExternal: (words: string[]) => void;
  setSnippets: (snippets: Snippet[]) => void;
  applySnippetsFromExternal: (snippets: Snippet[]) => void;
  setAssemblyAiStreaming: (value: boolean) => void;
  setAutoGenerateNoteTitle: (value: boolean) => void;
  setUseCleanupModel: (value: boolean) => void;
  setCleanupModel: (value: string) => void;
  setCleanupProvider: (value: string) => void;
  setUiLanguage: (language: string) => void;

  setOpenaiApiKey: (key: string) => Promise<SecretSaveResult>;
  setAnthropicApiKey: (key: string) => Promise<SecretSaveResult>;
  setGeminiApiKey: (key: string) => Promise<SecretSaveResult>;
  setGroqApiKey: (key: string) => Promise<SecretSaveResult>;
  setXaiApiKey: (key: string) => Promise<SecretSaveResult>;
  setMistralApiKey: (key: string) => Promise<SecretSaveResult>;
  setOpenrouterApiKey: (key: string) => Promise<SecretSaveResult>;
  setCortiClientId: (key: string) => Promise<SecretSaveResult>;
  setCortiClientSecret: (key: string) => Promise<SecretSaveResult>;
  setCortiApiKey: (key: string) => Promise<SecretSaveResult>;
  setTinfoilApiKey: (key: string) => Promise<SecretSaveResult>;
  setDeepgramApiKey: (key: string) => Promise<SecretSaveResult>;
  setElevenLabsApiKey: (key: string) => Promise<SecretSaveResult>;
  setAssemblyaiApiKey: (key: string) => Promise<SecretSaveResult>;
  setCustomTranscriptionApiKey: (key: string) => Promise<SecretSaveResult>;
  setCleanupCustomApiKey: (key: string) => Promise<SecretSaveResult>;

  // Corti (BYOK)
  cortiEnvironment: string;
  cortiTenant: string;
  setCortiEnvironment: (value: string) => void;
  setCortiTenant: (value: string) => void;

  // Enterprise providers
  enterpriseSetupMode: EnterpriseSetupMode;
  enterpriseTranscriptionSetupMode: EnterpriseSetupMode;
  bedrockAuthMode: string;
  bedrockRegion: string;
  bedrockProfile: string;
  bedrockAccessKeyId: string;
  bedrockSecretAccessKey: string;
  bedrockSessionToken: string;
  azureEndpoint: string;
  azureApiKey: string;
  azureDeploymentName: string;
  azureApiVersion: string;
  vertexAuthMode: string;
  vertexProject: string;
  vertexLocation: string;
  vertexApiKey: string;
  setBedrockAuthMode: (value: string) => void;
  setEnterpriseSetupMode: (value: EnterpriseSetupMode) => void;
  setEnterpriseTranscriptionSetupMode: (value: EnterpriseSetupMode) => void;
  setBedrockRegion: (value: string) => void;
  setBedrockProfile: (value: string) => void;
  setBedrockAccessKeyId: (key: string) => Promise<SecretSaveResult>;
  setBedrockSecretAccessKey: (key: string) => Promise<SecretSaveResult>;
  setBedrockSessionToken: (key: string) => Promise<SecretSaveResult>;
  setAzureEndpoint: (value: string) => void;
  setAzureApiKey: (key: string) => Promise<SecretSaveResult>;
  setAzureDeploymentName: (value: string) => void;
  setAzureApiVersion: (value: string) => void;
  setVertexAuthMode: (value: string) => void;
  setVertexProject: (value: string) => void;
  setVertexLocation: (value: string) => void;
  setVertexApiKey: (key: string) => Promise<SecretSaveResult>;

  setMeetingKey: (key: string) => void;
  setMeetingHotkeyLayoutMode: (mode: "side-panel" | "full-width") => void;
  setOnboardingUseCases: (useCases: string[]) => void;
  setOnboardingUseCaseNote: (note: string) => void;
  setSpokenLanguages: (languages: string[]) => void;

  setPreferBuiltInMic: (value: boolean) => void;
  setMicrophoneSelectionMode: (mode: MicrophoneSelectionMode) => void;
  setSelectedMicDevice: (deviceId: string, label: string) => void;
  setMicWarmHoldSeconds: (seconds: number) => void;

  setTheme: (value: "light" | "dark" | "auto") => void;
  setColorScheme: (value: ColorSchemeId) => void;
  setTelemetryEnabled: (value: boolean) => void;
  setAudioRetentionDays: (days: number) => void;
  setTranscriptRetentionDays: (days: number) => void;
  setDataRetentionEnabled: (value: boolean) => void;
  setSaveDiscardedTranscriptions: (value: boolean) => void;
  setAudioCuesEnabled: (value: boolean) => void;
  setFloatingIconAutoHide: (enabled: boolean) => void;
  setStartMinimized: (enabled: boolean) => void;
  setGcalAccounts: (accounts: CalendarAccount[]) => void;
  setMcalAccounts: (accounts: CalendarAccount[]) => void;
  setNotificationsEnabled: (value: boolean) => void;
  setNotifyMeetingDetection: (value: boolean) => void;
  setNotifyCalendarReminders: (value: boolean) => void;
  setMeetingCompanionEnabled: (value: boolean) => void;
  setGcalPrimaryOnly: (value: boolean) => void;
  setMcalPrimaryOnly: (value: boolean) => void;
  setAppleCalendarConnected: (value: boolean) => void;
  setMeetingProcessDetection: (value: boolean) => void;
  setSpeakerDiarizationEnabled: (value: boolean) => void;
  setNoteRecordingSileroEnabled: (value: boolean) => void;
  setMeetingSileroEnabled: (value: boolean) => void;
  setWhisperVadThreshold: (value: number) => void;
  setWhisperVadMinSpeechDurationMs: (value: number) => void;
  setWhisperVadMinSilenceDurationMs: (value: number) => void;
  setWhisperVadMaxSpeechDurationS: (value: number) => void;
  setWhisperVadSpeechPadMs: (value: number) => void;
  setWhisperVadSamplesOverlap: (value: number) => void;
  setPanelStartPosition: (position: "bottom-right" | "center" | "bottom-left") => void;
  setAutoPasteEnabled: (value: boolean) => void;
  setKeepTranscriptionInClipboard: (value: boolean) => void;
  setNoteFilesEnabled: (value: boolean) => void;
  setNoteFilesPath: (value: string) => void;
  setIsSignedIn: (value: boolean) => void;

  setChatAgentModel: (value: string) => void;
  setChatAgentProvider: (value: string) => void;
  setChatAgentCloudMode: (value: string) => void;
  setChatAgentMode: (mode: InferenceMode) => void;
  setChatAgentCloudBaseUrl: (value: string) => void;
  setChatAgentRemoteUrl: (url: string) => void;
  setChatAgentCustomApiKey: (key: string) => void;

  updateTranscriptionSettings: (settings: Partial<TranscriptionSettings>) => void;
  setCloudTranscriptionForAllScopes: (settings: Partial<TranscriptionSettings>) => void;
  updateCleanupSettings: (settings: Partial<CleanupSettings>) => void;
  setCloudReasoningForAllScopes: (
    settings: Partial<CleanupSettings & Pick<ApiKeySettings, "cleanupCustomApiKey">>
  ) => void;
  updateApiKeys: (keys: Partial<ApiKeySettings>) => void;
  updateChatAgentSettings: (settings: Partial<ChatAgentSettings>) => void;
}

function createStringSetter(key: string) {
  return (value: string) => {
    if (isBrowser) localStorage.setItem(key, value);
    useSettingsStore.setState({ [key]: value });
  };
}

function persistTranscriptionModelMemory(memory: Record<string, string>) {
  if (isBrowser) localStorage.setItem("transcriptionModelByProvider", JSON.stringify(memory));
  useSettingsStore.setState({ transcriptionModelByProvider: memory });
}

function persistReasoningModelMemory(memory: Record<string, string>) {
  if (isBrowser) localStorage.setItem("reasoningModelByProvider", JSON.stringify(memory));
  useSettingsStore.setState({ reasoningModelByProvider: memory });
}

function readModelMemory(key: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readString(key, "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

/** Writes a string setting whose key is computed rather than known up front. */
export function setStringSetting(key: keyof SettingsState, value: string): void {
  createStringSetter(key)(value);
}

function createBooleanSetter(key: string) {
  return (value: boolean) => {
    if (isBrowser) localStorage.setItem(key, String(value));
    useSettingsStore.setState({ [key]: value });
  };
}

function createNumberSetter(key: string) {
  return (value: number) => {
    if (isBrowser) localStorage.setItem(key, String(value));
    useSettingsStore.setState({ [key]: value });
  };
}

// Setter for hotkeys that must be registered with the main process before
// being persisted. Rolls back to the previous key if registration fails.
// Resolves to false on failure so optimistic UIs (HotkeyListInput) can revert.
let envPersistTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedPersistToEnv() {
  if (!isBrowser) return;
  if (envPersistTimer) clearTimeout(envPersistTimer);
  envPersistTimer = setTimeout(() => {
    window.electronAPI?.saveAllKeysToEnv?.().catch((err) => {
      logger.warn(
        "Failed to persist API keys to .env",
        { error: (err as Error).message },
        "settings"
      );
    });
  }, 1000);
}

const SECRET_IPC_SAVERS = {
  openai: "saveOpenAIKey",
  anthropic: "saveAnthropicKey",
  gemini: "saveGeminiKey",
  groq: "saveGroqKey",
  xai: "saveXaiKey",
  mistral: "saveMistralKey",
  openrouter: "saveOpenrouterKey",
  cortiClientId: "saveCortiClientId",
  cortiClientSecret: "saveCortiClientSecret",
  cortiApiKey: "saveCortiKey",
  tinfoil: "saveTinfoilKey",
  deepgram: "saveDeepgramKey",
  elevenlabs: "saveElevenLabsKey",
  assemblyai: "saveAssemblyAIKey",
  customTranscription: "saveCustomTranscriptionKey",
  cleanupCustom: "saveCleanupCustomKey",
  noteFormattingCustom: "saveNoteFormattingCustomKey",
  chatAgentCustom: "saveChatAgentCustomKey",
  bedrockAccessKeyId: "saveBedrockAccessKeyId",
  bedrockSecretAccessKey: "saveBedrockSecretAccessKey",
  bedrockSessionToken: "saveBedrockSessionToken",
  azureApiKey: "saveAzureApiKey",
  vertexApiKey: "saveVertexApiKey",
} as const;

type SecretProvider = keyof typeof SECRET_IPC_SAVERS;

type SecretSaveResult = { success: boolean };

async function persistSecret(provider: SecretProvider, key: string): Promise<SecretSaveResult> {
  if (!isBrowser) return { success: false };
  const api = window.electronAPI;
  const save = api?.[SECRET_IPC_SAVERS[provider]] as
    ((value: string) => Promise<SecretSaveResult>) | undefined;
  if (!save) return { success: false };
  try {
    const result = await save(key);
    return result?.success === true ? { success: true } : { success: false };
  } catch {
    logger.warn("Failed to persist secret", { provider }, "settings");
    return { success: false };
  }
}

const STALE_SECRET_LOCALSTORAGE_KEYS = [
  "openaiApiKey",
  "anthropicApiKey",
  "geminiApiKey",
  "groqApiKey",
  "xaiApiKey",
  "mistralApiKey",
  "openrouterApiKey",
  "cortiClientId",
  "cortiClientSecret",
  "cortiApiKey",
  "tinfoilApiKey",
  "deepgramApiKey",
  "elevenLabsApiKey",
  "assemblyaiApiKey",
  "customTranscriptionApiKey",
  "customReasoningApiKey",
  "cleanupCustomApiKey",
  "noteFormattingCustomApiKey",
  "chatAgentCustomApiKey",
  "bedrockAccessKeyId",
  "bedrockSecretAccessKey",
  "bedrockSessionToken",
  "azureApiKey",
  "vertexApiKey",
] as const;

function invalidateApiKeyCaches(
  provider?:
    | "openai"
    | "anthropic"
    | "gemini"
    | "groq"
    | "mistral"
    | "tinfoil"
    | "custom"
    | "openrouter"
    | "corti"
) {
  if (provider) {
    if (_ReasoningService) {
      _ReasoningService.clearApiKeyCache(provider);
    } else {
      import("../services/ReasoningService.js")
        .then((mod) => {
          // NodeNext CJS interop: the ESM default (the singleton instance) is
          // exposed on .default; type it through the declared field shape.
          const service = (mod as unknown as { default: NonNullable<typeof _ReasoningService> }).default;
          _ReasoningService = service;
          service.clearApiKeyCache(provider);
        })
        .catch(() => {});
    }
  }
  if (isBrowser) window.dispatchEvent(new Event("api-key-changed"));
}

// Persist each secret before exposing it in renderer state, then clear the
// provider's cached key. cacheProvider is omitted where there is no scoped
// cache to clear (xai).
function createSecretSetter(
  storeKey: string,
  saver: SecretProvider,
  cacheProvider?: Parameters<typeof invalidateApiKeyCaches>[0]
) {
  return async (key: string): Promise<SecretSaveResult> => {
    const result = await persistSecret(saver, key);
    if (!result.success) return result;
    useSettingsStore.setState({ [storeKey]: key });
    invalidateApiKeyCaches(cacheProvider);
    return result;
  };
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  profileName: readString("profileName", ""),
  setProfileName: createStringSetter("profileName"),
  uiLanguage: normalizeUiLanguage(
    isBrowser ? localStorage.getItem("uiLanguage") || i18n.language : null
  ),
  dateFormat: (() => {
    const value = readString("dateFormat", "locale");
    return value === "dmy" || value === "mdy" || value === "ymd" ? value : "locale";
  })(),
  timeFormat: (() => {
    const value = readString("timeFormat", "locale");
    return value === "12h" || value === "24h" ? value : "locale";
  })(),
  setDateFormat: (format) => {
    if (isBrowser) localStorage.setItem("dateFormat", format);
    set({ dateFormat: format });
  },
  setTimeFormat: (format) => {
    if (isBrowser) localStorage.setItem("timeFormat", format);
    set({ timeFormat: format });
  },
  useLocalWhisper: readBoolean("useLocalWhisper", false),
  whisperModel: readString("whisperModel", "base"),
  localTranscriptionProvider: readLocalProvider("localTranscriptionProvider"),
  parakeetModel: readString("parakeetModel", ""),
  cohereModel: readString("cohereModel", DEFAULT_COHERE_MODEL),
  allowOpenAIFallback: readBoolean("allowOpenAIFallback", false),
  allowLocalFallback: readBoolean("allowLocalFallback", false),
  fallbackWhisperModel: readString("fallbackWhisperModel", "base"),
  preferredLanguage: readString("preferredLanguage", "auto"),
  chineseScriptPreference: normalizeChineseScriptPreference(
    readString("chineseScriptPreference", "as-transcribed")
  ),
  cloudTranscriptionProvider: readString(
    "cloudTranscriptionProvider",
    DEFAULT_CLOUD_TRANSCRIPTION_PROVIDER
  ),
  cloudTranscriptionModel: readString("cloudTranscriptionModel", "gpt-4o-mini-transcribe"),
  cloudTranscriptionBaseUrl: readString(
    "cloudTranscriptionBaseUrl",
    API_ENDPOINTS.TRANSCRIPTION_BASE
  ),
  transcriptionModelByProvider: readModelMemory("transcriptionModelByProvider"),
  reasoningModelByProvider: readModelMemory("reasoningModelByProvider"),
  // Secrets aren't hydrated yet at construction; the BYOK default is set
  // post-hydration in initializeSettings.
  cloudTranscriptionMode: readDirectCloudMode("cloudTranscriptionMode"),
  cleanupCloudMode: readDirectCloudMode("cleanupCloudMode"),
  cleanupCloudBaseUrl: readString("cleanupCloudBaseUrl", API_ENDPOINTS.OPENAI_BASE),
  cortiEnvironment: readString("cortiEnvironment", "us"),
  cortiTenant: readString("cortiTenant", "base"),
  customDictionary: readStringArray("customDictionary", []),
  snippets: (() => {
    try {
      const parsed = JSON.parse(readString("snippets", "[]"));
      return Array.isArray(parsed) ? (parsed as Snippet[]) : [];
    } catch {
      return [];
    }
  })(),
  assemblyAiStreaming: readBoolean("assemblyAiStreaming", true),

  autoGenerateNoteTitle: readBoolean("autoGenerateNoteTitle", true),
  useCleanupModel: readBoolean("useCleanupModel", true),
  cleanupModel: readString("cleanupModel", ""),
  cleanupProvider: readString("cleanupProvider", "openai"),

  // Secrets hydrate from main process in initializeSettings, never from localStorage.
  openaiApiKey: "",
  anthropicApiKey: "",
  geminiApiKey: "",
  groqApiKey: "",
  xaiApiKey: "",
  mistralApiKey: "",
  openrouterApiKey: "",
  cortiClientId: "",
  cortiClientSecret: "",
  cortiApiKey: "",
  tinfoilApiKey: "",
  deepgramApiKey: "",
  elevenLabsApiKey: "",
  assemblyaiApiKey: "",
  customTranscriptionApiKey: "",
  cleanupCustomApiKey: "",

  // Enterprise providers
  enterpriseSetupMode: (() => {
    const v = readString("enterpriseSetupMode", "auto");
    if (v === "auto" || v === "managed" || v === "manual") return v;
    return "auto" as EnterpriseSetupMode;
  })(),
  enterpriseTranscriptionSetupMode: (() => {
    const v = readString("enterpriseTranscriptionSetupMode", "auto");
    if (v === "auto" || v === "managed" || v === "manual") return v;
    return "auto" as EnterpriseSetupMode;
  })(),
  bedrockAuthMode: readString("bedrockAuthMode", "sso"),
  bedrockRegion: readString("bedrockRegion", "us-east-1"),
  bedrockProfile: readString("bedrockProfile", ""),
  bedrockAccessKeyId: "",
  bedrockSecretAccessKey: "",
  bedrockSessionToken: "",
  azureEndpoint: readString("azureEndpoint", ""),
  azureApiKey: "",
  azureDeploymentName: readString("azureDeploymentName", ""),
  azureApiVersion: readString("azureApiVersion", "2024-10-21"),
  vertexAuthMode: readString("vertexAuthMode", "adc"),
  vertexProject: readString("vertexProject", ""),
  vertexLocation: readString("vertexLocation", "us-central1"),
  vertexApiKey: "",

  meetingKey: readString("meetingKey", ""),
  onboardingUseCases: readStringArray("onboardingUseCases", []),
  onboardingUseCaseNote: readString("onboardingUseCaseNote", ""),
  spokenLanguages: readStringArray("spokenLanguages", []),
  meetingHotkeyLayoutMode: (readString("meetingHotkeyLayoutMode", "full-width") === "side-panel"
    ? "side-panel"
    : "full-width") as "side-panel" | "full-width",

  microphoneSelectionMode: (() => {
    const mode = readString("microphoneSelectionMode", "system");
    return (
      mode === "built-in" || mode === "specific" ? mode : "system"
    ) as MicrophoneSelectionMode;
  })(),
  preferBuiltInMic: readBoolean("preferBuiltInMic", false),
  selectedMicDeviceId: readString("selectedMicDeviceId", ""),
  selectedMicDeviceLabel: readString("selectedMicDeviceLabel", ""),
  micWarmHoldSeconds: snapMicWarmHold(readNumber("micWarmHoldSeconds", 0)),

  theme: (() => {
    const v = readString("theme", "auto");
    if (v === "light" || v === "dark" || v === "auto") return v;
    return "auto" as const;
  })(),
  colorScheme: normalizeColorScheme(readString("colorScheme", DEFAULT_COLOR_SCHEME)),
  telemetryEnabled: readBoolean("telemetryEnabled", false),
  audioRetentionDays: readNumber("audioRetentionDays", 7),
  transcriptRetentionDays: readNumber("transcriptRetentionDays", 0),
  dataRetentionEnabled: readBoolean("dataRetentionEnabled", true),
  saveDiscardedTranscriptions: readBoolean("saveDiscardedTranscriptions", false),
  audioCuesEnabled: readBoolean("audioCuesEnabled", true),
  floatingIconAutoHide: readBoolean("floatingIconAutoHide", false),
  startMinimized: readBoolean("startMinimized", false),
  notificationsEnabled: readBoolean("notificationsEnabled", true),
  notifyMeetingDetection: readBoolean("notifyMeetingDetection", true),
  notifyCalendarReminders: readBoolean("notifyCalendarReminders", true),
  meetingCompanionEnabled: readBoolean("meetingCompanionEnabled", true),
  ...(() => {
    let accounts: CalendarAccount[] = [];
    try {
      const parsed = JSON.parse(readString("gcalAccounts", "[]"));
      if (Array.isArray(parsed)) accounts = parsed;
    } catch {
      /* use empty default */
    }
    return {
      gcalAccounts: accounts,
      gcalConnected: accounts.length > 0,
      gcalEmail: accounts[0]?.email ?? "",
    };
  })(),
  ...(() => {
    let accounts: CalendarAccount[] = [];
    try {
      const parsed = JSON.parse(readString("mcalAccounts", "[]"));
      if (Array.isArray(parsed)) accounts = parsed;
    } catch {
      /* use empty default */
    }
    return {
      mcalAccounts: accounts,
      mcalConnected: accounts.length > 0,
    };
  })(),
  gcalPrimaryOnly: readBoolean("gcalPrimaryOnly", true),
  mcalPrimaryOnly: readBoolean("mcalPrimaryOnly", true),
  appleCalendarConnected: readBoolean("appleCalendarConnected", false),
  meetingProcessDetection: readBoolean("meetingProcessDetection", true),
  speakerDiarizationEnabled: readBoolean("speakerDiarizationEnabled", true),
  // Off by default: VAD on pause-heavy recordings can strip the speech and make
  // Whisper hallucinate the dictionary prompt as the transcript (#1454).
  noteRecordingSileroEnabled: readBoolean("noteRecordingSileroEnabled", true),
  meetingSileroEnabled: readBoolean("meetingSileroEnabled", true),
  whisperVadThreshold: clampVadValue("threshold", readString("whisperVadThreshold", "0.5")),
  whisperVadMinSpeechDurationMs: clampVadValue(
    "minSpeechDurationMs",
    readString("whisperVadMinSpeechDurationMs", "250")
  ),
  whisperVadMinSilenceDurationMs: clampVadValue(
    "minSilenceDurationMs",
    readString("whisperVadMinSilenceDurationMs", "200")
  ),
  whisperVadMaxSpeechDurationS: clampVadValue(
    "maxSpeechDurationS",
    readString("whisperVadMaxSpeechDurationS", "30")
  ),
  whisperVadSpeechPadMs: clampVadValue("speechPadMs", readString("whisperVadSpeechPadMs", "100")),
  whisperVadSamplesOverlap: clampVadValue(
    "samplesOverlap",
    readString("whisperVadSamplesOverlap", "0.5")
  ),
  panelStartPosition: (() => {
    const v = readString("panelStartPosition", "bottom-right");
    if (v === "bottom-right" || v === "center" || v === "bottom-left") return v;
    return "bottom-right" as const;
  })(),
  autoPasteEnabled: readBoolean("autoPasteEnabled", true),
  keepTranscriptionInClipboard: readBoolean("keepTranscriptionInClipboard", false),
  noteFilesEnabled: readBoolean("noteFilesEnabled", false),
  noteFilesPath: readString("noteFilesPath", ""),
  isSignedIn: readBoolean("isSignedIn", false),

  transcriptionMode: readTranscriptionMode(
    "transcriptionMode",
    "useLocalWhisper",
    "cloudTranscriptionProvider",
    DEFAULT_CLOUD_TRANSCRIPTION_PROVIDER
  ),
  remoteTranscriptionType: (() => {
    const v = readString("remoteTranscriptionType", "lan");
    return v === "openai-compatible" ? "openai-compatible" : ("lan" as SelfHostedType);
  })(),
  remoteTranscriptionUrl: readString("remoteTranscriptionUrl", ""),
  remoteTranscriptionModel: readString("remoteTranscriptionModel", ""),
  cleanupMode: readReasoningMode("cleanupMode", "cleanupCloudMode", "cleanupProvider"),
  cleanupRemoteUrl: readString("cleanupRemoteUrl", ""),

  meetingTranscriptionMode: readTranscriptionMode(
    "meetingTranscriptionMode",
    "meetingUseLocalWhisper",
    "meetingCloudTranscriptionProvider"
  ),
  meetingUseLocalWhisper: readBoolean("meetingUseLocalWhisper", false),
  meetingWhisperModel: readString("meetingWhisperModel", ""),
  meetingLocalTranscriptionProvider: readLocalProvider("meetingLocalTranscriptionProvider"),
  meetingParakeetModel: readString("meetingParakeetModel", ""),
  meetingCohereModel: readString("meetingCohereModel", ""),
  meetingCloudTranscriptionProvider: readString("meetingCloudTranscriptionProvider", ""),
  meetingCloudTranscriptionModel: readString("meetingCloudTranscriptionModel", ""),
  meetingCloudTranscriptionBaseUrl: readString("meetingCloudTranscriptionBaseUrl", ""),
  meetingCloudTranscriptionMode: readString("meetingCloudTranscriptionMode", ""),
  meetingRemoteTranscriptionType: (() => {
    const v = readString("meetingRemoteTranscriptionType", "lan");
    return v === "openai-compatible" ? "openai-compatible" : ("lan" as SelfHostedType);
  })(),
  meetingRemoteTranscriptionUrl: readString("meetingRemoteTranscriptionUrl", ""),

  uploadTranscriptionMode: readTranscriptionMode(
    "uploadTranscriptionMode",
    "uploadUseLocalWhisper",
    "uploadCloudTranscriptionProvider"
  ),
  uploadUseLocalWhisper: readBoolean("uploadUseLocalWhisper", false),
  uploadWhisperModel: readString("uploadWhisperModel", ""),
  uploadLocalTranscriptionProvider: readLocalProvider("uploadLocalTranscriptionProvider"),
  uploadParakeetModel: readString("uploadParakeetModel", ""),
  uploadCohereModel: readString("uploadCohereModel", ""),
  uploadCloudTranscriptionProvider: readString("uploadCloudTranscriptionProvider", ""),
  uploadCloudTranscriptionModel: readString("uploadCloudTranscriptionModel", ""),
  uploadCloudTranscriptionBaseUrl: readString("uploadCloudTranscriptionBaseUrl", ""),
  uploadCloudTranscriptionMode: readString("uploadCloudTranscriptionMode", ""),

  noteFormattingMode: readReasoningMode(
    "noteFormattingMode",
    "noteFormattingCloudMode",
    "noteFormattingProvider"
  ),
  noteFormattingProvider: readString("noteFormattingProvider", ""),
  noteFormattingModel: readString("noteFormattingModel", ""),
  noteFormattingCloudMode: readDirectCloudMode("noteFormattingCloudMode", ""),
  noteFormattingCloudBaseUrl: readString("noteFormattingCloudBaseUrl", ""),
  noteFormattingRemoteUrl: readString("noteFormattingRemoteUrl", ""),
  noteFormattingCustomApiKey: "",
  noteFormattingBbProvider: readString("noteFormattingBbProvider", ""),
  noteFormattingBbModel: readString("noteFormattingBbModel", ""),
  noteFormattingBbReasoningLevel: readString("noteFormattingBbReasoningLevel", ""),
  bbAgentPreferences: isBrowser ? parseBbAgentPreferences(localStorage.getItem("bbAgentPreferences")) : null,
  setBbAgentPreferences: (preferences: BbAgentPreferences) => {
    if (isBrowser) localStorage.setItem("bbAgentPreferences", JSON.stringify(preferences));
    set({ bbAgentPreferences: preferences });
  },

  setTranscriptionMode: createStringSetter("transcriptionMode") as (mode: InferenceMode) => void,
  setRemoteTranscriptionType: createStringSetter("remoteTranscriptionType") as (
    type: SelfHostedType
  ) => void,
  setRemoteTranscriptionUrl: createStringSetter("remoteTranscriptionUrl"),
  setRemoteTranscriptionModel: createStringSetter("remoteTranscriptionModel"),
  setCleanupMode: createStringSetter("cleanupMode") as (mode: InferenceMode) => void,
  setCleanupRemoteUrl: createStringSetter("cleanupRemoteUrl"),

  setMeetingTranscriptionMode: createStringSetter("meetingTranscriptionMode") as (
    mode: InferenceMode
  ) => void,
  setMeetingUseLocalWhisper: createBooleanSetter("meetingUseLocalWhisper"),
  setMeetingWhisperModel: createStringSetter("meetingWhisperModel"),
  setMeetingLocalTranscriptionProvider: (value: LocalTranscriptionProvider) => {
    if (isBrowser) localStorage.setItem("meetingLocalTranscriptionProvider", value);
    useSettingsStore.setState({ meetingLocalTranscriptionProvider: value });
  },
  setMeetingParakeetModel: createStringSetter("meetingParakeetModel"),
  setMeetingCohereModel: createStringSetter("meetingCohereModel"),
  setMeetingCloudTranscriptionProvider: createStringSetter("meetingCloudTranscriptionProvider"),
  setMeetingCloudTranscriptionModel: createStringSetter("meetingCloudTranscriptionModel"),
  setMeetingCloudTranscriptionBaseUrl: createStringSetter("meetingCloudTranscriptionBaseUrl"),
  setMeetingCloudTranscriptionMode: createStringSetter("meetingCloudTranscriptionMode"),
  setMeetingRemoteTranscriptionType: createStringSetter("meetingRemoteTranscriptionType") as (
    type: SelfHostedType
  ) => void,
  setMeetingRemoteTranscriptionUrl: createStringSetter("meetingRemoteTranscriptionUrl"),

  setUploadTranscriptionMode: createStringSetter("uploadTranscriptionMode") as (
    mode: InferenceMode
  ) => void,
  setUploadUseLocalWhisper: createBooleanSetter("uploadUseLocalWhisper"),
  setUploadWhisperModel: createStringSetter("uploadWhisperModel"),
  setUploadLocalTranscriptionProvider: (value: LocalTranscriptionProvider) => {
    if (isBrowser) localStorage.setItem("uploadLocalTranscriptionProvider", value);
    useSettingsStore.setState({ uploadLocalTranscriptionProvider: value });
  },
  setUploadParakeetModel: createStringSetter("uploadParakeetModel"),
  setUploadCohereModel: createStringSetter("uploadCohereModel"),
  setUploadCloudTranscriptionProvider: createStringSetter("uploadCloudTranscriptionProvider"),
  setUploadCloudTranscriptionModel: createStringSetter("uploadCloudTranscriptionModel"),
  setUploadCloudTranscriptionBaseUrl: createStringSetter("uploadCloudTranscriptionBaseUrl"),
  setUploadCloudTranscriptionMode: createStringSetter("uploadCloudTranscriptionMode"),

  setNoteFormattingMode: createStringSetter("noteFormattingMode") as (mode: InferenceMode) => void,
  setNoteFormattingProvider: createStringSetter("noteFormattingProvider"),
  setNoteFormattingModel: createStringSetter("noteFormattingModel"),
  setNoteFormattingCloudMode: createStringSetter("noteFormattingCloudMode"),
  setNoteFormattingCloudBaseUrl: createStringSetter("noteFormattingCloudBaseUrl"),
  setNoteFormattingRemoteUrl: createStringSetter("noteFormattingRemoteUrl"),
  setNoteFormattingCustomApiKey: createSecretSetter(
    "noteFormattingCustomApiKey",
    "noteFormattingCustom",
    "custom"
  ),

  chatAgentModel: readString("chatAgentModel", "openai/gpt-oss-120b"),
  chatAgentProvider: readString("chatAgentProvider", "groq"),
  chatAgentCloudMode: readDirectCloudMode("chatAgentCloudMode"),
  chatAgentMode: readReasoningMode("chatAgentMode", "chatAgentCloudMode", "chatAgentProvider"),
  chatAgentRemoteUrl: readString("chatAgentRemoteUrl", ""),
  chatAgentCloudBaseUrl: readString("chatAgentCloudBaseUrl", ""),
  chatAgentCustomApiKey: "",
  chatAgentBbProvider: readString("chatAgentBbProvider", ""),
  chatAgentBbModel: readString("chatAgentBbModel", ""),
  chatAgentBbReasoningLevel: readString("chatAgentBbReasoningLevel", ""),

  cleanupDisableThinking: readBoolean("cleanupDisableThinking", true),
  noteFormattingDisableThinking: readBoolean("noteFormattingDisableThinking", true),
  chatAgentDisableThinking: readBoolean("chatAgentDisableThinking", true),

  customPrompts: PROMPT_KIND_LIST.reduce(
    (acc, kind) => ({ ...acc, [kind]: readString(`customPrompt.${kind}`, "") }),
    {} as Record<PromptKind, string>
  ),
  setCustomPrompt: (kind, value) => {
    if (isBrowser) localStorage.setItem(`customPrompt.${kind}`, value);
    useSettingsStore.setState((s) => ({
      customPrompts: { ...s.customPrompts, [kind]: value },
    }));
  },

  setCleanupDisableThinking: createBooleanSetter("cleanupDisableThinking"),
  setNoteFormattingDisableThinking: createBooleanSetter("noteFormattingDisableThinking"),
  setChatAgentDisableThinking: createBooleanSetter("chatAgentDisableThinking"),

  setUseLocalWhisper: createBooleanSetter("useLocalWhisper"),
  setWhisperModel: createStringSetter("whisperModel"),
  setLocalTranscriptionProvider: (value: LocalTranscriptionProvider) => {
    if (isBrowser) localStorage.setItem("localTranscriptionProvider", value);
    set({ localTranscriptionProvider: value });
  },
  setParakeetModel: createStringSetter("parakeetModel"),
  setCohereModel: createStringSetter("cohereModel"),
  setAllowOpenAIFallback: createBooleanSetter("allowOpenAIFallback"),
  setAllowLocalFallback: createBooleanSetter("allowLocalFallback"),
  setFallbackWhisperModel: createStringSetter("fallbackWhisperModel"),
  setPreferredLanguage: createStringSetter("preferredLanguage"),
  setChineseScriptPreference: (value: ChineseScriptPreference) =>
    createStringSetter("chineseScriptPreference")(normalizeChineseScriptPreference(value)),
  setCloudTranscriptionProvider: createStringSetter("cloudTranscriptionProvider"),
  setCloudTranscriptionModel: createStringSetter("cloudTranscriptionModel"),
  setCloudTranscriptionBaseUrl: createStringSetter("cloudTranscriptionBaseUrl"),

  // Every provider shares one model slot per scope, so a plain provider write
  // destroys the outgoing provider's model (the "Parasail" wipe). This setter
  // remembers the outgoing model and restores the incoming provider's last one.
  switchCloudTranscriptionProvider: (context, providerId) => {
    const s = useSettingsStore.getState();
    const keys = TRANSCRIPTION_CONTEXT_KEYS.find((entry) => entry.context === context);
    if (!keys) return;
    // Meeting/upload raw keys default to "" (inherit from transcription), so work
    // against resolved values. Restoring writes a concrete model — the scope
    // stops inheriting the transcription model from that point on.
    const outgoingProvider = (s[keys.provider] as string) || s.cloudTranscriptionProvider;
    if (outgoingProvider === providerId) {
      setStringSetting(keys.provider, providerId);
      return;
    }
    const outgoingModel = (s[keys.model] as string) || s.cloudTranscriptionModel;
    const memory = { ...s.transcriptionModelByProvider };
    if (outgoingProvider && outgoingModel) {
      memory[`${context}:${outgoingProvider}`] = outgoingModel;
      persistTranscriptionModelMemory(memory);
    }
    const remembered = memory[`${context}:${providerId}`];
    setStringSetting(keys.provider, providerId);
    setStringSetting(
      keys.model,
      remembered && transcriptionModelBelongsToProvider(providerId, remembered, context)
        ? remembered
        : defaultTranscriptionModel(providerId, context)
    );
  },

  // LLM twin of switchCloudTranscriptionProvider. The caller supplies the
  // provider's default model because dynamic catalogs (Tinfoil) live in the UI.
  switchReasoningProvider: (scope, providerId, fallbackModel = "") => {
    const s = useSettingsStore.getState();
    const cfg = selectResolvedLLMConfig(s, scope);
    const memory = { ...s.reasoningModelByProvider };
    // Only remember a model the outgoing provider actually owns — after a
    // local/cloud mode round-trip the shared slot can hold a foreign id.
    if (cfg.provider && cfg.provider !== providerId) {
      if (reasoningModelBelongsToProvider(cfg.provider, cfg.model)) {
        memory[`${scope}:${cfg.provider}`] = cfg.model;
        persistReasoningModelMemory(memory);
      }
    } else if (reasoningModelBelongsToProvider(providerId, cfg.model)) {
      // Reselecting the current provider with a model it owns: keep it.
      setResolvedLLMConfig(scope, { provider: providerId });
      return;
    }
    const remembered = memory[`${scope}:${providerId}`];
    setResolvedLLMConfig(scope, {
      provider: providerId,
      model:
        remembered && reasoningModelBelongsToProvider(providerId, remembered)
          ? remembered
          : fallbackModel,
    });
  },
  setCloudTranscriptionMode: createStringSetter("cloudTranscriptionMode"),
  setCleanupCloudMode: createStringSetter("cleanupCloudMode"),
  setCleanupCloudBaseUrl: createStringSetter("cleanupCloudBaseUrl"),
  setAssemblyAiStreaming: createBooleanSetter("assemblyAiStreaming"),
  setAutoGenerateNoteTitle: createBooleanSetter("autoGenerateNoteTitle"),
  setUseCleanupModel: createBooleanSetter("useCleanupModel"),
  setCleanupProvider: createStringSetter("cleanupProvider"),
  setCleanupModel: createStringSetter("cleanupModel"),

  // Replaces the whole dictionary: anything absent from `words` is deleted.
  // Editing specific words wants updateCustomDictionary instead (#1295).
  setCustomDictionary: (words: string[]) => {
    if (isBrowser) localStorage.setItem("customDictionary", JSON.stringify(words));
    set({ customDictionary: words });
    window.electronAPI?.setDictionary(words)
      .catch((err) => {
        logger.warn(
          "Failed to sync dictionary to SQLite",
          { error: (err as Error).message },
          "settings"
        );
      });
  },

  updateCustomDictionary: ({ add = [], remove = [] }) => {
    const removeLower = new Set(remove.map((w) => w.toLowerCase()));
    const addLower = new Set(add.map((w) => w.toLowerCase()));
    // Optimistic so the UI updates immediately; the stored list replaces it below.
    const optimistic = [
      ...get().customDictionary.filter((w) => {
        const lower = w.toLowerCase();
        return !removeLower.has(lower) && !addLower.has(lower);
      }),
      ...add,
    ];
    if (isBrowser) localStorage.setItem("customDictionary", JSON.stringify(optimistic));
    set({ customDictionary: optimistic });

    const api = window.electronAPI;
    if (!api) return;
    const written = api.applyDictionaryChanges({ add, remove });

    written
      .then(async () => {
        // SQLite owns ordering, casing and dedupe — adopt what it stored.
        const stored = await api.getDictionary?.();
        if (stored) {
          if (isBrowser) localStorage.setItem("customDictionary", JSON.stringify(stored));
          set({ customDictionary: stored });
        }
      })
      .catch((err) => {
        logger.warn(
          "Failed to apply dictionary changes to SQLite",
          { error: (err as Error).message },
          "settings"
        );
      });
  },

  // For broadcasts from main process — DB is already authoritative, only update UI.
  applyCustomDictionaryFromExternal: (words: string[]) => {
    if (isBrowser) localStorage.setItem("customDictionary", JSON.stringify(words));
    set({ customDictionary: words });
  },

  setSnippets: (snippets: Snippet[]) => {
    if (isBrowser) localStorage.setItem("snippets", JSON.stringify(snippets));
    set({ snippets });
    window.electronAPI?.setSnippets?.(snippets)
      .catch((err) => {
        logger.warn(
          "Failed to sync snippets to SQLite",
          { error: (err as Error).message },
          "settings"
        );
      });
  },

  // For broadcasts from main process — DB is already authoritative, only update UI.
  applySnippetsFromExternal: (snippets: Snippet[]) => {
    if (isBrowser) localStorage.setItem("snippets", JSON.stringify(snippets));
    set({ snippets });
  },

  setUiLanguage: (language: string) => {
    const normalized = normalizeUiLanguage(language);
    if (isBrowser) localStorage.setItem("uiLanguage", normalized);
    set({ uiLanguage: normalized });
    void i18n.changeLanguage(normalized);
    if (isBrowser && window.electronAPI?.setUiLanguage) {
      window.electronAPI.setUiLanguage(normalized).catch((err) => {
        logger.warn(
          "Failed to sync UI language to main process",
          { error: (err as Error).message },
          "settings"
        );
      });
    }
  },

  setOpenaiApiKey: createSecretSetter("openaiApiKey", "openai", "openai"),
  setAnthropicApiKey: createSecretSetter("anthropicApiKey", "anthropic", "anthropic"),
  setGeminiApiKey: createSecretSetter("geminiApiKey", "gemini", "gemini"),
  setGroqApiKey: createSecretSetter("groqApiKey", "groq", "groq"),
  setXaiApiKey: createSecretSetter("xaiApiKey", "xai"),
  setMistralApiKey: createSecretSetter("mistralApiKey", "mistral", "mistral"),
  setOpenrouterApiKey: createSecretSetter("openrouterApiKey", "openrouter", "openrouter"),
  setCortiClientId: createSecretSetter("cortiClientId", "cortiClientId", "corti"),
  setCortiClientSecret: createSecretSetter("cortiClientSecret", "cortiClientSecret", "corti"),
  setCortiApiKey: createSecretSetter("cortiApiKey", "cortiApiKey", "corti"),
  setCortiEnvironment: createStringSetter("cortiEnvironment"),
  setCortiTenant: createStringSetter("cortiTenant"),
  setTinfoilApiKey: createSecretSetter("tinfoilApiKey", "tinfoil", "tinfoil"),
  // STT-only, so there is no ReasoningService key cache to invalidate.
  setDeepgramApiKey: createSecretSetter("deepgramApiKey", "deepgram"),
  setElevenLabsApiKey: createSecretSetter("elevenLabsApiKey", "elevenlabs"),
  setAssemblyaiApiKey: createSecretSetter("assemblyaiApiKey", "assemblyai"),
  setCustomTranscriptionApiKey: createSecretSetter(
    "customTranscriptionApiKey",
    "customTranscription",
    "custom"
  ),
  setCleanupCustomApiKey: createSecretSetter("cleanupCustomApiKey", "cleanupCustom", "custom"),

  // Enterprise provider setters
  setEnterpriseSetupMode: createStringSetter("enterpriseSetupMode") as (
    value: EnterpriseSetupMode
  ) => void,
  setEnterpriseTranscriptionSetupMode: createStringSetter("enterpriseTranscriptionSetupMode") as (
    value: EnterpriseSetupMode
  ) => void,
  setBedrockAuthMode: (value: string) => {
    if (isBrowser) localStorage.setItem("bedrockAuthMode", value);
    set({ bedrockAuthMode: value });
  },
  setBedrockRegion: (value: string) => {
    if (isBrowser) localStorage.setItem("bedrockRegion", value);
    set({ bedrockRegion: value });
    window.electronAPI?.saveBedrockRegion?.(value);
    debouncedPersistToEnv();
  },
  setBedrockProfile: (value: string) => {
    if (isBrowser) localStorage.setItem("bedrockProfile", value);
    set({ bedrockProfile: value });
    window.electronAPI?.saveBedrockProfile?.(value);
    debouncedPersistToEnv();
  },
  setBedrockAccessKeyId: createSecretSetter("bedrockAccessKeyId", "bedrockAccessKeyId"),
  setBedrockSecretAccessKey: createSecretSetter(
    "bedrockSecretAccessKey",
    "bedrockSecretAccessKey"
  ),
  setBedrockSessionToken: createSecretSetter("bedrockSessionToken", "bedrockSessionToken"),
  setAzureEndpoint: (value: string) => {
    if (isBrowser) localStorage.setItem("azureEndpoint", value);
    set({ azureEndpoint: value });
    window.electronAPI?.saveAzureEndpoint?.(value);
    debouncedPersistToEnv();
  },
  setAzureApiKey: createSecretSetter("azureApiKey", "azureApiKey"),
  setAzureDeploymentName: (value: string) => {
    if (isBrowser) localStorage.setItem("azureDeploymentName", value);
    set({ azureDeploymentName: value });
    window.electronAPI?.saveAzureDeployment?.(value);
    debouncedPersistToEnv();
  },
  setAzureApiVersion: (value: string) => {
    if (isBrowser) localStorage.setItem("azureApiVersion", value);
    set({ azureApiVersion: value });
    window.electronAPI?.saveAzureApiVersion?.(value);
    debouncedPersistToEnv();
  },
  setVertexAuthMode: (value: string) => {
    if (isBrowser) localStorage.setItem("vertexAuthMode", value);
    set({ vertexAuthMode: value });
  },
  setVertexProject: (value: string) => {
    if (isBrowser) localStorage.setItem("vertexProject", value);
    set({ vertexProject: value });
    window.electronAPI?.saveVertexProject?.(value);
    debouncedPersistToEnv();
  },
  setVertexLocation: (value: string) => {
    if (isBrowser) localStorage.setItem("vertexLocation", value);
    set({ vertexLocation: value });
    window.electronAPI?.saveVertexLocation?.(value);
    debouncedPersistToEnv();
  },
  setVertexApiKey: createSecretSetter("vertexApiKey", "vertexApiKey"),

  setMeetingKey: (key: string) => {
    if (isBrowser) localStorage.setItem("meetingKey", key);
    set({ meetingKey: key });
  },
  setMeetingHotkeyLayoutMode: (mode: "side-panel" | "full-width") => {
    if (isBrowser) localStorage.setItem("meetingHotkeyLayoutMode", mode);
    set({ meetingHotkeyLayoutMode: mode });
  },

  setOnboardingUseCases: (useCases: string[]) => {
    if (isBrowser) localStorage.setItem("onboardingUseCases", JSON.stringify(useCases));
    set({ onboardingUseCases: useCases });
  },

  setOnboardingUseCaseNote: createStringSetter("onboardingUseCaseNote"),

  setSpokenLanguages: (languages: string[]) => {
    if (isBrowser) localStorage.setItem("spokenLanguages", JSON.stringify(languages));
    set({ spokenLanguages: languages });
  },

  setPreferBuiltInMic: (value: boolean) => {
    const mode: MicrophoneSelectionMode = value ? "built-in" : "system";
    if (isBrowser) {
      localStorage.setItem("preferBuiltInMic", String(value));
      localStorage.setItem("microphoneSelectionMode", mode);
    }
    set({ preferBuiltInMic: value, microphoneSelectionMode: mode });
  },
  setMicrophoneSelectionMode: (mode: MicrophoneSelectionMode) => {
    const normalized: MicrophoneSelectionMode =
      mode === "built-in" || mode === "specific" ? mode : "system";
    const preferBuiltInMic = normalized === "built-in";
    if (isBrowser) {
      localStorage.setItem("microphoneSelectionMode", normalized);
      localStorage.setItem("preferBuiltInMic", String(preferBuiltInMic));
    }
    set({ microphoneSelectionMode: normalized, preferBuiltInMic });
  },
  setSelectedMicDevice: (deviceId: string, label: string) => {
    if (isBrowser) {
      localStorage.setItem("selectedMicDeviceLabel", label);
      localStorage.setItem("selectedMicDeviceId", deviceId);
    }
    set({ selectedMicDeviceId: deviceId, selectedMicDeviceLabel: label });
  },

  setTheme: (value: "light" | "dark" | "auto") => {
    if (isBrowser) localStorage.setItem("theme", value);
    set({ theme: value });
  },
  setColorScheme: (value: ColorSchemeId) => {
    const scheme = normalizeColorScheme(value);
    if (isBrowser) localStorage.setItem("colorScheme", scheme);
    set({ colorScheme: scheme });
  },

  setTelemetryEnabled: createBooleanSetter("telemetryEnabled"),
  setMicWarmHoldSeconds: (value: number) => {
    const snapped = snapMicWarmHold(value);
    if (isBrowser) localStorage.setItem("micWarmHoldSeconds", String(snapped));
    set({ micWarmHoldSeconds: snapped });
  },
  setAudioRetentionDays: createNumberSetter("audioRetentionDays"),
  setTranscriptRetentionDays: createNumberSetter("transcriptRetentionDays"),
  setDataRetentionEnabled: (value: boolean) => {
    if (isBrowser) localStorage.setItem("dataRetentionEnabled", String(value));
    set({ dataRetentionEnabled: value });
    logger.info(
      value
        ? "Data retention enabled — transcriptions and audio will be saved"
        : "Data retention disabled — transcriptions and audio will not be saved",
      {},
      "settings"
    );
  },
  setSaveDiscardedTranscriptions: createBooleanSetter("saveDiscardedTranscriptions"),
  setAudioCuesEnabled: createBooleanSetter("audioCuesEnabled"),

  setFloatingIconAutoHide: (enabled: boolean) => {
    if (get().floatingIconAutoHide === enabled) return;
    if (isBrowser) localStorage.setItem("floatingIconAutoHide", String(enabled));
    set({ floatingIconAutoHide: enabled });
    if (isBrowser) {
      window.electronAPI?.notifyFloatingIconAutoHideChanged?.(enabled);
    }
  },

  setStartMinimized: (enabled: boolean) => {
    if (get().startMinimized === enabled) return;
    if (isBrowser) localStorage.setItem("startMinimized", String(enabled));
    set({ startMinimized: enabled });
    if (isBrowser) {
      window.electronAPI?.notifyStartMinimizedChanged?.(enabled);
    }
  },

  setGcalAccounts: (accounts: CalendarAccount[]) => {
    if (isBrowser) localStorage.setItem("gcalAccounts", JSON.stringify(accounts));
    useSettingsStore.setState({
      gcalAccounts: accounts,
      gcalConnected: accounts.length > 0,
      gcalEmail: accounts[0]?.email ?? "",
    });
  },
  setMcalAccounts: (accounts: CalendarAccount[]) => {
    if (isBrowser) localStorage.setItem("mcalAccounts", JSON.stringify(accounts));
    useSettingsStore.setState({
      mcalAccounts: accounts,
      mcalConnected: accounts.length > 0,
    });
  },
  setNotificationsEnabled: createBooleanSetter("notificationsEnabled"),
  setNotifyMeetingDetection: createBooleanSetter("notifyMeetingDetection"),
  setNotifyCalendarReminders: createBooleanSetter("notifyCalendarReminders"),
  setMeetingCompanionEnabled: createBooleanSetter("meetingCompanionEnabled"),
  setGcalPrimaryOnly: (value: boolean) => {
    if (isBrowser) localStorage.setItem("gcalPrimaryOnly", String(value));
    useSettingsStore.setState({ gcalPrimaryOnly: value });
    if (isBrowser) window.electronAPI?.gcalSetPrimaryOnly?.(value);
  },
  setMcalPrimaryOnly: (value: boolean) => {
    if (isBrowser) localStorage.setItem("mcalPrimaryOnly", String(value));
    useSettingsStore.setState({ mcalPrimaryOnly: value });
    if (isBrowser) window.electronAPI?.mcalSetPrimaryOnly?.(value);
  },
  setAppleCalendarConnected: createBooleanSetter("appleCalendarConnected"),
  setMeetingProcessDetection: createBooleanSetter("meetingProcessDetection"),
  setSpeakerDiarizationEnabled: (value: boolean) => {
    if (isBrowser) localStorage.setItem("speakerDiarizationEnabled", String(value));
    useSettingsStore.setState({ speakerDiarizationEnabled: value });
    if (isBrowser) {
      window.electronAPI?.setSpeakerDiarizationEnabled?.(value);
    }
  },
  setNoteRecordingSileroEnabled: (value: boolean) => {
    if (isBrowser) localStorage.setItem("noteRecordingSileroEnabled", String(value));
    useSettingsStore.setState({ noteRecordingSileroEnabled: value });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ noteRecordingSileroEnabled: value });
    }
  },
  setMeetingSileroEnabled: (value: boolean) => {
    if (isBrowser) localStorage.setItem("meetingSileroEnabled", String(value));
    useSettingsStore.setState({ meetingSileroEnabled: value });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ meetingSileroEnabled: value });
    }
  },
  setWhisperVadThreshold: (value: number) => {
    const next = clampVadValue("threshold", value);
    if (isBrowser) localStorage.setItem("whisperVadThreshold", String(next));
    useSettingsStore.setState({ whisperVadThreshold: next });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ threshold: next });
    }
  },
  setWhisperVadMinSpeechDurationMs: (value: number) => {
    const next = clampVadValue("minSpeechDurationMs", value);
    if (isBrowser) localStorage.setItem("whisperVadMinSpeechDurationMs", String(next));
    useSettingsStore.setState({ whisperVadMinSpeechDurationMs: next });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ minSpeechDurationMs: next });
    }
  },
  setWhisperVadMinSilenceDurationMs: (value: number) => {
    const next = clampVadValue("minSilenceDurationMs", value);
    if (isBrowser) localStorage.setItem("whisperVadMinSilenceDurationMs", String(next));
    useSettingsStore.setState({ whisperVadMinSilenceDurationMs: next });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ minSilenceDurationMs: next });
    }
  },
  setWhisperVadMaxSpeechDurationS: (value: number) => {
    const next = clampVadValue("maxSpeechDurationS", value);
    if (isBrowser) localStorage.setItem("whisperVadMaxSpeechDurationS", String(next));
    useSettingsStore.setState({ whisperVadMaxSpeechDurationS: next });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ maxSpeechDurationS: next });
    }
  },
  setWhisperVadSpeechPadMs: (value: number) => {
    const next = clampVadValue("speechPadMs", value);
    if (isBrowser) localStorage.setItem("whisperVadSpeechPadMs", String(next));
    useSettingsStore.setState({ whisperVadSpeechPadMs: next });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ speechPadMs: next });
    }
  },
  setWhisperVadSamplesOverlap: (value: number) => {
    const next = clampVadValue("samplesOverlap", value);
    if (isBrowser) localStorage.setItem("whisperVadSamplesOverlap", String(next));
    useSettingsStore.setState({ whisperVadSamplesOverlap: next });
    if (isBrowser) {
      window.electronAPI?.setWhisperVadConfig?.({ samplesOverlap: next });
    }
  },
  setPanelStartPosition: (position: "bottom-right" | "center" | "bottom-left") => {
    if (get().panelStartPosition === position) return;
    if (isBrowser) localStorage.setItem("panelStartPosition", position);
    set({ panelStartPosition: position });
    if (isBrowser) {
      window.electronAPI?.notifyPanelStartPositionChanged?.(position);
    }
  },

  setAutoPasteEnabled: createBooleanSetter("autoPasteEnabled"),
  setKeepTranscriptionInClipboard: createBooleanSetter("keepTranscriptionInClipboard"),
  setNoteFilesEnabled: createBooleanSetter("noteFilesEnabled"),
  setNoteFilesPath: createStringSetter("noteFilesPath"),

  setIsSignedIn: (value: boolean) => {
    if (isBrowser) localStorage.setItem("isSignedIn", String(value));
    set({ isSignedIn: value });
  },

  setChatAgentModel: createStringSetter("chatAgentModel"),
  setChatAgentProvider: createStringSetter("chatAgentProvider"),
  setChatAgentCloudMode: createStringSetter("chatAgentCloudMode"),
  setChatAgentMode: createStringSetter("chatAgentMode") as (mode: InferenceMode) => void,
  setChatAgentCloudBaseUrl: createStringSetter("chatAgentCloudBaseUrl"),
  setChatAgentRemoteUrl: createStringSetter("chatAgentRemoteUrl"),
  setChatAgentCustomApiKey: createSecretSetter(
    "chatAgentCustomApiKey",
    "chatAgentCustom",
    "custom"
  ),

  updateTranscriptionSettings: (settings: Partial<TranscriptionSettings>) => {
    const s = useSettingsStore.getState();
    if (settings.useLocalWhisper !== undefined) s.setUseLocalWhisper(settings.useLocalWhisper);
    if (settings.uiLanguage !== undefined) s.setUiLanguage(settings.uiLanguage);
    if (settings.whisperModel !== undefined) s.setWhisperModel(settings.whisperModel);
    if (settings.localTranscriptionProvider !== undefined)
      s.setLocalTranscriptionProvider(settings.localTranscriptionProvider);
    if (settings.parakeetModel !== undefined) s.setParakeetModel(settings.parakeetModel);
    if (settings.cohereModel !== undefined) s.setCohereModel(settings.cohereModel);
    if (settings.allowOpenAIFallback !== undefined)
      s.setAllowOpenAIFallback(settings.allowOpenAIFallback);
    if (settings.allowLocalFallback !== undefined)
      s.setAllowLocalFallback(settings.allowLocalFallback);
    if (settings.fallbackWhisperModel !== undefined)
      s.setFallbackWhisperModel(settings.fallbackWhisperModel);
    if (settings.preferredLanguage !== undefined)
      s.setPreferredLanguage(settings.preferredLanguage);
    if (settings.chineseScriptPreference !== undefined)
      s.setChineseScriptPreference(settings.chineseScriptPreference);
    if (settings.cloudTranscriptionProvider !== undefined)
      s.setCloudTranscriptionProvider(settings.cloudTranscriptionProvider);
    if (settings.cloudTranscriptionModel !== undefined)
      s.setCloudTranscriptionModel(settings.cloudTranscriptionModel);
    if (settings.cloudTranscriptionBaseUrl !== undefined)
      s.setCloudTranscriptionBaseUrl(settings.cloudTranscriptionBaseUrl);
    if (settings.cloudTranscriptionMode !== undefined)
      s.setCloudTranscriptionMode(settings.cloudTranscriptionMode);
    if (settings.customDictionary !== undefined) s.setCustomDictionary(settings.customDictionary);
    if (settings.snippets !== undefined) s.setSnippets(settings.snippets);
    if (settings.assemblyAiStreaming !== undefined)
      s.setAssemblyAiStreaming(settings.assemblyAiStreaming);
  },

  // Apply a transcription config, then mirror its provider routing to
  // note recording and audio upload — used when onboarding picks one provider
  // for everything (e.g. Corti for medical providers).
  setCloudTranscriptionForAllScopes: (settings: Partial<TranscriptionSettings>) => {
    const s = useSettingsStore.getState();
    s.updateTranscriptionSettings(settings);
    const {
      useLocalWhisper,
      cloudTranscriptionMode,
      cloudTranscriptionProvider,
      cloudTranscriptionModel,
    } = useSettingsStore.getState();
    // Each Settings tab selects on its InferenceMode field, so set it for every
    // scope — otherwise the UI keeps showing the previous mode even though the
    // routing now points at the new provider.
    const mode = deriveTranscriptionMode(
      useLocalWhisper,
      cloudTranscriptionProvider
    );
    s.setTranscriptionMode(mode);
    s.setMeetingTranscriptionMode(mode);
    s.setUploadTranscriptionMode(mode);
    s.setMeetingUseLocalWhisper(useLocalWhisper);
    s.setMeetingCloudTranscriptionMode(cloudTranscriptionMode);
    s.setMeetingCloudTranscriptionProvider(cloudTranscriptionProvider);
    s.setMeetingCloudTranscriptionModel(cloudTranscriptionModel);
    s.setUploadUseLocalWhisper(useLocalWhisper);
    s.setUploadCloudTranscriptionMode(cloudTranscriptionMode);
    s.setUploadCloudTranscriptionProvider(cloudTranscriptionProvider);
    s.setUploadCloudTranscriptionModel(cloudTranscriptionModel);
    // Seed the per-provider model memory so a later provider switch-and-return
    // in any scope restores the model onboarding chose.
    if (cloudTranscriptionProvider && cloudTranscriptionModel) {
      const memory = { ...useSettingsStore.getState().transcriptionModelByProvider };
      for (const { context } of TRANSCRIPTION_CONTEXT_KEYS) {
        memory[`${context}:${cloudTranscriptionProvider}`] = cloudTranscriptionModel;
      }
      persistTranscriptionModelMemory(memory);
    }
  },

  updateCleanupSettings: (settings: Partial<CleanupSettings>) => {
    const s = useSettingsStore.getState();
    if (settings.useCleanupModel !== undefined) s.setUseCleanupModel(settings.useCleanupModel);
    if (settings.cleanupModel !== undefined) s.setCleanupModel(settings.cleanupModel);
    if (settings.cleanupProvider !== undefined) s.setCleanupProvider(settings.cleanupProvider);
    if (settings.cleanupCloudBaseUrl !== undefined)
      s.setCleanupCloudBaseUrl(settings.cleanupCloudBaseUrl);
    if (settings.cleanupCloudMode !== undefined) s.setCleanupCloudMode(settings.cleanupCloudMode);
    if (settings.cleanupRemoteUrl !== undefined) s.setCleanupRemoteUrl(settings.cleanupRemoteUrl);
  },

  // Apply a cleanup config to the other LLM scopes for a consistent local setup.
  setCloudReasoningForAllScopes: (settings) => {
    const s = useSettingsStore.getState();
    // Local and enterprise modes are inference modes, not cloud routing values.
    const requestedCloudMode = settings.cleanupCloudMode ?? s.cleanupCloudMode;
    const isDirectMode = requestedCloudMode === "local" || requestedCloudMode === "enterprise";
    // Derive the mode from the incoming patch (falling back to current state) so
    // the helper patches are the single source of truth for every scope's mode.
    const mode = isDirectMode
      ? requestedCloudMode
      : deriveLegacyReasoningMode(requestedCloudMode, settings.cleanupProvider ?? s.cleanupProvider);
    const { cleanup, ...mirrored } = buildReasoningScopePatches(
      isDirectMode
        ? { ...settings, cleanupCloudMode: undefined }
        : { ...settings, cleanupCloudMode: "byok" },
      mode
    );
    s.updateCleanupSettings(cleanup);
    s.setCleanupMode(cleanup.cleanupMode);
    if (cleanup.cleanupCustomApiKey !== undefined) {
      s.setCleanupCustomApiKey(cleanup.cleanupCustomApiKey);
    }
    // Each Settings tab selects on its own mode field, so every scope gets the
    // mode even when the routing fields are absent — otherwise the tab keeps
    // showing the previous provider despite the new cloud routing.
    setResolvedLLMConfig("noteFormatting", mirrored.noteFormatting);
    setResolvedLLMConfig("chatIntelligence", mirrored.chatIntelligence);
  },

  updateApiKeys: (keys: Partial<ApiKeySettings>) => {
    const s = useSettingsStore.getState();
    if (keys.openaiApiKey !== undefined) s.setOpenaiApiKey(keys.openaiApiKey);
    if (keys.anthropicApiKey !== undefined) s.setAnthropicApiKey(keys.anthropicApiKey);
    if (keys.geminiApiKey !== undefined) s.setGeminiApiKey(keys.geminiApiKey);
    if (keys.groqApiKey !== undefined) s.setGroqApiKey(keys.groqApiKey);
    if (keys.xaiApiKey !== undefined) s.setXaiApiKey(keys.xaiApiKey);
    if (keys.mistralApiKey !== undefined) s.setMistralApiKey(keys.mistralApiKey);
    if (keys.openrouterApiKey !== undefined) s.setOpenrouterApiKey(keys.openrouterApiKey);
    if (keys.cortiClientId !== undefined) s.setCortiClientId(keys.cortiClientId);
    if (keys.cortiClientSecret !== undefined) s.setCortiClientSecret(keys.cortiClientSecret);
    if (keys.cortiApiKey !== undefined) s.setCortiApiKey(keys.cortiApiKey);
    if (keys.tinfoilApiKey !== undefined) s.setTinfoilApiKey(keys.tinfoilApiKey);
    if (keys.deepgramApiKey !== undefined) s.setDeepgramApiKey(keys.deepgramApiKey);
    if (keys.elevenLabsApiKey !== undefined) s.setElevenLabsApiKey(keys.elevenLabsApiKey);
    if (keys.assemblyaiApiKey !== undefined) s.setAssemblyaiApiKey(keys.assemblyaiApiKey);
    if (keys.customTranscriptionApiKey !== undefined)
      s.setCustomTranscriptionApiKey(keys.customTranscriptionApiKey);
    if (keys.cleanupCustomApiKey !== undefined) s.setCleanupCustomApiKey(keys.cleanupCustomApiKey);
  },

  updateChatAgentSettings: (settings: Partial<ChatAgentSettings>) => {
    const s = useSettingsStore.getState();
    if (settings.chatAgentModel !== undefined) s.setChatAgentModel(settings.chatAgentModel);
    if (settings.chatAgentProvider !== undefined)
      s.setChatAgentProvider(settings.chatAgentProvider);
    if (settings.chatAgentCloudMode !== undefined)
      s.setChatAgentCloudMode(settings.chatAgentCloudMode);
  },
}));

// Scope custom keys are secrets kept in the OS secure store, not localStorage
// (which is stripped on startup). Writes must go through their dedicated
// setters so the values survive restarts.
const SECRET_SCOPE_KEY_SETTERS = {
  cleanupCustomApiKey: "setCleanupCustomApiKey",
  noteFormattingCustomApiKey: "setNoteFormattingCustomApiKey",
  chatAgentCustomApiKey: "setChatAgentCustomApiKey",
} as const;

export function setResolvedLLMConfig(
  scope: InferenceScope,
  patch: Partial<Omit<ResolvedLLMConfig, "scope">>
): Promise<SecretSaveResult> | undefined {
  const def: InferenceScopeDefinition = INFERENCE_SCOPES[scope];
  const updates: Partial<SettingsState> = {};
  let secretWrite: Promise<SecretSaveResult> | undefined;
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const storeKey = def.storeKeys[field as keyof InferenceScopeStoreKeys];
    if (!storeKey) continue;
    const secretSetter =
      SECRET_SCOPE_KEY_SETTERS[storeKey as keyof typeof SECRET_SCOPE_KEY_SETTERS];
    if (secretSetter) {
      const result = useSettingsStore.getState()[secretSetter](value as string);
      if (result) secretWrite = result;
      continue;
    }
    if (isBrowser) {
      localStorage.setItem(
        storeKey as string,
        typeof value === "boolean" ? String(value) : (value as string)
      );
    }
    (updates as Record<string, unknown>)[storeKey as string] = value;
  }
  if (Object.keys(updates).length > 0) useSettingsStore.setState(updates);
  return secretWrite;
}

// --- Convenience getters for non-React code ---

interface TranscriptionContextKeys {
  context: TranscriptionContext;
  mode: keyof SettingsState;
  useLocal: keyof SettingsState;
  cloudMode: keyof SettingsState;
  provider: keyof SettingsState;
  model: keyof SettingsState;
  baseUrl: keyof SettingsState;
}

const TRANSCRIPTION_CONTEXT_KEYS: readonly TranscriptionContextKeys[] = [
  {
    context: "dictation",
    mode: "transcriptionMode",
    useLocal: "useLocalWhisper",
    cloudMode: "cloudTranscriptionMode",
    provider: "cloudTranscriptionProvider",
    model: "cloudTranscriptionModel",
    baseUrl: "cloudTranscriptionBaseUrl",
  },
  {
    context: "meeting",
    mode: "meetingTranscriptionMode",
    useLocal: "meetingUseLocalWhisper",
    cloudMode: "meetingCloudTranscriptionMode",
    provider: "meetingCloudTranscriptionProvider",
    model: "meetingCloudTranscriptionModel",
    baseUrl: "meetingCloudTranscriptionBaseUrl",
  },
  {
    context: "upload",
    mode: "uploadTranscriptionMode",
    useLocal: "uploadUseLocalWhisper",
    cloudMode: "uploadCloudTranscriptionMode",
    provider: "uploadCloudTranscriptionProvider",
    model: "uploadCloudTranscriptionModel",
    baseUrl: "uploadCloudTranscriptionBaseUrl",
  },
];

export function getSettings(): SettingsState {
  return useSettingsStore.getState();
}

/**
 * Drops any local model selection the model cache no longer backs — a scope left
 * pointing at a deleted model fails at inference time with an error the user has
 * no way to act on. Cleared rather than repointed so the picker asks again.
 */
export function clearMissingLocalModelSelections(isInstalled: (modelId: string) => boolean): void {
  const settings = useSettingsStore.getState() as unknown as Record<string, unknown>;
  const staleKeys: string[] = findStaleLocalModelKeys(
    Object.values(INFERENCE_SCOPES),
    settings,
    isInstalled
  );
  for (const key of staleKeys) {
    setStringSetting(key as keyof SettingsState, "");
  }
}

/** Reconciles every scope against the models actually on disk. */
export async function reconcileLocalModelSelections(): Promise<void> {
  if (!isBrowser || !window.electronAPI?.modelGetAll) return;

  const models = await window.electronAPI.modelGetAll();
  const installed = new Set(models.filter((model) => model.isDownloaded).map((model) => model.id));
  clearMissingLocalModelSelections((modelId) => installed.has(modelId));
}

/**
 * Repoints any scope still selecting a cloud model the registry no longer ships
 * (e.g. a retired Groq id) at that provider's current default — otherwise every
 * request 404s with an error the user can't act on. Custom, OpenRouter and
 * Tinfoil ids are skipped: they're free-form or reconciled from the live
 * catalog in tinfoilModels.ts.
 */
export function reconcileRetiredCloudModelSelections(): void {
  const state = useSettingsStore.getState() as unknown as Record<string, unknown>;
  for (const scope of Object.values(INFERENCE_SCOPES)) {
    const provider = state[scope.storeKeys.provider] as string;
    const model = state[scope.storeKeys.model] as string;
    if (!provider || !model || provider === "tinfoil") continue;
    const providerDef = modelRegistryData.cloudProviders.find((p) => p.id === provider);
    if (!providerDef || reasoningModelBelongsToProvider(provider, model)) continue;
    const replacement = pickDefaultModelId(providerDef);
    if (!replacement) continue;
    setStringSetting(scope.storeKeys.model as keyof SettingsState, replacement);
    logger.info(
      "Repointed retired cloud model selection",
      { scope: scope.storeKeys.model, from: model, to: replacement },
      "settings"
    );
  }
}

export function getEffectiveCleanupModel() {
  return selectResolvedLLMConfig(getSettings(), "cleanup").model;
}

// --- Initialization ---

// Hydrate scope custom keys from the secure store. The stale-secret sweep
// below discards older browser copies so a missing key can be re-entered.
let hasInitialized = false;

export async function initializeSettings(): Promise<void> {
  if (hasInitialized) return;
  hasInitialized = true;

  if (!isBrowser) return;

  // Discard plaintext credentials before attempting secure-store hydration.
  // A failed or unavailable bridge must never make a legacy local copy usable.
  for (const key of STALE_SECRET_LOCALSTORAGE_KEYS) {
    localStorage.removeItem(key);
  }

  const state = useSettingsStore.getState();

  if (window.electronAPI) {
    try {
      const [
        openai,
        anthropic,
        gemini,
        groq,
        xai,
        mistral,
        openrouter,
        cortiClientId,
        cortiClientSecret,
        cortiApiKey,
        tinfoil,
        customTx,
        customRx,
        noteFormattingCustom,
        chatAgentCustom,
        bedrockAccessKeyId,
        bedrockSecretAccessKey,
        bedrockSessionToken,
        azureApiKey,
        vertexApiKey,
        deepgram,
        elevenlabs,
        assemblyai,
      ] = await Promise.all([
        window.electronAPI.getOpenAIKey?.(),
        window.electronAPI.getAnthropicKey?.(),
        window.electronAPI.getGeminiKey?.(),
        window.electronAPI.getGroqKey?.(),
        window.electronAPI.getXaiKey?.(),
        window.electronAPI.getMistralKey?.(),
        window.electronAPI.getOpenrouterKey?.(),
        window.electronAPI.getCortiClientId?.(),
        window.electronAPI.getCortiClientSecret?.(),
        window.electronAPI.getCortiKey?.(),
        window.electronAPI.getTinfoilKey?.(),
        window.electronAPI.getCustomTranscriptionKey?.(),
        window.electronAPI.getCleanupCustomKey?.(),
        window.electronAPI.getNoteFormattingCustomKey?.(),
        window.electronAPI.getChatAgentCustomKey?.(),
        window.electronAPI.getBedrockAccessKeyId?.(),
        window.electronAPI.getBedrockSecretAccessKey?.(),
        window.electronAPI.getBedrockSessionToken?.(),
        window.electronAPI.getAzureApiKey?.(),
        window.electronAPI.getVertexApiKey?.(),
        window.electronAPI.getDeepgramKey?.(),
        window.electronAPI.getElevenLabsKey?.(),
        window.electronAPI.getAssemblyAIKey?.(),
      ]);

      useSettingsStore.setState({
        openaiApiKey: openai || "",
        anthropicApiKey: anthropic || "",
        geminiApiKey: gemini || "",
        groqApiKey: groq || "",
        xaiApiKey: xai || "",
        mistralApiKey: mistral || "",
        openrouterApiKey: openrouter || "",
        cortiClientId: cortiClientId || "",
        cortiClientSecret: cortiClientSecret || "",
        cortiApiKey: cortiApiKey || "",
        tinfoilApiKey: tinfoil || "",
        customTranscriptionApiKey: customTx || "",
        cleanupCustomApiKey: customRx || "",
        noteFormattingCustomApiKey: noteFormattingCustom || "",
        chatAgentCustomApiKey: chatAgentCustom || "",
        bedrockAccessKeyId: bedrockAccessKeyId || "",
        bedrockSecretAccessKey: bedrockSecretAccessKey || "",
        bedrockSessionToken: bedrockSessionToken || "",
        azureApiKey: azureApiKey || "",
        vertexApiKey: vertexApiKey || "",
        deepgramApiKey: deepgram || "",
        elevenLabsApiKey: elevenlabs || "",
        assemblyaiApiKey: assemblyai || "",
      });

      if (!localStorage.getItem("enterpriseSetupMode")) {
        // One-time migration. "Managed by default" is meant to equip employees who never chose a
        // provider — not to move someone who deliberately set up local, self-hosted, BYOK, or
        // enterprise inference. Anyone with an existing choice starts on "manual" and opts in.
        const hasChosenProvider =
          Object.values(INFERENCE_SCOPES).some((scope) => {
            const stored = localStorage.getItem(scope.storeKeys.mode as string);
            return Boolean(stored);
          }) ||
          Boolean(
            useSettingsStore.getState().bedrockProfile.trim() ||
            (bedrockAccessKeyId && bedrockSecretAccessKey) ||
            azureApiKey
          );
        const enterpriseSetupMode: EnterpriseSetupMode = hasChosenProvider ? "manual" : "auto";
        localStorage.setItem("enterpriseSetupMode", enterpriseSetupMode);
        useSettingsStore.setState({ enterpriseSetupMode });
      }

    } catch (err) {
      logger.warn(
        "Failed to hydrate secrets from main process",
        { error: (err as Error).message },
        "settings"
      );
    }

    // Sync UI language from main process
    try {
      const envLanguage = await window.electronAPI.getUiLanguage?.();
      const resolved = normalizeUiLanguage(envLanguage || state.uiLanguage);
      if (resolved !== state.uiLanguage) {
        if (isBrowser) localStorage.setItem("uiLanguage", resolved);
        useSettingsStore.setState({ uiLanguage: resolved });
      }
      await i18n.changeLanguage(resolved);
    } catch (err) {
      logger.warn(
        "Failed to sync UI language on startup",
        { error: (err as Error).message },
        "settings"
      );
      void i18n.changeLanguage(normalizeUiLanguage(state.uiLanguage));
    }

    const migratedLang = isBrowser ? localStorage.getItem("preferredLanguage") : null;
    if (migratedLang && migratedLang !== state.preferredLanguage) {
      useSettingsStore.setState({ preferredLanguage: migratedLang });
    }

    // Sync dictionary from SQLite <-> localStorage.
    // Prefer SQLite whenever it has entries (same policy as snippets). A stale
    // cache used to win when both sides were non-empty; ensureAgentNameInDictionary
    // then wrote that cache through setDictionary and wiped newer DB words (#1295).
    let dictionarySyncSucceeded = !window.electronAPI?.getDictionary;
    try {
      if (window.electronAPI.getDictionary) {
        const currentDictionary = useSettingsStore.getState().customDictionary;
        const dbWords = await window.electronAPI.getDictionary();
        const decision = chooseDictionaryStartupAction(dbWords, currentDictionary);
        if (decision.action === "push-local-to-db") {
          await window.electronAPI.setDictionary(decision.words);
        } else if (decision.action === "pull-db-to-local") {
          if (isBrowser) localStorage.setItem("customDictionary", JSON.stringify(decision.words));
          useSettingsStore.setState({ customDictionary: decision.words });
        }
        dictionarySyncSucceeded = true;
      }
    } catch (err) {
      logger.warn(
        "Failed to sync dictionary on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    // Sync snippets from SQLite <-> localStorage
    try {
      if (window.electronAPI.getSnippets) {
        const currentSnippets = useSettingsStore.getState().snippets;
        const dbSnippets = await window.electronAPI.getSnippets();
        if (dbSnippets.length === 0 && currentSnippets.length > 0) {
          await window.electronAPI.setSnippets?.(currentSnippets);
          const normalizedSnippets = await window.electronAPI.getSnippets();
          if (isBrowser) localStorage.setItem("snippets", JSON.stringify(normalizedSnippets));
          useSettingsStore.setState({ snippets: normalizedSnippets });
        } else if (dbSnippets.length > 0) {
          if (isBrowser) localStorage.setItem("snippets", JSON.stringify(dbSnippets));
          useSettingsStore.setState({ snippets: dbSnippets });
        }
      }
    } catch (err) {
      logger.warn(
        "Failed to sync snippets on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    // Audio detection is derived from the meeting-notification toggle in
    // sync-notification-preferences, so it is not sent here.
    try {
      const currentState = useSettingsStore.getState();
      await window.electronAPI.meetingDetectionSetPreferences?.({
        processDetection: currentState.meetingProcessDetection,
      });
    } catch (err) {
      logger.warn(
        "Failed to sync meeting detection preferences on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    try {
      const currentState = useSettingsStore.getState();
      await window.electronAPI.syncNotificationPreferences?.({
        notificationsEnabled: currentState.notificationsEnabled,
        notifyMeetingDetection: currentState.notifyMeetingDetection,
        notifyCalendarReminders: currentState.notifyCalendarReminders,
      });
    } catch (err) {
      logger.warn(
        "Failed to sync notification preferences on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    // The main-process DB is the source of truth for the Apple Calendar connection
    try {
      const status = await window.electronAPI.acalGetConnectionStatus?.();
      if (status) {
        useSettingsStore.getState().setAppleCalendarConnected(status.connected);
      }
    } catch (err) {
      logger.warn(
        "Failed to hydrate Apple Calendar connection status",
        { error: (err as Error).message },
        "settings"
      );
    }

    try {
      const currentState = useSettingsStore.getState();
      await window.electronAPI.gcalSetPrimaryOnly?.(currentState.gcalPrimaryOnly);
    } catch (err) {
      logger.warn(
        "Failed to sync gcal primary-only on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    try {
      const currentState = useSettingsStore.getState();
      await window.electronAPI.mcalSetPrimaryOnly?.(currentState.mcalPrimaryOnly);
    } catch (err) {
      logger.warn(
        "Failed to sync mcal primary-only on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    try {
      const currentState = useSettingsStore.getState();
      await window.electronAPI.setSpeakerDiarizationEnabled?.(
        currentState.speakerDiarizationEnabled
      );
    } catch (err) {
      logger.warn(
        "Failed to sync speaker diarization preference on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    try {
      const currentState = useSettingsStore.getState();
      await window.electronAPI.setWhisperVadConfig?.({
        noteRecordingSileroEnabled: currentState.noteRecordingSileroEnabled,
        meetingSileroEnabled: currentState.meetingSileroEnabled,
        threshold: currentState.whisperVadThreshold,
        minSpeechDurationMs: currentState.whisperVadMinSpeechDurationMs,
        minSilenceDurationMs: currentState.whisperVadMinSilenceDurationMs,
        maxSpeechDurationS: currentState.whisperVadMaxSpeechDurationS,
        speechPadMs: currentState.whisperVadSpeechPadMs,
        samplesOverlap: currentState.whisperVadSamplesOverlap,
      });
    } catch (err) {
      logger.warn(
        "Failed to sync whisper VAD config on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    reconcileRetiredCloudModelSelections();

    try {
      await reconcileLocalModelSelections();
    } catch (err) {
      logger.warn(
        "Failed to reconcile local model selections on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    // Only after a successful DB↔cache reconcile. If the read failed, the cache
    // may still be stale — writing it via setCustomDictionary would wipe SQLite.
    if (dictionarySyncSucceeded) {
      ensureAgentNameInDictionary();
    }
  }

  // Sync Zustand store when another window writes to localStorage
  window.addEventListener("storage", (event) => {
    if (!event.key || event.storageArea !== localStorage || event.newValue === null) return;

    const { key, newValue } = event;

    if (key.startsWith("customPrompt.")) {
      const kind = key.slice("customPrompt.".length) as PromptKind;
      if (!PROMPT_KIND_LIST.includes(kind)) return;
      useSettingsStore.setState((s) => ({
        customPrompts: { ...s.customPrompts, [kind]: newValue },
      }));
      return;
    }

    const state = useSettingsStore.getState();
    if (!(key in state) || typeof (state as unknown as Record<string, unknown>)[key] === "function")
      return;

    let value: unknown;
    if (BOOLEAN_SETTINGS.has(key)) {
      value = newValue === "true";
    } else if (ARRAY_SETTINGS.has(key)) {
      try {
        const parsed = JSON.parse(newValue);
        value = Array.isArray(parsed) ? parsed : [];
      } catch {
        value = [];
      }
    } else if (NUMERIC_SETTINGS.has(key)) {
      const parsed = Number(newValue);
      if (Number.isNaN(parsed)) {
        value =
          key === "audioRetentionDays" ? 7 : (state as unknown as Record<string, unknown>)[key];
      } else if (key === "audioRetentionDays") {
        value = Math.round(parsed);
      } else if (key === "micWarmHoldSeconds") {
        // Same whitelist as the setter — a hand-edited localStorage value
        // synced from another window must not exceed the offered durations.
        value = snapMicWarmHold(parsed);
      } else {
        value = parsed;
      }
    } else {
      value = newValue;
    }

    useSettingsStore.setState({ [key]: value });

    if (key === "gcalAccounts" && Array.isArray(value)) {
      const accounts = value as CalendarAccount[];
      useSettingsStore.setState({
        gcalConnected: accounts.length > 0,
        gcalEmail: accounts[0]?.email ?? "",
      });
    }

    if (key === "mcalAccounts" && Array.isArray(value)) {
      useSettingsStore.setState({ mcalConnected: (value as CalendarAccount[]).length > 0 });
    }

    if (key === "uiLanguage" && typeof value === "string") {
      void i18n.changeLanguage(value);
    }
  });

  // Sync settings pushed from main process (e.g., hotkey changed in control panel)
  window.electronAPI?.onSettingUpdated?.((data: { key: string; value: unknown }) => {
    const state = useSettingsStore.getState();
    if (
      data.key in state &&
      typeof (state as unknown as Record<string, unknown>)[data.key] !== "function"
    ) {
      localStorage.setItem(
        data.key,
        typeof data.value === "string" ? data.value : JSON.stringify(data.value)
      );
      useSettingsStore.setState({ [data.key]: data.value });
    }
  });
}
