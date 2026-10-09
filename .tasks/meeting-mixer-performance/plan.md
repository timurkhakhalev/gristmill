# Fast meeting audio preparation (Implementation Plan)

## 1. Scope (what to implement)

Replace per-calibration FFmpeg branches with continuous native resampling in the shared post-Stop preparation path. Preserve capture, originals, persisted alignment validation, existing processing scheduling, provider selection and completed artifacts. Apply the same timeline to ASR, playback, mixed export and selected-source export. No new controls, database schema, fallback mode, automatic historical retry or zero-copy pipeline.

Blast radius: all consumers of `src/helpers/meetingAudioMixer.ts`, including cloud/local ASR, derived playback and export. Native build and packaging change. External provider APIs remain unchanged, but incorrect prepared audio could produce incorrect paid transcripts and Summaries.

Criticality: failed preparation makes these operations unavailable; wrong timing or channels can produce misleading transcripts and exports. Original audio loss is unacceptable. Preserve the existing derived-file ownership and publication boundary.

Rollback: revert task code and ship the previous build to restore its preparation algorithm. No schema migration is planned. Existing derived files can remain until their normal cleanup; a fresh explicit processing run rebuilds them. Previously created transcripts, exported files and provider responses are not corrected by a code rollback.

Irreversible effects: provider calls can incur charges and exported audio can leave the application once the user starts those operations. Validation uses isolated profiles and local fixtures without live provider calls. No new irreversible storage mutation is planned. Installing over the user's running application is not part of this plan.

## 2. Fixed decisions (must follow)

