const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const test: typeof import("node:test") = require("node:test");
const { createRendererServer }: typeof import("../lib/rendererTestHarness.ts") = require("../lib/rendererTestHarness.ts");
const routeGlobals = globalThis as typeof globalThis & { __meetingSnapshotRouteReads?: number };

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
      "/stores/settingsStore.js": `export function getSettings() { return { preferredLanguage: "en", uiLanguage: "en", customDictionary: ["ProjectX"], noteFormattingDisableThinking: false }; }`,
      "/config/settingsSelectors.js": `export function selectResolvedMeetingTranscription() { globalThis.__meetingSnapshotRouteReads += 1; return { transcriptionMode: "self-hosted" }; } export function selectResolvedNoteFormatting() { return { mode: "providers", provider: "openai", model: "gpt-4o-mini", cloudMode: "chat", cloudBaseUrl: "", remoteUrl: "" }; }`,
      "/config/prompts.js": `export function appendDictionarySuffix(prompt, dictionary) { return dictionary.length ? prompt + " " + dictionary.join(", ") : prompt; }`,
      "/config/secretKeys.js": `export const BYOK_API_KEYS = [];`,
      "/stores/actionStore.js": `export function getActions() { return [{ translation_key: "notes.actions.builtin.detailedNotes", prompt: "User-edited Detailed Notes instruction." }]; }`,
    },
  });
  const { snapshotMeetingRecordingConfig } = await vite.ssrLoadModule("/helpers/meetingRecordingConfigSnapshot.ts");
  const savedTranscription = {
    mode: "providers",
    provider: "elevenlabs",
    model: "scribe_v2",
    language: "en",
  };

  const corrected = snapshotMeetingRecordingConfig(savedTranscription);
  assert.equal(routeGlobals.__meetingSnapshotRouteReads, 0, "summary correction does not resolve the current ASR route");
  assert.equal(corrected.configError, null);
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
  assert.equal(routeGlobals.__meetingSnapshotRouteReads, 1, "ordinary capture still validates current meeting settings");
});

test("meeting summary snapshots the selected bb harness, model and reasoning level", async (t: import("node:test").TestContext) => {
  const vite = await createRendererServer(t, {
    cachePrefix: "meeting-bb-snapshot-",
    mockModules: {
      "/stores/settingsStore.js": `export function getSettings() { return { preferredLanguage: "ru", uiLanguage: "ru", customDictionary: [], noteFormattingDisableThinking: false }; }`,
      "/config/settingsSelectors.js": `export function selectResolvedMeetingTranscription() { throw new Error("saved transcription should be used"); } export function selectResolvedNoteFormatting() { return { mode: "agent", agentProvider: "codex", agentModel: "gpt-6-luna", agentReasoningLevel: "high" }; }`,
      "/config/prompts.js": `export function appendDictionarySuffix(prompt) { return prompt; }`,
      "/config/secretKeys.js": `export const BYOK_API_KEYS = [];`,
      "/stores/actionStore.js": `export function getActions() { return [{ translation_key: "notes.actions.builtin.detailedNotes", prompt: "Current Detailed Notes prompt." }]; }`,
    },
  });
  const { snapshotMeetingRecordingConfig } = await vite.ssrLoadModule("/helpers/meetingRecordingConfigSnapshot.ts");
  const result = snapshotMeetingRecordingConfig({
    mode: "providers", provider: "elevenlabs", model: "scribe_v2", language: "ru",
  });
  assert.equal(result.configError, null);
  assert.equal(result.config.summary.reasoningMode, "agent");
  assert.equal(result.config.summary.agentProvider, "codex");
  assert.equal(result.config.summary.model, "gpt-6-luna");
  assert.equal(result.config.summary.agentReasoningLevel, "high");
});
