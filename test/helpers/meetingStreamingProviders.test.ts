const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const load = () => import("../../src/helpers/meetingStreamingProviders.ts");

test("tinfoil-realtime resolves to the Tinfoil client, never the OpenAI default", async () => {
  const { STREAMING_CLIENT_BY_PROVIDER } = await load();
  const { TinfoilRealtimeStreaming } =
    await import("../../src/helpers/tinfoilRealtimeStreaming.ts");
  const { OpenAIRealtimeStreaming } = await import("../../src/helpers/openaiRealtimeStreaming.ts");

  assert.equal(STREAMING_CLIENT_BY_PROVIDER["tinfoil-realtime"], TinfoilRealtimeStreaming);
  assert.notEqual(STREAMING_CLIENT_BY_PROVIDER["tinfoil-realtime"], OpenAIRealtimeStreaming);
});

test("every allowed realtime provider has a streaming client (no silent OpenAI fallback)", async () => {
  const { STREAMING_CLIENT_BY_PROVIDER, ALLOWED_MEETING_PROVIDERS } = await load();

  for (const provider of ALLOWED_MEETING_PROVIDERS) {
    if (provider === "local") continue;
    assert.equal(
      typeof STREAMING_CLIENT_BY_PROVIDER[provider],
      "function",
      `${provider} is allowed but would fall through to the OpenAI default class`
    );
  }
});

test("allow-list accepts tinfoil-realtime and local", async () => {
  const { ALLOWED_MEETING_PROVIDERS } = await load();

  assert.equal(ALLOWED_MEETING_PROVIDERS.has("tinfoil-realtime"), true);
  assert.equal(ALLOWED_MEETING_PROVIDERS.has("local"), true);
});

test("every provider note recording offers is one the main process accepts", async () => {
  const { ALLOWED_MEETING_PROVIDERS } = await load();
  const { MEETING_STREAMING_PROVIDER_IDS } =
    await import("../../src/helpers/meetingTranscriptionRouting.ts");

  // Note recording derives its streaming provider id by concatenation
  // (`${provider.id}-realtime`), so an offered catalog id with no client class
  // is rejected at meeting-transcription-prepare with no user-visible message.
  for (const id of MEETING_STREAMING_PROVIDER_IDS) {
    assert.equal(
      ALLOWED_MEETING_PROVIDERS.has(`${id}-realtime`),
      true,
      `${id} is offered for note recording but ${id}-realtime has no streaming client`
    );
  }
});

test("a dictation-only streaming provider is not offered for note recording", async () => {
  const { getStreamingTranscriptionProviders, getMeetingStreamingTranscriptionProviders } =
    await import("../../src/models/ModelRegistry.ts");

  const streamingIds: string[] = getStreamingTranscriptionProviders().map((provider) => provider.id);
  const meetingIds: string[] = getMeetingStreamingTranscriptionProviders().map((provider) => provider.id);

  assert.ok(streamingIds.includes("gemini"), "gemini ships a streaming dictation model");
  assert.equal(meetingIds.includes("gemini"), false);
});

// The intersection is an allow-list, so a new streaming provider is silently
// excluded from note recording unless it is listed. Deepgram and AssemblyAI are
// the managed note-recording providers and must stay admitted.
test("deepgram and assemblyai are offered for note recording", async () => {
  const { getMeetingStreamingTranscriptionProviders } =
    await import("../../src/models/ModelRegistry.ts");

  const meetingIds = getMeetingStreamingTranscriptionProviders().map((provider) => provider.id);
  assert.ok(meetingIds.includes("deepgram"));
  assert.ok(meetingIds.includes("assemblyai"));
});

test("allow-list rejects unknown and batch-only providers", async () => {
  const { ALLOWED_MEETING_PROVIDERS } = await load();

  // The bare ids are live settings values now, so they must not be mistaken for
  // meeting provider ids (which always carry the "-realtime" suffix).
  for (const provider of [
    "tinfoil",
    "openai",
    "deepgram",
    "assemblyai",
    "mistral-realtime",
    "grok-stt",
    "",
    undefined,
  ]) {
    assert.equal(Reflect.apply(ALLOWED_MEETING_PROVIDERS.has, ALLOWED_MEETING_PROVIDERS, [provider]), false, `${provider} must be rejected`);
  }
});

test("client lookup fails closed instead of defaulting to OpenAI", async () => {
  const { STREAMING_CLIENT_BY_PROVIDER, getMeetingStreamingClient } = await load();

  assert.throws(() => Reflect.apply(getMeetingStreamingClient, undefined, ["unknown-realtime"]), /Unsupported meeting/);
  assert.equal(
    getMeetingStreamingClient(Object("openai-realtime")),
    STREAMING_CLIENT_BY_PROVIDER["openai-realtime"]
  );
});

test("OpenAI-derived streaming clients carry their own provider log label", async () => {
  const { STREAMING_CLIENT_BY_PROVIDER } = await load();
  const { OpenAIRealtimeStreaming } = await import("../../src/helpers/openaiRealtimeStreaming.ts");
  const baseLabel = new OpenAIRealtimeStreaming().providerLabel;

  assert.equal(typeof baseLabel, "string");
  assert.ok(baseLabel.length > 0, "the base class must define a provider log label");

  for (const [provider, StreamingClient] of Object.entries(STREAMING_CLIENT_BY_PROVIDER)) {
    if (StreamingClient === OpenAIRealtimeStreaming) continue;
    if (!Object.prototype.isPrototypeOf.call(OpenAIRealtimeStreaming.prototype, StreamingClient.prototype)) continue;
    const client = new StreamingClient();
    assert.ok("providerLabel" in client);
    assert.notEqual(
      client.providerLabel,
      baseLabel,
      `${provider} inherits the OpenAI log label and would misreport where audio goes`
    );
  }
});

test("connection identity includes every provider-specific option", async () => {
  const { getMeetingConnectionKey } = await load();
  const options = {
    provider: "corti-realtime",
    model: "corti-transcribe",
    language: "en",
    mode: "byok",
    environment: "us",
    tenant: "tenant-a",
    keyterms: ["OpenWhispr"],
  };

  assert.equal(getMeetingConnectionKey(options), getMeetingConnectionKey({ ...options }));
  assert.notEqual(
    getMeetingConnectionKey(options),
    getMeetingConnectionKey({ ...options, provider: "tinfoil-realtime" })
  );
  assert.notEqual(
    getMeetingConnectionKey(options),
    getMeetingConnectionKey({ ...options, tenant: "tenant-b" })
  );
});
