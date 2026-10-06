import fs from "fs";
import path from "path";
import debugLogger from "./debugLogger.js";
import { getModelsDirForService } from "./modelDirUtils.js";
import onnxWorkerClient from "./onnxWorkerClient.js";
import type { SpeakerExtractResult } from "../contracts/onnxWorker.js";

export const SAMPLE_RATE = 16000;

export const EMBEDDING_DIM = 512;

export const MIN_SEGMENT_SECONDS = 1.5;

export const MIN_SEGMENT_SAMPLES = SAMPLE_RATE * MIN_SEGMENT_SECONDS;

export const MAX_EMBEDDING_SECONDS = 8;

export const MAX_EMBEDDING_SAMPLES = SAMPLE_RATE * MAX_EMBEDDING_SECONDS;

const MODEL_FILE = "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx";

export interface WavHeaderInfo {
  sampleRate: number;
  dataOffset: number;
}

export class SpeakerEmbeddings {
  loadPromise: Promise<void> | null;

  constructor() {
    this.loadPromise = null;
  }

  getModelPath(): string {
    if (process.resourcesPath) {
      const bundledPath = path.join(process.resourcesPath, "bin", "diarization-models", MODEL_FILE);

      if (fs.existsSync(bundledPath)) {
        return bundledPath;
      }
    }

    return path.join(getModelsDirForService("diarization"), MODEL_FILE);
  }

  isAvailable(): boolean {
    return fs.existsSync(this.getModelPath());
  }

  _ensureLoaded(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;

    if (!this.isAvailable()) {
      return Promise.reject(
        new Error(`Speaker embedding model not found at ${this.getModelPath()}`)
      );
    }

    const modelPath = this.getModelPath();
    debugLogger.debug("speaker-embeddings loading model", { modelPath });
    this.loadPromise = onnxWorkerClient
      .request("speaker.load", { modelPath })
      .then(() => {
        debugLogger.debug("speaker-embeddings model loaded");
      })
      .catch((err: Error) => {
        this.loadPromise = null;
        throw err;
      });

    return this.loadPromise;
  }

  async _extractEmbeddingFromSamples(samples: Float32Array): Promise<Float32Array | null> {
    await this._ensureLoaded();

    // SAFETY: slice() copies the typed array's region into a fresh
    // ArrayBuffer, so the result is a real ArrayBuffer, not a SharedArrayBuffer.
    const samplesBuffer = samples.buffer.slice(
      samples.byteOffset,
      samples.byteOffset + samples.byteLength
    ) as ArrayBuffer;

    // No transfer-list: MessagePortMain can't transfer ArrayBuffers, so the samples are cloned.
    // SAFETY: speaker.extract is the only request this client issues for that
    // method, and the worker replies with the matching SpeakerExtractResult.
    const { embeddingBuffer } = (await onnxWorkerClient.request("speaker.extract", {
      samplesBuffer,
    })) as SpeakerExtractResult;

    if (!embeddingBuffer) return null;

    return new Float32Array(embeddingBuffer);
  }

  async extractEmbeddingFromSamples(samples: Float32Array): Promise<Float32Array | null> {
    if (samples.length < MIN_SEGMENT_SAMPLES) return null;

    const capped =
      samples.length > MAX_EMBEDDING_SAMPLES
        ? samples.subarray(samples.length - MAX_EMBEDDING_SAMPLES)
        : samples;

    return this._extractEmbeddingFromSamples(capped);
  }

  async extractEmbedding(
    wavPath: string,
    startSec: number,
    endSec: number
  ): Promise<Float32Array | null> {
    if (endSec - startSec < MIN_SEGMENT_SECONDS) return null;

    const buf = fs.readFileSync(wavPath);
    const { sampleRate, dataOffset } = this._parseWavHeader(buf);

    const cappedSeconds = Math.min(endSec - startSec, MAX_EMBEDDING_SECONDS);
    const cappedStartSec = endSec - cappedSeconds;
    const startSample = Math.floor(cappedStartSec * sampleRate);
    const endSample = Math.floor(endSec * sampleRate);
    const numSamples = endSample - startSample;

    const samples = new Float32Array(numSamples);
    const bytesPerSample = 2;
    const offset = dataOffset + startSample * bytesPerSample;

    for (let i = 0; i < numSamples; i++) {
      const bytePos = offset + i * bytesPerSample;

      if (bytePos + 1 >= buf.length) break;
      const int16 = buf.readInt16LE(bytePos);
      samples[i] = int16 / 32768;
    }

    return this._extractEmbeddingFromSamples(samples);
  }

  _parseWavHeader(buf: Buffer): WavHeaderInfo {
    let offset = 12;
    let sampleRate = 16000;
    let dataOffset = 44;

    while (offset < buf.length - 8) {
      const chunkId = buf.toString("ascii", offset, offset + 4);
      const chunkSize = buf.readUInt32LE(offset + 4);

      if (chunkId === "fmt ") {
        sampleRate = buf.readUInt32LE(offset + 12);
      } else if (chunkId === "data") {
        dataOffset = offset + 8;
        break;
      }

      offset += 8 + chunkSize;
    }

    return { sampleRate, dataOffset };
  }

  computeCentroid(embeddings: Float32Array[]): Float32Array {
    if (embeddings.length === 0) return new Float32Array(EMBEDDING_DIM);

    const centroid = new Float32Array(EMBEDDING_DIM);

    for (const emb of embeddings) {
      for (let i = 0; i < EMBEDDING_DIM; i++) {
        centroid[i] += emb[i];
      }
    }

    for (let i = 0; i < EMBEDDING_DIM; i++) {
      centroid[i] /= embeddings.length;
    }

    return centroid;
  }

  cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);

    return denom === 0 ? 0 : dot / denom;
  }
}

const instance = new SpeakerEmbeddings();

export default instance;

module.exports = instance;

Object.assign(module.exports, {
  SpeakerEmbeddings,
  MAX_EMBEDDING_SECONDS,
});
