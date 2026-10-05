const fs = require("fs");

const os = require("os");

const path = require("path");

import {
  parseOnnxWorkerRequest,
  type OnnxWorkerRequest,
  type PingResult,
  type ShutdownResult,
  type SpeakerExtractResult,
  type SpeakerLoadResult,
} from "../contracts/onnxWorker.js";

interface LogExtra {
  [key: string]: unknown;
}

let logStream: import("fs").WriteStream | null = null;

function openLog(): void {
  const logPath = process.env.GRISTMILL_ONNX_WORKER_LOG;

  if (!logPath) return;

  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    logStream = fs.createWriteStream(logPath, { flags: "a" });
  } catch {
    logStream = null;
  }
}

openLog();

const FBANK_SAMPLE_RATE = 16000;

const FBANK_FRAME_LENGTH_MS = 25;

const FBANK_FRAME_SHIFT_MS = 10;

const FBANK_NUM_MELS = 80;

const FBANK_FRAME_LENGTH = Math.round((FBANK_SAMPLE_RATE * FBANK_FRAME_LENGTH_MS) / 1000);

const FBANK_FRAME_SHIFT = Math.round((FBANK_SAMPLE_RATE * FBANK_FRAME_SHIFT_MS) / 1000);

const FBANK_FFT_SIZE = 512;

const SPEAKER_MAX_SAMPLES = FBANK_SAMPLE_RATE * 8;

const intraOpNumThreads = Math.min(4, Math.max(2, Math.floor((os.cpus()?.length || 4) / 2)));

interface MessagePortLike {
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  start(): void;
  postMessage(message: unknown, transferList?: unknown[]): unknown;
}

let port: MessagePortLike | null = null;

// onnxruntime-node's surface is untyped in this graph; the narrow slice the
// worker uses is declared here instead of pulling the package's types into a
// utility process that must boot without them.
interface OrtTensorData {
  data: ArrayLike<number>;
}

interface OrtTensor {
  data: ArrayLike<number>;
}

type OrtTensorConstructor = new (
  type: "float32" | "int64",
  data: Float32Array | BigInt64Array,
  dims: number[]
) => OrtTensor;

interface OrtSession {
  inputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensorData>>;
}

interface OrtModule {
  InferenceSession: {
    create(modelPath: string, options: Record<string, unknown>): Promise<OrtSession>;
  };
  Tensor: OrtTensorConstructor;
}

let ort: OrtModule | null = null;

let speakerSession: OrtSession | null = null;

let speakerInputName: string | null = null;

function log(level: string, message: string, extra?: LogExtra): void {
  if (!logStream) return;

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    pid: process.pid,
    message,
    ...(extra || {}),
  });

  try {
    logStream.write(line + "\n");
  } catch {
    // Best-effort logging; never throw from log path.
  }
}

function loadOrt(): void {
  if (ort) return;
  ort = require("onnxruntime-node") as OrtModule;
  log("info", "ort loaded");
}

const SESSION_OPTIONS: Record<string, unknown> = {
  intraOpNumThreads,
  executionMode: "sequential",
};

let _melFilterbank: Float32Array[] | null = null;

function getMelFilterbank(): Float32Array[] {
  if (_melFilterbank) return _melFilterbank;

  const numBins = FBANK_FFT_SIZE / 2 + 1;
  const lowFreq = 20;
  const highFreq = FBANK_SAMPLE_RATE / 2;
  const melLow = 1127 * Math.log(1 + lowFreq / 700);
  const melHigh = 1127 * Math.log(1 + highFreq / 700);

  const melPoints = new Float64Array(FBANK_NUM_MELS + 2);

  for (let i = 0; i < melPoints.length; i++) {
    const mel = melLow + ((melHigh - melLow) * i) / (FBANK_NUM_MELS + 1);
    melPoints[i] = 700 * (Math.exp(mel / 1127) - 1);
  }

  const binPoints = new Float64Array(melPoints.length);

  for (let i = 0; i < melPoints.length; i++) {
    binPoints[i] = Math.floor(((FBANK_FFT_SIZE + 1) * melPoints[i]) / FBANK_SAMPLE_RATE);
  }

  const bank = new Array<Float32Array>(FBANK_NUM_MELS);

  for (let m = 0; m < FBANK_NUM_MELS; m++) {
    const filter = new Float32Array(numBins);
    const left = binPoints[m];
    const center = binPoints[m + 1];
    const right = binPoints[m + 2];

    for (let k = 0; k < numBins; k++) {
      if (k >= left && k <= center && center > left) {
        filter[k] = (k - left) / (center - left);
      } else if (k > center && k <= right && right > center) {
        filter[k] = (right - k) / (right - center);
      }
    }

    bank[m] = filter;
  }

  _melFilterbank = bank;

  return _melFilterbank;
}

