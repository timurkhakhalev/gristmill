const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Characterization tests for the four settings selectors. Expectations are
// written from the documented routing rules, not read back from the selectors:
// empty-string fields inherit through `||`, mode and provider flags come from
// the context scope, LLM scope keys resolve through INFERENCE_SCOPES with
// cleanup as the only fallback, and the note-formatting API key only follows
// the cleanup key when the endpoint is inherited too.

const loadSelectors = async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-settings-selectors-test-",
  });
  return vite.ssrLoadModule("/stores/settingsStore.ts");
};

const transcriptionFixture = (overrides = {}) => ({
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
  ...overrides,
});

const llmFixture = (overrides = {}) => ({
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
  ...overrides,
});

test("meeting overrides win; empty routing fields inherit the base scope", async (t) => {
  const { selectResolvedMeetingTranscription } = await loadSelectors(t);
  const resolved = selectResolvedMeetingTranscription(
    transcriptionFixture({
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

test("meeting empty strings inherit base fields through ||", async (t) => {
  const { selectResolvedMeetingTranscription } = await loadSelectors(t);
  const resolved = selectResolvedMeetingTranscription(transcriptionFixture());
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

test("upload overrides win and empty fields inherit the base scope", async (t) => {
  const { selectResolvedUploadTranscription } = await loadSelectors(t);
  const resolved = selectResolvedUploadTranscription(
    transcriptionFixture({
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

test("streaming-only base provider is not inherited by upload", async (t) => {
  const { selectResolvedUploadTranscription } = await loadSelectors(t);
  for (const provider of ["deepgram", "assemblyai"]) {
    const resolved = selectResolvedUploadTranscription(
      transcriptionFixture({
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
    transcriptionFixture({
      cloudTranscriptionProvider: "deepgram",
      cloudTranscriptionBaseUrl: "https://deepgram.example/v1",
      cloudTranscriptionMode: "byok",
    })
  );
  assert.equal(stillInheritsOther.cloudTranscriptionBaseUrl, "https://deepgram.example/v1");
  assert.equal(stillInheritsOther.cloudTranscriptionMode, "byok");
});

test("an explicit streaming-only upload provider is kept for the route guard", async (t) => {
  const { selectResolvedUploadTranscription } = await loadSelectors(t);
  const resolved = selectResolvedUploadTranscription(
    transcriptionFixture({
      cloudTranscriptionProvider: "deepgram",
      uploadCloudTranscriptionProvider: "assemblyai",
      uploadCloudTranscriptionModel: "universal",
    })
  );
  assert.equal(resolved.cloudTranscriptionProvider, "assemblyai");
  assert.equal(resolved.cloudTranscriptionModel, "universal");
});

test("cleanup and chatIntelligence do not gain a fallback scope", async (t) => {
  const { selectResolvedLLMConfig } = await loadSelectors(t);
  const cleanup = selectResolvedLLMConfig(llmFixture({ cleanupProvider: "", cleanupModel: "" }), "cleanup");
  assert.equal(cleanup.provider, "");
  assert.equal(cleanup.model, "");
  const chat = selectResolvedLLMConfig(
    llmFixture({ chatAgentProvider: "", chatAgentModel: "" }),
    "chatIntelligence"
  );
  assert.equal(chat.provider, "");
  assert.equal(chat.model, "");
});

test("empty noteFormatting fields inherit cleanup; mode does not", async (t) => {
  const { selectResolvedLLMConfig } = await loadSelectors(t);
  const cfg = selectResolvedLLMConfig(llmFixture(), "noteFormatting");
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

test("noteFormatting keeps its own mode while inheriting cleanup routing", async (t) => {
  const { selectResolvedLLMConfig } = await loadSelectors(t);
  const cfg = selectResolvedLLMConfig(
    llmFixture({ noteFormattingMode: "local" }),
    "noteFormatting"
  );
  assert.equal(cfg.mode, "local");
  assert.equal(cfg.provider, "openai");
});

test("disableThinking=false survives as false and true stays true", async (t) => {
  const { selectResolvedLLMConfig } = await loadSelectors(t);
  const cleanup = selectResolvedLLMConfig(llmFixture(), "cleanup");
  assert.equal(cleanup.disableThinking, false);
  const withoutKey = selectResolvedLLMConfig(
    llmFixture({ chatAgentDisableThinking: false, chatAgentCustomApiKey: "" }),
    "chatIntelligence"
  );
  assert.equal(withoutKey.disableThinking, false);
});

test("selectResolvedLLMConfig customApiKey is scope-owned, never borrowed", async (t) => {
  const { selectResolvedLLMConfig } = await loadSelectors(t);
  const cfg = selectResolvedLLMConfig(llmFixture(), "noteFormatting");
  assert.equal(cfg.customApiKey, undefined);
  const own = selectResolvedLLMConfig(
    llmFixture({ noteFormattingCustomApiKey: "sk-own" }),
    "noteFormatting"
  );
  assert.equal(own.customApiKey, "sk-own");
});

test("selectResolvedNoteFormatting: own key wins, inherited endpoint borrows the cleanup key", async (t) => {
  const { selectResolvedNoteFormatting } = await loadSelectors(t);
  const borrowed = selectResolvedNoteFormatting(llmFixture());
  assert.equal(borrowed.customApiKey, "sk-cleanup");

  const own = selectResolvedNoteFormatting(
    llmFixture({ noteFormattingCustomApiKey: "sk-own" })
  );
  assert.equal(own.customApiKey, "sk-own");

  // Own endpoint (cloudBaseUrl or remoteUrl set): no borrowed key.
  const ownUrl = selectResolvedNoteFormatting(
    llmFixture({ noteFormattingCloudBaseUrl: "https://nf.example/v1" })
  );
  assert.equal(ownUrl.customApiKey, "");
  const ownRemote = selectResolvedNoteFormatting(
    llmFixture({ noteFormattingRemoteUrl: "http://host:11434/v1" })
  );
  assert.equal(ownRemote.customApiKey, "");

  // Different mode with empty endpoints: still no borrowed key.
  const otherMode = selectResolvedNoteFormatting(
    llmFixture({ noteFormattingMode: "local", cleanupMode: "providers" })
  );
  assert.equal(otherMode.customApiKey, "");

  // A textually identical URL is still an own endpoint.
  const sameTextUrl = selectResolvedNoteFormatting(
    llmFixture({ noteFormattingCloudBaseUrl: "https://api.openai.com/v1" })
  );
  assert.equal(sameTextUrl.customApiKey, "");
});

test("selectResolvedNoteFormatting falls back to empty strings, keeps undefined vs '' split", async (t) => {
  const { selectResolvedNoteFormatting } = await loadSelectors(t);
  const resolved = selectResolvedNoteFormatting(llmFixture());
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
    llmFixture({
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

test("selectors never mutate the snapshot they read", async (t) => {
  const { selectResolvedLLMConfig, selectResolvedNoteFormatting } = await loadSelectors(t);
  const snapshot = Object.freeze(llmFixture());
  assert.doesNotThrow(() => selectResolvedLLMConfig(snapshot, "noteFormatting"));
  assert.doesNotThrow(() => selectResolvedNoteFormatting(snapshot));
  const transcription = Object.freeze(
    transcriptionFixture()
  );
  const { selectResolvedUploadTranscription, selectResolvedMeetingTranscription } =
    await loadSelectors(t);
  assert.doesNotThrow(() => selectResolvedUploadTranscription(transcription));
  assert.doesNotThrow(() => selectResolvedMeetingTranscription(transcription));
});
