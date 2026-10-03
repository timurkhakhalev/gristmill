// Regression coverage for #161: the real preprocessing path (WAV needing
// FFmpeg normalization, not the PCM16 bypass) must pass the caller's signal
// into convertToWav and own its temp files from creation — success,
// conversion failure and read failure all release them, and an abort before
// conversion starts no inference.
const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");

const MODEL_NAME = "parakeet-tdt-0.6b-v3";

// 16 kHz mono float32 WAV: fails the PCM16 bypass check, forcing the FFmpeg path.
function createFloat32Wav(sampleValue: number, sampleCount = 160) {
  const dataSize = sampleCount * 4;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(3, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(64000, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(32, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    wav.writeFloatLE(sampleValue, 44 + index * 4);
  }
  return wav;
}

// Minimal 16 kHz mono PCM16 WAV standing in for a converted output.
function createPcm16Wav(sampleValue: number, sampleCount = 160) {
  const dataSize = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    wav.writeInt16LE(Math.round(sampleValue * 32767), 44 + index * 2);
  }
  return wav;
}

function listParakeetTempFiles(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((f: string) => f.startsWith("parakeet-"));
}

interface LoadedParakeet {
  ParakeetServerManager: any;
  convertCalls: { input: string; output: string; signal: unknown }[];
}

const parakeetServerModulePath = require.resolve("../../src/helpers/parakeetServer.ts");

// Loads a fresh parakeetServer module with convertToWav replaced, recording
// the signal it received and simulating ffmpeg's on-disk behavior.
function loadWithConvertToWav(behavior: (outputPath: string) => void): LoadedParakeet {
  const convertCalls: { input: string; output: string; signal: unknown }[] = [];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(
    request: string,
    parent: { filename?: string } | undefined,
    isMain: boolean
  ) {
    if (request === "./ffmpegUtils.js" && parent?.filename?.endsWith("parakeetServer.ts")) {
      const ffmpegUtils = require("../../src/helpers/ffmpegUtils");
      return {
        ...ffmpegUtils,
        getFFmpegPath: () => "/mock/ffmpeg",
        convertToWav: async (
          inputPath: string,
          outputPath: string,
          options: { signal?: unknown } = {}
        ) => {
          convertCalls.push({ input: inputPath, output: outputPath, signal: options.signal });
          behavior(outputPath);
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[parakeetServerModulePath];
  try {
    const ParakeetServerManager = require("../../src/helpers/parakeetServer");
    return {
      ParakeetServerManager:
        ParakeetServerManager.ParakeetServerManager ?? ParakeetServerManager,
      convertCalls,
    };
  } finally {
    Module._load = originalLoad;
    delete require.cache[parakeetServerModulePath];
  }
}

function withIsolatedModelDir<T>(run: () => Promise<T>): Promise<T> {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-161-cache-"));
  const previous = process.env.GRISTMILL_CACHE_ROOT;
  process.env.GRISTMILL_CACHE_ROOT = cacheRoot;
  const modelDir = path.join(cacheRoot, "parakeet-models", MODEL_NAME);
  fs.mkdirSync(modelDir, { recursive: true });
  const { getRequiredModelFiles }: typeof import("../../src/helpers/parakeetModelInfo") =
    require("../../src/helpers/parakeetModelInfo");
  for (const file of getRequiredModelFiles(MODEL_NAME)) {
    fs.writeFileSync(path.join(modelDir, file), "");
  }
  return run().finally(() => {
    if (previous === undefined) delete process.env.GRISTMILL_CACHE_ROOT;
    else process.env.GRISTMILL_CACHE_ROOT = previous;
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  });
}

test("preprocessing passes the caller's signal to convertToWav and cleans up on success", async () => {
  const { ParakeetServerManager, convertCalls } = loadWithConvertToWav((outputPath) => {
    fs.writeFileSync(outputPath, createPcm16Wav(0.5));
  });
  await withIsolatedModelDir(async () => {
    const manager = new ParakeetServerManager();
    manager.wsServer = {
      start: async () => {},
      transcribe: async () => ({ text: "audible", elapsed: 0 }),
    };
    const controller = new AbortController();
    const result = await manager.transcribe(createFloat32Wav(0.5), {
      modelName: MODEL_NAME,
      signal: controller.signal,
    });
    assert.equal(result.text, "audible");
    assert.equal(convertCalls.length, 1);
    assert.equal(convertCalls[0].signal, controller.signal, "the cancellation signal reaches ffmpeg");
    assert.deepEqual(listParakeetTempFiles(), [], "success must leave no parakeet temp files behind");
  });
});

test("conversion failure cleans up the temp input and partial WAV", async () => {
  const { ParakeetServerManager, convertCalls } = loadWithConvertToWav((outputPath) => {
    fs.writeFileSync(outputPath, Buffer.from("partial"));
    throw new Error("FFmpeg exited with code 1");
  });
  await withIsolatedModelDir(async () => {
    const manager = new ParakeetServerManager();
    manager.wsServer = {
      start: async () => {},
      transcribe: async () => ({ text: "never", elapsed: 0 }),
    };
    await assert.rejects(
      () => manager.transcribe(createFloat32Wav(0.5), { modelName: MODEL_NAME }),
      /FFmpeg exited/
    );
    assert.equal(convertCalls.length, 1);
    assert.deepEqual(listParakeetTempFiles(), [], "conversion failure must not leak the input or the partial WAV");
  });
});

test("WAV read failure after conversion also cleans up the temp files", async () => {
  const { ParakeetServerManager } = loadWithConvertToWav((outputPath) => {
    fs.writeFileSync(outputPath, createPcm16Wav(0.5));
    // Simulate the file vanishing between ffmpeg close and readFileSync.
    fs.unlinkSync(outputPath);
  });
  await withIsolatedModelDir(async () => {
    const manager = new ParakeetServerManager();
    manager.wsServer = {
      start: async () => {},
      transcribe: async () => ({ text: "never", elapsed: 0 }),
    };
    await assert.rejects(() => manager.transcribe(createFloat32Wav(0.5), { modelName: MODEL_NAME }));
    assert.deepEqual(listParakeetTempFiles(), [], "a read failure must not leak the temp input");
  });
});

test("a pre-aborted signal stops before conversion and starts no inference", async () => {
  const { ParakeetServerManager, convertCalls } = loadWithConvertToWav(() => {
    throw new Error("conversion must not run after cancellation");
  });
  await withIsolatedModelDir(async () => {
    const manager = new ParakeetServerManager();
    const wsStarts: number[] = [];
    manager.wsServer = {
      start: async () => {
        wsStarts.push(1);
      },
      transcribe: async () => ({ text: "late", elapsed: 0 }),
    };
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => manager.transcribe(createFloat32Wav(0.5), { modelName: MODEL_NAME, signal: controller.signal }),
      (error: Error) => error.name === "AbortError"
    );
    assert.equal(convertCalls.length, 0, "no conversion child after an abort");
    assert.equal(wsStarts.length, 0, "inference must not start after an abort");
  });
});
