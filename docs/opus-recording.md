# Opus recording

Decision: Timur, 2026-09-30, issue [#115](https://github.com/timurkhakhalev/gristmill/issues/115).
The product remains macOS Apple Silicon only.

## Capture

Microphone and system audio remain separate mono sources. Their 24 kHz PCM16LE
packets feed one bundled FFmpeg/libopus process per active epoch. Originals are
Ogg/Opus: 32 kbit/s VBR, `application=voip`, `compression_level=0`. There is no
post-Stop compression pass and no PCM file during capture.

Main accepts at most five seconds of unencoded samples per writer. Packet ACK
means accepted into this bounded encoder queue; it does not promise an fsync.
Main writes complete, CRC-checked Ogg pages, requests 250 ms pages, and fsyncs
once per second. Stop waits for each encoder, verifies end-of-stream and exact
24 kHz input frame count, then fsyncs and closes the file. Errors preserve saved
pages and mark capture incomplete. A missing system track cannot become a
successful mic-only recording. Source restarts preserve their own timeline
offsets and await all previous epoch flushes before finalization.

Recovery reads complete Ogg pages without changing the original. Granules use
48 kHz units; duration subtracts Opus pre-skip and converts to the capture’s
24 kHz frame units. A torn or corrupt tail is counted separately. Absence of
end-of-stream marks an epoch interrupted. Startup finalizes interrupted capture
as incomplete, so a new recording can begin.

250 ms pages and a one-second fsync interval are settings, not a guaranteed
maximum loss on app crash or power loss. Encoder buffering, OS scheduling and
storage durability still matter. Live microphone/system capture and power-loss
tail bounds require an isolated hardware check.

## Derived files

ASR provider payload formats stay unchanged: Deepgram stereo WAV, other cloud
providers separate mic/system WAV, Local mono WAV. FFmpeg decodes Opus before
resampling, offsetting and mixing, so encoder pre-skip does not shift the
timeline. Derived audio is reusable within preparation/ASR, rebuilt if absent on
resume, and removed after normalization/speaker consumers settle or a failed
stage. JSON provider responses, transcripts and summaries remain durable.

Playback and export use independent temporary IDs, avoiding races with the
processing worker. Playback releases its file when it ends, changes recordings,
leaves the Note or the renderer exits. Pausing keeps the current player’s file
for seeking/resume. Export removes its temporary mix in `finally`. Startup
removes abandoned derived directories before processing resumes.

## One-time migration

An existing PCM schema triggers a synchronous bootstrap migration before the
application can capture or process. Large libraries can make this first startup
take longer. The new runtime only uses `.opus` files; there is no dual codec path.

1. Save a SQLite snapshot and hard-link PCM originals into
   `userData/meeting-audio-before-opus/`. Hard links retain the original disk
   blocks without creating a second PCM copy.
2. Encode each nonempty PCM epoch to a temporary Opus file, decode-validate it,
   compare its duration, fsync, then rename. Reuse validated converted files
   after a restart; keep every PCM original until all conversions succeed.
3. Atomically replace the epoch table with the Opus schema/paths. Preserve
   Notes, blank notes, run IDs, configuration, JSON results and speaker data.
4. Remove active PCM paths. The backup remains available for recovery.

Migration failure prevents startup from exposing a partly converted library.
It does not erase the PCM originals. The backup is deliberately retained; its
PCM space is reclaimed only after the owner verifies the migrated library and
removes this backup directory. Restore requires both the SQLite snapshot and
the corresponding PCM files while the application is closed.

Development checks use synthetic profiles. The installed 1.10.1 application
migrated the real Gristmill profile on its first normal startup.

## Verification, 2026-09-30

- `pnpm run lint`: no errors; existing unused-code and icon export warnings remain.
- `pnpm run typecheck`: main, renderer, settings selectors and tests pass.
- `pnpm test --verbose`: 405 files, 2,883 passing tests, no failures or skips.
- `pnpm run build:renderer`: passes; the existing large-chunk warning remains.
- Real-time synthetic capture: two tracks, 100 ms packets, 2.2 seconds of audio;
  encoded pages appear before Stop and both final files contain exactly 52,800
  frames. Capture plus Stop took about 2.25 seconds including the real-time feed.
- Killed FFmpeg processes at three page positions recover their valid prefix;
  short writes and disk failure preserve the original bytes and surface an
  incomplete epoch. Stop, restart gaps, missing sources and retries remain covered.
- Migration resumes after a pre-commit failure, reuses validated output and
  completes PCM unlinking after an interrupted SQL cutover. Notes, blank notes
  and existing provider artifacts survive. Backup files and directory entries
  are fsynced before cutover.
- Resumed ASR rebuilds deleted WAVs, sends only the unfinished provider source,
  keeps the speaker-recognition input until its consumer finishes, and removes
  derived WAVs afterwards. Playback lease tests protect other owners’ files.
- Isolated real Electron startup: renderer/preload load, emitted main code
  writes two one-second Opus tracks, a real HTML audio element decodes their
  prepared timeline, and real IPC releases the temporary playback file.

The Electron check uses synthetic audio and a fresh profile. It does not verify
live microphone/system hardware, a crash of the whole app, power loss, or paid
provider transcription quality.

## Release verification, 1.10.1

- `pnpm run build:mac:arm64:local` produced the arm64 app, DMG and ZIP.
  `codesign --verify --deep --strict` passed for both the built and installed app.
- The packaged app passed the same isolated four-check Electron scenario above,
  using its bundled code and FFmpeg; it exited cleanly afterwards.
- `/Applications/Gristmill.app` was replaced and launched normally. Its previous
  bundle was retained in a temporary backup directory.
- The real profile migrated all 14 epochs: 650,701,264 bytes of PCM became
  49,773,671 bytes of Opus, preserving all 325,350,632 frames. SQLite comparisons
  against the pre-migration snapshot found no changed or missing Notes, changed
  recording rows or changed processing runs. Abandoned derived WAVs were removed.
- All 14 PCM originals and the SQLite snapshot remain in
  `meeting-audio-before-opus/`; this backup still occupies the original PCM space.
- Normal startup subsequently waited inside macOS Keychain access for saved
  credentials. Full production UI readiness requires answering that system prompt.
