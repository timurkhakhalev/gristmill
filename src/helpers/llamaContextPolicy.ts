/**
 * Pure policy for sizing the llama-server context window.
 *
 * Replaces the flat SERVER_CONTEXT_SIZE = 16384 cap (#2142), which blocked
 * every transcript over ~80 minutes on every bundled model. The cap itself was
 * not gratuitous: it fixed #1203, where an unbounded context allocated a ~15 GB
 * Metal-wired KV cache and froze a 16 GB Mac into a watchdog kernel panic. So
 * the replacement is not a bigger constant but a per-machine, per-model budget.
 *
 * Everything here is pure arithmetic so the memory guarantee can be tested
 * without a GPU, a model file, or a spawned process.
 */

// Raw GGUF values: scalars are numbers, but GGUF also permits per-layer
// arrays (real files use them for attention.head_count_kv). Absent metadata is
// undefined — never a default invented here, so callers cannot mistake
// "unknown" for "zero".
export interface GgufArchitectureMetadata {
  blockCount?: number | number[] | boolean;
  embeddingLength?: number | number[] | boolean;
  headCount?: number | number[] | boolean;
  headCountKv?: number | number[] | boolean;
  keyLength?: number | number[] | boolean;
  valueLength?: number | number[] | boolean;
}

// Latin text tokenizes at roughly 3.5-4.2 chars/token on the Qwen/Llama BPEs
// used here (measured: 4.16 on a synthetic English transcript). 3 leaves
// headroom, because under-estimating is the bug and over-estimating only costs
// KV bytes that the ceiling already bounds.
export const LATIN_CHARS_PER_TOKEN = 3;

// CJK runs about 1-1.5 chars/token. Charging 1 keeps the estimate on the safe
// side for the ja / zh-CN / zh-TW locales the app ships.
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x11ff], // Hangul Jamo
  [0x3000, 0x303f], // CJK symbols and punctuation
  [0x3040, 0x30ff], // Hiragana + Katakana
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xac00, 0xd7af], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xff00, 0xffef], // Halfwidth and Fullwidth Forms
  [0x20000, 0x3ffff], // CJK Unified Ideographs Extensions B and beyond
];

function isCjkCodePoint(codePoint: number): boolean {
  for (const [start, end] of CJK_RANGES) {
    if (codePoint >= start && codePoint <= end) return true;
  }

  return false;
}

/**
 * Cheap, deliberately high estimate of how many tokens a string will occupy.
 *
 * Only used to choose the context size a server STARTS at. Once a server is
 * running, POST /tokenize returns the exact count in ~13 ms and supersedes
 * this; the estimate just avoids paying a restart in the common case.
 */
export function estimateTokens(text: string): number {
  if (typeof text !== "string" || text.length === 0) return 0;

  let cjkCount = 0;
  let otherCount = 0;

  for (const character of text) {
    if (isCjkCodePoint(character.codePointAt(0) ?? 0)) cjkCount += 1;
    else otherCount += 1;
  }

  return cjkCount + Math.ceil(otherCount / LATIN_CHARS_PER_TOKEN);
}

// K and V are cached as f16 by default (llama.cpp --cache-type-k/-v).
export const KV_ELEMENT_BYTES = 2;

// GGUF arrays carry per-layer values; only scalars are usable here. A scalar
// read out of an array-declared field would price garbage, so arrays surface
// as unknown (null) exactly like absent metadata.
function scalarValue(raw: number | number[] | boolean | undefined): number | null {
  return typeof raw === "number" && raw > 0 ? raw : null;
}

function resolveHeadCountKv(metadata: GgufArchitectureMetadata): number | null {
  const raw = metadata.headCountKv;

  // GGUF permits a per-layer array. The widest layer is the safe reading.
  if (Array.isArray(raw)) {
    const widest = raw.reduce((max, value) => (value > max ? value : max), 0);

    return widest > 0 ? widest : null;
  }

  return scalarValue(raw);
}

