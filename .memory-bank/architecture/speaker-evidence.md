# Platform speaker evidence

Zoom (Accessibility), Google Meet and Telemost (Companion extension) supply display-name suggestions for system audio speakers.
Platform evidence is a hint. It is never proof of identity.

- Browser adapters: [Companion](companion.md), [Telemost](companion-telemost.md).

## Shared layer

- `meeting_platform_observations` keeps a platform discriminator, the recording, binding and participant identity, the full active set, a bounded host-time interval and the uncertainty.
- Zoom Accessibility, Google Meet and Telemost observations use the same matcher: `meetingPlatformMatcher.ts`.
- Each platform has its explicit timing policy. Initial indicator delay: Zoom 0.5 s, Google Meet 0.3 s, Telemost 0.3 s. These values are hypotheses, not measured identity guarantees.
- The matcher needs three independent speech episodes of one second or more, system-only speech, bounded clocks and unambiguous participants.
- If the evidence is missing or contradictory, the transcript alias does not change.
- Names include the specific platform in Results, the Note transcript, the CLI and the LLM context.
- A manual rename removes the platform badge.
- A user correction updates only the Note transcript when the selected result uses that transcript source. This also applies to Summary-only results. It preserves manual Summary text, its prompt and generation metadata. A correction of an unselected source does not change the Note.
- Correction revisions can make a saved Summary stale. Selecting a result can replace the full Note projection; renaming a speaker cannot.

### Retention and priority

- Corrections include the specific platform. User and voice matches win over platform suggestions.
- Audio retention keeps names and evidence. Note deletion removes them.
- Exports use the final names, without raw roster data.

## Pipeline and priority

### Collection

- Capture can collect read-only Zoom Accessibility activity and sparse CoreAudio clock ranges. It uses the existing Accessibility permission.
- The recording owns the evidence and the coverage. They stay after a restart and after new processing. They are deleted together with the recording or the Note.
- An Accessibility, SQLite or metadata failure never changes successful microphone and system audio into failed capture.
- After a restart, recovered collecting coverage is marked incomplete.
- Quit confirmation finishes capture before the general shutdown. A macOS window sheet keeps the capture IPC running while the user decides.
- The bounded sidecar teardown waits for the capture and tap cleanup.

### Matching sequence

1. The shared part-offset map controls both the audio concatenation and the matcher on normalized system-only segments.
2. Voice recognition runs first.
3. Platform matching runs next.
4. Model naming and the Summary run last.

- Per-run decisions keep the evidence IDs, the transcript intervals and the initial timing policy.
- Acceptance and correction are atomic, with current-run, revision, cancellation and deletion guards.
- Priority: user > voice > platform > model.
- A platform suggestion never creates a voice profile or an email.
- Old recordings without evidence keep their existing pipeline.
- The UI shows Zoom names differently from model suggestions. It reports incomplete platform evidence independently of the audio.

### Acceptance rules

- Production suggests a Zoom display name after three or more independent activity and speech episodes agree with one system ASR cluster.
- Continued confirmations of one long turn count as one episode.
- Recreated tiles or Pause and Resume can supply later episodes. This does not mean a stable participant ID.
- The initial 500 ms indicator lag is a hypothesis from static client inspection, not a Gristmill measurement.
- A 500 ms boundary guard, one second of stable speech for each episode and strict clock continuity and rate checks are conservative product rules, not measured accuracy.

### Rejection rules

- Known self labels and overlapping microphone speech are excluded.
- An unknown self does not stop naming.
- These cases abstain: simultaneous duplicate display names, competing names or clusters, ambiguous speech, unusable clock or Accessibility spans.
- Gaps stay local. Earlier and later usable spans still contribute.
- The matcher never renames the microphone and never repairs ASR boundaries.
- It does not prove exclusive Zoom audio, voice identity or one person for each device.
- A Zoom badge identifies the source of an editable suggestion.
- Known-signal conversion, the real Zoom lag and multi-speaker accuracy are not verified.
- Synthetic tests cover both platforms. Real Google Meet attribution is not verified.

## Zoom Accessibility collector

### Collector behavior

- `macos-meeting-ax --collect-zoom <recording UUID>` runs a read-only 2 Hz collector.
- Without that flag, the helper makes the bounded call detector snapshot.
- The collector reads all Accessibility windows and direct Video render children. It parses the camera-off and audio status from the right side. It records transitions as unconfirmed candidates.
- The second consistent read starts an explicit interval. Continued confirmation ranges follow each two polls.
- A switch, a clear, Stop or unknown availability closes the interval at the last confirmed read.
- All ranges of one uninterrupted turn have one episode ID. A long turn supplies one example.
- A poll gap of more than one second ends the activity.
- These are collection guards, not measured acceptance thresholds.
- Unrelated windows without supported children are ignored. Real Accessibility errors or children with an incorrect shape stay incomplete.
- Names are private metadata that the recording owns. Trees, names and transcripts do not go into diagnostic logs.
- Repeated reads of one active episode do not increase the number of independent examples.
- The collector finds new names, late tiles and rename revisions until Stop.

### Identity limits

