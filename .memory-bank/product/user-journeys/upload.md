# Import audio

As a Gristmill user, I want to turn saved audio into a note.

## Entry points

- **Gristmill app → sidebar → Upload file** — the Upload Audio screen.

## Paths

### Transcribe one file

1. Open **Upload file**.
2. Drop an audio file on the screen, or click to browse. Gristmill accepts MP3, WAV, M4A, WebM, OGG, FLAC, AAC and Opus.
3. Optionally turn on **Speaker detection** and set the number of speakers, or keep **Auto-detect**.
4. Click **Transcribe**. The screen shows the progress.
5. When you see **Transcription complete**, select the destination folder. Personal is selected first. Select **No folder** to keep the note directly under **Notes**.
6. Click **Open Note**, or click **Upload Another**.

### Transcribe several files

1. Drop several files, or add files while a queue already exists.
2. Gristmill puts the files in a queue and transcribes them one at a time.
3. Add more files with **Add to queue** while the queue runs. The settings of the queue do not change after it starts.
4. Read the status of each item. Remove an item with **Remove from queue**, or click **Cancel all**.
5. Open the notes of the items that completed. If you quit Gristmill, the queue is lost.

### Transcribe one link

1. Paste one direct HTTPS audio or video file URL into the link field and click **Download**.
2. Wait for the download. Click **Cancel download** if you want to stop it.
3. Click **Transcribe**. When the transcription completes, select the destination folder. This uses the single-file flow.
4. If the URL is invalid or the file cannot be downloaded, Gristmill shows an error. YouTube links and links to private network addresses are rejected.

### Transcribe several links

1. Paste direct HTTPS audio or video file URLs into the link field, one per line. The multiline field opens when you paste multiple lines.
2. Click **Add to queue**. Gristmill skips invalid, duplicate and YouTube links and shows **Some links were skipped.** Private network addresses are rejected during download.
3. Select the destination folder and click **Transcribe**. Gristmill downloads and transcribes the queued files one at a time.
4. Add more links while the queue runs, or click **Cancel all** to stop it. A link submitted while a queue exists also joins the queue.

### Recover from a failed save

1. The transcription completes, but Gristmill cannot save the note.
2. Click **Retry**. Gristmill saves the same transcript again. It does not send the audio to the provider again.
3. Click **Start Over** to discard the result.

### Set up a provider first

1. If no transcription provider is set up, the screen shows **No transcription provider set up**.
2. Click **Open Transcription Settings**, add an API key or download a local model, and come back.

## BDD acceptance criteria

- Given I add several audio files, when I start the queue, then Gristmill transcribes them one at a time.
- Given I submit one valid link with an empty queue, when the download completes, then I can transcribe it in the single-file flow.
- Given I submit several links, when I click **Add to queue**, then valid links join the queue and invalid links are skipped.
- Given I submit a YouTube link, when the download is requested, then Gristmill rejects the link.
- Given the transcription completed but the note did not save, when I click **Retry**, then the note saves without a new provider request.

## Related documents

- [Import architecture](../../architecture/import.md) — file types, link rules, queue and size limits.
- [Choose processing routes](providers.md) — which providers can transcribe a file.
