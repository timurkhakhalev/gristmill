// Environment-neutral ONNX utility-process protocol. The discriminated unions
// below are the only shapes that cross the MessagePortMain boundary; both
// sides parse unknown messages through these guards before any model
// invocation or pending-resolution happens.

export const ONNX_WORKER_METHODS = ["ping", "speaker.load", "speaker.extract", "shutdown"] as const;

export type OnnxWorkerMethod = (typeof ONNX_WORKER_METHODS)[number];

interface RequestBase {
  id: number;
}

interface ReplyBase {
  id: number;
}

export interface PingRequest extends RequestBase {
  method: "ping";
  payload?: Record<string, never>;
}

export interface SpeakerLoadRequest extends RequestBase {
  method: "speaker.load";
  payload: { modelPath: string };
}

export interface SpeakerExtractRequest extends RequestBase {
  method: "speaker.extract";
  payload: { samplesBuffer: ArrayBuffer };
}

export interface ShutdownRequest extends RequestBase {
  method: "shutdown";
  payload?: Record<string, never>;
}

export type OnnxWorkerRequest =
  | PingRequest
  | SpeakerLoadRequest
  | SpeakerExtractRequest
  | ShutdownRequest;

export interface PingResult {
  ok: true;
  sessions: { speaker: boolean };
}

export interface SpeakerLoadResult {
  ok: true;
}

export interface SpeakerExtractResult {
  embeddingBuffer: ArrayBuffer | null;
}

export interface ShutdownResult {
  ok: true;
}

export type OnnxWorkerResult =
  | PingResult
  | SpeakerLoadResult
  | SpeakerExtractResult
  | ShutdownResult;

// The client builds a request from a method and its matching payload; this map
// ties the two together so the transport never takes an untyped payload.
export interface OnnxWorkerPayloadByMethod {
  ping: Record<string, never>;
  "speaker.load": { modelPath: string };
  "speaker.extract": { samplesBuffer: ArrayBuffer };
  shutdown: Record<string, never>;
}

export interface OnnxWorkerResultByMethod {
  ping: PingResult;
  "speaker.load": SpeakerLoadResult;
  "speaker.extract": SpeakerExtractResult;
  shutdown: ShutdownResult;
}

export interface OnnxWorkerError {
  message: string;
}

export type OnnxWorkerReply =
  | ({ error?: undefined } & ReplyBase & { result: OnnxWorkerResult })
  | ({ result?: undefined } & ReplyBase & { error: OnnxWorkerError });

// Both processes validate against the finite method map, so the guard only has
// to check the discriminating fields and the payload shape per method.
// `raw` is the MessagePortMain payload — the exact-file override keeps the
// parser signature honest.
export function parseOnnxWorkerRequest(raw: unknown): OnnxWorkerRequest | null {
  // SAFETY: every field is re-checked below before the object literal is
  // rebuilt; the assertion only carries the checked candidate shape.
  const candidate = raw as {
    id?: unknown;
    method?: unknown;
    payload?: { modelPath?: unknown; samplesBuffer?: unknown };
  };

  if (typeof candidate.id !== "number" || !Number.isInteger(candidate.id)) return null;

  switch (candidate.method) {
    case "ping":
    case "shutdown":
      return { id: candidate.id, method: candidate.method };
    case "speaker.load": {
      const modelPath = candidate.payload?.modelPath;

      if (typeof modelPath !== "string") return null;

      return { id: candidate.id, method: "speaker.load", payload: { modelPath } };
    }

    case "speaker.extract": {
      const samplesBuffer = candidate.payload?.samplesBuffer;

      if (!(samplesBuffer instanceof ArrayBuffer)) return null;

      return { id: candidate.id, method: "speaker.extract", payload: { samplesBuffer } };
    }

    default:
      return null;
  }
}

export function parseOnnxWorkerReply(raw: unknown): OnnxWorkerReply | null {
  // SAFETY: every field is re-checked below before the reply is rebuilt; the
  // assertion only carries the checked candidate shape.
  const candidate = raw as { id?: unknown; result?: unknown; error?: unknown };

  if (typeof candidate.id !== "number" || !Number.isInteger(candidate.id)) return null;

  if (candidate.error !== undefined) {
    // SAFETY: the message field is probed for a string before the reply
    // rebuild below reads it as one.
    if (
      typeof candidate.error !== "object" ||
      candidate.error === null ||
      !("message" in candidate.error) ||
      typeof candidate.error.message !== "string"
    ) {
      return null;
    }

    return { id: candidate.id, error: { message: candidate.error.message } };
  }

  // Results are method-specific and opaque to the client's transport layer;
  // an absent result with no error is not a reply it can resolve with.
  if (candidate.result === undefined) return null;

  // SAFETY: the worker contract types results per method; the transport layer
  // routes by id and the awaiting caller owns the method-specific parse.
  return { id: candidate.id, result: candidate.result as OnnxWorkerResult };
}

export function isOnnxWorkerMethod(value: unknown): value is OnnxWorkerMethod {
  // SAFETY: the membership test against the frozen method list is the check;
  // the assertion only re-voiced the already-narrowed value.
  return typeof value === "string" && (ONNX_WORKER_METHODS as readonly string[]).includes(value);
}

// Identity of a rejected request, used only to build the "unknown method" error
// reply both sides agree on. Lives on this boundary so the worker does not
// re-probe an untrusted port payload itself.
export interface OnnxWorkerRequestIdentity {
  id: number;
  method: string;
}

export function onnxWorkerRequestIdentity(raw: unknown): OnnxWorkerRequestIdentity {
  if (typeof raw !== "object" || raw === null) return { id: 0, method: "" };

  const id = "id" in raw && typeof raw.id === "number" && Number.isInteger(raw.id) ? raw.id : 0;
  const method = "method" in raw ? String(raw.method) : "";

  return { id, method };
}
