# Recording and processing architecture

This architecture implements [ADR-0003 record-then-process](../adr/0003-record-then-process.md).
The detailed pipeline rules are in [post-Stop processing](post-stop-processing.md).
Live microphone and system recording, tail loss and restart recovery need isolated hardware checks.
Automated tests do not prove them.

## Ownership

- The existing Note is the product root.
- The main process owns recording files, SQLite persistence, provider calls, processing jobs and managed paths.
- The renderer requests operations through typed IPC.
- There is no replacement dashboard, no second sweeper and no compatibility path.

## Persistence

SQLite keeps these tables:

- `meeting_recordings`
- `meeting_recording_epochs`
- `meeting_recording_intentional_intervals`
- `meeting_recording_epoch_alignments`
- `meeting_processing_runs`
- `meeting_deletion_intents`
- `meeting_run_speaker_corrections`

Table contents:

- A recording row keeps the configuration snapshot from before capture, the capture and audio states, the end time and the selected run.
- An epoch row keeps the source, the sample offset, byte and frame recovery data and the managed relative path.
- A processing run keeps its source, provider, model, configuration, stage, status, error and artifact paths.
- The scope of a speaker correction is `(run_id, speaker_id)`. Profile rows stay shared.

### Intentional intervals

- An intentional interval keeps the source, the start and end frames and the reason: `manual-muted` or `platform-muted`.
- An open interval has a null end frame. It closes at the acknowledged render-frame boundary at unmute, or at Stop.
- The first accepted microphone packet is examined against that boundary. A missing tail stays incomplete.
- A microphone recording without epochs is intentionally empty in one of these conditions:
  - Aligned intervals cover the full recording.
  - Main kept the mute intent during all of the capture. This proof does not need a clock offset for a source that made no audio.

## Managed files

All paths are under Electron `userData`:

| Content                                                          | Path                                                                                                                                                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Original mono Ogg/Opus (32 kbit/s VBR, complexity 0, voice mode) | `audio/meetings/{recordingId}/{mic\|system}/epoch-000000.opus`                                                                                                                                         |
| Derived full-timeline WAV                                        | `audio/meetings/{recordingId}/derived/{runId}.wav` (mono), `{runId}-stereo.wav`, `{runId}-mic.wav` or `{runId}-system.wav`                                                                             |
| Raw provider response                                            | `meeting-results/{runId}/raw-provider-response.json`. Two-request cloud routes write `raw-provider-response-mic.json` and `raw-provider-response-system.json` and combine them into the canonical file |
| Transcript                                                       | `meeting-results/{runId}/transcript.json`                                                                                                                                                              |
| Summary                                                          | `meeting-results/{runId}/summary.json`                                                                                                                                                                 |

- PCM16LE at 24 kHz exists only in capture memory.
- Derived WAV files are built again from the original epochs. They are removed after the ASR and normalization consumers finish.
- Playback and export use separate temporary IDs. Playback releases its file when the player ends or unmounts.
- Startup removes abandoned derived files.
- SQLite and the storage manager derive and validate these paths in main. Renderer IPC accepts recording and run IDs, not arbitrary file paths.

For recovery limits and legacy PCM profiles, see [audio storage](audio-storage.md).

## Renderer capture

- The microphone Worklet counts render frames continuously, also during mute.
- It discards gated samples before transfer, analysis, encoding or storage.
- It keeps the healthy microphone stream, the AudioContext and the Worklet alive. The system capture continues.
- Pause and Stop release both audio devices.
- The manual mute intent stays through Pause, Resume, reopen and Restart. A separate Start begins without a mute intent.
- `meetingAudioPipeline.ts` owns the Worklet code, the write queue of each processor, gate acknowledgements, epochs and the flush and drain barrier for renderer audio.
- `meetingRecordingStore.ts` owns the session, streams, contexts, the analyser, device recovery and clock mapping. Thus capture continues when a view remounts.
- A replacement microphone starts with its gate closed. Its actual track mute state replaces the old device mute; manual and Meet mute keep their own intent. Recovery reports active only after the live track and its current persisted intent are accepted.
- The intent queue owns the whole microphone handoff, including drain and replacement setup. Controls received during handoff apply to the replacement; old track listeners detach before setup.
- Initial and replacement microphone analysers read the Worklet output. A closed gate gives zero microphone level; system audio can still move the Companion bars. Each output path keeps a zero-gain sink.
- The native system-audio watchdog arms its first-delivery deadline only after a validated helper start ACK. Silent PCM counts as delivery; sleep and each replacement rebase the deadline. An ACK alone does not report recovered audio.
- The pipeline reports the microphone flush boundary through a typed callback. The session stop barrier waits for the drain. Then it sends the last sequences and that boundary to main.

