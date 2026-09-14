const test = require("node:test");
const assert = require("node:assert/strict");
const ts = require("typescript");
const fs = require("node:fs");
const path = require("node:path");

// Strict compiler probes for the pure settings-selectors graph, run against
// tsconfig.settings-selectors.json. The whole program is type-checked: a
// broken import must surface as a diagnostic, never as a false success.

const ROOT = path.join(__dirname, "..", "..");

function compileWithProbe(probeSource, probeName, mutateSources) {
  const configPath = path.join(ROOT, "tsconfig.settings-selectors.json");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, ROOT);
  const probe = path.join(ROOT, probeName);
  const virtualFiles = new Map(
    parsed.fileNames.map((file) => [
      path.relative(ROOT, file).split(path.sep).join("/"),
      fs.readFileSync(file, "utf8"),
    ])
  );
  if (mutateSources) mutateSources(virtualFiles);
  const host = ts.createCompilerHost(parsed.options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, onError, shouldCreate, ...rest) => {
    const relative = path.relative(ROOT, file).split(path.sep).join("/");
    if (file === probe) {
      return ts.createSourceFile(file, probeSource, languageVersion, true);
    }
    if (virtualFiles.has(relative)) {
      return ts.createSourceFile(file, virtualFiles.get(relative), languageVersion, true);
    }
    return readSource(file, languageVersion, onError, shouldCreate, ...rest);
  };
  const program = ts.createProgram([...parsed.fileNames, probe], parsed.options, host);
  // Full-program verdict: implementation files and file-less diagnostics all
  // count, so a broken graph can never hide behind a filtered probe.
  const diagnostics = ts.getPreEmitDiagnostics(program);
  return { codes: diagnostics.map((d) => d.code) };
}

test("probe: a wrong InferenceMode is rejected at compile time", () => {
  const { codes } = compileWithProbe(
    `import { selectResolvedLLMConfig } from "./src/config/settingsSelectors";
import type { InferenceSettingsSnapshot } from "./src/contracts/inferenceSettings";
const snapshot = {} as InferenceSettingsSnapshot;
selectResolvedLLMConfig(snapshot, "noteFormatting");
selectResolvedLLMConfig(snapshot, "dictation");
`,
    "settings-selectors-probe.ts"
  );
  assert.deepEqual(codes, [2345]);
});

test("probe: an invalid mode cannot reach buildReasoningScopePatches", () => {
  const { codes } = compileWithProbe(
    `import { buildReasoningScopePatches, inheritsFallbackEndpoint } from "./src/helpers/reasoningRouting";
buildReasoningScopePatches({ cleanupProvider: "openai" }, "totally-invalid-mode");
inheritsFallbackEndpoint({ mode: "providers" }, "totally-invalid-mode");
`,
    "settings-selectors-probe.ts"
  );
  assert.deepEqual(codes, [2345, 2345]);
});

test("probe: an implementation-file error is part of the verdict", () => {
  const { codes } = compileWithProbe(
    `import { selectResolvedLLMConfig } from "./src/config/settingsSelectors";
import type { InferenceSettingsSnapshot } from "./src/contracts/inferenceSettings";
const snapshot = {} as InferenceSettingsSnapshot;
selectResolvedLLMConfig(snapshot, "cleanup");
`,
    "settings-selectors-probe.ts",
    (virtualFiles) => {
      const target = "src/config/settingsSelectors.ts";
      virtualFiles.set(target, virtualFiles.get(target) + "\nconst broken: number = \"wrong\";\n");
    }
  );
  assert.deepEqual(codes, [2322]);
});

test("probe: a boolean where a provider string is read is rejected", () => {
  const { codes } = compileWithProbe(
    `import type { NoteFormattingScopeSettings } from "./src/contracts/inferenceSettings";
const bad = { noteFormattingProvider: true } as NoteFormattingScopeSettings;
`,
    "settings-selectors-probe.ts"
  );
  assert.deepEqual(codes, [2352]);
});

test("probe: a wrong result field type is rejected", () => {
  const { codes } = compileWithProbe(
    `import type { ResolvedLLMConfig } from "./src/config/settingsSelectors";
const config = { disableThinking: "yes" } as ResolvedLLMConfig;
`,
    "settings-selectors-probe.ts"
  );
  assert.deepEqual(codes, [2352]);
});

test("probe: correct usage compiles cleanly under strict", () => {
  const { codes } = compileWithProbe(
    `import { selectResolvedLLMConfig, selectResolvedNoteFormatting,
  selectResolvedUploadTranscription, selectResolvedMeetingTranscription,
} from "./src/config/settingsSelectors";
import type { InferenceSettingsSnapshot } from "./src/contracts/inferenceSettings";
const snapshot = {} as InferenceSettingsSnapshot;
const cfg = selectResolvedLLMConfig(snapshot, "chatIntelligence");
const fmt = selectResolvedNoteFormatting(snapshot);
const upload = selectResolvedUploadTranscription(snapshot);
const meeting = selectResolvedMeetingTranscription(snapshot);
const mode: string = cfg.mode;
const key: string = fmt.customApiKey;
const provider: string = upload.cloudTranscriptionProvider;
export { cfg, fmt, upload, meeting, mode, key, provider };
`,
    "settings-selectors-probe.ts"
  );
  assert.deepEqual(codes, []);
});

test("probe: a DOM/global dependency cannot enter the pure graph", () => {
  const { codes } = compileWithProbe(
    `import { selectResolvedLLMConfig } from "./src/config/settingsSelectors";
import type { InferenceSettingsSnapshot } from "./src/contracts/inferenceSettings";
const snapshot = {} as InferenceSettingsSnapshot;
declare const el: HTMLElement;
selectResolvedLLMConfig(snapshot, "cleanup");
`,
    "settings-selectors-probe.ts"
  );
  // With types:[] there is no DOM lib here: HTMLElement is unresolvable.
  assert.deepEqual(codes, [2304]);
});
