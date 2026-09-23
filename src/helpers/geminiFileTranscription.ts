import { spawn } from "child_process";
import { createReadStream } from "fs";
import { basename } from "path";
import { createAbortError } from "./abortError.js";
import { getFFmpegPath, parseFfmpegDuration } from "./ffmpegUtils.js";
import { formatTimestamp } from "./speakerMerge.js";
import type { RemoteTranscriptionResult } from "../contracts/uploadTranscription.js";

const API_ROOT = "https://generativelanguage.googleapis.com";
const FILES_URL = `${API_ROOT}/upload/v1beta/files`;
const INTERACTIONS_URL = `${API_ROOT}/v1beta/interactions`;
export const GEMINI_TRANSCRIBE_MAX_SECONDS = 30 * 60;

type FetchResponse = Pick<Response, "ok" | "status" | "headers" | "json" | "text">;
export interface GeminiFileDeps {
  fetch: (url: string, init: RequestInit) => Promise<FetchResponse>;
  probeDuration: (filePath: string, signal?: AbortSignal) => Promise<number | null>;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

interface GeminiFileRequest {
  filePath: string;
  fileSizeBytes: number;
  contentType: string;
  model: string;
  apiKey: string;
  diarize: boolean;
  signal?: AbortSignal;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function mimeType(value: string): string {
  if (value === "audio/mp4") return "audio/m4a";
  if (value === "audio/mpeg") return "audio/mp3";
  return value;
}

function apiError(status: number, body: string): Error {
  if (status === 401 || status === 403 || body.includes("API_KEY_INVALID")) {
    return Object.assign(new Error("Invalid Gemini API key. Check your key in Settings."), {
      code: "INVALID_KEY",
    });
  }
  return Object.assign(new Error(`Gemini API error ${status}: ${body.slice(0, 240)}`), {
    code: status === 429 ? "PROVIDER_RATE_LIMITED" : "GEMINI_API_ERROR",
  });
}

async function checkedJson(response: FetchResponse): Promise<unknown> {
  if (!response.ok) throw apiError(response.status, await response.text());
  return response.json();
}

function parseOffset(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?s$/.test(value)) return null;
  const seconds = Number(value.slice(0, -1));
  return Number.isFinite(seconds) ? seconds : null;
}

export function parseGeminiFileResponse(raw: unknown, diarize: boolean): RemoteTranscriptionResult {
  const response = record(raw);
  if (response?.status !== "completed") {
    return {
      success: false,
      error: `Gemini transcription did not complete (status: ${String(response?.status ?? "unknown")})`,
      code: "GEMINI_INCOMPLETE",
    };
  }
  const steps = response.steps;
  const contents = Array.isArray(steps)
    ? steps.flatMap((step) => {
        const content = record(step)?.content;
        return Array.isArray(content) ? content : [];
      })
    : [];
  const text =
    typeof response.output_text === "string"
      ? response.output_text
      : contents
          .map((content) => record(content))
          .filter((content) => content?.type === "text" && typeof content.text === "string")
          .map((content) => content!.text as string)
          .join(" ");
  if (!text.trim()) {
    return {
      success: false,
      error: "Gemini returned no transcript",
      code: "GEMINI_INVALID_RESPONSE",
    };
  }

  const segments: NonNullable<RemoteTranscriptionResult["segments"]> = [];
  for (const content of contents) {
    const annotations = record(content)?.annotations;
    if (!Array.isArray(annotations)) continue;
    for (const value of annotations) {
      const word = record(value);
      if (word?.type !== "word_info") continue;
      const start = parseOffset(word.start_offset);
      const end = parseOffset(word.end_offset);
      if (
        typeof word.text !== "string" ||
        !word.text ||
        start === null ||
        end === null ||
        end < start
      ) {
        return {
          success: false,
          error: "Gemini returned invalid word or timing data",
          code: "GEMINI_INVALID_RESPONSE",
        };
      }
      if (diarize && (typeof word.speaker !== "string" || !word.speaker)) {
        return {
          success: false,
          error: "Gemini returned no speaker data",
          code: "GEMINI_DIARIZATION_MISSING",
        };
      }
      const speakerId = diarize ? (word.speaker as string) : "";
      const match = /^spk_(\d+)$/.exec(speakerId);
      const speaker = diarize ? (match ? `Speaker ${Number(match[1])}` : speakerId) : undefined;
      const previous = segments.at(-1);
      if (previous && previous.speaker === speaker) {
        previous.text += /^[.,!?;:]/.test(word.text) ? word.text : ` ${word.text}`;
        previous.end = end;
      } else {
        segments.push({ ...(speaker ? { speaker } : {}), text: word.text, start, end });
      }
    }
  }
  if (segments.length === 0) {
    return {
      success: false,
      error: "Gemini returned no word timestamps",
      code: "GEMINI_TIMESTAMPS_MISSING",
    };
  }
  return {
    success: true,
    text: diarize
      ? segments
          .map(
            (segment) =>
              `[${segment.speaker}] ${formatTimestamp(segment.start)} - ${formatTimestamp(segment.end)}\n${segment.text}`
          )
          .join("\n\n")
      : text,
    diarized: diarize,
    segments,
  };
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(createAbortError());
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(createAbortError());
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function probeGeminiAudioDuration(
  filePath: string,
  signal?: AbortSignal
): Promise<number | null> {
  const ffmpeg = getFFmpegPath();
  if (!ffmpeg) return null;
  if (signal?.aborted) throw createAbortError();
  return new Promise((resolve, reject) => {
    // A recorded WebM may have no Duration header. Stream-copying to the null
    // muxer reads its last timestamp without decoding or changing the source.
    const child = spawn(
      ffmpeg,
      ["-hide_banner", "-i", filePath, "-map", "0:a:0", "-c", "copy", "-f", "null", "-"],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    let header = "";
    let tail = "";
    let settled = false;
    const timer = setTimeout(() => finish(null), 120_000);
    function finish(duration: number | null, error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      child.kill();
      if (error) reject(error);
      else resolve(duration);
    }
    function abort() {
      finish(null, createAbortError());
    }
    signal?.addEventListener("abort", abort, { once: true });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (header.length < 32_768) header += text.slice(0, 32_768 - header.length);
      tail = (tail + text).slice(-32_768);
    });
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => {
      const times = [...tail.matchAll(/time=\s*(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)/g)];
      const last = times.at(-1);
      const elapsed = last ? Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]) : 0;
      finish(code === 0 ? Math.max(parseFfmpegDuration(header) || 0, elapsed) || null : null);
    });
  });
}

