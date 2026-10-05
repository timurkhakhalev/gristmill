// The three direct-HTTPS download channels, moved out of ipcHandlers.js.
// Registration order, tolerant argument handling, cancel semantics, targeted
// progress and the temp-cleanup path guards match the previous JS
// implementations. The downloader stays JS behind a narrow dependency:
// its results and progress events are accepted as unknown and checked with
// the shared contract schemas before use.
import path from "node:path";
import fs from "node:fs";
import type { ZodType } from "zod";
import {
  cancelUrlDownloadArgsSchema,
  deleteTempFileArgsSchema,
  downloadUrlAudioArgsSchema,
  urlDownloadChannels,
  urlDownloadEventChannel,
  urlDownloadProgressSchema,
  urlDownloadResultSchema,
  type CancelUrlDownloadResult,
  type DeleteTempFileResult,
  type UrlDownloadResult,
} from "../contracts/urlDownload.js";

export interface UrlDownloadHandlerDeps {
  download: (
    url: string,
    onProgress: (progress: unknown) => void,
    signal: AbortSignal
  ) => Promise<unknown>;
  sweepStaleTempArtifacts: () => void;
  getSafeTempDir: () => string;
  debugLogger: {
    error(message: string, meta?: unknown): void;
    warn(message: string, meta?: unknown): void;
  };
}

interface ProgressSender {
  send(channel: string, payload: unknown): void;
  isDestroyed(): boolean;
}

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): unknown;
}

// Downloader results and progress come from untyped JS. Validate before use so
// a shape drift surfaces as a failure result, not a silently-typed lie.
function parseOrThrow<T>(schema: ZodType<T>, raw: unknown, message: string): T {
  const result = schema.safeParse(raw);

  if (!result.success) {
    throw new Error(message);
  }

  return result.data;
}

export function registerUrlDownloadHandlers(
  ipcMain: IpcMainLike,
  deps: UrlDownloadHandlerDeps
): void {
  // Per-registration state, not a module global: a second registration gets
  // its own map and sequence instead of sharing the first one's.
  const activeUrlDownloads = new Map<string, AbortController>();
  let urlDownloadSeq = 0;

  // Sweep ow-url-*/ow-diarize-* orphans from crashes or windows closed
  // mid-download. Runs once at setup time, exactly where the old handler ran
  // it — never at module import.
  deps.sweepStaleTempArtifacts();

  ipcMain.handle(
    urlDownloadChannels.downloadUrlAudio,
    async (rawEvent, ...rawArgs): Promise<UrlDownloadResult> => {
      const parsed = downloadUrlAudioArgsSchema.safeParse(rawArgs);

      if (!parsed.success) {
        // The old boundary checked only type and length; keep exactly that
        // split — an empty string still reaches the downloader.
        return { success: false, error: "Invalid URL", code: "INVALID_URL" };
      }

      const [url, downloadId] = parsed.data;
      const event = rawEvent as { sender: ProgressSender } | null;

      if (!event || !event.sender) {
        return { success: false, error: "Invalid URL", code: "INVALID_URL" };
      }

      // The renderer API types downloadId as an optional string, but JS callers
      // (old preload copies, CLI glue) historically passed anything; a missing,
      // empty or non-string id gets a generated one — exactly the tolerant
      // normalization the JS handlers did before parsing existed.
      const id =
        typeof downloadId === "string" && downloadId ? downloadId : `dl-${++urlDownloadSeq}`;

      const abortController = new AbortController();
      activeUrlDownloads.set(id, abortController);

      try {
        const result = await deps.download(
          url,
          (progress: unknown) => {
            const validated = urlDownloadProgressSchema.safeParse(progress);

            if (!validated.success) {
              deps.debugLogger.warn("Dropping malformed URL download progress event");

              return;
            }

            if (!event.sender.isDestroyed()) {
              event.sender.send(urlDownloadEventChannel, {
                ...validated.data,
                downloadId: id,
              });
            }
          },
          abortController.signal
        );

        const merged: unknown = { success: true, ...(result as Record<string, unknown>) };

        return parseOrThrow(
          urlDownloadResultSchema,
          merged,
          "URL audio downloader returned an unexpected result shape"
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Download failed";

        const code =
          typeof (error as { code?: unknown })?.code === "string"
            ? (error as { code: string }).code
            : undefined;

        deps.debugLogger.error("URL audio download error", { error: message, code });

        return { success: false, error: message, code: code || "DOWNLOAD_FAILED" };
      } finally {
        if (activeUrlDownloads.get(id) === abortController) {
          activeUrlDownloads.delete(id);
        }
      }
    }
  );

  // With an id, cancels that download; without (empty, missing, non-string),
  // cancels all (unmount cleanup).
  ipcMain.handle(
    urlDownloadChannels.cancelUrlDownload,
    async (_event, ...rawArgs): Promise<CancelUrlDownloadResult> => {
      const parsed = cancelUrlDownloadArgsSchema.safeParse(rawArgs);

      if (!parsed.success) {
        return { success: false };
      }

      const [downloadId] = parsed.data;

      if (typeof downloadId === "string" && downloadId) {
        const controller = activeUrlDownloads.get(downloadId);

        if (!controller) return { success: false };
        controller.abort();
        activeUrlDownloads.delete(downloadId);

        return { success: true };
      }

      if (activeUrlDownloads.size === 0) return { success: false };

      for (const controller of activeUrlDownloads.values()) controller.abort();
      activeUrlDownloads.clear();

      return { success: true };
    }
  );

  ipcMain.handle(
    urlDownloadChannels.deleteTempFile,
    async (_event, ...rawArgs): Promise<DeleteTempFileResult> => {
      const parsed = deleteTempFileArgsSchema.safeParse(rawArgs);

      if (!parsed.success) {
        return { success: false, error: "Invalid file path" };
      }

      const [filePath] = parsed.data;

      try {
        const resolved = path.resolve(filePath);
        const basename = path.basename(resolved);

        if (!basename.startsWith("ow-url-") && !basename.startsWith("ow-diarize-")) {
          return { success: false, error: "Not an Gristmill temp file" };
        }

        const real = fs.realpathSync(resolved);
        let tempDir = deps.getSafeTempDir();

        try {
          tempDir = fs.realpathSync(tempDir);
        } catch {}

        const rel = path.relative(tempDir, real);

        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          return { success: false, error: "Not an Gristmill temp file" };
        }

        fs.unlinkSync(real);

        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to delete temp file";
        deps.debugLogger.warn("Failed to delete temp file", { error: message });

        return { success: false, error: message };
      }
    }
  );
}