## Run creation

- Finish sends only the Note ID to main. The processing worker selects available finalized parts in chronological order and uses the latest eligible part's initial config snapshot. Main owns repeated-Finish deduplication and the persisted processing gate. Explicit reprocess and Summary controls remain separate operations.
- Before the first captured frame, main saves the selected configuration.
- Capture does no ASR and no provider request.
- Stop closes both source epochs, recovers their frame counts and gaps, finalizes the recording and creates its initial run.
- The worker waits until the retention settings are synchronized. It pauses while capture is active.
- A successful Stop also saves a 15-second not-before deadline in `retry_at`. Preparation and ASR cannot claim the run before this deadline, also after a restart.
- Pause does not put work in the queue. Resume makes the pending work of the previous Note audio version invalid.
- The worker examines eligibility again at the claim and before ASR.

## Clock alignment

- New source positions come from actual frame anchors.
- The renderer uses the AudioWorklet render-frame counter and a shared renderer and native clock mapping.
- The native helper answers bounded stdin clock probes. It keeps raw PCM on stdout.
- The mapping records the rate, the uncertainty, the helper generation and the freshness.
- Raw source frames stay continuous, independently of calibration. This includes the frames discarded during mute.
- Source-generation coordinates and nullable timeline coordinates are stored separately.
- A late valid calibration can cover earlier frames in the same continuous generation. It does not change the source audio.
- Unknown alignment never stops healthy capture. If necessary frames have no bounded alignment, prepare fails with `audio-alignment-unavailable`.
- Solver limits: a maximum of eight probes, a span of 250 ms or more, rate bounds of 0.999–1.001, and freshness or continuation of five seconds or less.
- Prepare accepts an endpoint uncertainty of 25 ms or less.
- Saved capture-time bounds do not expire at processing time.
- The IPC receipt time and `Date.now()` are not exact audio positions.
- Gaps stay between epochs. Older recordings without the anchor metadata keep their saved offsets and the duration from UTC values.

## Provider routes

- After the gate, the worker makes the full-timeline WAV input of the selected route: stereo for Deepgram, separate mono microphone and system files for the other cloud routes, mono for Local.
- ElevenLabs, Gemini and OpenAI get two parallel requests: the microphone without diarization and the system audio with diarization. OpenAI uses `whisper-1` for microphone timestamps and `gpt-4o-transcribe-diarize` for the system audio.
- Deepgram gets one stereo WAV (microphone on channel 0, system on channel 1) with multichannel mode and diarization.
- The raw JSON of each track is saved before normalization. A retry does not send a successful track again.
- It sends the input through the selected supported route.
- It saves the raw provider response before normalization.
- Supported file routes: ElevenLabs, Deepgram, Gemini and OpenAI. The existing Local meeting path stays.
- There is no new Self-Hosted meeting route, no provider fallback and no hidden audio split.
- Capability and size errors belong to the selected route.

If closed manual or platform intervals prove that the microphone was intentionally empty for the full recording:

- Deepgram keeps a silent microphone channel next to the system audio.
- ElevenLabs, Gemini and OpenAI save a canonical empty microphone result and skip that source request.
- Local continues to process the available system track.

A missing source without full intentional coverage stays an error.

## Run ownership and Summary consumers

### Speaker naming and run snapshots

- Speaker naming uses the saved Summary provider and model configuration and the complete canonical segments.
- Calendar people are only naming candidates. A user correction wins by revision check.
- Each processing run keeps its source run, recording IDs, manual-note revision, speaker-correction revision, a snapshot of the corrected segments and a prompt and model snapshot.
- The Summary input uses the corrected segments, the title hint and the manual notes.
- Old runs and artifacts stay.

### Summary

- An automatic Summary needs 180 seconds of recording or more and 2,500 transcript characters or more.
- A manual Summary run can use each ready transcript.
- The per-run `summary.json` contains one Markdown `text` value and processing metadata.
- `notes.enhanced_content` shows the text of the selected run. `notes.content` stays the manual note of the user.
- A change of the selection changes what the Note shows. It does not delete earlier run artifacts.

