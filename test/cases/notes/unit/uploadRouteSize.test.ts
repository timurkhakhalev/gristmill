const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const vm: typeof import("node:vm") = require("node:vm");

const ts: typeof import("typescript") = require("typescript");

// Drive the actual view's single and batch gates, including its route input.
// This catches a resolver wired without the endpoint or mode settings.
const source = fs.readFileSync("src/components/notes/UploadAudioView.tsx", "utf8");

const tree = ts.createSourceFile(
  "view.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);

const wanted = [
  "uploadRoute",
  "sizeCapBytes",
  "byokMaxFileSizeMb",
  "byokTooLarge",
  "getBatchSizeErrorKey",
];

const initializers = new Map<string, string>();

function visit(node: import("typescript").Node) {
  if (
    ts.isVariableDeclaration(node) &&
    wanted.includes(node.name.getText(tree)) &&
    node.initializer
  ) {
    initializers.set(node.name.getText(tree), node.initializer.getText(tree));
  }

  ts.forEachChild(node, visit);
}

visit(tree);

const cases = [
  {
    name: "Custom",
    settings: {
      cloudTranscriptionProvider: "custom",
      cloudTranscriptionBaseUrl: "https://example.com/v1",
    },
    cap: 25 * 1024 ** 2,
  },
  {
    name: "Custom with derived self-hosted mode",
    settings: {
      transcriptionMode: "self-hosted",
      cloudTranscriptionProvider: "custom",
      cloudTranscriptionBaseUrl: "https://example.com/v1",
    },
    cap: 25 * 1024 ** 2,
  },
  {
    name: "Self-Hosted with stale provider",
    settings: {
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "http://127.0.0.1:8080/v1",
      cloudTranscriptionProvider: "openai",
    },
    cap: null,
  },
  { name: "Local", settings: { useLocalWhisper: true }, cap: null },
  { name: "OpenAI", settings: { cloudTranscriptionProvider: "openai" }, cap: 25 * 1024 ** 2 },
  { name: "Deepgram", settings: { cloudTranscriptionProvider: "deepgram" }, cap: 2 * 1024 ** 3 },
  {
    name: "ElevenLabs",
    settings: { cloudTranscriptionProvider: "elevenlabs" },
    cap: 3 * 1024 ** 3,
  },
];

for (const { name, settings, cap } of cases) {
  test(`${name} single and batch upload agree with the execution route cap`, async () => {
    const { resolveTranscriptionRoute } =
      await import("../../../../src/helpers/transcriptionRoute.ts");

    for (const bytes of cap === null ? [10 * 1024 ** 3] : [cap, cap + 1]) {
      const sandbox: Record<string, any> = {
        useLocalWhisper: false,
        transcriptionMode: "providers",
        remoteTranscriptionUrl: "",
        remoteTranscriptionModel: "",
        cloudTranscriptionProvider: "openai",
        cloudTranscriptionModel: "",
        cloudTranscriptionBaseUrl: "",
        cortiEnvironment: "us",
        cortiTenant: "base",
        preferredLanguage: "auto",
        ...settings,
        file: { sizeBytes: bytes },
        resolveTranscriptionRoute,
        getTranscriptionProviders: () => [],
      };

      for (const name of wanted) {
        const initializer = initializers.get(name);
        assert.ok(initializer, `View initializer ${name}`);

        const js = ts.transpileModule(`(${initializer})`, {
          compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText;

        sandbox[name] = vm.runInNewContext(js, sandbox);
      }

      assert.equal(sandbox.sizeCapBytes, cap);
      const tooLarge = cap !== null && bytes > cap;
      assert.equal(sandbox.byokTooLarge, tooLarge);
      assert.equal(sandbox.getBatchSizeErrorKey(bytes), tooLarge ? "byokTooLarge" : null);
    }
  });
}
