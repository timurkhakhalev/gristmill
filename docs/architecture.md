# Architecture

## Current implementation (M1–M4)

M1–M4 implement the approved record-then-process flow. Root owns the M4
focused/full verification and integrated application smoke. Live mic/system
recording, tail-loss, and restart recovery still require isolated hardware
checks and remain unverified. Product decisions and remaining hypotheses are in
[record-then-process.md](record-then-process.md).

The existing Note remains the product root. The main process owns recording
files, SQLite persistence, provider calls, processing jobs, and managed paths;
the renderer requests operations through typed IPC. No replacement dashboard,
second sweeper, or compatibility path was added.

SQLite stores `meeting_recordings`, `meeting_recording_epochs`,
`meeting_recording_intentional_intervals`, `meeting_recording_epoch_alignments`, `meeting_processing_runs`, `meeting_deletion_intents`, and
`meeting_run_speaker_corrections`. The recording row holds the pre-capture
configuration snapshot, capture/audio states, end time, and selected run.
Epoch rows store source, sample offset, byte/frame recovery information, and
the managed relative path. Each processing run stores its source/provider/model,
configuration, stage, status, error, and artifact paths. Speaker corrections
are scoped by `(run_id, speaker_id)`; profile rows remain shared.

Intentional intervals store the source, start/end frame, and `manual-muted` or
`platform-muted` reason. An open interval has a null end frame and closes at the
acknowledged render-frame boundary on unmute or at Stop. The first accepted mic
packet is checked against that boundary; a missing tail remains incomplete. A
mic recording with no epochs is intentionally empty when aligned intervals cover
the whole recording, or main retained mute intent throughout capture. The latter
proof does not require inventing a clock offset for a source that produced no audio.

Under Electron `userData`, original mono Ogg/Opus is stored at
`audio/meetings/{recordingId}/{mic|system}/epoch-000000.opus` (32 kbit/s VBR,
complexity 0, voice mode). PCM16LE at 24 kHz exists only in capture memory. Derived full
timeline WAVs live at `audio/meetings/{recordingId}/derived/{runId}.wav` and
are rebuilt from the original epochs and removed after ASR/normalization consumers finish.
The mic Worklet counts render frames continuously through mute, but discards
gated samples before transfer, analysis, encoding, or storage. It keeps the
healthy mic stream, AudioContext, and Worklet alive; system capture continues.
Pause and Stop release both audio devices. Manual mute intent survives Pause,
Resume, reopen, and Restart; a separate Start begins with a clear intent.
Playback/export use separate temporary IDs; playback releases its file when the player
ends or unmounts. Startup removes abandoned derived files. Per-run artifacts live at
`meeting-results/{runId}/raw-provider-response.json`, `transcript.json`, and
`summary.json`. SQLite and the storage manager derive and validate these paths
in main; renderer IPC takes recording/run IDs, not arbitrary filesystem paths.

See [Opus capture and migration](opus-recording.md) for recovery limits and the one-time PCM cutover.

Before the first captured frame, main persists the selected configuration.
Capture performs no ASR or provider request. Stop closes both source epochs,
recovers their frame counts and gaps, finalizes the recording, and creates its
initial run. The worker waits for retention settings to sync and pauses while
capture is active. A successful Stop also persists a 15-second not-before
deadline in `retry_at`. Preparation and ASR cannot claim the run before that
deadline, including after restart. Pause does not queue work; Resume invalidates
pending work for the earlier Note audio version, and the worker rechecks eligibility
at claim and before ASR.

New source positions come from actual frame anchors: the renderer uses the
AudioWorklet render-frame counter and a shared renderer/native clock mapping;
the native helper answers bounded stdin clock probes and keeps raw PCM on
stdout. The mapping records rate, uncertainty, helper generation, and
freshness. Raw source frames stay continuous independently of calibration, including
frames discarded while muted. Source-generation coordinates and nullable timeline
coordinates are stored separately. Late valid calibration can cover earlier frames
in the same continuous generation without changing the source audio. Unknown
alignment never stops healthy capture; prepare fails with
`audio-alignment-unavailable` if any required frames lack bounded alignment.
The solver uses up to eight probes, at least 250 ms span, rate bounds 0.999–1.001,
and at most five seconds of freshness/continuation. Prepare accepts at most
25 ms endpoint uncertainty. Persisted capture-time bounds do not expire at
processing time. IPC receipt time and `Date.now()` are not exact audio positions.
Gaps remain between epochs, and older recordings without the anchor metadata
keep their stored offsets and UTC-derived duration.

