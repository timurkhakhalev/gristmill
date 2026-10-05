const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const path: typeof import("node:path") = require("node:path");

const ts = require("typescript");

type TranscriptionBaseUrlModule = typeof import("../../src/services/transcriptionBaseUrl.js");

let loaded: Promise<TranscriptionBaseUrlModule> | undefined;

const load = () => {
  if (!loaded) {
    const filename = path.join(__dirname, "../../src/services/transcriptionBaseUrl.ts");
    const source = fs.readFileSync(filename, "utf8");

    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;

    loaded = import(
      `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`
    ) as Promise<TranscriptionBaseUrlModule>;
  }

  return loaded;
};

const PROVIDERS = [
  { id: "openai", baseUrl: "https://api.openai.com/v1" },
  { id: "groq", baseUrl: "https://api.groq.com/openai/v1" },
  { id: "mistral", baseUrl: "https://api.mistral.ai/v1" },
  { id: "tinfoil", baseUrl: "https://inference.tinfoil.sh/v1" },
];

test("detects Tinfoil's inference host regardless of path or trailing slash", async () => {
  const { isTinfoilInferenceUrl } = await load();
  assert.equal(isTinfoilInferenceUrl("https://inference.tinfoil.sh/v1", PROVIDERS), true);
  assert.equal(isTinfoilInferenceUrl("https://inference.tinfoil.sh/v1/", PROVIDERS), true);
  assert.equal(
    isTinfoilInferenceUrl("https://inference.tinfoil.sh/v1/audio/transcriptions", PROVIDERS),
    true
  );
});

test("detects Tinfoil's inference host when the protocol is omitted", async () => {
  const { isTinfoilInferenceUrl } = await load();
  assert.equal(isTinfoilInferenceUrl("inference.tinfoil.sh/v1", PROVIDERS), true);
});

test("does not flag other hosts, lookalike hosts, or garbage input", async () => {
  const { isTinfoilInferenceUrl } = await load();
  assert.equal(isTinfoilInferenceUrl("https://api.openai.com/v1", PROVIDERS), false);
  assert.equal(isTinfoilInferenceUrl("https://inference.tinfoil.sh.evil.com/v1", PROVIDERS), false);
  assert.equal(isTinfoilInferenceUrl("http://127.0.0.1:8587/v1", PROVIDERS), false);
  assert.equal(isTinfoilInferenceUrl("", PROVIDERS), false);
  assert.equal(isTinfoilInferenceUrl("::not a url::", PROVIDERS), false);
});

test("never flags anything when Tinfoil is absent from the provider list", async () => {
  const { isTinfoilInferenceUrl } = await load();
  const withoutTinfoil = PROVIDERS.filter((p) => p.id !== "tinfoil");
  assert.equal(isTinfoilInferenceUrl("https://inference.tinfoil.sh/v1", withoutTinfoil), false);
});
