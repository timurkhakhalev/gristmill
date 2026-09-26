const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { downloadFile } = require("./downloadUtils.js");
const debugLogger = require("./debugLogger.js");

// Issue #89: the Silero VAD model for whisper.cpp is a model asset, not a
// runtime binary, so it is fetched on first VAD-enabled use instead of being
// bundled or downloaded at startup. Landed in the whisper cache dir next to
// the ASR models; bundled copies (old installs, packaged Resources/bin) still
// win when present.
const VAD_MODEL_URL =
  "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin";
const VAD_MODEL_FILE = "ggml-silero-v5.1.2.bin";

let inFlight: Promise<string | null> | null = null;

function bundledVadModelPath(): string | null {
  const candidates: string[] = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "bin", "whisper-vad", VAD_MODEL_FILE));
  }
  candidates.push(path.join(app.getAppPath(), "resources", "bin", "whisper-vad", VAD_MODEL_FILE));
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function cacheVadModelPath(): string {
  return path.join(app.getPath("userData"), "models", "whisper-vad", VAD_MODEL_FILE);
}

export async function ensureWhisperVadModel(): Promise<string | null> {
  const bundled = bundledVadModelPath();
  if (bundled) return bundled;

  const cached = cacheVadModelPath();
  if (fs.existsSync(cached)) return cached;

  if (!inFlight) {
    inFlight = (async () => {
      debugLogger.info("Downloading whisper VAD model", { destPath: cached }, "assets");
      await fs.promises.mkdir(path.dirname(cached), { recursive: true });
      await downloadFile(VAD_MODEL_URL, cached);
      debugLogger.info("Whisper VAD model downloaded", { destPath: cached }, "assets");
      return cached;
    })().catch((error: Error) => {
      debugLogger.warn(
        "Whisper VAD model download failed",
        { error: error.message },
        "assets"
      );
      throw error;
    }).finally(() => {
      inFlight = null;
    });
  }

  return inFlight;
}

export function resetWhisperVadModelForTests(): void {
  inFlight = null;
}