function realFFT(frame: Float32Array): Float32Array {
  const n = FBANK_FFT_SIZE;
  const re = new Float64Array(n);
  const im = new Float64Array(n);

  for (let i = 0; i < frame.length && i < n; i++) re[i] = frame[i];

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;

    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }

    j ^= bit;

    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);

    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;

      for (let j = 0; j < len / 2; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + len / 2] * curRe - im[i + j + len / 2] * curIm;
        const vIm = re[i + j + len / 2] * curIm + im[i + j + len / 2] * curRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + len / 2] = uRe - vRe;
        im[i + j + len / 2] = uIm - vIm;
        const tmpRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = tmpRe;
      }
    }
  }

  const numBins = n / 2 + 1;
  const powerSpectrum = new Float32Array(numBins);

  for (let i = 0; i < numBins; i++) {
    powerSpectrum[i] = re[i] * re[i] + im[i] * im[i];
  }

  return powerSpectrum;
}

interface Fbank {
  features: Float32Array;
  numFrames: number;
}

function computeFbank(samples: Float32Array): Fbank | null {
  const numFrames = Math.max(
    0,
    Math.floor((samples.length - FBANK_FRAME_LENGTH) / FBANK_FRAME_SHIFT) + 1
  );

  if (numFrames === 0) return null;

  const hamming = new Float32Array(FBANK_FRAME_LENGTH);

  for (let i = 0; i < FBANK_FRAME_LENGTH; i++) {
    hamming[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FBANK_FRAME_LENGTH - 1));
  }

  const melBank = getMelFilterbank();
  const features = new Float32Array(numFrames * FBANK_NUM_MELS);

  for (let f = 0; f < numFrames; f++) {
    const start = f * FBANK_FRAME_SHIFT;
    const frame = new Float32Array(FBANK_FRAME_LENGTH);

    for (let i = 0; i < FBANK_FRAME_LENGTH; i++) {
      frame[i] = (samples[start + i] || 0) * hamming[i];
    }

    const power = realFFT(frame);

    for (let m = 0; m < FBANK_NUM_MELS; m++) {
      let energy = 0;
      const filter = melBank[m];

      for (let k = 0; k < power.length; k++) {
        energy += filter[k] * power[k];
      }

      features[f * FBANK_NUM_MELS + m] = Math.log(Math.max(energy, 1e-10));
    }
  }

  return { features, numFrames };
}

async function speakerLoad({ modelPath }: { modelPath: string }): Promise<SpeakerLoadResult> {
  if (speakerSession) return { ok: true };
  loadOrt();
  const module = ort as OrtModule;
  speakerSession = await module.InferenceSession.create(modelPath, SESSION_OPTIONS);
  speakerInputName = speakerSession.inputNames[0];
  log("info", "speaker session loaded", { modelPath });

  return { ok: true };
}