export async function transcribeGeminiFile(
  request: GeminiFileRequest,
  deps: GeminiFileDeps
): Promise<RemoteTranscriptionResult> {
  const { filePath, fileSizeBytes, apiKey, model, diarize, signal } = request;
  if (!apiKey.trim()) {
    return { success: false, error: "Gemini API key not configured. Add it in Settings." };
  }
  const duration = await deps.probeDuration(filePath, signal);
  if (duration === null || !Number.isFinite(duration) || duration <= 0) {
    return {
      success: false,
      error: "Cannot determine audio duration. Gemini requires a recording of at most 30 minutes.",
      code: "GEMINI_DURATION_UNKNOWN",
    };
  }
  if (duration > GEMINI_TRANSCRIBE_MAX_SECONDS) {
    return {
      success: false,
      error: "Gemini transcription with timestamps supports at most 30 minutes of audio.",
      code: "GEMINI_DURATION_LIMIT",
    };
  }
  if (signal?.aborted) throw createAbortError();

  const contentType = mimeType(request.contentType);
  const headers = { "x-goog-api-key": apiKey };
  const started = await deps.fetch(FILES_URL, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(fileSizeBytes),
      "X-Goog-Upload-Header-Content-Type": contentType,
    },
    body: JSON.stringify({ file: { display_name: basename(filePath) } }),
    signal,
  });
  if (!started.ok) throw apiError(started.status, await started.text());
  const uploadUrl = started.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini did not provide a file upload URL");
  const target = new URL(uploadUrl);
  if (target.origin !== API_ROOT || !target.pathname.startsWith("/upload/")) {
    throw new Error("Gemini returned an invalid file upload URL");
  }

  let name: string | undefined;
  try {
    let offset = 0;
    let uploaded: unknown;
    for await (const chunk of createReadStream(filePath, { highWaterMark: UPLOAD_CHUNK_BYTES })) {
      if (signal?.aborted) throw createAbortError();
      if (offset + chunk.length > fileSizeBytes) {
        throw new Error("Audio file changed during Gemini upload");
      }
      const final = offset + chunk.length === fileSizeBytes;
      const response = await deps.fetch(target.toString(), {
        method: "POST",
        headers: {
          "X-Goog-Upload-Offset": String(offset),
          "X-Goog-Upload-Command": final ? "upload, finalize" : "upload",
        },
        body: chunk as unknown as NonNullable<RequestInit["body"]>,
        signal,
      });
      if (!response.ok) throw apiError(response.status, await response.text());
      if (final) uploaded = await response.json();
      offset += chunk.length;
    }
    if (offset !== fileSizeBytes) throw new Error("Audio file changed during Gemini upload");
    let file = record(record(uploaded)?.file);
    name = typeof file?.name === "string" ? file.name : undefined;
    if (!name || !/^files\/[a-z0-9-]+$/.test(name)) {
      throw new Error("Gemini returned invalid file metadata");
    }
    for (let attempt = 0; file?.state !== "ACTIVE"; attempt++) {
      if (file?.state === "FAILED") throw new Error("Gemini could not process the uploaded audio");
      if (attempt >= 300) throw new Error("Gemini file processing timed out");
      await (deps.wait || wait)(1000, signal);
      file = record(
        await checkedJson(await deps.fetch(`${API_ROOT}/v1beta/${name}`, { headers, signal }))
      );
    }
    const uri = file.uri;
    if (typeof uri !== "string" || !uri) throw new Error("Gemini returned no file URI");
    const interaction = await checkedJson(
      await deps.fetch(INTERACTIONS_URL, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          input: [{ type: "audio", uri, mime_type: contentType }],
          generation_config: {
            transcription_config: {
              mode: {
                type: "verbatim",
                ...(diarize ? { diarization_mode: "speaker" } : {}),
                timestamp_granularities: ["word"],
              },
            },
          },
        }),
        signal,
      })
    );
    return parseGeminiFileResponse(interaction, diarize);
  } finally {
    if (name) {
      try {
        await deps.fetch(`${API_ROOT}/v1beta/${name}`, {
          method: "DELETE",
          headers,
        });
      } catch {
        // Uploaded files expire automatically; cleanup must not hide the ASR result.
      }
    }
  }
}
