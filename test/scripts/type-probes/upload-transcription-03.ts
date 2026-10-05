// @probe-name "the full registration set and bridge compile under strict settings"
// @probe-codes []
// @probe-origin test/scripts/uploadTranscriptionTypeProbe.test.js
import { registerRemoteTranscriptionHandler } from "./src/helpers/remoteTranscriptionIpcHandler.js";
import { registerFileDiarizationHandlers } from "./src/helpers/fileDiarizationIpcHandlers.js";
import { registerUploadCancelHandler } from "./src/helpers/uploadCancelIpcHandler.js";
import { createUploadTranscriptionBridge } from "./src/preload/uploadTranscriptionBridge.js";
import { buildMultipartBody } from "./src/helpers/remoteTranscriptionIpcHandler.js";

declare const ipcMain: {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
};

const registry = {
  register: (id: unknown) => ({ signal: undefined, release: () => {} }),
  cancel: () => 0,
};

registerUploadCancelHandler(ipcMain, { uploadCancelRegistry: registry });

registerFileDiarizationHandlers(ipcMain, {
  diarizationManager: {
    isModelDownloaded: () => true,
    diarize: async (wavPath: string, options: { numSpeakers: number; threshold: number }) => {
      void wavPath;
      void options;
      return [];
    },
    capSpeakerClusters: (segments: Array<{ start: number; end: number; speaker: string }>) =>
      segments,
  },
  resolveAllowedAudioPath: (p: string) => (p.endsWith(".wav") ? p : null),
  convertToWav: async (input: string, output: string) => {
    void input;
    void output;
  },
  createTempWavPath: () => "/tmp/w.wav",
  fileSize: () => 32000,
  resolveClusterThreshold: (d: number) => d * 0 + 0.55,
  dropNegligibleClusters: (segments: Array<{ start: number; end: number; speaker: string }>) =>
    segments,
  pcm16Mono16kBytesPerSecond: 32000,
  maxSpeakerCount: 16,
  removeFile: () => {},
  mergeSpeakersWithText: () => [],
  formatSpeakerTranscript: () => "",
  uploadCancelRegistry: registry,
  logDebug: () => {},
  logError: () => {},
});

registerRemoteTranscriptionHandler(ipcMain, {
  resolveAllowedAudioPath: (p: string) => (p.endsWith(".wav") ? p : null),
  readFile: (p: string) => Buffer.from(p),
  fileSize: (p: string) => p.length,
  providerBaseUrls: () => [],
  postMultipart: async (url: URL) => ({ statusCode: 200, data: { text: "t" }, url }),
  postRawAudioFile: async () => ({ statusCode: 200, data: { results: {} } }),
  transcribeWithTinfoil: async () => ({ text: "t" }),
  transcribeGeminiFile: async () => ({ success: true, text: "t" }),
  transcribeWithCorti: async () => ({ text: "t" }),
  getCortiClientId: () => "id",
  getCortiClientSecret: () => "secret",
  getTinfoilKey: () => "key",
  getGeminiKey: () => "key",
  uploadCancelRegistry: registry,
  logDebug: () => {},
  logWarn: () => {},
  logError: () => {},
});

const { body, boundary } = buildMultipartBody(Buffer.from("x"), "a.wav", "audio/wav", {
  model: "m",
});
void body;
void boundary;

declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
};
const bridge = createUploadTranscriptionBridge(ipcRendererLike);
async function useAll(): Promise<string> {
  const byok = await bridge.transcribeAudioFileByok({ filePath: "/tmp/a.wav" });
  const diar = await bridge.diarizeAudioFile("/tmp/a.wav", { numSpeakers: 2 });
  const merged = await bridge.mergeSpeakerText([], "text", 1);
  const cancelled = await bridge.cancelUploadTranscription({ requestId: "r" });
  return [
    byok.text ?? "",
    String(diar.success),
    merged.text ?? "",
    String(cancelled.cancelled),
  ].join();
}
void useAll;
