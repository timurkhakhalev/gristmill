# Fast meeting audio preparation (Draft)

## 1. Goal

Prepare saved meeting audio in seconds instead of minutes spent in a large FFmpeg filter graph. This reduces the local wait before transcription and Summary. It does not promise faster provider responses or a fixed total Summary completion time.

## 2. Scope

Replace the shared post-capture audio preparation in `src/helpers/meetingAudioMixer.ts`. Apply the same timing rules to ASR, playback, mixed export and selected-source export. Keep the existing callers, ownership and output contracts.

Adapt persisted epoch and alignment metadata to continuous resampling. Cover valid pauses, clock and device generations, restarts, multiple epochs and overlapping timeline ranges. Integrate the native component into the macOS arm64 build and package. Extend the reproduction stand to exercise the production path.

The new path applies when audio is prepared for new or existing recordings. Existing completed artifacts remain available. Historical failed runs do not start automatically; the existing explicit Retry action is sufficient to use the new preparation path.

## 3. Non-goals

- Change live capture, original Opus encoding, clock calibration collection or database schema.
- Change provider selection, ASR, Summary prompts, speaker attribution or processing recovery policy.
- Add settings, buttons, a second preparation mode, a feature flag or an old-mixer fallback.
- Reprocess old recordings in bulk, replace completed results or redesign the processing timer.
- Build a zero-copy pipe pipeline or claim measured battery savings.

## 4. Constraints and fixed decisions

- Work in the current checkout. Do not create a worktree or alter unrelated changes. Draft does not create or switch a branch.
- Use a persistent native `libswresample` resampler with bounded audio buffers. Update compensation at calibration boundaries; do not create one full-stream filter branch for each calibration range. Decode each required source epoch once per preparation operation.
- Keep intermediate float PCM files for this implementation. The prototype used roughly 1 GiB per recording hour, plus original Opus files. Estimate the required temporary space for the selected layout and source epochs before preparation. Insufficient space must fail without changing originals; later disk-write failures must also clean up owned intermediates.
- Bundle the helper and its required libraries. Users must not install Homebrew, FFmpeg or development tools. Build inputs must be pinned and compatible; the prototype's local Homebrew libraries are evidence, not a production dependency path. Use the existing native build, resource packaging and signing mechanisms. Verify distribution license obligations and notices for the selected build.
- Preserve proven alignment, uncertainty, generation and coverage checks. Do not infer unknown timing. Preserve selected-source export's existing rule: the selected track needs proven alignment; an unknown peer must not block it. Other strict consumers retain their current validation.
- Preserve initial, internal and trailing silence, timeline extent, overlap summation and existing gain/channel rules. An overlap is not a new error merely because the prototype rejects it. A generation discontinuity must not inherit resampler history from the preceding generation, even when there is no visible gap.
- Output remains 24 kHz PCM16 WAV: mic left/system right for stereo; current mono mix and individual-source layouts stay. Preserve intentional-empty-source rules; do not turn an unexpected missing source into success.
- Keep originals byte-for-byte intact. Intermediate files belong to the existing preparation operation; successful output remains owned by its existing consumer. Clean intermediates after success, failure or cancellation, and use existing startup cleanup for abandoned derived files. Quit and deletion must still wait for owned work; stopped work must not publish a late output.
- Replace the old algorithm outright. Different PCM bytes from the old per-range `atempo` algorithm are acceptable only when independent timing, continuity and audio checks pass. Prototype endpoint clamping is not sufficient evidence to hide missing source audio.

## 5. User journey and visible behavior

The user stops recording. Gristmill keeps the original tracks and follows its existing processing schedule. Local preparation finishes promptly, then the selected transcription route and existing Summary flow continue automatically. No resampler control appears in the UI.

Playback and export use the same corrected timeline. An existing failed recording uses the existing one-action Retry flow. A preparation failure reports the actionable cause through existing error handling, such as insufficient disk space, rather than suggesting an API key or network problem for a local failure. It must not add technical mapping details to the normal UI.

## 6. Testing expectations

