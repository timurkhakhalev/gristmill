const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");
import type { MeetingTranscriptionProvider, ResolveMeetingTranscriptionOptions } from "../../src/helpers/meetingTranscriptionRouting";

const load = () => import("../../src/helpers/meetingTranscriptionRouting.ts");
const modelRegistryData: { transcriptionProviders: { id: string; models: { id: string; streaming?: boolean }[] }[] } = require("../../src/models/modelRegistryData.json");

// Sentinels this module throws, paired with the MEETING_ERROR_KEYS entry that
// MeetingRecordingMount looks up. A healed legacy profile can reach any of them,
// so an untranslated one would show a bare sentinel in the failure toast.
const SENTINEL_KEYS = {
  unsupportedSelfHosted: "unsupportedSelfHosted",
  unsupportedProvider: "unsupportedProvider",
  noProviderSelected: "noProviderSelected",
};

const byokProviders: MeetingTranscriptionProvider[] = [
  {
    id: "openai",
    models: [{ id: "gpt-4o-mini-transcribe" }, { id: "gpt-4o-transcribe" }],
  },
  { id: "corti", models: [{ id: "corti-transcribe" }] },
  { id: "tinfoil", models: [{ id: "voxtral-mini-4b-realtime" }] },
  { id: "deepgram", models: [{ id: "nova-3", default: true }] },
  {
    id: "assemblyai",
    models: [{ id: "universal-streaming-english", default: true }],
  },
];

const baseOptions: ResolveMeetingTranscriptionOptions = {
  transcriptionMode: "providers",
  language: "en",
  localProvider: "whisper",
  whisperModel: "small",
  parakeetModel: "parakeet-tdt-0.6b-v3",
  selectedProvider: "tinfoil",
  selectedModel: "voxtral-mini-4b-realtime",
  byokProviders,
  cortiEnvironment: "us",
  cortiTenant: "tenant",
  keyterms: ["OpenWhispr"],
};

test("providers mode routes Tinfoil through its realtime client", async () => {
  const { resolveMeetingTranscriptionOptions } = await load();

  assert.deepEqual(resolveMeetingTranscriptionOptions(baseOptions), {
    provider: "tinfoil-realtime",
    model: "voxtral-mini-4b-realtime",
    mode: "byok",
    language: "en",
  });
});

test("BYOK Deepgram and AssemblyAI route to their own realtime clients", async () => {
  const { resolveMeetingTranscriptionOptions } = await load();

  for (const [selectedProvider, model] of [
    ["deepgram", "nova-3"],
    ["assemblyai", "universal-streaming-english"],
  ]) {
    assert.deepEqual(
      resolveMeetingTranscriptionOptions({ ...baseOptions, selectedProvider, selectedModel: "" }),
      { provider: `${selectedProvider}-realtime`, model, mode: "byok", language: "en" }
    );
  }
});

test("BYOK OpenAI never downgrades to managed cloud when its key is unavailable", async () => {
  const { resolveMeetingTranscriptionOptions } = await load();

  assert.deepEqual(
    resolveMeetingTranscriptionOptions({
      ...baseOptions,
      selectedProvider: "openai",
      selectedModel: "gpt-4o-mini-transcribe",
    }),
    {
      provider: "openai-realtime",
      model: "gpt-4o-mini-transcribe",
      mode: "byok",
      language: "en",
    }
  );
});

test("self-hosted mode never follows a stale Tinfoil provider", async () => {
  const { resolveMeetingTranscriptionOptions } = await load();

  assert.throws(
    () =>
      resolveMeetingTranscriptionOptions({
        ...baseOptions,
        transcriptionMode: "self-hosted",
      }),
    { message: "unsupportedSelfHosted" }
  );
});

test("local mode wins over stale cloud provider state", async () => {
  const { resolveMeetingTranscriptionOptions } = await load();

  assert.deepEqual(
    resolveMeetingTranscriptionOptions({
      ...baseOptions,
      transcriptionMode: "local",
      localProvider: "nvidia",
      parakeetModel: "nemotron-speech-streaming-en-0.6b",
    }),
    {
      provider: "local",
      localProvider: "nvidia",
      localModel: "nemotron-speech-streaming-en-0.6b",
      language: "en",
    }
  );
});

