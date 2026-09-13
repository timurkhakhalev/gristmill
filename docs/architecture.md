# Target architecture

## Architectural unit

The root entity is a **Meeting**, not a note or transcription. A meeting owns an immutable recording and a history of replaceable processing artifacts.

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
                         finalized recording manifest
                                    |
                                    v
                         durable processing runner
                                    |
                +-------------------+------------------+
                v                   v                  v
             batch ASR         diarization       health checks
                +-------------------+
                                    v
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

The manifest is written locally before any transcription request begins.

## Processing state machine

```text
recording
  -> captured
  -> transcribing
  -> diarizing
  -> merging
  -> summarizing
  -> ready
```

Failures are stage-specific:

```text
transcription_failed
diarization_failed
merge_failed
summary_failed
```

A meeting with usable audio is never reduced to a generic failed state. The UI must show which artifacts exist and which stage needs attention.

Jobs are persisted in SQLite. On launch, the runner resumes pending work. A local desktop queue is enough; OpenHercules does not require Redis or a separate service.

## Provider contracts

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

interface DiarizationProvider {
  diarize(
    input: { track: RecordingTrack; expectedSpeakers?: number },
    context: RunContext,
  ): Promise<SpeakerTurnArtifact>;
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

The microphone track maps to the user. Diarization normally applies only to system audio, where multiple remote participants may share one channel. Calendar attendees are naming candidates, not automatic identity proof.

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

The initial chat is scoped to one meeting. Ordinary meetings can be sent to the model as a full transcript. Longer meetings use timestamped chunks and SQLite full-text search before a model call.

Answers should cite transcript intervals. Cross-meeting vector search is explicitly deferred; Qdrant is not required for the first version.

## Evaluation support

The revision and processing-run model makes evaluation a natural extension:

- run the same recording through several providers;
- preserve outputs without overwriting them;
- compare latency and cost;
- attach a manually corrected reference transcript;
- calculate WER/CER for Russian and mixed Russian/English speech;
- evaluate speaker attribution and summary facts separately.

