const test = require("node:test");
const assert = require("node:assert/strict");
const ts = require("typescript");
const path = require("node:path");

// Strict compiler probes for the pure settings-selectors graph, run against
// tsconfig.settings-selectors.json. The whole program is type-checked: a
// broken import must surface as a diagnostic, never as a false success.

const ROOT = path.join(__dirname, "..", "..");

function compileWithProbe(probeSource, probeName) {
  const configPath = path.join(ROOT, "tsconfig.settings-selectors.json");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, ROOT);
  const probe = path.join(ROOT, probeName);
  const host = ts.createCompilerHost(parsed.options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, onError, shouldCreate, ...rest) =>
    file === probe
      ? ts.createSourceFile(file, probeSource, languageVersion, true)
      : readSource(file, languageVersion, onError, shouldCreate, ...rest);
  const program = ts.createProgram([...parsed.fileNames, probe], parsed.options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program).filter(
    (d) => d.file && d.file.fileName === probe
  );
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