- Unit tests: persisted mapping conversion, continuous calibration changes, gaps, generation boundaries, overlap and exact output extent. Preserve alignment rejection and selected-source validation rules.
- Integration tests with actual Opus decoding and native resampling: temporary storage with real persisted metadata contracts; all four layouts; multiple epochs, overlap, intentional silence and invalid inputs. Check output timing and source placement against independently generated markers, not only old-output hashes. Check original hashes, failed output publication, cancellation, process settlement and disk-space/write errors.
- Reproduction stand: run the production preparation path on 10-, 60- and 120-minute fixtures with two sources and one calibration range per four seconds. Use changing drift up to ±200 ppm and explicit gaps. Measure decode through final WAV completion, including intermediate I/O; exclude fixture generation and provider calls. Record wall time, child CPU, peak child RSS and temporary disk use. Audio working buffers must not grow with recording length.
- Timing oracle: marker error at most 4 ms on the deterministic fixtures, exact expected output frame count, correct channels, silence in known gaps and no artificial discontinuity at continuous calibration boundaries. Keep the existing tone boundary guard (normalized adjacent-sample step below 0.02 on its fixture). Do not present these tolerances as hardware clock accuracy.
- Real-audio validation: use a local copy of saved recording metadata and audio to reproduce the diagnosed high-range-count case without changing its profile. Listen to speech around calibration, restart and overlap boundaries and check source synchronization. Keep private audio and content out of committed fixtures and reports.
- Packaged validation: run the built macOS arm64 app against an isolated profile, without resolving helper libraries from Homebrew. Exercise preparation, playback/export, cancellation and a short microphone/system recording followed by Stop. Verify bundled dependency loading and code signatures. Follow the repository quality steering for full-suite, lint, typecheck, renderer build and package checks.

## 7. Documentation updates

Update `.memory-bank/architecture/audio-storage.md` with the derived-audio algorithm, temporary-space requirement and unchanged timeline/ownership guarantees. Update `.memory-bank/runbooks/testing.md` with the production reproduction command and packaged validation. Update the existing native build/local build documentation where library delivery changes its instructions. Keep one-run measurements in task evidence and the later PR, not permanent architecture documents. Do not change accepted ADRs.

## 8. Acceptance criteria

1. On the current development Mac, without another benchmark or build competing for resources, all three consecutive measured runs of the specified production-path fixture finish within 30 seconds for 60 minutes and 60 seconds for 120 minutes. Record machine and build details. This budget covers local preparation only and is not a guarantee for every device.
2. Deterministic fixtures meet the timing, duration, channel, silence and continuity checks above. Valid overlaps, generation changes and multi-epoch recordings retain their existing audible placement. Saved real-audio reproduction passes synchronization and listening checks.
3. ASR, playback and exports preserve their output and validation contracts. Unknown alignment and unexpected missing audio cannot be silently accepted. Existing results and original audio remain unchanged.
4. Insufficient space, write failure, invalid input and cancellation leave originals intact, stop owned child work and do not publish a partial output. Owned intermediate files are released through normal cleanup or existing startup recovery after interruption.
5. The packaged app prepares audio without external runtime installation. It adds no user settings or controls and preserves existing processing/retry behavior, including no automatic retry of historical errors.
6. Required repository checks, packaged validation and documentation updates pass. Results distinguish synthetic evidence, real-recording checks and hardware/package checks.

## 9. Questions resolved during brainstorming

- Optimize after Stop, not capture. The observed delay was local audio preparation, before ASR and Summary began.
- Use continuous resampling rather than a growing graph of per-calibration branches. The standalone prototype completed 60 minutes in 11.93 seconds and 120 minutes in 23.90 seconds; these are individual synthetic runs, not production guarantees or an exact A/B speedup.
- Accept intermediate disk files for the first implementation. Do not add a pipe redesign to this task.
- Ship the native component inside the app. Its current experimental helper is about 34 KiB; the local dependency set is about 6.3 MiB. Final package size depends on the production library build and must be measured, not inferred from the prototype.
- Preserve existing recordings and completed work. Historical failures need one explicit retry.
- Keep shared consumers consistent and preserve valid overlaps, even though the experimental core does not yet implement them.

## 10. Notes for planning

Primary code: `src/helpers/meetingAudioMixer.ts`, its alignment/storage helpers, `src/helpers/meetingAudioExport.ts` and the processing/playback callers. Existing delivery entry points include `scripts/build-native.cts` and `electron-builder.json`.

Evidence and limitations are in `investigation.md`, `streaming-prototype.md` and `streaming-prototype-results.json` in this folder. Experimental sources are `test/benchmarks/meeting-resampler.c` and `test/benchmarks/meeting-resampler.mts`; the original reproduction test is `test/cases/recording/integration/meetingMixerPerformance.test.ts`. Reuse their fixtures and guards where they prove the production contract. Do not ship their synthetic mapping assumptions, overlap rejection or arbitrary duration limits.

Plan must specify the persisted-metadata adapter, discontinuity/overlap processing, validated sample rounding, and pinned native library delivery within these decisions. These are implementation details, not permission to expand product scope. No implementation or application update is part of this Draft stage.
