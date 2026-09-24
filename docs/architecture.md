# Architecture

## Current implementation (M1–M4)

M1–M4 implement the approved record-then-process flow. The task branch still
needs the root-owned M4 focused/full verification and integrated application
smoke. The live mic/system hardware smoke was explicitly deferred and remains
unverified. Product decisions and remaining hypotheses are in
[record-then-process.md](record-then-process.md).

The existing Note remains the product root. The main process owns recording
files, SQLite persistence, provider calls, processing jobs, and managed paths;
the renderer requests operations through typed IPC. No replacement dashboard,
second sweeper, or compatibility path was added.

SQLite stores `meeting_recordings`, `meeting_recording_epochs`,
`meeting_processing_runs`, `meeting_deletion_intents`, and
`meeting_run_speaker_corrections`. The recording row holds the pre-capture
configuration snapshot, capture/audio states, end time, and selected run.
Epoch rows store source, sample offset, byte/frame recovery information, and
the managed relative path. Each processing run stores its source/provider/model,
configuration, stage, status, error, and artifact paths. Speaker corrections
are scoped by `(run_id, speaker_id)`; profile rows remain shared.

Under Electron `userData`, immutable PCM is stored at
`audio/meetings/{recordingId}/{mic|system}/epoch-000000.pcm`. Derived full
timeline WAVs live at `audio/meetings/{recordingId}/derived/{runId}.wav` and
are rebuilt from the original epochs. Per-run artifacts live at
`meeting-results/{runId}/raw-provider-response.json`, `transcript.json`, and
`summary.json`. SQLite and the storage manager derive and validate these paths
in main; renderer IPC takes recording/run IDs, not arbitrary filesystem paths.

Before the first captured frame, main persists the selected configuration.
Capture performs no ASR or provider request. Stop closes both source epochs,
recovers their frame counts and gaps, finalizes the recording, and creates its
initial run. The worker waits for retention settings to sync and pauses while
capture is active. It creates one mono, full timeline WAV for the run, sends it
through the selected existing route, persists the raw provider response before
normalization, then stores transcript and summary separately. Existing provider
adapters are used for ElevenLabs, Deepgram, and Gemini; the existing Local
meeting path remains. There is no new Self-Hosted meeting route or automatic
fallback/splitting.

Completed result selection atomically updates the existing Note transcript and
generated-content projection while preserving `note.content`. Raw JSON and
earlier run artifacts remain available. Playback and mixed export use the
selected derived timeline; mic/system exports reconstruct the separate source
epochs with their saved gaps. Export targets are chosen in main and written
through a temporary file before rename.

One existing startup/6-hour cleanup handles legacy audio and meeting retention.
New recordings use a 7-day audio default, `0` means keep indefinitely, and
saved values remain in settings. Meeting expiry uses recording end time rather
than derived file mtime. Durable deletion intents are retried before processing
jobs are released; active readers/transports are cancelled and awaited. Audio
deletion retains transcript/summary artifacts; Note deletion removes its
recording artifacts while preserving shared speaker profiles.

Preserved consumer surfaces include Notes/manual text/blank Notes, Notes chat
and tools, import, Dictionary/Snippets, calendars, speaker management, and
existing Local, Self-Hosted, and direct provider routes on their existing
surfaces. M4 focused tests and final integration checks are root-owned and have
not been run by the implementer.

---

## Previous target sketch (historical)

The remaining sections preserve the earlier pre-implementation design notes.
They are not the current schema or implementation contract; use the current
section above and [record-then-process.md](record-then-process.md) for those.

## Architectural unit

The existing **Note** remains the product root, including notes without audio.
A future recording session attaches audio and processing artifacts to a note.
References to a meeting below describe that session, not a mandatory new root.

```text
Calendar / manual start
          |
          v
  Meeting capture session
      |             |
      v             v
  microphone     system audio
      |             |
      +------ durable chunks ------+
                                    |
                                    v
                       capture health + source metadata
                                    |
                                   Stop
                                    |
                        finalize audio and manifest
                                    |
                        durable post-Stop processing job
                                    |
                        file ASR with diarization
                                    |
                         canonical transcript
                                    |
                              note generation
                                    |
                              meeting chat
```

## Module boundaries

```text
main/meeting/
  MeetingCaptureService
  RecordingRepository
  CaptureHealthMonitor
  MeetingProcessingRunner

main/providers/
  transcription/
  diarization/
  summary/
  chat/

main/storage/
  MeetingRepository
  ProcessingRunRepository
  TranscriptRepository

renderer/meetings/
  meetingStore
  meetingLibrary
  meetingDetail
  meetingChat
```

The renderer store mirrors UI state. It must not own native capture, files, provider connections, processing orchestration, and persistence at the same time.

## Recording layout

Each meeting receives an application-controlled directory:

```text
meetings/{meetingId}/
  manifest.json
  mic/
    000001.caf
    000002.caf
  system/
    000001.caf
    000002.caf
  artifacts/
    asr-{runId}.json
    diarization-{runId}.json
    transcript-{revisionId}.json
    notes-{revisionId}.md
```

Audio is written in bounded chunks so a crash cannot corrupt the whole meeting. Finalization may produce convenient FLAC or M4A exports, but internal source tracks remain separate.

`manifest.json` records:

- meeting and session identifiers;
- capture start and end;
- codec and sample-rate information;
- ordered chunks and checksums;
- per-track duration and byte counts;
- device and route changes;
- interruptions and known gaps;
- clean or unclean shutdown;
- finalization status.

