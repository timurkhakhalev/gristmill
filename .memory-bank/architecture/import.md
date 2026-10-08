# Audio import

This document contains the file, link and queue rules of the Upload screen.
User paths: [Import audio](../product/user-journeys/upload.md). Provider size limits: [processing routes](processing-routes.md).

## Files

- The local picker accepts MP3, WAV, M4A, WebM, Ogg, Oga, FLAC, AAC and Opus. The picker does not offer general video-container import.
- One file with an empty queue uses the single-file flow. Several files, or additions to an existing queue, use the batch.

## Links

- URL import requires HTTPS, also for redirects. YouTube hosts and private or internal addresses are rejected.
- A URL download allows at most three redirects and 500 MiB.
- Batch URL input accepts one URL for each line and at most 50 valid unique URLs for each addition. This is not a total queue limit.

## Queue

- The queue runs one item at a time and accepts new items while it runs.
- Settings are captured when the batch starts.
- The queue does not survive an application restart.

## Destination and speakers

- Folder choices come from the Notes tree. Personal is initially selected when available. No folder saves the note at the Notes root.
- Speaker detection is optional and off by default. Depending on the route, it uses provider diarization or downloaded local models.

## Results

- Each successful item creates an upload Note with saved transcript data.
- A single upload keeps its completed transcript before the first Note save. If that save rejects or returns an unsuccessful result, Retry saves the retained result without another ASR request. Start Over clears it.

## Not available

- Granola CSV parsing, preview and import exist in main and preload, but no renderer action calls them. Granola import is not a user journey.

## Code locations

- `src/components/notes/UploadAudioView.tsx` — file, URL and folder controls.
- `src/stores/batchQueueStore.ts` — queue lifecycle.
- `src/services/uploadNotes.ts` — saved notes.
- `src/services/fileTranscription.ts` — transcription and diarization.
- `src/helpers/urlAudioDownloader.ts` — download limits.
- `src/helpers/noteFilesIpcHandlers.ts` — Granola backend.
