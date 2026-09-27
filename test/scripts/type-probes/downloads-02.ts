// @probe-name "the full primitive graph compiles under strict settings"
// @probe-codes []
// @probe-origin test/scripts/downloadsTypeProbe.test.js
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
