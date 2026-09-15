// Strict compiler probes for the migrated download/filesystem and sidecar
// primitives. The positive graph is the strict main tsconfig itself (these
// modules are part of it); this probe adds negative checks that the typed
// boundaries actually reject wrong usage.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "../..");
const configPath = path.join(root, "tsconfig.main.json");

function probeDiagnostics(source) {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.equal(parsed.options.strict, true);
  const probe = path.join(root, "downloads-type-probe.ts");
  const host = ts.createCompilerHost(parsed.options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, ...args) =>
    file === probe
      ? ts.createSourceFile(file, source, languageVersion, true)
      : readSource(file, languageVersion, ...args);
  const program = ts.createProgram([probe], { ...parsed.options, noEmit: true }, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  return {
    codes: diagnostics.map((d) => d.code).sort((a, b) => a - b),
    cleanup: () => {
      if (fs.existsSync(probe)) fs.rmSync(probe, { force: true });
    },
  };
}

test("wrong download/ffmpeg/sidecar usage fails compilation", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { convertToWav, mergeAudioSegments, splitAudioFile } from "./src/helpers/ffmpegUtils.js";
import { createDownloadSignal, downloadFile } from "./src/helpers/downloadUtils.js";
import { write as writePid } from "./src/helpers/sidecarPidFile.js";
import { register as registerSidecar } from "./src/helpers/sidecarRegistry.js";
import { reapStaleSidecars } from "./src/helpers/sidecarReaper.js";

// Conversion options are typed: a string sample rate is rejected.
convertToWav("/tmp/a.wav", "/tmp/a.out.wav", { sampleRate: "16000" });

// Segment buffers carry audio data, not arbitrary objects.
mergeAudioSegments([{ buffer: { notAudio: true } }]);

// Split options need numbers/AbortSignal.
splitAudioFile("/tmp/a.wav", "/tmp/out", { segmentDuration: "10", signal: "none" });

// A DOM AbortSignal is not the download signal the model managers share.
downloadFile("https://x", "/tmp/x", { signal: new AbortController().signal });

// The pid file takes an integer pid.
writePid("whisper", "1234");

// Sidecar stop callbacks are functions.
registerSidecar("whisper", "stop");

// Reaper options are numbers.
reapStaleSidecars({ sigtermGraceMs: "5" });
`);
  try {
    assert.ok(codes.includes(2345), `wrong arguments must fail, got ${codes.join(",")}`);
    // Wrong field values (string where number/typed value expected) report as
    // assignment errors on the call arguments/options objects.
    assert.ok(
      codes.filter((code) => code === 2322).length >= 3,
      `wrong property usage must fail, got ${codes.join(",")}`
    );
    // Every wrong call site reports its own diagnostic across the probe source.
    assert.ok(
      codes.length >= 7,
      `each wrong call site reports its own diagnostic, got ${codes.join(",")}`
    );
  } finally {
    cleanup();
  }
});

test("the full primitive graph compiles under strict settings", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { convertToWav, mergeAudioSegments, parseWavFormat } from "./src/helpers/ffmpegUtils.js";
import {
  createDownloadSignal,
  downloadFile,
  extractArchive,
  checkDiskSpace,
  fetchJson,
  validateFileSize,
  cleanupStaleDownloads,
  findFile,
  findFiles,
  createDownloadInProgressError,
} from "./src/helpers/downloadUtils.js";
import { resolveSystemTarExecutable, runSystemTar } from "./src/helpers/systemTar.js";
import { write as writePid, clear as clearPid, readAll as readPids } from "./src/helpers/sidecarPidFile.js";
import { register as registerSidecar, shutdownAll } from "./src/helpers/sidecarRegistry.js";
import { reapStaleSidecars, waitForExit } from "./src/helpers/sidecarReaper.js";
import { getSafeTempDir } from "./src/helpers/safeTempDir.js";
import { resolveBundledBinary } from "./src/helpers/binaryResolver.js";
import { getCacheRoot, getModelsDirForService, pathHasProblematicChars } from "./src/helpers/modelDirUtils.js";
import { runCommand, killProcess, killProcessGroup, TIMEOUTS } from "./src/utils/process.js";
import {
  findAvailablePort,
  isPortAvailable,
  resolveBinaryPath,
  gracefulStopProcess,
} from "./src/utils/serverUtils.js";
import { createAbortError } from "./src/helpers/abortError.js";
import {
  download,
  downloadDirect,
  downloadViaProxy,
  detectUrlType,
  isPrivateIp,
  isAcceptableAudioContentType,
  sweepStaleTempArtifacts,
} from "./src/helpers/urlAudioDownloader.js";
import type { ChildProcess } from "child_process";

async function useAll(): Promise<string> {
  const { signal, abort } = createDownloadSignal();
  abort();
  await downloadFile("https://example.com/model.bin", "/tmp/model.bin", {
    onProgress: (done, total) => void (done + total),
    signal,
    expectedSize: 1024,
  });
  await convertToWav("/tmp/a.wav", "/tmp/a.out.wav", { sampleRate: 16000, channels: 1 });
  await mergeAudioSegments([{ buffer: Buffer.from("x"), mimeType: "audio/webm" }]);
  const format = parseWavFormat(Buffer.from("RIFF"));
  void format?.sampleRate;
  await extractArchive("/tmp/a.tar.gz", "/tmp/out");
  await checkDiskSpace("/tmp", 1024);
  await fetchJson<{ tag: string }>("https://example.com/meta.json");
  await validateFileSize("/tmp/model.bin", 1024);
  await cleanupStaleDownloads("/tmp");
  await findFile("/tmp", "model.bin");
  await findFiles("/tmp", /model/);
  void createDownloadInProgressError("m", "active").code;
  await runSystemTar("/tmp/a.tar.gz", "/tmp/out", { timeoutMs: TIMEOUTS.INSTALL });
  void resolveSystemTarExecutable({ platform: "darwin" });
  writePid("whisper", 4242);
  clearPid("whisper");
  for (const entry of readPids()) void entry.pid;
  registerSidecar("whisper", async () => undefined);
  await shutdownAll();
  await reapStaleSidecars({ sigtermGraceMs: 1, sigkillGraceMs: 1 });
  await waitForExit(4242, 10);
  void getSafeTempDir();
  void resolveBundledBinary("probe", "ctx");
  void pathHasProblematicChars(getCacheRoot());
  void getModelsDirForService("whisper");
  const result = await runCommand("echo", ["hi"]);
  void result.output;
  killProcess(null);
  killProcessGroup(null);
  void (await findAvailablePort(10000, 10010));
  void (await isPortAvailable(8080));
  void resolveBinaryPath("ffmpeg");
  await gracefulStopProcess(null as unknown as ChildProcess);
  void createAbortError().name;
  void detectUrlType("https://example.com/a.mp3");
  void isPrivateIp("10.0.0.1");
  void isAcceptableAudioContentType("audio/mpeg");
  await downloadDirect("https://example.com/a.mp3");
  await downloadViaProxy("https://example.com/a.mp3");
  await download("https://example.com/a.mp3");
  sweepStaleTempArtifacts(1000);
  return "ok";
}
void useAll;
`);
  try {
    assert.deepEqual(codes, []);
  } finally {
    cleanup();
  }
});