After the gate, the worker creates the selected route’s full-timeline WAV input
(stereo for Deepgram, separate mono mic/system for other cloud routes, mono for Local),
sends it through the selected supported route, and persists the raw provider
response before normalization. Supported file routes are ElevenLabs,
Deepgram, Gemini, and OpenAI; the existing Local meeting path remains. There is
no new Self-Hosted meeting route, provider fallback, or hidden audio split.
Capability and size errors belong to the selected route.
When closed manual/platform intervals prove that mic was intentionally empty
for the whole recording, Deepgram keeps a silent mic channel beside system
audio; ElevenLabs, Gemini, and OpenAI save a canonical empty mic outcome and
skip that source request; Local continues to process the available system
track. A missing source without full intentional coverage remains an error.

## Run ownership and Summary consumers

Speaker naming uses the saved Summary provider/model configuration and complete
canonical segments. Calendar people are naming candidates only; a user
correction wins by revision check. Each processing run stores its source run,
recording IDs, manual-note revision, speaker-correction revision, corrected
segment snapshot, and prompt/model snapshot. Summary input uses corrected
segments, the title hint, and manual notes. Old runs and artifacts remain
intact.

Automatic Summary requires at least 180 seconds of recording and 2,500
transcript characters. A manual Summary run can use any ready transcript. The
per-run `summary.json` contains one Markdown `text` value and processing
metadata; `notes.enhanced_content` projects the currently selected run's text,
while `notes.content` remains the user's manual note. Selection changes the
projection without deleting earlier run artifacts.

After Summary is saved, prioritized tasks fill or remove its existing
`## Action Items` section. Recap is a manual editable Action that inserts or
updates `## Recap` in the same Markdown. Both recheck selection, source, and
revision state, and serialize Summary writes. A concurrent change to the target
section or its valid boundary becomes a visible conflict. Task status is stored
with the Summary artifact. Recap progress is a transient UI notice, never
placeholder Markdown. Follow-up uses the existing embedded Chat, stores a
normal assistant reply, and has no send operation.

Speaker naming, task extraction, and Recap require strict JSON and allow one
repair turn in the same selected-provider conversation when the reply is
invalid. Refusals and transport errors do not trigger repair. BB repairs use
the saved `bb_thread_id`; the BB adapter exposes final text but no native
refusal metadata, and its task/Recap turns are serialized on the saved thread
to avoid steering another in-flight turn.

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

Preserved consumer surfaces include Notes/manual text/blank Notes, full Notes
chat and tools, import, Dictionary/Snippets, calendars, speaker management, and
existing Local, Self-Hosted, and direct provider routes on their existing
surfaces. Debug scenario controls are restricted to development builds and
their synthetic states remain in memory; live UI reads persisted run/Chat
state. Root owns the M4 focused/full gates; live mic/system hardware behavior
remains unverified until the isolated smoke is run.

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

Recording-processing jobs and completed provider results are persisted. SQLite is the proposed local queue store. On launch, the runner recovers pending work without discarding saved audio or completed artifacts. Request identity, retry/idempotency rules and recovery of interrupted capture still require a design pass. A local desktop queue is enough; Gristmill does not require Redis or a separate service.

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

## Meeting platform evidence

`meeting_platform_observations` stores a platform discriminator, recording/binding/
participant identity, full active set, bounded host-time interval and uncertainty.
Zoom AX and Google Meet observations share `meetingPlatformMatcher.ts`; each
platform keeps its explicit timing policy (initial indicator delay: Zoom 0.5 s,
Meet 0.3 s). These values are hypotheses, not measured identity guarantees.
The matcher requires three independent speech episodes of at least one second,
system-only speech, bounded clocks and unambiguous participants. Missing or
contradictory evidence leaves the transcript alias intact.

The one-way metadata migration preserves Zoom IDs, decisions and revisions in a
transaction. Corrections include the concrete platform; user and voice matches
win over platform suggestions. Audio retention keeps names and evidence; deleting
the Note removes them. Exports use final names, without raw roster data. Before
upgrading an isolated develop profile, close the app and copy the profile. To
roll back the application version, restore that copy; do not open the migrated
profile with the older binary.
