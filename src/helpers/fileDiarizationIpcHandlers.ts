// The file diarization and speaker-text merge IPC handlers, moved out of
// ipcHandlers.js. Diarization registers its requestId in the shared upload
// cancel registry (the same id as the upload's transcription), passes the
// AbortSignal into the FFmpeg conversion and the diarizer, checks for cancel
// after lazy model preparation and between stages, and always releases the
// registration plus the temporary WAV in finally. Model download/delete and
// meeting background diarization stay in their own modules. The merge handler
// keeps its historical normalizing behavior (sanitized segments, size limits
// as error results) instead of a strict reject.
import {
  diarizationOptionsSchema,
  mergeSpeakerTextRequestSchema,
  uploadTranscriptionChannels,
  type DiarizationResult,
  type DiarizationSegment,
} from "../contracts/uploadTranscription.js";
import { z } from "zod";
import type { MergedSpeakerSegment } from "./speakerMerge.js";
import type { UploadCancelRegistry } from "./uploadCancelRegistry.js";

type IpcMainLike = {
  handle<Result>(channel: string, listener: (...args: unknown[]) => Result): void;
};

// The merge handler keeps its historical tolerance: junk items are coerced
// field-by-field (missing keys keep their defaults), never rejected.
const sanitizedSegmentSchema = z
  .object({
    speaker: z
      .string()
      .transform((value) => value.slice(0, 100))
      .catch("unknown")
      .default("unknown"),
    start: z.number().refine(Number.isFinite).catch(0).default(0),
    end: z.number().refine(Number.isFinite).catch(0).default(0),
  })
  .catch({ speaker: "unknown", start: 0, end: 0 });

function messageOf<T>(error: T): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

function nameOf<T>(error: T): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function isString<T>(value: T): value is T & string {
  return typeof value === "string";
}

export interface FileDiarizationManager {
  isModelDownloaded(): boolean;
  diarize(
    wavPath: string,
    options: { numSpeakers: number; threshold: number; signal?: AbortSignal }
  ): Promise<DiarizationSegment[]>;
  capSpeakerClusters(segments: DiarizationSegment[], cap: number): DiarizationSegment[];
}

export interface FileDiarizationDeps {
  diarizationManager: FileDiarizationManager | null;
  resolveAllowedAudioPath: (filePath: string) => string | null;
  convertToWav: (
    inputPath: string,
    outputPath: string,
    options?: { sampleRate?: number; channels?: number; signal?: AbortSignal }
  ) => Promise<void>;
  createTempWavPath: () => string;
  fileSize: (filePath: string) => number;
  resolveClusterThreshold: (durationSeconds: number, requestedThreshold?: number) => number;
  dropNegligibleClusters: (segments: DiarizationSegment[]) => DiarizationSegment[];
  pcm16Mono16kBytesPerSecond: number;
  maxSpeakerCount: number;
  removeFile: (filePath: string) => void;
  mergeSpeakersWithText: (
    segments: DiarizationSegment[],
    text: string,
    duration: number
  ) => MergedSpeakerSegment[];
  formatSpeakerTranscript: (merged: MergedSpeakerSegment[]) => string;
  uploadCancelRegistry: UploadCancelRegistry;
  logDebug: <T>(message: string, data?: T) => void;
  logError: <T>(message: string, data?: T) => void;
}

function cancelled(): DiarizationResult {
  return { success: false, error: "Cancelled", code: "UPLOAD_CANCELLED" };
}

