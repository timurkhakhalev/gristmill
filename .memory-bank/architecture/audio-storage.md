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

250 ms pages and a one-second fsync interval are settings.
They do not guarantee a maximum loss after an app crash or a power loss.
Encoder buffering, OS scheduling and storage durability also have an effect.
Live microphone and system capture and power-loss tail limits need an isolated hardware check.

## Derived files

- ASR provider payload formats do not change: stereo WAV for Deepgram, separate microphone and system WAV for the other cloud providers, mono WAV for Local.
- FFmpeg decodes Opus before resampling, offsetting and mixing. Thus the encoder pre-skip does not move the timeline.
- Preparation and ASR can use derived audio again. If it is missing when processing continues, it is built again.
- Derived audio is removed after the normalization and speaker consumers finish, or after a failed stage.
- JSON provider responses, transcripts and summaries stay durable.

### Playback and export

- Playback and export use independent temporary IDs. This prevents races with the processing worker.
- Playback releases its file when it ends, when the recording changes, when the user leaves the Note or when the renderer stops.
- Pause keeps the file of the current player for seek and resume.
- Export removes its temporary mix in `finally`.
- Startup removes abandoned derived directories before processing continues.

## Legacy PCM profiles

A profile with the old PCM schema is converted to Opus one time at startup (`meetingAudioMigration.ts`), before capture or processing can start.
The migration keeps a SQLite snapshot and hard links to the PCM originals in `userData/meeting-audio-before-opus/`.
If the migration fails, startup stops and the PCM originals stay.
To restore, close the app and use both the SQLite snapshot and the PCM files.