- Unknown access, malformed tiles, ambiguous activity, window replacement and process changes end identities.
- Display names, the PID and the tile position are never participant or meeting identifiers.
- Availability transitions are saved as unavailable observations.
- Compact, Pin and Spotlight candidates without an explicit marker are never accepted.
- Coverage reports gaps but keeps the usable intervals of the part.
- Self is known only with an explicit `(Me)`, `(You)` or Russian `(я)` name suffix. Other names stay unknown self.
- The collector does not click, change the layout or use OCR.
- Simultaneous duplicate display names abstain.
- Accessibility objects and names are evidence strings, not stable participant identities.

### Audio helper clock ranges

- The audio helper keeps PCM on stdout. It sends sparse clock ranges on stderr with a helper UUID, the converted-frame start and end, host nanoseconds and the timebase.
- A bounded metadata queue runs separately from PCM writes.
- Each range binds to its actual source epoch and `startFrame`. It waits until those frames are delivered.
- A clock reorder never changes the PCM order. Unknown or unbound ranges are not extrapolated.
- Startup shortening and the last pending PCM flush use the actual converted frame count.
- The converter latency is **not calibrated**. Reported priming data does not prove its startup or tail alignment.
- The raw Opus tracks and the existing audio watchdog stay authoritative.
- SQLite, Accessibility and metadata failures affect only the evidence.
- The JSONL reader uses a streaming UTF-8 decoder. An incomplete tail rejects the coverage.
- A failed collector stops its own helper and escalates within 500 ms, also while the recording continues.
- The evidence capability is required at the composition boundary. Test doubles implement it explicitly.

### Matcher

- `composeMeetingAudioParts` returns the offset map that ASR preparation and the matcher both use.
- Internal gaps stay. Deliberate pauses between parts are removed.
- Matching runs on normalized system segments after voice recognition and before model naming and the Summary. This includes continued normalization and new provider runs.
- It never assigns `mic`, moves diarization boundaries, creates a voice profile, invents an email or carries Speaker N across runs.
- Per-run rejection and acceptance records include observation and clock IDs, transcript intervals and the initial timing policy with its origin.
- Accepted corrections and decisions share a guarded transaction.
- Accepted platform names have a Zoom provenance badge. They go to LLM snapshots and prompts with that source.
- Manual edits keep priority.
- Incomplete collection shows in the transcript view. It does not mark the recorded audio or the transcript as failed.

### Timing policy

- Production uses the fixed `zoom-activity-v1` policy.
- The 500 ms initial Zoom lag is a hypothesis from read-only static inspection of an installed client. It is not our live latency measurement.
- We implement the matcher independently and do not copy proprietary code.
- A 500 ms turn-boundary guard, one second of stable speech and three independent activity and speech episodes are conservative product rules, not measured accuracy.
- Heartbeats or recreated tiles in one continuous ASR speech bout cannot supply more independent examples.
- Decisions keep the policy and the evidence IDs without an invented measurement ID.
- Old run decisions without a timing policy keep a null policy. Never claim the current heuristic for them.

### Interval mapping

- Intervals map through actual clock anchor ranges in one finalized epoch.
- Adjacent ranges need frame and host continuity. Rate checks use a 1 ms boundary tolerance and a 2 ms range-duration tolerance.
- The shared multipart map removes intentional pauses.
- The matcher never extrapolates past the startup or the tail, or across missing clocks.
- Unknown spans reject intersecting ranges locally.
- The matcher trims turn boundaries and shifts by the lag hypothesis. Then it rejects microphone overlap, competing system speech and known self names.
- Several separate episodes must agree before the matcher names the full run-local system cluster.
- Sequential tile recreation or Pause and Resume can agree. Simultaneous same-name tiles, conflicting names or one name for competing clusters abstain.
- An unknown self is permitted.
- Exclusive Zoom audio and one person for each tile cannot be proved. They are not acceptance gates.
- A Zoom label is an editable display-name suggestion, not a verified identity. Other system audio can still cause errors.

### Test coverage

- Synthetic fixtures use the actual native candidate, confirmation, continued and end shape with unknown self, system-wide provenance and uncalibrated clocks.
- They test production matching, atomic corrections, new processing and the shared Note and CLI transcript reader.
- Their acceptance does not prove live accuracy.
- Provenance consumers, retention and manual priority have focused tests.
- Synthetic Google Meet cases do not prove real-browser attribution quality.

## Known Zoom Accessibility facts (live probes, 2026-09-30)

- Video tile attributes contain no `AXIdentifier`. One display name can appear under several successive Accessibility objects. Thus Accessibility objects are not participant identities.
- Accessibility notifications do not report tile value, title or layout changes reliably. Use polling. Event delivery alone does not give activity coverage.
- Explicit activity is sometimes available during screen share. Do not treat screen share as always supported or always unsupported.
- Known audio suffixes include `Telephone muted`, `Telephone unmuted` and `No audio connected`. Disconnected audio has a null mute state.
- An Accessibility read takes approximately 2–12 ms and less than 1% of one core at 2 Hz.
- The audio callback occurs approximately 32 ms after the input capture time. This is a capture timing difference, not the Zoom indicator delay.
- The first converted 48 kHz → 24 kHz buffer can be shorter (248 instead of 256 frames). `AVAudioConverter.primeInfo` does not explain it. Use the actual converted frame count.