interface HeadWidths {
  keyLength: number;
  valueLength: number;
}

function resolveHeadWidths(metadata: GgufArchitectureMetadata): HeadWidths | null {
  const keyLength = scalarValue(metadata.keyLength);
  const valueLength = scalarValue(metadata.valueLength);

  if (keyLength !== null && valueLength !== null) return { keyLength, valueLength };

  // llama.cpp's own fallback when the widths are not declared.
  const embeddingLength = scalarValue(metadata.embeddingLength);
  const headCount = scalarValue(metadata.headCount);

  if (embeddingLength !== null && headCount !== null) {
    const width = embeddingLength / headCount;

    if (Number.isInteger(width) && width > 0) return { keyLength: width, valueLength: width };
  }

  return null;
}

/**
 * Bytes of KV cache each token of context costs, from the model's own
 * architecture. Assumes every layer is full attention, which over-estimates
 * sliding-window models (Gemma 3/4) and models that interleave full attention
 * (Qwen3.5). Over-estimating shrinks the ceiling, so it errs safe.
 *
 * Returns null when the architecture cannot be read. Callers must treat null
 * as "fall back to the historical 16384", never as "assume it is cheap".
 */
export function kvBytesPerToken(metadata: GgufArchitectureMetadata | null): number | null {
  if (!metadata || typeof metadata !== "object") return null;

  const blockCount = scalarValue(metadata.blockCount);

  if (blockCount === null) return null;

  const headCountKv = resolveHeadCountKv(metadata);

  if (headCountKv === null) return null;

  const widths = resolveHeadWidths(metadata);

  if (widths === null) return null;

  return blockCount * headCountKv * (widths.keyLength + widths.valueLength) * KV_ELEMENT_BYTES;
}

// The historical cap (#1236). Now the floor and the universal fallback rather
// than the ceiling, so no configuration that works today can get smaller.
export const BASELINE_CONTEXT_SIZE = 16384;

// Half the machine, minus a fixed slice for the OS itself. Deliberately ~1.7x
// tighter than llama.cpp's own --fit, which would permit ~9.6 GiB of wired
// memory on the 16 GB Mac that panicked in #1203.
export const USABLE_MEMORY_FRACTION = 0.5;

export const FIXED_OS_RESERVE_BYTES = 2 * 1024 * 1024 * 1024;

// Compute buffers also grow with context: measured 144 MiB total at 16384 and
// 240 MiB at 65536 for a 9B, i.e. ~2 KiB/token plus a fixed base. Doubled for
// margin, and the base sized for the 31B-class graphs.
export const COMPUTE_FIXED_BYTES = 384 * 1024 * 1024;

export const COMPUTE_BYTES_PER_TOKEN = 4096;

// Hybrid models (Qwen3.5, LFM2) carry recurrent state that is not part of the
// KV cache and does not scale with context.
export const RECURRENT_STATE_BYTES = 512 * 1024 * 1024;

// A discrete GPU's VRAM is not system RAM and we do not probe it. Until a real
// measurement exists, stay modest and let the existing GPU fallback ladder
// handle anything that still will not fit.
export const UNVERIFIED_GPU_CEILING = 65536;

// Contexts are aligned down to a round number so that near-identical requests
// land on the same value and cannot cause a second restart.
export const CONTEXT_ALIGNMENT = 512;

const MIB = 1024 * 1024;

const MIN_CACHE_RAM_MIB = 512;

const MAX_CACHE_RAM_MIB = 2048;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export interface ContextCeiling {
  ceiling: number;
  reason: string;
  cacheRamMiB: number;
}

function fallbackCeiling(reason: string): ContextCeiling {
  return { ceiling: BASELINE_CONTEXT_SIZE, reason, cacheRamMiB: MIN_CACHE_RAM_MIB };
}