test("managed mode fails closed instead of routing through an OpenWhispr provider", async () => {
  const { resolveMeetingTranscriptionOptions } = await load();

  assert.throws(
    () => resolveMeetingTranscriptionOptions({ ...baseOptions, transcriptionMode: "openwhispr" as ResolveMeetingTranscriptionOptions["transcriptionMode"] }),
    /Unsupported Note Recording transcription mode/
  );
});

test("Corti keeps the meeting-specific connection settings", async () => {
  const { resolveMeetingTranscriptionOptions } = await load();

  assert.deepEqual(
    resolveMeetingTranscriptionOptions({
      ...baseOptions,
      selectedProvider: "corti",
      selectedModel: "corti-transcribe",
    }),
    {
      provider: "corti-realtime",
      model: "corti-transcribe",
      mode: "byok",
      language: "en",
      environment: "us",
      tenant: "tenant",
      keyterms: ["OpenWhispr"],
    }
  );
});

test("unknown and custom providers fail closed", async () => {
  const { resolveMeetingTranscriptionOptions } = await load();

  // Sentinels, translated at display time by MeetingRecordingMount. The named
  // provider rides after the colon so the toast can say which one failed.
  for (const [selectedProvider, message] of [
    ["custom", "unsupportedProvider:custom"],
    ["groq", "unsupportedProvider:groq"],
    ["", "noProviderSelected"],
    [undefined, "noProviderSelected"],
  ]) {
    assert.throws(
      () =>
        resolveMeetingTranscriptionOptions({
          ...baseOptions,
          selectedProvider,
        }),
      { message },
      `provider ${JSON.stringify(selectedProvider)}`
    );
  }
});

test("every thrown sentinel is translated and rendered by the mount", () => {
  const translation = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
  );
  const mount = fs.readFileSync(
    path.join(__dirname, "../../src/components/MeetingRecordingMount.tsx"),
    "utf8"
  );

  for (const [sentinel, key] of Object.entries(SENTINEL_KEYS)) {
    assert.equal(
      typeof translation.notes.meeting[key],
      "string",
      `notes.meeting.${key} missing from en/translation.json`
    );
    assert.ok(
      mount.includes(`${sentinel}: "notes.meeting.${key}"`),
      `MEETING_ERROR_KEYS is missing ${sentinel}`
    );
  }

  // The provider sentinel carries its argument after a colon, so its copy has to
  // have somewhere to put it.
  assert.match(translation.notes.meeting.unsupportedProvider, /\{\{provider\}\}/);
});

// gpt-live-transcribe has no server VAD and only completes a turn when the client
// commits, which dictation does on stop and a long-running meeting stream never
// does. Until that guard exists, the desktop must not be able to route a meeting
// onto it: no registry entry, and a stale selection falls back to the default.
test("gpt-live-transcribe is never offered for Note Recording", async () => {
  const { resolveMeetingTranscriptionOptions, filterMeetingStreamingProviders } = await load();
  // Mirrors getStreamingTranscriptionProviders(): the meeting BYOK picker.
  const registryStreamingProviders = filterMeetingStreamingProviders(modelRegistryData.transcriptionProviders
    .map((provider) => ({ ...provider, models: provider.models.filter((model) => model.streaming) }))
    .filter((provider) => provider.models.length > 0));
  for (const provider of registryStreamingProviders) {
    for (const model of provider.models) {
      assert.equal(model.id.startsWith("gpt-live-transcribe"), false, model.id);
    }
  }

  const route = resolveMeetingTranscriptionOptions({
      ...baseOptions,
      selectedProvider: "openai",
      selectedModel: "gpt-live-transcribe",
      byokProviders: registryStreamingProviders,
    });
  assert.equal(route.provider, "openai-realtime");
  assert.equal(route.model, "gpt-4o-mini-transcribe");
  assert.throws(
    () =>
      resolveMeetingTranscriptionOptions({
        ...baseOptions,
        transcriptionMode: "openwhispr" as ResolveMeetingTranscriptionOptions["transcriptionMode"],
        selectedModel: "gpt-live-transcribe",
      }),
    /Unsupported Note Recording transcription mode/
  );
});
