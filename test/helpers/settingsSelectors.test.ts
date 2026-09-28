const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const path = require("node:path");
import type {
  BaseTranscriptionSettings, MeetingTranscriptionSettings, UploadTranscriptionSettings,
  CleanupScopeSettings, NoteFormattingScopeSettings, ChatAgentScopeSettings,
  InferenceSettingsSnapshot,
} from "../../src/contracts/inferenceSettings.js";

const ROOT = path.join(__dirname, "..", "..");

// Characterization tests for the four settings selectors, imported directly
// (pure TypeScript, no Vite/store/browser globals). Expectations are written
// from the documented routing rules, not read back from the selectors:
// empty-string fields inherit through `||`, mode and provider flags come from
// the context scope, LLM scope keys resolve through INFERENCE_SCOPES with
// cleanup as the only fallback, and the note-formatting API key only follows
// the cleanup key when the endpoint is inherited too.

const loadSelectors = async () => import("../../src/config/settingsSelectors.ts");
const loadRouting = async () => import("../../src/helpers/reasoningRouting.ts");

const transcriptionDefaults = {
  useLocalWhisper: false,
  whisperModel: "base",
  localTranscriptionProvider: "whisper",
  parakeetModel: "parakeet-base",
  cohereModel: "cohere-base",
  cloudTranscriptionProvider: "openai",
  cloudTranscriptionModel: "gpt-4o-mini-transcribe",
  cloudTranscriptionBaseUrl: "https://api.openai.com/v1",
  cloudTranscriptionMode: "byok",
  transcriptionMode: "providers",
  remoteTranscriptionType: "lan",
  remoteTranscriptionUrl: "",
  meetingTranscriptionMode: "providers",
  meetingUseLocalWhisper: false,
  meetingWhisperModel: "",
  meetingLocalTranscriptionProvider: "whisper",
  meetingParakeetModel: "",
  meetingCohereModel: "",
  meetingCloudTranscriptionProvider: "",
  meetingCloudTranscriptionModel: "",
  meetingCloudTranscriptionBaseUrl: "",
  meetingCloudTranscriptionMode: "",
  meetingRemoteTranscriptionType: "lan",
  meetingRemoteTranscriptionUrl: "",
  uploadTranscriptionMode: "providers",
  uploadUseLocalWhisper: false,
  uploadWhisperModel: "",
  uploadLocalTranscriptionProvider: "whisper",
  uploadParakeetModel: "",
  uploadCohereModel: "",
  uploadCloudTranscriptionProvider: "",
  uploadCloudTranscriptionModel: "",
  uploadCloudTranscriptionBaseUrl: "",
  uploadCloudTranscriptionMode: "",
} satisfies BaseTranscriptionSettings & MeetingTranscriptionSettings & UploadTranscriptionSettings;

const llmDefaults = {
  cleanupMode: "providers",
  cleanupProvider: "openai",
  cleanupModel: "gpt-5-mini",
  cleanupCloudMode: "byok",
  cleanupCloudBaseUrl: "https://api.openai.com/v1",
  cleanupRemoteUrl: "",
  cleanupCustomApiKey: "sk-cleanup",
  cleanupDisableThinking: false,
  noteFormattingMode: "providers",
  noteFormattingProvider: "",
  noteFormattingModel: "",
  noteFormattingCloudMode: "",
  noteFormattingCloudBaseUrl: "",
  noteFormattingRemoteUrl: "",
  noteFormattingCustomApiKey: "",
  noteFormattingDisableThinking: true,
  chatAgentMode: "providers",
  chatAgentProvider: "anthropic",
  chatAgentModel: "claude-haiku",
  chatAgentCloudMode: "byok",
  chatAgentCloudBaseUrl: "",
  chatAgentRemoteUrl: "",
  chatAgentCustomApiKey: "sk-chat",
  chatAgentDisableThinking: true,
} satisfies CleanupScopeSettings & NoteFormattingScopeSettings & ChatAgentScopeSettings;

const settingsFixture = (overrides: Partial<InferenceSettingsSnapshot> = {}): InferenceSettingsSnapshot => ({
  ...transcriptionDefaults,
  ...llmDefaults,
  ...overrides,
});

