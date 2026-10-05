const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const test: typeof import("node:test") = require("node:test");

const {
  createRendererServer,
  installBrowserGlobals,
}: typeof import("../lib/rendererTestHarness.ts") = require("../lib/rendererTestHarness.ts");

const routeGlobals = globalThis as typeof globalThis & { __meetingSnapshotRouteReads?: number };

test("new Local snapshots enable diarization despite a removed preference; saved options stay explicit", async (t: import("node:test").TestContext) => {
  installBrowserGlobals(t, {
    initialStorage: {
      speakerDiarizationEnabled: "false",
      transcriptionMode: "local",
      localTranscriptionProvider: "whisper",
      whisperModel: "base",
      preferredLanguage: "en",
    },
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "meeting-local-diarization-snapshot-",
    mockModules: {
      "/stores/actionStore.js": `export function getActions() { return [{ translation_key: "notes.actions.builtin.detailedNotes", prompt: "Summary instruction" }]; }`,
    },
  });

  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  useSettingsStore.setState({
    meetingTranscriptionMode: "local",
    meetingLocalTranscriptionProvider: "whisper",
    meetingWhisperModel: "base",
  });

  const { snapshotMeetingRecordingConfig } = await vite.ssrLoadModule(
    "/helpers/meetingRecordingConfigSnapshot.ts"
  );

  const fresh = snapshotMeetingRecordingConfig();
  assert.equal(fresh.configError, null);
  assert.equal(fresh.config.transcription.mode, "local");
  assert.equal(fresh.config.transcription.local.options.diarize, true);

  const saved = {
    ...fresh.config.transcription,
    local: { ...fresh.config.transcription.local, options: { diarize: false } },
  };

  const reprocessed = snapshotMeetingRecordingConfig(saved);
  assert.equal(reprocessed.configError, null);
  assert.deepEqual(reprocessed.config.transcription, saved);
});

test("saved transcription bypasses an unsupported current meeting route while snapshotting current summary settings", async (t: import("node:test").TestContext) => {
  const previousRouteReads = routeGlobals.__meetingSnapshotRouteReads;
  routeGlobals.__meetingSnapshotRouteReads = 0;
  t.after(() => {
    if (previousRouteReads === undefined) delete routeGlobals.__meetingSnapshotRouteReads;
    else routeGlobals.__meetingSnapshotRouteReads = previousRouteReads;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "meeting-config-snapshot-review-",
    mockModules: {
      "/stores/settingsStore.js": `export function getSettings() { return { profileName: "  Timur  ", preferredLanguage: "en", uiLanguage: "en", customDictionary: ["ProjectX"], noteFormattingDisableThinking: false }; }`,
      "/config/settingsSelectors.js": `export function selectResolvedMeetingTranscription() { globalThis.__meetingSnapshotRouteReads += 1; return { transcriptionMode: "self-hosted" }; } export function selectResolvedNoteFormatting() { return { mode: "providers", provider: "openai", model: "gpt-4o-mini", cloudMode: "chat", cloudBaseUrl: "", remoteUrl: "" }; }`,
      "/config/prompts.js": `export function appendDictionarySuffix(prompt, dictionary) { return dictionary.length ? prompt + " " + dictionary.join(", ") : prompt; }`,
      "/config/secretKeys.js": `export const BYOK_API_KEYS = [];`,
      "/stores/actionStore.js": `export function getActions() { return [{ translation_key: "notes.actions.builtin.detailedNotes", prompt: "User-edited Detailed Notes instruction." }]; }`,
    },
  });

  const { snapshotMeetingRecordingConfig } = await vite.ssrLoadModule(
    "/helpers/meetingRecordingConfigSnapshot.ts"
  );

  const savedTranscription = {
    mode: "providers",
    provider: "elevenlabs",
    model: "scribe_v2",
    language: "en",
  };

  const corrected = snapshotMeetingRecordingConfig(savedTranscription);
  assert.equal(
    routeGlobals.__meetingSnapshotRouteReads,
    0,
    "summary correction does not resolve the current ASR route"
  );
  assert.equal(corrected.configError, null);
  assert.equal(corrected.config.selfDisplayName, "Timur");
  assert.deepEqual(corrected.config.transcription, savedTranscription);
  assert.equal(corrected.config.summary.provider, "openai");
  assert.equal(corrected.config.summary.model, "gpt-4o-mini");
  assert.match(corrected.config.summary.instruction, /ProjectX/);
  assert.match(corrected.config.summary.instruction, /User-edited Detailed Notes instruction/);

  const ordinary = snapshotMeetingRecordingConfig();
  assert.deepEqual(ordinary, {
    config: null,
    configError: { code: "unsupported-transcription-route" },
  });
  assert.equal(
    routeGlobals.__meetingSnapshotRouteReads,
    1,
    "ordinary capture still validates current meeting settings"
  );
});

