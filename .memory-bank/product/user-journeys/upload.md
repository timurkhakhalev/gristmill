# Import audio

As a Gristmill user, I want to turn saved audio into a note.

## User journey

1. Open Upload and select or drop audio files, or download a direct media URL.
2. Choose the destination folder, including No folder.
3. Review transcription settings and optionally enable speaker detection.
4. Start transcription. For a batch, review each item as the queue runs.
5. Open the notes created from successful items.

## Behavior and limits

- The local picker accepts MP3, WAV, M4A, WebM, Ogg, Oga, FLAC, AAC and Opus. General video-container import is not offered by this picker.
- One file with an empty queue uses the single-file flow. Multiple files, or additions to an existing queue, use the batch.
- URL import requires HTTPS, including redirects. YouTube hosts and private/internal addresses are rejected. URL downloads allow at most three redirects and 500 MiB.
- Batch URL input accepts one URL per line and at most 50 valid unique URLs per addition. This is not a total queue limit.
- The queue runs sequentially and accepts new items while running. Settings are captured when the batch starts. The queue does not survive an application restart.
- Folder choices come from the private space. Personal is initially selected when available. No folder saves the note at the space root.
- Speaker detection is optional and defaults to off. Depending on the route, it uses provider diarization or downloaded local models.
- Each successful item creates an upload Note with saved transcript data. [Provider limits](providers.md) also apply.
- Granola CSV parsing, preview and import exist in main/preload, but no renderer action calls them. Granola import is not an available UI journey.

## What to check

- Single and batch imports create notes in the chosen destination.
- Invalid media URLs fail without creating a successful import.

## BDD acceptance criteria

- Given I add several audio files, when I start the batch, then the queue processes them one at a time.
- Given I submit a YouTube URL, when download is requested, then the URL is rejected.

## Entry points

- [UploadAudioView.tsx](../../../src/components/notes/UploadAudioView.tsx) — file, URL and folder controls.
- [batchQueueStore.ts](../../../src/stores/batchQueueStore.ts) — queue lifecycle.
- [uploadNotes.ts](../../../src/services/uploadNotes.ts) — saved notes.
- [fileTranscription.ts](../../../src/services/fileTranscription.ts) — transcription and diarization.
- [urlAudioDownloader.ts](../../../src/helpers/urlAudioDownloader.ts) — download limits.
- [noteFilesIpcHandlers.ts](../../../src/helpers/noteFilesIpcHandlers.ts) — Granola backend.