- Do not introduce fallbacks or backward compatibility unless explicitly requested by the user. Preserve existing supported recording formats and alignment rules; this instruction does not authorize dropping historical recordings.
- Work in the current checkout on `meeting-mixer-performance`, based on updated `develop`. Preserve unrelated changes. The separate timer change is outside this task.
- Use libswresample with bounded audio buffers. Decode each required epoch once per operation. Calibration updates compensation without resetting a continuous run. Explicit gaps, overlaps and epoch/generation changes end a run; overlaps must still sum at their saved timeline positions.
- Keep intermediate float PCM files. Estimate peak disk use from source lengths, timeline extent, selected layout and actual file lifecycle before work starts; roughly 1 GiB/hour is evidence, not a constant admission formula. Handle later ENOSPC as well.
- Bundle the native executable and required libraries using the existing native build/resource/signing path. Pin the library source version and checksum in repository build inputs; do not load Homebrew at runtime. Use the prototype-tested FFmpeg 8.1.1 libswresample/libavutil source release for the native build, with only required libraries enabled, shared linking, no GPL/nonfree components, network protocols or OpenSSL. Keep the existing bundled FFmpeg decoder. Record the verified source archive checksum when implementing the download/build step; never invent it. Use LGPL-2.1-or-later shared libraries, with GPL, nonfree and version3 options disabled. The [upstream license guidance](https://ffmpeg.org/legal.html) identifies this license and calls for matching source and build instructions. Add `resources/licenses/meeting-resampler/COPYING.LGPLv2.1`, `NOTICE.txt` (FFmpeg attribution, version, copyright and library names), and `BUILDING.md` (archive URL/checksum, full configure/compiler commands, toolchain, no source modifications or exact patch list, and replacement-library/re-signing instructions). Package these at `Contents/Resources/licenses/meeting-resampler/`, along with the exact compressed FFmpeg source archive used by the build and the helper source/build recipe. Generate build-specific values from the pinned inputs. Source is included with every app bundle rather than depending on an external download remaining available. Do not change the existing decoder license setup or add a new licensing UI.
- Preserve 24 kHz PCM16 WAV, stereo mic-left/system-right, current mono gain and individual-source outputs. Sum overlapping samples without per-range normalization, then perform final PCM16 conversion. Preserve initial/internal/trailing silence, exact frame extent and intentional-empty-source rules.
- `alignedAudioRanges` remains the authority for coverage, uncertainty and clock provenance. Use its accepted ranges plus epoch identity/generation. Do not create a second validator that accepts previously rejected alignment. Single-source export validates the selected source, not an unknown peer; mixed consumers remain strict.
- Originals stay byte-identical. Reuse existing per-operation derived paths, atomic final rename, cancellation/quit/deletion ownership and startup cleanup. Successful final files remain under their consumer's existing lifetime. Historical failures start only after the existing explicit Retry action.
- Keep normal UI free of resampler details. Local preparation errors use actionable existing error surfaces, not API-key/network advice. Capture, Summary prompts, recovery policy and provider contracts do not change.
- Update current Memory Bank documents in English. Historical task files and accepted ADRs are read-only. No accepted architectural decision changes in this task.

## 3. Milestone rules (dependencies)

Execute milestones sequentially. Each milestone includes its own regression checks before the next starts. Commands below are planned checks, not passing evidence. Reuse current test fixtures and lifecycle seams; do not create parallel queues, storage or process managers.

## 4. Milestone index

| ID | Name | Depends on | Notes |
| --- | --- | --- | --- |
| M1 | Native continuous audio preparation | none | Mapping, overlap, bounded processing and build |
| M2 | Shared consumer cutover and lifecycle | M1 | All layouts, failures and cleanup |
| M3 | Performance and packaged validation | M2 | Reproduction, real speech and distribution |

## 5. Milestone details

### 5.1 M1 — Native continuous audio preparation

#### 5.1.1 Depends on

Depends on: none.

#### 5.1.2 Scope

Implement the production native source under `resources/` using the experimental C core as evidence, not an unchanged shipping artifact. Extend `scripts/build-native.cts` and its native build helpers for the pinned library build and executable. Include the helper/libraries in `electron-builder.json`, development packaging and the existing signing path. Resolve installed resources relative to the app, with relative library install names. Fail the build when required native output is missing.

Contracts consumed: saved epoch identity, source generation, frame count and accepted `AlignedAudioRange` values from `src/helpers/meetingAudioAlignment.ts`; existing 24 kHz decoded float samples.

Contracts produced: one internal preparation manifest for the helper: output extent, source identity, decoded input path and exact input length, epoch/generation boundary, and integer source/timeline intervals. Keep this private to preparation, not a persisted/public DTO. Validate integer bounds, finite positive rates and full input coverage before output creation. Do not carry the prototype's 4096-range, 60-second-range or 8000-second total limits into production.

Implement a small mapper beside the mixer. For each accepted range retain start and `start + round(frameCount * rate)` as its target bounds. Continuous source/timeline adjacency within an epoch shares one resampler; gaps and overlaps split runs while retaining their exact positions. Epoch/generation changes reset even without a gap. Decode once per epoch; consume its ranges in source order. Write corrected samples by bounded read/add/write into the source's zero-initialized float timeline, so overlap is summed rather than discarded. Process epochs sequentially; avoid a new filter branch per run or calibration. Final channel assembly can use the existing FFmpeg with a fixed number of tracks.

At each run end flush the resampler. Permit at most two samples of endpoint rounding, filling/trimming only that endpoint to its exact target; fail larger discrepancies. This is not a rule for accepting absent input: decoded length and full mapping coverage must pass first. Verify the rounding bound on the production library and all discontinuity fixtures; if it cannot pass, fix the mapping/resampling calculation rather than widening the tolerance silently.

#### 5.1.3 Acceptance criteria

Native processing preserves exact target extent, valid overlap summation, silence and channel identity. Continuous calibration does not introduce a reset artifact. Buffers remain bounded by processing block size, not duration. Invalid input cannot produce a successful output. The helper and required libraries are buildable without runtime Homebrew paths.

#### 5.1.4 Verification

Current observed behavior is a growing filter graph; expected behavior is sequential sample processing. Add `test/cases/recording/unit/meetingResamplerMapping.test.ts` for mapping/range decisions and `test/cases/recording/native/meetingResampler.test.ts` for real helper execution. Reuse prototype marker/tone generation with independent expected coordinates. Check rate changes, no-gap generation changes, gaps, overlaps, multiple epochs, lengths beyond prototype caps, malformed/truncated input and endpoint rounding. Assert marker error ≤4 ms, exact output frame count and silence; tone fixture adjacent-sample boundary step must stay below 0.02. Test overlap with distinct source signals and an independent expected sum, not old PCM hashes.

Run `pnpm run compile:native`, then `pnpm test --verbose test/cases/recording/unit/meetingResamplerMapping.test.ts test/cases/recording/native/meetingResampler.test.ts`. Compile C with `-Wall -Wextra -Werror`. Run `pnpm run lint` and `pnpm run typecheck:scripts`. Package runtime validation waits for M3.

#### 5.1.5 Consumer surfaces impacted

Native build and the private preparation boundary. Application callers switch in M2.

#### 5.1.6 Pre-response/loading/success/error/empty states (when applicable)

Validate before output creation; process in bounded blocks; return only after output closes successfully. Invalid/empty unproven input fails. Intentional silence is explicit manifest input, not inferred from missing files. Caller cancellation and cleanup are connected and verified in M2.

### 5.2 M2 — Shared consumer cutover and lifecycle

#### 5.2.1 Depends on

Depends on: M1.

#### 5.2.2 Scope

Contract sync: inspect the mapper/helper manifest and output/error semantics from M1 before connecting consumers. Replace `runMixer` in `src/helpers/meetingAudioMixer.ts`; keep `PreparedMeetingAudio`, layout selection and public call signatures unless a private dependency seam needs extending. Reuse `inspectMeetingOpus`, WAV validation and final rename. Remove the old per-range graph path.

Contracts consumed: M1 helper, existing `MeetingRecordingStorage` paths, AbortSignal and audio-operation ownership. Contracts produced/changed: unchanged public prepared-audio result; private child execution and disk estimate include intermediate stages.

Decode each selected epoch once, release decoded temporaries when consumed, retain at most the required corrected source timelines and final output. Estimate peak coexistence from this lifecycle plus headers; use the existing `availableBytes` seam. Capture stderr and classify local preparation failures through existing processing/error mappings. Do not replace all provider errors or add a new UI surface. Wait for owned child close on success, failure and abort; keep existing quit/deletion barriers effective. Publish only a validated final WAV, never a partial result.

Trace ASR, playback, exports and part composition to preserve their selected-source/full-alignment, gain and duration rules. Keep cached validated final files under existing operation IDs; no versioned cache or automatic reprocessing is needed.

#### 5.2.3 Acceptance criteria

All four layouts and all consumers use the new path. Original hashes and completed results remain unchanged. Unknown timing, unexpected missing sources, open epochs and truncated audio fail under existing rules. Low-space/write failure, cancellation and helper failure stop owned work and remove intermediates. Restart cleanup removes abandoned derived intermediates before processing continues. Existing final-file leases and Retry behavior remain valid; historical failures are not queued automatically.

#### 5.2.4 Verification

Extend current integration fixtures rather than create a parallel storage harness. Run:

`pnpm test --verbose test/cases/recording/integration/meetingAudioPipeline.test.ts test/cases/recording/integration/meetingAlignmentPersistence.test.ts test/cases/recording/integration/meetingSourceExportAlignment.test.ts test/cases/recording/integration/meetingIntentionalIntervals.test.ts test/cases/recording/integration/meetingNoteAudioContinuity.test.ts test/cases/recording/integration/meetingPlaybackLease.test.ts test/helpers/meetingProcessing.test.ts test/helpers/meetingRecordingStorage.test.ts`

Assertions cover actual Opus → helper → WAV, all layouts, original hashes, selected-track validation with invalid peer, late epoch ends, overlap, muted source, pre-abort/mid-decode/mid-resample/final-publication abort, ENOSPC admission and write-time failure. Exercise persisted startup recovery, historical error non-retry and caller cleanup using existing fixtures. Add quit/deletion settlement assertions to their existing owner tests if helper integration changes their process ownership; do not simulate success before child close.

Run `pnpm run lint`, `pnpm run typecheck:main` and `pnpm run typecheck:tests`. These prove shared behavior and local failure semantics; real speech and package loading wait for M3.

#### 5.2.5 Consumer surfaces impacted

ASR preparation, playback, mixed and selected-source export, part composition, processing error/retry UI, quit and audio/note deletion ownership. No capture or external provider API changes.

#### 5.2.6 Pre-response/loading/success/error/empty states (when applicable)

Keep existing processing waiting/preparing states and scheduling. During preparation the existing cancel/quit controls retain ownership. Success advances to the selected provider or returns the playback/export file. Local failure stays retryable under existing policy, with an actionable local cause. Intentional empty microphone retains its supported silence; unexpectedly absent audio is an error. No new loading screen or technical mapping text.

### 5.3 M3 — Performance and packaged validation

#### 5.3.1 Depends on

Depends on: M2.

#### 5.3.2 Scope

Contract sync: use the integrated mixer, not a standalone substitute. Update `test/benchmarks/meeting-resampler.mts` to seed isolated persisted recording metadata and call the production path with the built helper. Retain independent pulse/tone oracles, original hashes and resource measurement. Consolidate obsolete experimental comparisons rather than maintain multiple production-equivalent implementations.

Contracts consumed: M2 preparation and cleanup, native package output. Contracts produced: reproducible verification command and measured evidence, no new runtime API.

Run 10-, 60- and 120-minute two-source fixtures with calibration every four seconds, drift up to ±200 ppm and explicit gaps. Report decode-through-final-WAV wall time including intermediate I/O, CPU, maximum child RSS and peak temporary disk; exclude fixture creation and provider calls. Measure three consecutive runs for each 60-/120-minute duration on this Mac without competing builds/benchmarks; record hardware, library versions and build details.

Provide the runner mode `node test/benchmarks/meeting-resampler.mts --saved-profile "$HOME/Library/Application Support/Gristmill" --scratch /tmp/gristmill-mixer-real-check`. The scratch path must be new and owned by this run. Open `transcriptions.db` with SQLite read-only mode; select a finalized recording with both sources, all referenced Opus files present and proven alignment, ordering by alignment-row count descending, then recording ID. Use this fixed selection rule for saved-profile mode; report its actual duration and alignment-row count so the real workload is explicit. Fail with a missing-fixture result if no eligible recording exists. Do not represent this selection as the exact historical incident unless its identity is independently confirmed. Read recording/epoch/alignment/intentional-interval metadata for that recording in one read transaction; copy its referenced Opus files, export only those metadata DTOs into scratch, and compare original/copy SHA-256 hashes. No startup migration, provider calls or writes to the source profile are allowed.

Seed the copied metadata through the existing isolated storage fixture and invoke production `prepareMeetingAudio` for each layout under a fresh operation ID. Report recording ID and boundary coordinates only in the private scratch report, not committed task evidence. For listening, derive five-second windows on each side of the first/middle/last continuous calibration boundary and every generation transition, gap and overlap. Also listen at the first and last ten seconds. Compare corrected individual tracks and mixed output to decoded originals using the proven mapping: no lost/repeated words except intentional overlapping sources, no new clicks, correct speaker channel and event placement within the mapping's existing uncertainty. If the selected recording lacks a boundary category, report it as absent and rely on the deterministic M1 fixture for that category; do not claim real-audio coverage for it. Keep private content out of commits. Build the signed macOS arm64 app and use an explicit temporary user-data directory; do not install over `/Applications/Gristmill.app`.

Update `.memory-bank/architecture/audio-storage.md` derived-file algorithm, peak-space accounting and ownership; `.memory-bank/runbooks/testing.md` reproduction commands/oracles; `.memory-bank/runbooks/local-builds.md` pinned native build prerequisites, library delivery and signing. Include the named license, source archive and build/relink files from §2 in the package. Keep one-run evidence in this task/PR, not permanent architecture docs.

#### 5.3.3 Acceptance criteria

Every measured hour run ≤30 seconds and every two-hour run ≤60 seconds on this Mac. Correctness assertions from M1/M2 pass on the production benchmark. Real speech is synchronized without new boundary clicks or lost content. Packaged helper loads only bundled/system libraries, has valid signatures and works without Homebrew. Current playback/export/cancel and short mic/system capture→Stop journeys pass in an isolated package. No battery or provider-latency claim is inferred from these checks.

#### 5.3.4 Verification

Run `node test/benchmarks/meeting-resampler.mts 600 3600 7200`, then `node test/benchmarks/meeting-resampler.mts 3600 7200` twice, recording all results. The runner must invoke the canonical Electron runtime when the real storage fixture needs its SQLite ABI; it must not rebuild bindings while other work runs. Maintain a short canonical integration smoke in `test/cases/recording/integration/meetingMixerPerformance.test.ts`; do not put hour-scale timing thresholds in ordinary CI.

Run checks sequentially: `pnpm test`, `pnpm run lint`, `pnpm run typecheck`, `pnpm run format:check`, `pnpm run build:mac:arm64:local` (which includes the renderer build). Discover the produced `.app` under `dist/`, run `codesign --verify --deep --strict` on that exact bundle and inspect helper/dylib dependencies with `otool -L`. Reject absolute Homebrew or build-cache dependencies, including transitive ones. Verify all §2 license/source/build files exist under the specified package path, compare the bundled source checksum to the pinned archive, and inspect the configure/build manifest for LGPL-only shared libraries and absence of GPL/nonfree/version3 options. Launch that bundle with an owned `--user-data-dir` path. Manually record a short mic/system sample, Stop, exercise local preparation, playback, exports and cancellation without paid provider requests. Reuse existing package smoke tooling where available. Record any hardware permission block honestly; it prevents claiming this milestone complete.

Compare the old observed stalled preparation with the new production timings; do not derive an exact A/B speedup from different fixtures. Report real-audio listening and hardware checks separately from synthetic timing accuracy.

#### 5.3.5 Consumer surfaces impacted

Packaged macOS application and all shared preparation journeys. Build/documentation users receive reproducible native delivery and verification instructions.

#### 5.3.6 Pre-response/loading/success/error/empty states (when applicable)

Verify the unchanged visible journey after Stop, successful playback/export and actionable local failure. Cancellation leaves no working child or unpublished output. Existing completed results remain accessible; old failed recordings require the existing Retry action.

## 6. Execution order (derived from dependencies)

M1 → M2 → M3. Finish each milestone's checks before continuing. Reuse the persistent PlanAct Implementer/Reviewer pair during Act, then perform the final code review. Do not merge or install the task automatically.

## 7. Shared verification commands

Use `pnpm test --verbose <exact test paths>` for focused regressions, `pnpm run compile:native` for native build, and the M3 benchmark commands for performance. The final sequential suite is `pnpm test`, `pnpm run lint`, `pnpm run typecheck`, `pnpm run format:check`, then `pnpm run build:mac:arm64:local` (includes renderer build). Run `git diff --check` before each milestone commit. Do not run tests/builds concurrently against shared generated outputs.

## Orchestration (managed by orchestrator)

| Milestone | Status | Commits |
| --- | --- | --- |
| M1 — Native continuous audio preparation | not started | |
| M2 — Shared consumer cutover and lifecycle | not started | |
| M3 — Performance and packaged validation | not started | |
| Reviewer | not started | |
| Code Reviewer | not started | |