test("meeting overrides win; empty routing fields inherit the base scope", async () => {
  const { selectResolvedMeetingTranscription } = await loadSelectors();
  const resolved = selectResolvedMeetingTranscription(
    settingsFixture({
      meetingUseLocalWhisper: true,
      meetingLocalTranscriptionProvider: "nvidia",
      meetingTranscriptionMode: "local",
      meetingWhisperModel: "meeting-large",
      meetingParakeetModel: "meeting-parakeet",
      meetingCohereModel: "meeting-cohere",
      meetingCloudTranscriptionProvider: "groq",
      meetingCloudTranscriptionModel: "meeting-model",
      meetingCloudTranscriptionBaseUrl: "https://meeting.example/v1",
      meetingCloudTranscriptionMode: "managed",
      meetingRemoteTranscriptionType: "openai-compatible",
      meetingRemoteTranscriptionUrl: "https://meeting-remote.example/v1",
    })
  );
  assert.deepEqual(resolved, {
    useLocalWhisper: true,
    whisperModel: "meeting-large",
    localTranscriptionProvider: "nvidia",
    parakeetModel: "meeting-parakeet",
    cohereModel: "meeting-cohere",
    cloudTranscriptionProvider: "groq",
    cloudTranscriptionModel: "meeting-model",
    cloudTranscriptionBaseUrl: "https://meeting.example/v1",
    cloudTranscriptionMode: "managed",
    transcriptionMode: "local",
    remoteTranscriptionType: "openai-compatible",
    remoteTranscriptionUrl: "https://meeting-remote.example/v1",
  });
});

test("meeting empty strings inherit base fields through ||", async () => {
  const { selectResolvedMeetingTranscription } = await loadSelectors();
  const resolved = selectResolvedMeetingTranscription(settingsFixture());
  assert.equal(resolved.whisperModel, "base");
  assert.equal(resolved.parakeetModel, "parakeet-base");
  assert.equal(resolved.cohereModel, "cohere-base");
  assert.equal(resolved.cloudTranscriptionProvider, "openai");
  assert.equal(resolved.cloudTranscriptionModel, "gpt-4o-mini-transcribe");
  assert.equal(resolved.cloudTranscriptionBaseUrl, "https://api.openai.com/v1");
  assert.equal(resolved.cloudTranscriptionMode, "byok");
  assert.equal(resolved.remoteTranscriptionUrl, "");
  assert.equal(resolved.useLocalWhisper, false);
  assert.equal(resolved.transcriptionMode, "providers");
  assert.equal(resolved.remoteTranscriptionType, "lan");
});

test("upload overrides win and empty fields inherit the base scope", async () => {
  const { selectResolvedUploadTranscription } = await loadSelectors();
  const resolved = selectResolvedUploadTranscription(
    settingsFixture({
      uploadUseLocalWhisper: true,
      uploadLocalTranscriptionProvider: "cohere",
      uploadTranscriptionMode: "local",
      uploadWhisperModel: "upload-large",
      uploadParakeetModel: "upload-parakeet",
      uploadCohereModel: "upload-cohere",
      uploadCloudTranscriptionProvider: "groq",
      uploadCloudTranscriptionModel: "upload-model",
      uploadCloudTranscriptionBaseUrl: "https://upload.example/v1",
      uploadCloudTranscriptionMode: "managed",
    })
  );
  assert.deepEqual(resolved, {
    useLocalWhisper: true,
    whisperModel: "upload-large",
    localTranscriptionProvider: "cohere",
    parakeetModel: "upload-parakeet",
    cohereModel: "upload-cohere",
    cloudTranscriptionProvider: "groq",
    cloudTranscriptionModel: "upload-model",
    cloudTranscriptionBaseUrl: "https://upload.example/v1",
    cloudTranscriptionMode: "managed",
    transcriptionMode: "local",
  });
});

test("streaming-only base provider is not inherited by upload", async () => {
  const { selectResolvedUploadTranscription } = await loadSelectors();
  for (const provider of ["assemblyai"]) {
    const resolved = selectResolvedUploadTranscription(
      settingsFixture({
        cloudTranscriptionProvider: provider,
        cloudTranscriptionModel: "nova-3",
        uploadCloudTranscriptionProvider: "",
        uploadCloudTranscriptionModel: "",
      })
    );
    assert.equal(resolved.cloudTranscriptionProvider, "openai", provider);
    assert.equal(resolved.cloudTranscriptionModel, "", `${provider}'s model must not follow`);
  }
  // The streaming-only exception does not extend to base URL or cloud mode.
  const stillInheritsOther = selectResolvedUploadTranscription(
    settingsFixture({
      cloudTranscriptionProvider: "assemblyai",
      cloudTranscriptionBaseUrl: "https://deepgram.example/v1",
      cloudTranscriptionMode: "byok",
    })
  );
  assert.equal(stillInheritsOther.cloudTranscriptionBaseUrl, "https://deepgram.example/v1");
  assert.equal(stillInheritsOther.cloudTranscriptionMode, "byok");

  const deepgram = selectResolvedUploadTranscription(
    settingsFixture({
      cloudTranscriptionProvider: "deepgram",
      cloudTranscriptionModel: "nova-3",
      uploadCloudTranscriptionProvider: "",
      uploadCloudTranscriptionModel: "",
    })
  );
  assert.equal(deepgram.cloudTranscriptionProvider, "deepgram");
  assert.equal(deepgram.cloudTranscriptionModel, "nova-3");

  const groq = selectResolvedUploadTranscription(
    settingsFixture({
      cloudTranscriptionProvider: "groq",
      cloudTranscriptionModel: "whisper-large-v3-turbo",
    })
  );
  assert.equal(groq.cloudTranscriptionProvider, "groq");
  assert.equal(groq.cloudTranscriptionModel, "whisper-large-v3-turbo");
});