### Tasks, Recap and Follow-up

- After the Summary is saved, prioritized tasks fill or remove its existing `## Action Items` section.
- Recap is a manual editable Action. It adds or updates `## Recap` in the same Markdown.
- Both examine the selection, the source and the revision state again. They write the Summary one at a time.
- A concurrent change to the target section or its valid boundary becomes a visible conflict.
- The task status is stored with the Summary artifact.
- Recap progress is a temporary UI notice, never placeholder Markdown.
- Follow-up uses the existing embedded Chat. It stores a normal assistant reply and has no send operation.

### JSON repair

- Speaker naming and Recap need strict JSON. Tasks return Markdown.
- If the JSON reply is invalid, one repair turn is permitted in the same selected-provider conversation.
- Refusals and transport errors do not start a repair.
- BB repairs use the saved `bb_thread_id`. The BB adapter gives the final text but no native refusal metadata.
- Task and Recap turns on the saved BB thread run one at a time. Thus one turn does not steer another active turn.

### Result selection and export

- The selection of a completed result updates the Note transcript and the generated-content projection atomically. `note.content` does not change.
- Raw JSON and earlier run artifacts stay available.
- Playback and mixed export use the selected derived timeline.
- Microphone and system exports rebuild the selected source with full proven alignment and saved gaps. Unknown peer alignment does not block source export; common saved extent and fully proven later peer ends preserve trailing silence ([audio storage](audio-storage.md#playback-and-export)).
- Main selects the export target. It writes through a temporary file and then renames it.

### Results panel

User paths: [Recording results](../product/user-journeys/meeting-results.md).

- Results are inside the Note editor. Start/Stop groups appear newest first. Pause/Resume parts inside a group appear in time order.
- The popover first opens on Audio. Play and export need available audio. New ASR also waits for capture and processing restrictions and the saved post-Stop deadline.
- The note-wide action processes available ready and incomplete parts in time order. Without a saved Summary it offers Transcribe & Summary. With a Summary, Transcribe and Summary are separate.
- Provider and model choices come from Settings. Results has no per-launch provider picker.
- Cancel processing is available for pending and running work, including the post-Stop wait. It keeps audio.
- Failed or blocked runs can be retried. Missing configuration has Open settings and Retry with current settings actions.
- A short-transcript notice explains a skipped automatic Summary. Manual Summary stays available for a ready transcript.
- Results appends transcript segments in batches of 60. Rows that are already shown stay in the DOM. The separate fallback `MeetingTranscriptChat` uses row virtualization.
- Runs are persisted, but Results has no user control to select an earlier completed version.
- Copy transcript is available. File export as Markdown, text, JSON or SRT exists in the backend without a Results control.
- Audio export covers the mixed audio of the selected part. There is no original-track picker or whole-meeting export control here.

## Retention and deletion

- One startup and 6-hour cleanup handles legacy audio and meeting retention.
- New recordings use a 7-day audio retention by default. `0` means keep the audio indefinitely. Saved values stay in the settings.
- Meeting expiry uses the recording end time, not the file modification time of derived files.
- Durable deletion intents are tried again before processing jobs are released. Active readers and transports are cancelled, and the cleanup waits for them.
- Audio deletion keeps the transcript and summary artifacts.
- Note deletion removes the recording artifacts of the Note. Shared speaker profiles stay.

## Kept consumer surfaces

- Notes, manual text and blank Notes, the full Notes chat and its tools, import, Dictionary and Snippets, calendars and speaker management stay.
- The existing Local, Self-Hosted and direct provider routes stay on their existing surfaces.
- Debug scenario controls are available only in development builds. Their synthetic states stay in memory.
- The live UI reads the persisted run and Chat state.

## Speaker recognition

Capture has no realtime ASR or live speaker identifier. After Stop, processing uses recorded tracks and saved note embeddings. Manual speaker mappings promote those saved embeddings into shared voice profiles and update matching notes.

New Local recording snapshots enable diarization. Existing saved processing configurations keep their explicit options, including `diarize: false`. The removed Models preference does not control new snapshots. See [ADR-0006](../adr/0006-remove-live-transcription.md).