export interface ContextCeilingInput {
  totalMemoryBytes: number;
  weightsBytes?: number;
  draftWeightsBytes?: number;
  kvBytesPerToken: number | null;
  hasRecurrentState?: boolean;
  trainedContextTokens?: number;
  discreteGpuUnverified?: boolean;
}

/**
 * The largest context this machine may allocate for this model.
 *
 * Every path that cannot answer confidently returns BASELINE_CONTEXT_SIZE, so
 * the worst case of this whole mechanism is the behaviour that ships today.
 */
export function resolveContextCeiling({
  totalMemoryBytes,
  weightsBytes = 0,
  draftWeightsBytes = 0,
  kvBytesPerToken,
  hasRecurrentState = false,
  trainedContextTokens = 0,
  discreteGpuUnverified = false,
}: ContextCeilingInput): ContextCeiling {
  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) {
    return fallbackCeiling("no-memory-info");
  }

  if (!Number.isFinite(kvBytesPerToken) || kvBytesPerToken === null || kvBytesPerToken <= 0) {
    return fallbackCeiling("unknown-kv-cost");
  }

  const budgetBytes = totalMemoryBytes * USABLE_MEMORY_FRACTION - FIXED_OS_RESERVE_BYTES;

  const kvBudgetBytes =
    budgetBytes -
    weightsBytes -
    draftWeightsBytes -
    COMPUTE_FIXED_BYTES -
    (hasRecurrentState ? RECURRENT_STATE_BYTES : 0);

  if (kvBudgetBytes <= 0) return fallbackCeiling("floor");

  const cacheRamMiB = clamp(
    Math.floor(kvBudgetBytes / 4 / MIB),
    MIN_CACHE_RAM_MIB,
    MAX_CACHE_RAM_MIB
  );

  const perTokenBytes = kvBytesPerToken + COMPUTE_BYTES_PER_TOKEN;

  const affordable =
    Math.floor(Math.floor(kvBudgetBytes / perTokenBytes) / CONTEXT_ALIGNMENT) * CONTEXT_ALIGNMENT;

  let hardMax = trainedContextTokens > 0 ? trainedContextTokens : Number.POSITIVE_INFINITY;
  let hardMaxReason = "trained-context-bound";

  if (discreteGpuUnverified && UNVERIFIED_GPU_CEILING < hardMax) {
    hardMax = UNVERIFIED_GPU_CEILING;
    hardMaxReason = "gpu-cap";
  }

  const ceiling = Math.min(affordable, hardMax);

  if (ceiling <= BASELINE_CONTEXT_SIZE) return fallbackCeiling("floor");

  return {
    ceiling,
    reason: ceiling === hardMax ? hardMaxReason : "memory-bound",
    cacheRamMiB,
  };
}

// Quantizing the chosen context bounds how many distinct restarts a session can
// cause: at most one per rung per model, however many differently-sized
// requests arrive.
export const CONTEXT_STEPS: readonly number[] = [16384, 32768, 65536, 131072, 262144];

export interface ContextSizeInput {
  needed?: number;
  floor?: number;
  ceiling?: number;
}

/**
 * The context size to start (or grow) the server at for a request needing
 * `needed` tokens, given a caller floor and the machine's ceiling.
 *
 * The ceiling always wins: it is the memory guarantee, and it is not
 * necessarily on a rung.
 */
export function resolveContextSize({
  needed = 0,
  floor = 0,
  ceiling = BASELINE_CONTEXT_SIZE,
}: ContextSizeInput): number {
  const target = Math.max(needed || 0, floor || 0, BASELINE_CONTEXT_SIZE);
  const rung = CONTEXT_STEPS.find((step) => step >= target) ?? Number.POSITIVE_INFINITY;
  const bounded = Math.min(rung, Math.max(ceiling, BASELINE_CONTEXT_SIZE));

  return Math.max(bounded, BASELINE_CONTEXT_SIZE);
}
