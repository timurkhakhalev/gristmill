// The typed diarize-audio-file and merge-speaker-text handlers after the
// cutover: fake manager/ffmpeg over a real temp dir and the real shared
// cancel registry. Pins manager gating, path denial before conversion,
// numSpeakers normalization, signal propagation into FFmpeg and the diarizer,
// the cancel checks between stages, temp WAV cleanup and release, plus the
// merge handler's normalizing behavior and limits.
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const test: typeof import("node:test") = require("node:test");

const fs: typeof import("node:fs") = require("node:fs");

const os: typeof import("node:os") = require("node:os");

const path: typeof import("node:path") = require("node:path");

type FileDiarizationModule = typeof import("../../src/helpers/fileDiarizationIpcHandlers.js");

type UploadCancelModule = typeof import("../../src/helpers/uploadCancelRegistry.js");

let registerFileDiarizationHandlers: FileDiarizationModule["registerFileDiarizationHandlers"];

let createUploadCancelRegistry: UploadCancelModule["createUploadCancelRegistry"];

test.before(async () => {
  ({ registerFileDiarizationHandlers } =
    await import("../../src/helpers/fileDiarizationIpcHandlers.ts"));
  ({ createUploadCancelRegistry } = await import("../../src/helpers/uploadCancelRegistry.ts"));
});

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-diarize-typed-")));

const audioFile = path.join(tmpRoot, "audio.wav");

fs.writeFileSync(audioFile, Buffer.alloc(2048));

const PCM16_MONO_16K_BYTES_PER_SECOND = 32000;

const MAX_SPEAKER_COUNT = 16;

const REAL_MERGE = require("../../src/helpers/speakerMerge.ts");

type DiarSegment = { start: number; end: number; speaker: string };

interface SetupOverrides {
  manager?: import("../../src/helpers/fileDiarizationIpcHandlers.js").FileDiarizationManager | null;
  convert?: (input: string, output: string, options: { signal?: AbortSignal }) => unknown;
  diarize?: (
    wavPath: string,
    options: { signal?: AbortSignal }
  ) => DiarSegment[] | Promise<DiarSegment[]>;
}

function setup({ manager, convert, diarize }: SetupOverrides = {}) {
  const registry = createUploadCancelRegistry();

  const calls: {
    converts: Array<{ input: string; output: string; options: { signal?: AbortSignal } }>;
    diarize: Array<{
      wavPath: string;
      options: { signal?: AbortSignal; numSpeakers?: number; threshold?: number };
    }>;
    removed: string[];
    merges: Array<{ segments: unknown; text: string; duration: unknown }>;
    debugs: Array<{ message: unknown; data: unknown }>;
    errors: Array<{ message: unknown; data: unknown }>;
  } = {
    converts: [],
    diarize: [],
    removed: [],
    merges: [],
    debugs: [],
    errors: [],
  };

  const wavPaths: string[] = [];

  const usedManager =
    manager === undefined
      ? {
          isModelDownloaded: () => true,
          diarize: async (wavPath: string, options: unknown) => {
            calls.diarize.push({
              wavPath,
              options: options as {
                signal?: AbortSignal;
                numSpeakers?: number;
                threshold?: number;
              },
            });

            return diarize
              ? diarize(wavPath, options as { signal?: AbortSignal })
              : [{ start: 0, end: 1, speaker: "speaker_0" }];
          },
          capSpeakerClusters: (segments: DiarSegment[]) => segments,
        }
      : manager;

  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  registerFileDiarizationHandlers(
    {
      handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) =>
        handlers.set(channel, fn),
    },
    {
      diarizationManager: usedManager,
      resolveAllowedAudioPath: (filePath: string) => {
        try {
          const real = fs.realpathSync(path.resolve(filePath));

          return real.startsWith(tmpRoot + path.sep) ? real : null;
        } catch {
          return null;
        }
      },
      convertToWav: async (input: string, output: string, options: unknown) => {
        calls.converts.push({ input, output, options: options as { signal?: AbortSignal } });
        wavPaths.push(output);
        fs.writeFileSync(output, Buffer.alloc(PCM16_MONO_16K_BYTES_PER_SECOND * 10));

        if (convert) return convert(input, output, options as { signal?: AbortSignal });
      },
      createTempWavPath: () =>
        path.join(tmpRoot, `ow-diarize-${Date.now()}-${wavPaths.length}.wav`),
      fileSize: (filePath: string) => fs.statSync(filePath).size,
      resolveClusterThreshold: (durationSeconds: number, requested: number | null | undefined) =>
        requested ?? (durationSeconds > 1200 ? 0.65 : 0.55),
      dropNegligibleClusters: (segments) => segments,
      pcm16Mono16kBytesPerSecond: PCM16_MONO_16K_BYTES_PER_SECOND,
      maxSpeakerCount: MAX_SPEAKER_COUNT,
      removeFile: (filePath: string) => {
        calls.removed.push(filePath);
        fs.unlinkSync(filePath);
      },
      mergeSpeakersWithText: (segments: unknown, text: string, duration: number) => {
        calls.merges.push({ segments, text, duration });

        return REAL_MERGE.mergeSpeakersWithText(segments, text, duration);
      },
      formatSpeakerTranscript: (merged: unknown) => REAL_MERGE.formatSpeakerTranscript(merged),
      uploadCancelRegistry: registry,
      logDebug: (message: unknown, data: unknown) => calls.debugs.push({ message, data }),
      logError: (message: unknown, data: unknown) => calls.errors.push({ message, data }),
    }
  );

  const diarizeCall = (filePath: string | number, options: unknown) =>
    handlers.get("diarize-audio-file")!(null, filePath, options);

  const mergeCall = (payload: unknown) => handlers.get("merge-speaker-text")!(null, payload);

  return { diarizeCall, mergeCall, calls, registry, wavPaths };
}