test("an explicit streaming-only upload provider is kept for the route guard", async () => {
  const { selectResolvedUploadTranscription } = await loadSelectors();
  const resolved = selectResolvedUploadTranscription(
    settingsFixture({
      cloudTranscriptionProvider: "deepgram",
      uploadCloudTranscriptionProvider: "assemblyai",
      uploadCloudTranscriptionModel: "universal",
    })
  );
  assert.equal(resolved.cloudTranscriptionProvider, "assemblyai");
  assert.equal(resolved.cloudTranscriptionModel, "universal");

  const groq = selectResolvedUploadTranscription(
    settingsFixture({
      cloudTranscriptionProvider: "deepgram",
      uploadCloudTranscriptionProvider: "groq",
      uploadCloudTranscriptionModel: "whisper-large-v3",
    })
  );
  assert.equal(groq.cloudTranscriptionProvider, "groq");
  assert.equal(groq.cloudTranscriptionModel, "whisper-large-v3");
});

test("cleanup and chatIntelligence do not gain a fallback scope", async () => {
  const { selectResolvedLLMConfig } = await loadSelectors();
  const cleanup = selectResolvedLLMConfig(
    settingsFixture({ cleanupProvider: "", cleanupModel: "" }),
    "cleanup"
  );
  assert.equal(cleanup.provider, "");
  assert.equal(cleanup.model, "");
  const chat = selectResolvedLLMConfig(
    settingsFixture({ chatAgentProvider: "", chatAgentModel: "" }),
    "chatIntelligence"
  );
  assert.equal(chat.provider, "");
  assert.equal(chat.model, "");
});

test("bb scopes follow the default harness model, keep overrides and never swap a disabled harness", async () => {
  const { selectResolvedLLMConfig } = await loadSelectors();
  const bbAgentPreferences = {
    order: ["codex", "claude-code"],
    disabled: [],
    defaultProvider: "codex",
    defaults: { codex: { model: "gpt-6", reasoningLevel: "high" }, "claude-code": { model: "opus", reasoningLevel: "low" } },
  };
  const chat = (overrides: Partial<InferenceSettingsSnapshot>) => selectResolvedLLMConfig(
    settingsFixture({ chatAgentMode: "agent", chatAgentBbProvider: "", chatAgentBbModel: "", chatAgentBbReasoningLevel: "", bbAgentPreferences, ...overrides }),
    "chatIntelligence"
  );

  const followsDefault = chat({});
  assert.deepEqual(
    [followsDefault.agentProvider, followsDefault.agentModel, followsDefault.agentReasoningLevel, followsDefault.agentUsesDefault],
    ["codex", "gpt-6", "high", true]
  );

  const pinned = chat({ chatAgentBbProvider: "claude-code", chatAgentBbModel: "sonnet", chatAgentBbReasoningLevel: "medium" });
  assert.deepEqual([pinned.agentProvider, pinned.agentModel, pinned.agentReasoningLevel, pinned.agentUsesDefault], ["claude-code", "sonnet", "medium", false]);

  const harnessOnly = chat({ chatAgentBbProvider: "claude-code" });
  assert.deepEqual([harnessOnly.agentModel, harnessOnly.agentReasoningLevel], ["opus", "low"], "a pinned harness without a model uses its default model");

  const disabled = chat({
    chatAgentBbProvider: "claude-code", chatAgentBbModel: "sonnet", chatAgentBbReasoningLevel: "medium",
    bbAgentPreferences: { ...bbAgentPreferences, disabled: ["claude-code"] },
  });
  assert.deepEqual([disabled.agentProvider, disabled.agentModel], ["", ""], "a disabled harness is reported, not replaced by the default");

  const unseeded = chat({ bbAgentPreferences: null });
  assert.equal(unseeded.agentProvider, "");
});

