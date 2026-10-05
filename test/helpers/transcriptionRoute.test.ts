const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const load = () => import("../../src/helpers/transcriptionRoute.ts");

const resolve = async (
  settings: import("../../src/helpers/transcriptionRoute.ts").TranscriptionRouteSettings &
    Record<string, unknown>,
  extra: Record<string, unknown> = {}
): Promise<any> => {
  const { resolveTranscriptionRoute } = await load();

  return resolveTranscriptionRoute({ settings, ...extra });
};

test("self-hosted routes to the configured server and wins over stale flags", async () => {
  const route = await resolve({
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: "http://192.168.1.5:11434/v1",
    remoteTranscriptionModel: "whisper-1",
    useLocalWhisper: true,
    cloudTranscriptionProvider: "mistral",
  });

  assert.equal(route.transport, "http-batch");
  assert.equal(route.provider, "self-hosted");
  assert.equal(route.endpoint, "http://192.168.1.5:11434/v1/audio/transcriptions");
  assert.deepEqual(route.auth, { scheme: "none", keyRef: null });
  assert.equal(route.sizeCapBytes, null);
});

test("self-hosted mode without a URL fails closed unless the provider is custom", async () => {
  for (const provider of ["openai", "groq", "mistral", "xai", "corti", "gemini", "tinfoil"]) {
    const route = await resolve({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "",
      cloudTranscriptionProvider: provider,
    });

    assert.equal(route.transport, "error", provider);
    assert.match(route.message, /not configured/, provider);
  }

  // byok+custom persists transcriptionMode="self-hosted" (deriveTranscriptionMode),
  // so a custom user with a cleared remote URL must still reach their endpoint.
  const customRoute = await resolve({
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: "",
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionBaseUrl: "https://stt.parasail.example.com/v1",
  });

  assert.equal(customRoute.transport, "http-batch");
  assert.equal(customRoute.provider, "custom");
  assert.equal(customRoute.endpoint, "https://stt.parasail.example.com/v1/audio/transcriptions");
});

test("self-hosted fails closed on invalid or public-http URLs", async () => {
  for (const remoteTranscriptionUrl of [
    "not a url",
    "ftp://localhost:8080",
    "http://example.com/v1",
  ]) {
    const route = await resolve({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl,
      cloudTranscriptionProvider: "openai",
    });

    assert.equal(route.transport, "error", remoteTranscriptionUrl);
    assert.match(route.message, /invalid or unsupported/, remoteTranscriptionUrl);
  }
});

test("local mode yields a bare local route; decode details stay with the local managers", async () => {
  assert.deepEqual(await resolve({ useLocalWhisper: true, whisperModel: "small" }), {
    transport: "local",
  });
});

test("proxied providers carry their quirks as route data", async () => {
  const tinfoil = await resolve({ cloudTranscriptionProvider: "tinfoil" });
  assert.equal(tinfoil.transport, "proxied");
  assert.equal(tinfoil.model, null, "tinfoil's attested client resolves its own model");

  const deepgram = await resolve({ cloudTranscriptionProvider: "deepgram" });
  assert.equal(deepgram.transport, "proxied");
  assert.equal(deepgram.provider, "deepgram");
  assert.equal(deepgram.model, "nova-3");
  assert.equal(deepgram.sizeCapBytes, 2 * 1024 * 1024 * 1024);

  const elevenlabs = await resolve({ cloudTranscriptionProvider: "elevenlabs" });
  assert.equal(elevenlabs.transport, "proxied");
  assert.equal(elevenlabs.model, "scribe_v2");
  assert.equal(elevenlabs.sizeCapBytes, 3 * 1024 * 1024 * 1024);

  const flux = await resolve({
    cloudTranscriptionProvider: "deepgram",
    cloudTranscriptionModel: "flux-general-en",
  });

  assert.equal(flux.transport, "error");
  assert.equal(flux.code, "DEEPGRAM_MODEL_UNSUPPORTED");

  const mistral = await resolve({
    cloudTranscriptionProvider: "mistral",
    cloudTranscriptionModel: "voxtral-small-latest",
  });

  assert.equal(mistral.model, "voxtral-small-latest");

  const xai = await resolve({
    cloudTranscriptionProvider: "xai",
    preferredLanguage: "mk",
  });

  assert.equal(xai.model, "grok-stt", "recorded for history; executors omit the form field");
  assert.equal(xai.language, "mk");

  const xaiUnsupported = await resolve({
    cloudTranscriptionProvider: "xai",
    preferredLanguage: "yo",
  });

  assert.equal(xaiUnsupported.language, undefined, "outside the xAI ITN allowlist");

  const corti = await resolve({ cloudTranscriptionProvider: "corti", cortiTenant: " acme " });
  assert.equal(corti.model, "corti-transcribe");
  assert.equal(corti.language, "en", "Corti needs a concrete language even on auto");
  assert.equal(corti.cortiEnvironment, "us");
  assert.equal(corti.cortiTenant, "acme");

  const gemini = await resolve({ cloudTranscriptionProvider: "gemini" });
  assert.equal(gemini.transport, "proxied");
  assert.equal(gemini.model, "gemini-3.5-transcribe");
  assert.equal(gemini.sizeCapBytes, 2 * 1024 * 1024 * 1024, "Gemini Files API accepts up to 2 GB");

  const geminiLive = await resolve({
    cloudTranscriptionProvider: "gemini",
    cloudTranscriptionModel: "gemini-3.5-transcribe-live",
  });

  assert.equal(geminiLive.code, "GEMINI_MODEL_UNSUPPORTED");
});