function registerDiarizeHandler(ipcMain: IpcMainLike, deps: FileDiarizationDeps): void {
  ipcMain.handle(
    uploadTranscriptionChannels.diarizeAudioFile,
    async (_event, ...args: unknown[]) => {
      const filePathArg = args[0];

      // The old JS default (`options = {}`) applied only to undefined; junk
      // (including null) is rejected before any model check, read or registration.
      const parsedOptions = diarizationOptionsSchema.safeParse(
        args[1] === undefined ? {} : args[1]
      );

      if (!parsedOptions.success) {
        return { success: false, error: "Invalid diarization request" };
      }

      const options = parsedOptions.data;
      // Registered under the same requestId as the upload's transcription, so
      // one cancel kills both the decode and the diarization child process.
      const { signal, release } = deps.uploadCancelRegistry.register(options.requestId);

      try {
        if (!deps.diarizationManager) {
          return { success: false, error: "Diarization not available" };
        }

        if (!deps.diarizationManager.isModelDownloaded()) {
          return { success: false, error: "Diarization models not downloaded" };
        }

        // Cancel may have landed during the lazy model preparation above.
        if (signal?.aborted) return cancelled();

        if (!isString(filePathArg)) {
          return { success: false, error: "Invalid file path" };
        }

        const realPath = deps.resolveAllowedAudioPath(filePathArg);

        if (!realPath) return { success: false, error: "File path not allowed" };

        const numSpeakers = Math.min(
          deps.maxSpeakerCount,
          Math.max(-1, Math.round(Number(options.numSpeakers) || -1))
        );

        const wavPath = deps.createTempWavPath();

        try {
          await deps.convertToWav(realPath, wavPath, { sampleRate: 16000, channels: 1, signal });

          if (signal?.aborted) {
            return cancelled();
          }

          // Auto-clustering over-splits long single-mic audio at the 0.55
          // default, so the threshold ramps with duration unless pinned.
          const durationSeconds = deps.fileSize(wavPath) / deps.pcm16Mono16kBytesPerSecond;
          const threshold = deps.resolveClusterThreshold(durationSeconds, options.threshold);

          let segments = await deps.diarizationManager.diarize(wavPath, {
            numSpeakers,
            threshold,
            signal,
          });

          if (signal?.aborted) {
            return cancelled();
          }

          // The meeting path caps clusters via its expectation resolver; this
          // path fed raw sherpa output to the merge, which is how a 2-person
          // voice memo surfaced 46 speakers.
          segments = deps.dropNegligibleClusters(segments);
          segments = deps.diarizationManager.capSpeakerClusters(
            segments,
            numSpeakers > 0 ? numSpeakers : deps.maxSpeakerCount
          );

          // Callers persist this as audio_duration_seconds: for picked files
          // the renderer has no other duration source.
          return { success: true, segments, durationSeconds };
        } finally {
          try {
            deps.removeFile(wavPath);
          } catch {
            // The temp WAV is best-effort cleanup.
          }
        }
      } catch (error) {
        if (nameOf(error) === "AbortError" || signal?.aborted) {
          deps.logDebug("Diarization cancelled", { requestId: options.requestId });

          return cancelled();
        }

        deps.logError("Diarization error", { error: messageOf(error) });

        return { success: false, error: messageOf(error) };
      } finally {
        release();
      }
    }
  );
}

function registerMergeHandler(ipcMain: IpcMainLike, deps: FileDiarizationDeps): void {
  ipcMain.handle(
    uploadTranscriptionChannels.mergeSpeakerText,
    async (_event, ...args: unknown[]) => {
      try {
        const parsed = mergeSpeakerTextRequestSchema.safeParse(args[0]);

        if (!parsed.success || !isFinite(parsed.data.duration)) {
          return { success: false, error: "Invalid arguments" };
        }

        const { segments, text, duration } = parsed.data;

        if (segments.length > 10000 || text.length > 1_000_000) {
          return { success: false, error: "Input too large" };
        }

        const sanitizedSegments = segments.map((s) => sanitizedSegmentSchema.parse(s));

        const merged = deps.mergeSpeakersWithText(sanitizedSegments, text, duration);

        return { success: true, text: deps.formatSpeakerTranscript(merged) };
      } catch (error) {
        deps.logError("Speaker merge error", { error: messageOf(error) });

        return { success: false, error: messageOf(error) };
      }
    }
  );
}

export function registerFileDiarizationHandlers(
  ipcMain: IpcMainLike,
  deps: FileDiarizationDeps
): void {
  registerDiarizeHandler(ipcMain, deps);
  registerMergeHandler(ipcMain, deps);
}