test("bb harness order keeps saved positions and appends new harnesses in bb order", async () => {
  const { orderBbHarnesses, moveBbHarness, parseBbAgentPreferences } = await import("../../src/config/bbAgentPreferences.ts");
  const items = ["codex", "pi", "claude-code", "acp-cursor"].map((id) => ({ id }));
  const ordered = orderBbHarnesses(items, { order: ["claude-code", "codex"], disabled: [], defaultProvider: "codex", defaults: {} });
  assert.deepEqual(ordered.map((item) => item.id), ["claude-code", "codex", "pi", "acp-cursor"]);
  assert.deepEqual(moveBbHarness(["a", "b", "c"], "c", 0), ["c", "a", "b"]);
  assert.deepEqual(moveBbHarness(["a", "b", "c"], "a", 9), ["b", "c", "a"]);
  assert.equal(parseBbAgentPreferences("{\"order\":\"codex\"}"), null, "malformed preferences are treated as unseeded");
  assert.equal(parseBbAgentPreferences("not json"), null);
});

test("empty noteFormatting fields inherit cleanup; mode does not", async () => {
  const { selectResolvedLLMConfig } = await loadSelectors();
  const cfg = selectResolvedLLMConfig(settingsFixture(), "noteFormatting");
  assert.deepEqual(cfg, {
    scope: "noteFormatting",
    mode: "providers",
    provider: "openai",
    model: "gpt-5-mini",
    cloudMode: "byok",
    cloudBaseUrl: "https://api.openai.com/v1",
    remoteUrl: undefined,
    customApiKey: undefined,
    disableThinking: true,
  });
});

test("noteFormatting keeps its own mode while inheriting cleanup routing", async () => {
  const { selectResolvedLLMConfig } = await loadSelectors();
  const cfg = selectResolvedLLMConfig(
    settingsFixture({ noteFormattingMode: "local" }),
    "noteFormatting"
  );
  assert.equal(cfg.mode, "local");
  assert.equal(cfg.provider, "openai");
});

test("disableThinking=false survives as false and true stays true", async () => {
  const { selectResolvedLLMConfig } = await loadSelectors();
  const cleanup = selectResolvedLLMConfig(settingsFixture(), "cleanup");
  assert.equal(cleanup.disableThinking, false);
  const withoutKey = selectResolvedLLMConfig(
    settingsFixture({ chatAgentDisableThinking: false, chatAgentCustomApiKey: "" }),
    "chatIntelligence"
  );
  assert.equal(withoutKey.disableThinking, false);
});

test("selectResolvedLLMConfig customApiKey is scope-owned, never borrowed", async () => {
  const { selectResolvedLLMConfig } = await loadSelectors();
  const cfg = selectResolvedLLMConfig(settingsFixture(), "noteFormatting");
  assert.equal(cfg.customApiKey, undefined);
  const own = selectResolvedLLMConfig(
    settingsFixture({ noteFormattingCustomApiKey: "sk-own" }),
    "noteFormatting"
  );
  assert.equal(own.customApiKey, "sk-own");
});

test("selectResolvedNoteFormatting: own key wins, inherited endpoint borrows the cleanup key", async () => {
  const { selectResolvedNoteFormatting } = await loadSelectors();
  const borrowed = selectResolvedNoteFormatting(settingsFixture());
  assert.equal(borrowed.customApiKey, "sk-cleanup");

  const own = selectResolvedNoteFormatting(settingsFixture({ noteFormattingCustomApiKey: "sk-own" }));
  assert.equal(own.customApiKey, "sk-own");

  // Own endpoint (cloudBaseUrl or remoteUrl set): no borrowed key.
  const ownUrl = selectResolvedNoteFormatting(
    settingsFixture({ noteFormattingCloudBaseUrl: "https://nf.example/v1" })
  );
  assert.equal(ownUrl.customApiKey, "");
  const ownRemote = selectResolvedNoteFormatting(
    settingsFixture({ noteFormattingRemoteUrl: "http://host:11434/v1" })
  );
  assert.equal(ownRemote.customApiKey, "");

  // Different mode with empty endpoints: still no borrowed key.
  const otherMode = selectResolvedNoteFormatting(
    settingsFixture({ noteFormattingMode: "local", cleanupMode: "providers" })
  );
  assert.equal(otherMode.customApiKey, "");

  // A textually identical URL is still an own endpoint.
  const sameTextUrl = selectResolvedNoteFormatting(
    settingsFixture({ noteFormattingCloudBaseUrl: "https://api.openai.com/v1" })
  );
  assert.equal(sameTextUrl.customApiKey, "");
});

