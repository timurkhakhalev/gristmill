// Strict compiler probes for the native audio/PCM migration. The probe is
// compile-only: native helpers are never loaded or executed by vm.
const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const path: typeof import("node:path") = require("node:path");

const ts: typeof import("typescript") = require("typescript");

const root = path.resolve(__dirname, "../..");

const configPath = path.join(root, "tsconfig.main.json");

function diagnosticsFor(source: string) {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.equal(parsed.options.strict, true);
  const probe = path.join(root, "native-audio-capture-type-probe.ts");
  const host = ts.createCompilerHost(parsed.options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, ...args) =>
    file === probe
      ? ts.createSourceFile(file, source, languageVersion, true)
      : readSource(file, languageVersion, ...args);
  const program = ts.createProgram([probe], { ...parsed.options, noEmit: true }, host);

  return ts.getPreEmitDiagnostics(program).map((diagnostic) => diagnostic.code);
}

test("native tap and activity monitor contracts reject wrong calls under strict main target", () => {
  const codes = diagnosticsFor(`
import { AudioTapManager } from "./src/helpers/audioTapManager.ts";
import { createMeetingAudioActivityMonitor } from "./src/helpers/meetingAudioActivityMonitor.ts";

const tap = new AudioTapManager();
tap.start({ onChunk: (chunk: string) => chunk.length });
createMeetingAudioActivityMonitor({ onActivityChanged: (state) => state.other });
`);

  assert.deepEqual(
    codes.sort((a, b) => a - b),
    [2322, 2339],
    "only the invalid callback and state property must fail"
  );
});