async function speakerExtract({
  samplesBuffer,
}: {
  samplesBuffer: ArrayBuffer;
}): Promise<SpeakerExtractResult> {
  if (!speakerSession || !ort || speakerInputName === null) {
    throw new Error("speaker session not loaded");
  }

  const allSamples = new Float32Array(samplesBuffer);

  const samples =
    allSamples.length > SPEAKER_MAX_SAMPLES
      ? allSamples.subarray(allSamples.length - SPEAKER_MAX_SAMPLES)
      : allSamples;

  const fbank = computeFbank(samples);

  if (!fbank) return { embeddingBuffer: null };

  const feeds = {
    [speakerInputName]: new ort.Tensor("float32", fbank.features, [
      1,
      fbank.numFrames,
      FBANK_NUM_MELS,
    ]),
  };

  const results = await speakerSession.run(feeds);
  const output = results[Object.keys(results)[0]];
  const data = new Float32Array(Array.from(output.data));

  return { embeddingBuffer: data.buffer };
}

type HandlerResult = PingResult | SpeakerLoadResult | SpeakerExtractResult | ShutdownResult;

const handlers: {
  ping(): HandlerResult;
  "speaker.load"(payload: { modelPath: string }): Promise<SpeakerLoadResult>;
  "speaker.extract"(payload: { samplesBuffer: ArrayBuffer }): Promise<SpeakerExtractResult>;
  shutdown(): ShutdownResult;
} = {
  ping: () => ({ ok: true, sessions: { speaker: !!speakerSession } }),
  "speaker.load": speakerLoad,
  "speaker.extract": speakerExtract,
  shutdown: () => {
    log("info", "shutdown requested");
    setImmediate(() => process.exit(0));

    return { ok: true };
  },
};

interface ReplyEnvelope {
  reply:
    | { id: number; result: HandlerResult; error?: undefined }
    | { id: number; error: { message: string }; result?: undefined };
  transferList: unknown[];
}

async function dispatch(raw: unknown): Promise<ReplyEnvelope> {
  const request: OnnxWorkerRequest | null = parseOnnxWorkerRequest(raw);

  if (!request) {
    const id = (raw as { id?: unknown } | null)?.id;
    const method = (raw as { method?: unknown } | null)?.method;

    return {
      reply: {
        id: typeof id === "number" ? id : 0,
        error: { message: `unknown method: ${String(method)}` },
      },
      transferList: [],
    };
  }

  const handler = handlers[request.method] as (
    payload?: unknown
  ) => HandlerResult | Promise<HandlerResult>;

  try {
    const result = await handler(
      request.method === "ping" || request.method === "shutdown" ? {} : request.payload
    );

    // MessagePortMain transfers only ports, not ArrayBuffers — clone the result buffers instead.
    return { reply: { id: request.id, result }, transferList: [] };
  } catch (err) {
    const message = (err as Error | undefined)?.message || String(err);
    log("error", "handler threw", {
      method: request.method,
      error: message,
      stack: (err as Error | undefined)?.stack,
    });

    return { reply: { id: request.id, error: { message } }, transferList: [] };
  }
}

process.on("uncaughtException", (err: Error) => {
  log("fatal", "uncaughtException", { error: err?.message, stack: err?.stack });
  process.stderr.write(`onnx worker uncaughtException: ${err?.stack || err?.message}\n`);
  process.exit(1);
});

process.on("unhandledRejection", (err: Error) => {
  log("fatal", "unhandledRejection", { error: err?.message, stack: err?.stack });
  process.stderr.write(`onnx worker unhandledRejection: ${err?.stack || err?.message}\n`);
  process.exit(1);
});

const parentPort = process.parentPort as
  | {
      once(
        event: "message",
        listener: (message: { data: unknown; ports?: unknown[] }) => void
      ): void;
    }
  | undefined;

if (!parentPort) {
  process.stderr.write("onnx worker: process.parentPort is undefined\n");
  process.exit(1);
}

parentPort.once("message", ({ data, ports }) => {
  if (data === "init" && ports?.length) {
    port = ports[0] as MessagePortLike;
    port.on("message", async (event: { data: unknown }) => {
      const { reply, transferList } = await dispatch(event.data);
      port?.postMessage(reply, transferList);
    });
    port.on("close", () => {
      log("info", "port closed");
      process.exit(0);
    });
    port.start();
    log("info", "worker initialized", { intraOpNumThreads });
  }
});

log("info", "worker boot", { intraOpNumThreads, pid: process.pid });