test("selectResolvedNoteFormatting falls back to empty strings, keeps undefined vs '' split", async () => {
  const { selectResolvedNoteFormatting } = await loadSelectors();
  const resolved = selectResolvedNoteFormatting(settingsFixture());
  assert.deepEqual(resolved, {
    provider: "openai",
    model: "gpt-5-mini",
    mode: "providers",
    cloudMode: "byok",
    cloudBaseUrl: "https://api.openai.com/v1",
    remoteUrl: "",
    customApiKey: "sk-cleanup",
  });
  const empty = selectResolvedNoteFormatting(
    settingsFixture({
      cleanupProvider: "",
      cleanupModel: "",
      cleanupCloudMode: "",
      cleanupCloudBaseUrl: "",
      cleanupCustomApiKey: "",
    })
  );
  assert.equal(empty.provider, "");
  assert.equal(empty.model, "");
  assert.equal(empty.cloudMode, "");
  assert.equal(empty.cloudBaseUrl, "");
  assert.equal(empty.remoteUrl, "");
  assert.equal(empty.customApiKey, "");
});

test("reasoningRouting keeps mirroring undefined routing fields and endpoint rules", async () => {
  const { inheritsFallbackEndpoint, buildReasoningScopePatches } = await loadRouting();
  assert.equal(inheritsFallbackEndpoint({ mode: "providers" }, "providers"), true);
  assert.equal(
    inheritsFallbackEndpoint({ mode: "providers", cloudBaseUrl: "" }, "providers"),
    true
  );
  assert.equal(inheritsFallbackEndpoint({ mode: "providers" }, "local"), false);
  assert.equal(inheritsFallbackEndpoint({ mode: "local" }, undefined), false);
  const { noteFormatting } = buildReasoningScopePatches(
    { cleanupProvider: "openai", cleanupCloudMode: undefined },
    "self-hosted"
  );
  assert.deepEqual(noteFormatting, { mode: "self-hosted", provider: "openai" });
});

// --- Purity: selectors run with no window and a throwing localStorage. ---

test("selectors import and run without window, with a throwing localStorage", async (t: import("node:test").TestContext) => {
  const originalWindow = globalThis.window;
  const originalLocalStorage = globalThis.localStorage;
  Reflect.deleteProperty(globalThis, "window");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("localStorage must not be touched by settings selectors");
    },
  });
  t.after(() => {
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else globalThis.window = originalWindow;
    if (originalLocalStorage === undefined) Reflect.deleteProperty(globalThis, "localStorage");
    else
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: originalLocalStorage,
      });
  });

  const selectors = await loadSelectors();
  const resolved = selectors.selectResolvedUploadTranscription(settingsFixture());
  assert.equal(resolved.transcriptionMode, "providers");
  const cfg = selectors.selectResolvedLLMConfig(settingsFixture(), "noteFormatting");
  assert.equal(cfg.provider, "openai");
  assert.equal(selectors.selectResolvedNoteFormatting(settingsFixture()).customApiKey, "sk-cleanup");
});

test("selectors never mutate the snapshot they read", async () => {
  const {
    selectResolvedMeetingTranscription,
    selectResolvedUploadTranscription,
    selectResolvedLLMConfig,
    selectResolvedNoteFormatting,
  } = await loadSelectors();
  const snapshot = Object.freeze({ ...settingsFixture(), ...settingsFixture() });
  assert.doesNotThrow(() => selectResolvedMeetingTranscription(snapshot));
  assert.doesNotThrow(() => selectResolvedUploadTranscription(snapshot));
  assert.doesNotThrow(() => selectResolvedLLMConfig(snapshot, "noteFormatting"));
  assert.doesNotThrow(() => selectResolvedLLMConfig(snapshot, "cleanup"));
  assert.doesNotThrow(() => selectResolvedNoteFormatting(snapshot));
});

test("selectors graph imports nothing from the store or electron", async () => {
  const graphRoots = [
    "src/config/settingsSelectors.ts",
    "src/config/inferenceScopes.ts",
    "src/config/transcriptionCapabilities.ts",
    "src/helpers/reasoningRouting.ts",
    "src/contracts/inferenceSettings.ts",
  ];
  const seen = new Set();
  const banned = new RegExp("stores/settingsStore|types/electron|zustand|electron", "i");
  const queue = [...graphRoots];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    for (const spec of imports) {
      assert.equal(banned.test(spec), false, `${file} imports ${spec}`);
      if (spec.startsWith(".")) {
        const resolved = path
          .relative(ROOT, path.resolve(path.dirname(path.join(ROOT, file)), spec))
          .replace(/\.js$/, ".ts");
        if (fs.existsSync(path.join(ROOT, resolved))) queue.push(resolved);
      }
    }
  }
});