test("happy path: conversion gets the signal, duration comes from the WAV, release runs", async () => {
  const { diarizeCall, calls, wavPaths } = setup();

  const result = (await diarizeCall(audioFile, { requestId: "r1" })) as {
    success: boolean;
    segments: DiarSegment[];
    durationSeconds: number;
  };

  assert.equal(result.success, true);
  assert.deepEqual(result.segments, [{ start: 0, end: 1, speaker: "speaker_0" }]);
  assert.equal(result.durationSeconds, 10);
  assert.ok(calls.converts[0].options.signal instanceof AbortSignal);
  assert.ok(calls.diarize[0].options.signal instanceof AbortSignal);
  assert.deepEqual(calls.removed, wavPaths, "temp WAV removed");
});

test("manager gating and invalid inputs reject before any conversion", async () => {
  const noManager = setup({ manager: null });
  assert.deepEqual(await noManager.diarizeCall(audioFile, {}), {
    success: false,
    error: "Diarization not available",
  });

  const noModels = setup({
    manager: {
      isModelDownloaded: () => false,
      diarize: async () => [],
      capSpeakerClusters: (s: import("../../src/helpers/diarization.js").DiarizationSegment[]) => s,
    },
  });

  assert.deepEqual(await noModels.diarizeCall(audioFile, {}), {
    success: false,
    error: "Diarization models not downloaded",
  });

  const { diarizeCall, calls } = setup();
  assert.deepEqual(await diarizeCall(12345, {}), { success: false, error: "Invalid file path" });
  assert.deepEqual(await diarizeCall("/etc/hosts", {}), {
    success: false,
    error: "File path not allowed",
  });
  assert.deepEqual(await diarizeCall(audioFile, null), {
    success: false,
    error: "Invalid diarization request",
  });
  assert.deepEqual(await diarizeCall(audioFile, { requestId: "" }), {
    success: false,
    error: "Invalid diarization request",
  });
  assert.equal(calls.converts.length, 0);
});

test("numSpeakers is clamped and junk options normalize like before", async () => {
  const { diarizeCall, calls } = setup();
  await diarizeCall(audioFile, { numSpeakers: 999 });
  assert.equal(calls.diarize[0].options.numSpeakers, MAX_SPEAKER_COUNT);
  await diarizeCall(audioFile, { numSpeakers: 2.7 });
  assert.equal(calls.diarize[1].options.numSpeakers, 3);
  await diarizeCall(audioFile, {});
  assert.equal(calls.diarize[2].options.numSpeakers, -1);
  // The handler resolves the threshold from the measured WAV duration (the
  // policy's ramp lives in diarizationPolicy's own tests); a pinned value
  // wins unchanged.
  assert.equal(calls.diarize[0].options.threshold, 0.55);
  await diarizeCall(audioFile, { threshold: 0.4 });
  assert.equal(calls.diarize[3].options.threshold, 0.4);
});