test("meeting summary snapshots the selected bb harness, model and reasoning level", async (t: import("node:test").TestContext) => {
  const vite = await createRendererServer(t, {
    cachePrefix: "meeting-bb-snapshot-",
    mockModules: {
      "/stores/settingsStore.js": `export function getSettings() { return { profileName: "", preferredLanguage: "ru", uiLanguage: "ru", customDictionary: [], noteFormattingDisableThinking: false }; }`,
      "/config/settingsSelectors.js": `export function selectResolvedMeetingTranscription() { throw new Error("saved transcription should be used"); } export function selectResolvedNoteFormatting() { return { mode: "agent", agentProvider: "codex", agentModel: "gpt-6-luna", agentReasoningLevel: "high" }; }`,
      "/config/prompts.js": `export function appendDictionarySuffix(prompt) { return prompt; }`,
      "/config/secretKeys.js": `export const BYOK_API_KEYS = [];`,
      "/stores/actionStore.js": `export function getActions() { return [{ translation_key: "notes.actions.builtin.detailedNotes", prompt: "Current Detailed Notes prompt." }]; }`,
    },
  });

  const { snapshotMeetingRecordingConfig } = await vite.ssrLoadModule(
    "/helpers/meetingRecordingConfigSnapshot.ts"
  );

  const result = snapshotMeetingRecordingConfig({
    mode: "providers",
    provider: "elevenlabs",
    model: "scribe_v2",
    language: "ru",
  });

  assert.equal(result.configError, null);
  assert.equal(result.config.selfDisplayName, "Вы");
  assert.equal(result.config.summary.reasoningMode, "agent");
  assert.equal(result.config.summary.agentProvider, "codex");
  assert.equal(result.config.summary.model, "gpt-6-luna");
  assert.equal(result.config.summary.agentReasoningLevel, "high");
});

test("transcription-only config includes the naming model without requesting Summary", async (t: import("node:test").TestContext) => {
  const vite = await createRendererServer(t, {
    mockModules: {
      "/stores/settingsStore.js": `export function getSettings() { return { profileName: "Timur", preferredLanguage: "en", uiLanguage: "en" }; }`,
      "/config/settingsSelectors.js": `export function selectResolvedMeetingTranscription() { throw new Error("use saved route"); } export function selectResolvedNoteFormatting() { return { mode: "providers", provider: "openai", model: "gpt-4o-mini" }; }`,
      "/stores/actionStore.js": `export function getActions() { return [{ translation_key: "notes.actions.builtin.detailedNotes", prompt: "Summary instruction" }]; }`,
    },
  });

  const { snapshotMeetingRecordingConfig } = await vite.ssrLoadModule(
    "/helpers/meetingRecordingConfigSnapshot.ts"
  );

  const transcription = {
    mode: "providers",
    provider: "elevenlabs",
    model: "scribe_v2",
    language: "en",
  };

  const result = snapshotMeetingRecordingConfig(transcription, false);
  assert.equal(result.configError, null);
  assert.equal(result.config.generateSummary, false);
  assert.equal(result.config.summary.provider, "openai");
  assert.deepEqual(result.config.transcription, transcription);
});