test("byokFileSizeLimit matches the per-provider route caps", async () => {
  const { byokFileSizeLimit } = await load();
  assert.equal(byokFileSizeLimit("gemini"), 2 * 1024 * 1024 * 1024);
  assert.equal(byokFileSizeLimit("deepgram"), 2 * 1024 * 1024 * 1024);
  assert.equal(byokFileSizeLimit("elevenlabs"), 3 * 1024 * 1024 * 1024);
  assert.equal(byokFileSizeLimit("openai"), 25 * 1024 * 1024);
});

test("custom requires a configured secure endpoint (empty, sentinel, garbage all fail)", async () => {
  const { resolveTranscriptionRoute } = await load();

  for (const cloudTranscriptionBaseUrl of [
    "",
    "   ",
    "https://api.openai.com/v1", // the untouched store default
    "not a url",
    "http://public.example.com/v1",
    "ftp://192.168.1.20/v1",
  ]) {
    const route = resolveTranscriptionRoute({
      settings: { cloudTranscriptionProvider: "custom", cloudTranscriptionBaseUrl },
    });

    assert.equal(route.transport, "error", cloudTranscriptionBaseUrl);
    assert.equal(
      (route as { code?: string }).code,
      "CUSTOM_ENDPOINT_INVALID",
      cloudTranscriptionBaseUrl
    );
  }

  const localhost = await resolve({
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionBaseUrl: "http://localhost:1234/v1",
    cloudTranscriptionModel: "my-model",
  });

  assert.equal(localhost.transport, "http-batch");
  assert.equal(localhost.endpoint, "http://localhost:1234/v1/audio/transcriptions");
  assert.equal(localhost.model, "my-model");
  assert.deepEqual(localhost.auth, { scheme: "bearer", keyRef: "custom" });
});

// The pre-guard fall-through returned an OpenAI http-batch route with
// keyRef "openai" for any unrecognised provider, so selecting a realtime-only
// provider and then uploading or retrying would have POSTed the user's audio to
// api.openai.com under their OpenAI key.
test("realtime-only providers fail closed instead of falling through to OpenAI", async () => {
  const { STREAMING_ONLY_PROVIDERS } =
    await import("../../src/config/transcriptionCapabilities.ts");

  assert.ok(STREAMING_ONLY_PROVIDERS.size > 0);

  for (const provider of STREAMING_ONLY_PROVIDERS) {
    for (const model of [undefined, "nova-3", "gpt-4o-mini-transcribe"]) {
      const route = await resolve({
        cloudTranscriptionProvider: provider,
        cloudTranscriptionModel: model,
      });

      assert.equal(route.transport, "error", `${provider} must not produce a batch route`);
      assert.equal(route.code, "STREAMING_ONLY_PROVIDER", provider);
      assert.equal(
        route.messageKey,
        "hooks.audioRecording.errorDescriptions.streamingOnlyProvider"
      );
      assert.equal(route.provider, undefined, provider);
      assert.equal(route.endpoint, undefined, provider);
      assert.equal(
        JSON.stringify(route).includes("openai.com"),
        false,
        `${provider} route leaked an OpenAI endpoint`
      );
    }
  }
});

// Dictation only reaches the batch path for these providers when streaming was
// skipped for want of a key, so the key — not the transport — is the diagnosis
// there. Retry and upload cannot know about keys and keep the transport error.
test("realtime-only providers report a missing key ahead of the transport limitation", async () => {
  const { STREAMING_ONLY_PROVIDERS } =
    await import("../../src/config/transcriptionCapabilities.ts");

  for (const provider of STREAMING_ONLY_PROVIDERS) {
    const missingKey = await resolve(
      { cloudTranscriptionProvider: provider },
      { hasProviderKey: false }
    );

    assert.equal(missingKey.transport, "error", provider);
    assert.equal(missingKey.code, "API_KEY_MISSING", provider);
    assert.equal(
      missingKey.messageKey,
      "hooks.audioRecording.errorDescriptions.providerKeyMissing",
      provider
    );
    assert.equal(JSON.stringify(missingKey).includes("openai.com"), false, provider);

    for (const hasProviderKey of [true, undefined]) {
      const route = await resolve({ cloudTranscriptionProvider: provider }, { hasProviderKey });
      assert.equal(route.code, "STREAMING_ONLY_PROVIDER", `${provider} key=${hasProviderKey}`);
    }
  }

  // The hint is only about realtime-only providers: batch providers diagnose
  // their own missing key at the key read, with the store+env fallback.
  const groq = await resolve({ cloudTranscriptionProvider: "groq" }, { hasProviderKey: false });
  assert.equal(groq.transport, "http-batch");
});

