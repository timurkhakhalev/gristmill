const modelRegistryData = require("../models/modelRegistryData.json");

export interface ParakeetModelRegistryEntry {
  runtime?: string;
  modelType?: string;
  sherpaModelType?: string;
  supportedLanguages?: string[];
}

const TRANSDUCER_MODEL_FILES: readonly string[] = [
  "encoder.int8.onnx",
  "decoder.int8.onnx",
  "joiner.int8.onnx",
  "tokens.txt",
];

const COHERE_TRANSCRIBE_MODEL_FILES: readonly string[] = [
  "encoder.int8.onnx",
  "encoder.int8.onnx.data",
  "decoder.int8.onnx",
  "tokens.txt",
];

export type ParakeetRuntime = "offline" | "online";
export type ParakeetModelKind = "transducer" | "cohere-transcribe";

function getModelInfo(modelName: string): ParakeetModelRegistryEntry | undefined {
  return (modelRegistryData.parakeetModels as Record<string, ParakeetModelRegistryEntry> | undefined)?.[modelName];
}

export function getModelRuntime(modelName: string): ParakeetRuntime {
  return getModelInfo(modelName)?.runtime === "online" ? "online" : "offline";
}

export function getModelType(modelName: string): ParakeetModelKind {
  return getModelInfo(modelName)?.modelType === "cohere-transcribe"
    ? "cohere-transcribe"
    : "transducer";
}

export function getSherpaModelType(modelName: string): string | null {
  // NeMo and stateless transducers use different sherpa decoders. Unverified
  // models must retain metadata detection rather than inherit a decoder type.
  return getModelRuntime(modelName) === "offline" &&
    getModelType(modelName) === "transducer" &&
    getModelInfo(modelName)?.sherpaModelType === "nemo_transducer"
    ? "nemo_transducer"
    : null;
}

export function getRequiredModelFiles(modelName: string): readonly string[] {
  return getModelType(modelName) === "cohere-transcribe"
    ? COHERE_TRANSCRIBE_MODEL_FILES
    : TRANSDUCER_MODEL_FILES;
}

// Both providers route to the parakeet/sherpa-onnx stack; only whisper differs.
export function isSherpaLocalProvider(provider: unknown): boolean {
  return provider === "nvidia" || provider === "cohere";
}

// Cohere Transcribe has no auto language detection — the WS server is started
// for exactly one language. Maps the app language (e.g. "auto", "zh-CN") to a
// supported code, falling back to English. Self-detecting models get null.
export function resolveModelLanguage(modelName: string, language: unknown): string | null {
  if (getModelType(modelName) !== "cohere-transcribe") return null;
  const base =
    typeof language === "string"
      ? language.trim().replace(/_/g, "-").split("-")[0].toLowerCase()
      : "";
  const supported = getModelInfo(modelName)?.supportedLanguages || [];
  return supported.includes(base) ? base : "en";
}