During capture, only save audio and capture-health metadata. Stop seals the remaining files and finalizes the manifest before a processing job becomes runnable. An interrupted recording is recovered and marked incomplete; recovery is distinct from a clean Stop.

Storage chunks exist for durability, not ASR scheduling. Prepare complete-track input after Stop while preserving original chunks. VAD cuts, overlap and minute-sized ASR requests are excluded from the default flow. If a provider cannot accept the recording, surface the limitation; any temporal splitting and speaker reconciliation require a separate validated design. The example CAF layout is not an approved codec or chunk-size choice.

## Processing state machine

```text
Capture:    recording -> Stop -> finalizing -> captured
Processing: captured recording -> queued -> transcribing with diarization
            -> normalizing -> final transcript -> summarizing -> ready
```

Processing starts only after recording finalization. There is no local/cloud draft, ASR or diarization during capture. Prefer one ASR pass with integrated diarization over the full input; separate source tracks may require separate requests. A standalone diarization pass is not a mandatory stage. Ordinary file APIs suffice; no provider Batch API is required. Earlier recordings may still have queued jobs while a new capture runs; those jobs must not block capture.

Failures are stage-specific:

```text
transcription_failed
diarization_failed
merge_failed
summary_failed
```

A meeting with usable audio is never reduced to a generic failed state. The UI must show which artifacts exist and which stage needs attention.

Recording-processing jobs and completed provider results are persisted. SQLite is the proposed local queue store. On launch, the runner recovers pending work without discarding saved audio or completed artifacts. Request identity, retry/idempotency rules and recovery of interrupted capture still require a design pass. A local desktop queue is enough; OpenHercules does not require Redis or a separate service.

## Provider contracts

The first post-Stop implementation includes ElevenLabs, Deepgram and Gemini. Comparative quality/cost evaluation is performed by Timur afterward and does not gate adding these adapters. Each adapter validates its documented input limits and preserves its raw result.

Providers implement small stage-specific interfaces. A provider never writes to SQLite or application directories directly; the orchestrator persists its result.

```ts
interface TranscriptionProvider {
  transcribe(
    input: {
      tracks: RecordingTrack[];
      language: string;
      vocabulary: string[];
    },
    context: RunContext,
  ): Promise<TranscriptArtifact>;
}

interface SummaryProvider {
  generate(
    input: {
      transcript: CanonicalTranscript;
      manualNotes: string;
      meeting: MeetingContext;
      template: SummaryTemplate;
    },
    context: RunContext,
  ): Promise<GeneratedNotes>;
}
```

The transcription artifact includes speaker turns when the selected provider supports them. Do not introduce a separate diarization interface or mandatory pass for the integrated path; existing independent speaker features remain supported. Exact audio input preparation and provider capability limits are validation questions, not assumptions in this sketch.

The first registry can be a static TypeScript map. A runtime plugin loader, dependency-injection container, or package marketplace is unnecessary until an external provider actually requires it.

## Canonical transcript

Provider-specific responses are retained as raw artifacts. Downstream code consumes one provider-independent shape:

```text
TranscriptSegment
- id
- source: mic | system
- startMs
- endMs
- text
- speakerId
- confidence
- transcriptionRunId
```

Source channel and speaker identity are distinct. The microphone can contain several people or speaker echo; system audio can contain multiple remote participants. Do not automatically equate mic with the user, or equal speaker IDs from independent source requests with the same person. Validate audio preparation and source attribution before fixing the canonical contract. Calendar attendees are naming candidates, not automatic identity proof.

Speaker corrections are stored as mappings over canonical segments. They do not rewrite raw ASR or diarization responses.

## Suggested persistence model

- `meetings`: title, time, state, calendar reference, capture health.
- `recording_tracks`: source, path, codec, duration, checksum, completeness.
- `capture_events`: device changes, interruptions, gaps, warnings.
- `processing_runs`: stage, provider, model, configuration, status, error, timing.
- `transcript_revisions`: canonical transcript artifact and provenance.
- `note_revisions`: generated Markdown, template, transcript revision, provenance.
- `participants`: reusable contact identity.
- `meeting_participants`: participant membership and speaker mapping.
- `tags` and `meeting_tags`: user organization.
- `chat_messages`: meeting-scoped conversation history.

Raw provider payloads remain files under `artifacts/`; SQLite stores their metadata and paths rather than forcing every provider response into relational columns.

## Capture health

Capture health is part of the product contract, not only logging:

- track heartbeat and latest chunk time;
- captured bytes and duration for both sources;
- system-audio stall detection;
- device invalidation and recovery;
- duration mismatch at finalization;
- known silent or missing intervals;
- visible `healthy`, `degraded`, or `incomplete` result.

A degraded meeting can still be processed, but the reason stays visible in the library and detail view.

## Summary and revisions

Summary generation starts automatically only after a final transcript revision exists. A note revision records the transcript revision, template, provider, model, and configuration used to create it.

If speaker labels or the transcript change, existing notes remain available but become stale. The UI offers regeneration rather than silently replacing them.

## Chat

Preserve the full embedded chat, including tools for finding, creating and editing
other notes. The current note supplies initial context, not an access restriction.
Future grounding can use timestamped chunks and SQLite full-text search.

Answers should cite transcript intervals. Cross-meeting vector search is explicitly deferred; Qdrant is not required for the first version.

## Evaluation support

The revision and processing-run model makes evaluation a natural extension:

- run the same recording through several providers;
- preserve outputs without overwriting them;
- compare latency and cost;
- attach a manually corrected reference transcript;
- calculate WER/CER for Russian and mixed Russian/English speech;
- evaluate speaker attribution and summary facts separately.