test("a custom URL pointing at Tinfoil's host must use the attested proxy", async () => {
  const route = await resolve(
    {
      cloudTranscriptionProvider: "custom",
      cloudTranscriptionBaseUrl: "https://inference.tinfoil.sh/v1",
    },
    { providers: [{ id: "tinfoil", baseUrl: "https://inference.tinfoil.sh/v1" }] }
  );

  assert.equal(route.transport, "error");
  assert.match(route.message, /attested main-process proxy/);
});

test("Azure custom endpoints build deployment URLs from the raw base", async () => {
  const route = await resolve({
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionBaseUrl: "https://myres.openai.azure.com",
    cloudTranscriptionModel: "my-deployment",
  });

  assert.equal(
    route.endpoint,
    "https://myres.openai.azure.com/openai/deployments/my-deployment/audio/transcriptions?api-version=2025-03-01-preview"
  );
  assert.deepEqual(route.auth, { scheme: "azure-api-key", keyRef: "custom" });

  // A user-pinned full path survives — normalization must not strip it.
  const pinned = await resolve({
    cloudTranscriptionProvider: "custom",
    cloudTranscriptionBaseUrl:
      "https://myres.openai.azure.com/openai/deployments/d1/audio/transcriptions?api-version=2024-06-01",
    cloudTranscriptionModel: "ignored",
  });

  assert.match(pinned.endpoint, /deployments\/d1\/audio\/transcriptions\?api-version=2024-06-01/);
});

// migrateProviderSettings files every legacy `custom + byok` user under
// transcriptionMode "self-hosted" and copies their base URL across, so Azure
// endpoints reach the resolver through this branch too.
test("Azure self-hosted endpoints build deployment URLs, like Custom ones", async () => {
  const route = await resolve({
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: "https://myres.openai.azure.com",
    remoteTranscriptionModel: "my-deployment",
  });

  assert.equal(route.provider, "self-hosted");
  assert.equal(
    route.endpoint,
    "https://myres.openai.azure.com/openai/deployments/my-deployment/audio/transcriptions?api-version=2025-03-01-preview"
  );

  const pinned = await resolve({
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl:
      "https://myres.openai.azure.com/openai/deployments/d1/audio/transcriptions?api-version=2024-06-01",
    remoteTranscriptionModel: "ignored",
  });

  assert.match(pinned.endpoint, /deployments\/d1\/audio\/transcriptions\?api-version=2024-06-01/);

  // Non-Azure self-hosted servers keep the plain OpenAI-compatible path.
  const plain = await resolve({
    transcriptionMode: "self-hosted",
    remoteTranscriptionUrl: "https://stt.internal.example.com",
    remoteTranscriptionModel: "tiny",
  });

  assert.equal(plain.endpoint, "https://stt.internal.example.com/audio/transcriptions");
});

test("openai and groq route to fixed endpoints with provider-validated models", async () => {
  const openai = await resolve({});
  assert.equal(openai.provider, "openai");
  assert.equal(openai.endpoint, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(openai.model, "gpt-transcribe");
  assert.equal(openai.sizeCapBytes, 25 * 1024 * 1024);

  // The deprecated OpenAI ids stay selectable and must reach the API untouched;
  // only an empty or foreign selection takes the new default.
  for (const legacy of ["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"]) {
    const route = await resolve({ cloudTranscriptionModel: legacy });
    assert.equal(route.model, legacy);
  }

  const groqStale = await resolve({
    cloudTranscriptionProvider: "groq",
    cloudTranscriptionModel: "voxtral-mini-latest", // stale from a mistral era
  });

  assert.equal(groqStale.endpoint, "https://api.groq.com/openai/v1/audio/transcriptions");
  assert.equal(groqStale.model, "whisper-large-v3-turbo", "mismatched model degrades to default");
  assert.deepEqual(groqStale.auth, { scheme: "bearer", keyRef: "groq" });
});

test("request overrides win: explicit model and effective language", async () => {
  const route = await resolve(
    { cloudTranscriptionProvider: "groq", preferredLanguage: "de-DE" },
    { request: { model: "whisper-large-v3", effectiveLanguage: "ja" } }
  );

  assert.equal(route.model, "whisper-large-v3");
  assert.equal(route.language, "ja");
});

test("enterprise transcription mode fails closed without organization routing", async () => {
  const route = await resolve({
    transcriptionMode: "enterprise",
    cloudTranscriptionProvider: "openai",
  });

  assert.equal(route.transport, "error");
  assert.equal(route.code, "UNSUPPORTED_TRANSCRIPTION_MODE");
});
