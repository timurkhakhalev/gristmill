# Delivery plan

## Phase 0: import and baseline

- Pin the selected OpenWhispr upstream commit.
- Import code with the original MIT license and required notices.
- Confirm the app builds and the current macOS meeting flow works.
- Add characterization tests for start, stop, repeated stop, system-audio interruption, device change, and renderer loss.
- Record the exact product surfaces to keep before deletion begins.

## Phase 1: recording as source of truth

- Introduce meeting IDs and application-controlled recording directories.
- Persist microphone and system chunks separately during capture.
- Write and recover recording manifests.
- Persist capture-health events.
- Expose both tracks in the meeting detail view.
- Remove deletion of meeting source audio after diarization.

Exit criterion: a meeting remains recoverable even when every cloud request is disabled.

## Phase 2: batch processing pipeline

- Add durable processing runs and restart recovery.
- Adapt existing file transcription to meeting tracks.
- Define canonical timestamped transcript artifacts.
- Add diarization of the system track and deterministic transcript merge.
- Add stage-specific retry with another provider or model.

Exit criterion: the same source recording can produce several preserved transcript revisions.

## Phase 3: automatic notes and chat

- Generate default notes after a final transcript exists.
- Store note provenance and stale state.
- Add custom templates and regeneration.
- Ground meeting chat in transcript timestamps.
- Add audio playback from transcript segments.

Exit criterion: one meeting can be recorded, processed, summarized, questioned, and reprocessed end to end.

## Phase 4: product cut

- Remove dictation, general assistant, translation, sharing, team, enterprise, sync, and non-macOS surfaces.
- Remove unused native binaries, downloads, settings, migrations, and dependencies.
- Split remaining meeting code out of large OpenWhispr modules.
- Rename application identifiers, storage directories, assets, and update metadata.

Exit criterion: the repository contains one coherent macOS meeting product rather than hidden OpenWhispr products.

## Phase 5: quality and Russian evaluation

- Build a consented Russian and mixed Russian/English test corpus.
- Add corrected reference transcripts.
- Compare cloud providers by WER, CER, named entities, punctuation, latency, and cost.
- Evaluate diarization separately with speaker-attributed time.
- Add summary factuality and action-item checks.
- Publish a reproducible internal provider scorecard.

## First milestone acceptance

- Local recording survives network and VPN changes.
- Both tracks are visible and exportable.
- Missing system audio is impossible to miss in the UI.
- Cloud processing can wait, resume, fail, and retry safely.
- Audio remains available after ASR or summary failure.
- A new ASR run does not overwrite the previous transcript.
- Notes are generated automatically and can be regenerated.
- Speaker corrections and timestamps work end to end.

