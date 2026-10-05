// Single source of truth for the direct HTTPS audio download vertical: the
// three IPC channels, their payloads/results and the progress event. Types are
// derived from Zod schemas so main, preload and renderer share one
// description. No Electron/React/store/fs imports here.
//
// The main handlers accept unknown from the renderer and validate with the
// argument schemas; the downloader (src/helpers/urlAudioDownloader.js) is an
// untyped JS boundary whose results are validated with the same schemas
// before use. URL protocol/SSRF/content checks stay in the downloader — this
// contract only fixes shapes.
import { z } from "zod";

const urlArg = z.string().max(2048);

// downloadId keeps its public optional-string shape, but the JS side of the
// boundary historically passed anything (missing, null, numbers); the main
// handlers normalize that tolerant id, not the schema.
export const downloadUrlAudioArgsSchema = z.tuple([urlArg, z.unknown().optional()]);

export const cancelUrlDownloadArgsSchema = z.tuple([z.unknown().optional()]);

export const deleteTempFileArgsSchema = z.tuple([z.string()]);

export const urlDownloadSuccessSchema = z.object({
  success: z.literal(true),
  tempPath: z.string(),
  title: z.string(),
  durationSeconds: z.number().nullable(),
  sizeBytes: z.number(),
});

export const urlDownloadFailureSchema = z.object({
  success: z.literal(false),
  error: z.string(),
  code: z.string().optional(),
});

export const urlDownloadResultSchema = z.union([
  urlDownloadSuccessSchema,
  urlDownloadFailureSchema,
]);

export const cancelUrlDownloadResultSchema = z.object({ success: z.boolean() });

export const deleteTempFileResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

export const urlDownloadProgressSchema = z.object({
  stage: z.enum(["resolving", "downloading", "ready"]),
  percent: z.number(),
  title: z.string().optional(),
  // The downloader does not set this; the handler stamps the assigned id
  // before forwarding the event to the initiating sender.
  downloadId: z.string().optional(),
});

export type UrlDownloadSuccess = z.infer<typeof urlDownloadSuccessSchema>;

export type UrlDownloadFailure = z.infer<typeof urlDownloadFailureSchema>;

export type UrlDownloadResult = z.infer<typeof urlDownloadResultSchema>;

export type CancelUrlDownloadResult = z.infer<typeof cancelUrlDownloadResultSchema>;

export type DeleteTempFileResult = z.infer<typeof deleteTempFileResultSchema>;

export type UrlDownloadProgress = z.infer<typeof urlDownloadProgressSchema>;

// The renderer-facing surface: three operations, one subscription with a
// precise unsubscribe. downloadId stays optional — unmount cleanup calls
// cancelUrlDownload() with no argument.
export interface UrlDownloadApi {
  downloadUrlAudio(url: string, downloadId?: string): Promise<UrlDownloadResult>;
  cancelUrlDownload(downloadId?: string): Promise<CancelUrlDownloadResult>;
  deleteTempFile(filePath: string): Promise<DeleteTempFileResult>;
  onUrlDownloadProgress(callback: (progress: UrlDownloadProgress) => void): () => void;
}

export const urlDownloadChannels = {
  downloadUrlAudio: "download-url-audio",
  cancelUrlDownload: "cancel-url-download",
  deleteTempFile: "delete-temp-file",
} as const;

export const urlDownloadEventChannel = "url-download-progress" as const;
