// @probe-name "a wrong bridge-level call fails compilation"
// @probe-codes [2345]
// @probe-origin test/scripts/localFileTranscriptionTypeProbe.test.js
import { createLocalFileTranscriptionBridge } from "./src/preload/localFileTranscriptionBridge.js";

declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
};
const bridge = createLocalFileTranscriptionBridge(ipcRendererLike);

// filePath must be a string; a number is a compile-time error.
bridge.transcribeAudioFile(1234);
