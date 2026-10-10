# Audio storage (Ogg/Opus)

Decision: [ADR-0004](../adr/0004-opus-capture.md). The product is macOS Apple Silicon only.

## Capture

- The microphone and the system audio are separate mono sources.
- Their 24 kHz PCM16LE packets go to one bundled FFmpeg/libopus process for each active epoch.
- The originals are Ogg/Opus: 32 kbit/s VBR, `application=voip`, `compression_level=0`.
- There is no compression step after Stop and no PCM file during capture.

### Write path

- Main accepts a maximum of five seconds of unencoded samples for each writer.
- A packet ACK means that the packet is in this bounded encoder queue. It does not promise an fsync.
- Alignment writes read the epoch header and use indexed coverage updates. They must not load the growing alignment history for each packet. The synthetic long-recording check is in the [testing runbook](../runbooks/testing.md#recording-performance-without-a-meeting).
- Main writes complete, CRC-checked Ogg pages. It requests 250 ms pages and does an fsync one time each second.
- At Stop, main waits for each encoder. It verifies the end-of-stream and the exact 24 kHz input frame count. Then it does an fsync and closes the file.
- An error keeps the saved pages and marks the capture incomplete.
- A missing system track cannot become a successful mic-only recording.
- A source restart keeps its own timeline offsets. Finalization waits for the flush of all previous epochs.

### Recovery

- Recovery reads complete Ogg pages. It does not change the original.
- Granules use 48 kHz units. The duration subtracts the Opus pre-skip and converts to the 24 kHz frame units of the capture.
- A torn or corrupt tail is counted separately.
- An epoch without an end-of-stream is marked as interrupted.
- Startup finalizes an interrupted capture as incomplete. Then a new recording can start.
- Main saves full-capture microphone mute proof before capture. The first effective unmute or microphone source error removes that proof permanently. Recovery can retain an intentionally empty mic without a guessed clock mapping, only when no mic frames exist.

250 ms pages and a one-second fsync interval are settings.
They do not guarantee a maximum loss after an app crash or a power loss.
Encoder buffering, OS scheduling and storage durability also have an effect.
Live microphone and system capture and power-loss tail limits need an isolated hardware check.

## Derived files

- ASR provider payload formats do not change: stereo WAV for Deepgram, separate microphone and system WAV for the other cloud providers, mono WAV for Local.
- Bundled FFmpeg decodes each epoch once to mono 48 kHz float PCM. The native helper uses bundled LGPL libswresample to produce each source's 24 kHz float timeline. Final FFmpeg assembly writes PCM16 WAV: mic left/system right for stereo, half gain per source for mono, unity gain for a single source. Encoder pre-skip does not move the saved timeline.
- The authoritative alignment selector proves complete source coverage. Calibration joins keep their fixed next anchor only when the preceding conservative uncertainty and the 0.999–1.001 effective-rate bound both permit it. Historical anchors have no invented confidence. Rejected joins retain their gap or summed overlap. Epoch and clock-generation boundaries reset filter state even without a gap.
- The helper validates the complete decoded input, bounds filter buffers and permits at most two samples of run-end rounding. Real endpoint reflection supplies filter context for short input; it does not replace missing decoded samples or fill silence.
- At most two source decoders run together. Each source processes epochs in order. Failure or abort stops owned process groups and waits for settlement before cleanup.
- Managed per-operation work directories contain decoded epochs, mappings and corrected timelines. The disk estimate includes both source timelines plus the larger of concurrent decoded epochs/mappings or final WAV assembly. Decoded float input uses eight bytes per original 24 kHz frame. The estimate is admission accounting, not a reservation; ENOSPC after admission remains an actionable local failure.
- Epoch scratch files are removed after use. Work directories are removed before validating and publishing the closed WAV. Cleanup also runs on failure and cancellation. Existing playback leases, export ownership, quit barriers and note-deletion barriers remain in force.
- Preparation and ASR can use derived audio again. If it is missing when processing continues, it is built again.
- Derived audio is removed after the normalization and speaker consumers finish, or after a failed stage.
- JSON provider responses, transcripts and summaries stay durable.

### Playback and export

- Playback and export use independent temporary IDs. This prevents races with the processing worker.
- Playback releases its file when it ends, when the recording changes, when the user leaves the Note or when the renderer stops.
- Pause keeps the file of the current player for seek and resume.
- Export removes its temporary mix in `finally`.
- Single-source export requires full proven alignment of the chosen track. Unknown peer alignment cannot block it or supply a guessed endpoint.
- Export length retains the saved common frame extent (or historical UTC duration) and fully proven later epoch ends. This keeps source gaps and trailing silence; it does not promise an exact physical Stop boundary.
- An open epoch on either source blocks export. An empty selected track is not synthesized as silence.
- Mixed playback, mixed export, ASR preparation and part composition remain strict for all nonempty epochs. See [ADR-0008](../adr/0008-source-export-alignment.md).
- Alignment selection sorts eligible segments once, then scans coverage in source-frame order. It retains the same uncertainty, clock-generation and full-coverage requirements.
- Startup removes abandoned derived directories before processing continues.

## Legacy PCM profiles

A profile with the old PCM schema is converted to Opus one time at startup (`meetingAudioMigration.ts`), before capture or processing can start.
The migration keeps a SQLite snapshot and hard links to the PCM originals in `userData/meeting-audio-before-opus/`.
If the migration fails, startup stops and the PCM originals stay.
To restore, close the app and use both the SQLite snapshot and the PCM files.