test("cancel before the conversion and between stages returns Cancelled and cleans up", async () => {
  // Cancel lands while the conversion is still pending: the post-conversion
  // check stops the run before the diarizer ever starts.
  let finishConvert;

  const gate = new Promise((resolve) => {
    finishConvert = resolve;
  });

  const pre = setup({ convert: () => gate });
  const pending = pre.diarizeCall(audioFile, { requestId: "pre" });
  await new Promise((resolve) => setImmediate(resolve));
  pre.registry.cancel("pre");
  finishConvert!();
  assert.deepEqual(await pending, { success: false, error: "Cancelled", code: "UPLOAD_CANCELLED" });
  assert.equal(pre.calls.diarize.length, 0);
  assert.deepEqual(pre.calls.removed, pre.wavPaths, "WAV cleaned");

  // Abort during the FFmpeg conversion surfaces as AbortError from the child.
  const midConvert = setup({
    convert: (_i: string, _o: string, options: { signal?: AbortSignal }): unknown =>
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => {
          const error = new Error("Aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  });

  const converting = midConvert.diarizeCall(audioFile, { requestId: "mid" });
  await new Promise((resolve) => setImmediate(resolve));
  midConvert.registry.cancel("mid");
  assert.deepEqual(await converting, {
    success: false,
    error: "Cancelled",
    code: "UPLOAD_CANCELLED",
  });
  assert.deepEqual(midConvert.calls.removed, midConvert.wavPaths, "WAV cleaned after abort");
  assert.equal(midConvert.registry.cancel("mid"), 0, "registration released");

  // Abort while the diarizer runs: the manager resolves [] on its own signal,
  // the post-diarize check still reports Cancelled.
  const midDiarize = setup({
    diarize: (_wavPath: string, options: { signal?: AbortSignal }) =>
      new Promise((resolve) => {
        options.signal?.addEventListener("abort", () => resolve([]), { once: true });
      }),
  });

  const diarizing = midDiarize.diarizeCall(audioFile, { requestId: "post" });
  await new Promise((resolve) => setImmediate(resolve));
  midDiarize.registry.cancel("post");
  assert.deepEqual(await diarizing, {
    success: false,
    error: "Cancelled",
    code: "UPLOAD_CANCELLED",
  });
});

test("errors map to failure results with cleanup and release", async () => {
  const { diarizeCall, calls, wavPaths } = setup({
    convert: async () => {
      throw new Error("FFmpeg not found");
    },
  });

  assert.deepEqual(await diarizeCall(audioFile, { requestId: "r" }), {
    success: false,
    error: "FFmpeg not found",
  });
  assert.deepEqual(calls.removed, wavPaths);
});

test("merge keeps the normalizing contract and its limits", async () => {
  const { mergeCall, calls } = setup();

  const ok = (await mergeCall({
    segments: [
      { speaker: "speaker_0", start: 0, end: 1 },
      { speaker: "x".repeat(200), start: Number.NaN, end: 2 },
      "junk",
    ],
    text: "Hello there.",
    duration: 5,
  })) as { success: boolean; text: string };

  assert.equal(ok.success, true);
  assert.equal(typeof ok.text, "string");
  assert.equal((calls.merges[0].segments as unknown[]).length, 3);
  const mergedSegs = calls.merges[0].segments as Array<{ speaker: string; start: number }>;
  assert.equal(mergedSegs[1].speaker.length, 100);
  assert.equal(mergedSegs[1].start, 0);
  assert.equal(mergedSegs[2].speaker, "unknown");

  assert.deepEqual(await mergeCall({ segments: "nope", text: "t", duration: 1 }), {
    success: false,
    error: "Invalid arguments",
  });
  assert.deepEqual(
    await mergeCall({ segments: [], text: "t", duration: Number.POSITIVE_INFINITY }),
    {
      success: false,
      error: "Invalid arguments",
    }
  );
  assert.deepEqual(
    await mergeCall({ segments: new Array(10001).fill({}), text: "t", duration: 1 }),
    { success: false, error: "Input too large" }
  );
  assert.deepEqual(await mergeCall({ segments: [], text: "x".repeat(1_000_001), duration: 1 }), {
    success: false,
    error: "Input too large",
  });
});
