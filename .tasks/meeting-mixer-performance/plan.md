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
- Use libswresample with bounded audio buffers. Decode each required epoch once per operation, with at most two simultaneous decoders, one per selected source. Epochs within each source remain ordered. The first failure or cancellation stops the peer and awaits both children. Calibration updates compensation without resetting a continuous run. Epoch or source/helper generation changes end a run. Within one epoch/generation, continuous source coverage plus the numeric confidence/rate checks below determine reconciliation; current persisted metadata has no further flag that identifies an unknown physical micro-gap. Do not claim to distinguish that micro-gap from calibration jitter. Preserve explicit intentional intervals according to their existing semantics. An incompatible join remains a mapped gap/overlap; do not distribute correction across several ranges. Original calibration rates and newly reconciled effective rates both stay within 0.999–1.001.
- Keep intermediate float PCM files under the existing recording `derived` directory, isolated by operation ID through `MeetingRecordingStorage`; never put production intermediates in unmanaged `/tmp` paths. Estimate peak disk use from source lengths, timeline extent, selected layout and actual file lifecycle before work starts; roughly 1 GiB/hour is evidence, not a constant admission formula. Handle later ENOSPC as well. This admission estimate is not a disk reservation: simultaneous playback, export or processing can exhaust space after admission. Test this race and cleanly fail the affected operation without introducing a scheduler/reservation subsystem.
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

Implement the production native source under `resources/` using the experimental C core as evidence, not an unchanged shipping artifact. Extend `scripts/build-native.cts` and its native build helpers for the pinned library build and executable. Cache the verified source archive and compiled libraries under gitignored `.cache/meeting-resampler-build/` at the repository root, outside `resources/bin/` and all package resources. Key reuse on archive checksum, configure flags, compiler identity, architecture and deployment target; reuse valid outputs on normal `compile:native`/dev starts. Download only missing pinned inputs. Offline with a complete cache succeeds; offline with missing inputs fails with a build-time explanation, never a runtime installation. Set the new helper and libraries to arm64 macOS 12.0 (`-mmacosx-version-min=12.0`), the minimum declared by the installed Electron 41 bundle. Do not change the other Swift helpers (11.0 defaults) or audio-tap (14.2). Verify Mach-O load-command minimums for the new binaries and fail if they exceed 12.0; this is the helper compatibility floor, not a new promise that audio capture works on macOS 12. Include the helper/libraries in `electron-builder.json`, development packaging and the existing signing path. Resolve installed resources relative to the app, with relative library install names. Fail the build when required native output is missing.

Contracts consumed: saved epoch identity, source generation, frame count and accepted ranges from `src/helpers/meetingAudioAlignment.ts`; existing 24 kHz decoded float samples.

Contracts changed: extend the internal `AlignedAudioRange` return type at its authoritative selection point. Retain all existing numeric fields and add provenance discriminated as calibrated or historical-anchored. Calibrated provenance contains the selected segment's stable input index, source/helper generation, source interval and conservative uncertainty bound; historical-anchored ranges have no calibration confidence and must not acquire invented segment metadata. This is not a new persisted DTO. Update direct callers in `meetingAudioMixer.ts` (timeline extent, selected-source validation and preparation mapping) and alignment test fixtures/type expectations together. Other consumers retain the same selection, extent and strictness semantics.

For a clipped range wholly inside its selected affine segment, use `max(uncertaintyStartFrames, uncertaintyEndFrames)` as a conservative interval-wide bound, plus one frame for integer coordinate rounding. Do not use the smaller endpoint bound or assume a clipped boundary equals a sampled endpoint. For affine clock-model uncertainty, the maximum endpoint bound covers interior positions; never extrapolate outside the selected source interval. Retain existing eligibility rejection before adding this conservative rounded-coordinate bound. Tests must cover clipping at both ends and unequal endpoint uncertainty.

Contracts produced: one internal preparation manifest for the helper: output extent, source identity, decoded input path and exact input length, epoch/generation boundary, and integer source/timeline intervals. Use a UTF-8 whitespace-delimited mapping file containing numeric rows (input start/end, timeline start/end and explicit reset flag); pass source/output paths and extent as separate argv fields, not shell text. The wrapper controls private per-epoch files and source identity. C parses bounded lines and rejects extra fields, malformed values, overflow and inconsistent coverage. No JSON parser is needed in C. Keep this private to preparation, not a persisted/public DTO. Validate integer bounds, persisted calibration rates within 0.999–1.001 and full input coverage before output creation. Do not carry the prototype's 4096-range, 60-second-range or 8000-second total limits into production.

Implement a small mapper beside the mixer. For each accepted range retain start and `start + round(frameCount * rate)` as its target bounds. Use precisely this join rule. Let P be the preceding mapped end, A the next mapped start, and up the preceding endpoint conservative uncertainty bound. The candidate anchor is A, not an arbitrary point in the intersection. Require `abs(A-P) <= up`, in addition to equal epoch/generations and contiguous source coverage. The next endpoint uncertainty is not used in this decision: A is fixed at that endpoint estimate, so checking A against its own interval adds no condition. Do not use the sum of uncertainties or search for another anchor. Let S be the preceding range's current start and N its input frame count; accept only if `0.999 <= (A-S)/N <= 1.001`, including the integer target coordinates. Apply this effective-rate check after any prior reconciliation, before changing an endpoint. Otherwise close/flush the preceding run and start a fresh resampler for the next range, retaining original mapped positions, silence for gaps and sample summation for overlaps, even within the same generation. No correction redistribution or larger tolerance. This preserves placement/mixing semantics, not bit-identical output or an unverified claim of no audible regression versus the old atempo algorithm. Historical anchored ranges are not candidates for calibration reconciliation. Feed the accepted endpoint to the resampler; retain original per-range mapping for rejected candidates. Integer quantization of untouched short ranges stays under the existing endpoint rounding contract and must not be mistaken for permission to apply excessive join correction. Epoch/generation changes reset even without a gap. Decode once per epoch; consume its ranges in source order. Write corrected samples by bounded read/add/write into the source's zero-initialized float timeline, so overlap is summed rather than discarded. Correct decoded epochs sequentially; only the two source decoders run concurrently. Avoid a new filter branch per run or calibration. Final channel assembly can use the existing FFmpeg with a fixed number of tracks. Helper exit 0 means successful closed output; use distinct fixed nonzero categories for malformed mapping/unsupported alignment, input corruption/length mismatch, I/O failure and resampler failure, with a bounded diagnostic on stderr. The wrapper maps these into existing local-preparation errors and treats ENOSPC as disk failure. Signals/cancellation are classified by the wrapper, which kills its owned child group, waits for exit and cleans operation files; no signal-handler filesystem cleanup or partial publication is needed.

Account for emitted samples and the resampler’s buffered delay when updating compensation toward each target endpoint; do not sum independently rounded rate deltas or interpret buffered audio as lost output. At each run end flush the resampler. Permit at most two samples of endpoint rounding, filling/trimming only that endpoint to its exact target; fail larger discrepancies. This is not a rule for accepting absent input: decoded length and full mapping coverage must pass first. Verify the rounding bound on the production library and all discontinuity fixtures; if it cannot pass, fix the mapping/resampling calculation rather than widening the tolerance silently.

#### 5.1.3 Acceptance criteria

Native processing preserves exact target extent, valid overlap summation, silence and channel identity. Continuous calibration does not introduce a reset artifact. Buffers remain bounded by processing block size, not duration. Invalid input cannot produce a successful output. The helper and required libraries are buildable without runtime Homebrew paths.

#### 5.1.4 Verification

Current observed behavior is a growing filter graph; expected behavior is sequential sample processing. Add `test/cases/recording/unit/meetingResamplerMapping.test.ts` for mapping/range decisions and `test/cases/recording/native/meetingResampler.test.ts` for real helper execution. Reuse prototype marker/tone generation with independent expected coordinates. Check rate changes, jitter at -50/-1/+1/+50 samples, compatible/incompatible confidence intervals, a two-sample gap across an actual epoch boundary, no-gap generation changes, gaps, overlaps, multiple epochs, lengths beyond prototype caps, malformed/truncated input and endpoint rounding. Add short-range/high-uncertainty regressions (for example 96,000 source frames and a 500-frame candidate correction with 600-frame bounds): confidence can pass while effective rate fails, and the mapped join must remain unchanged. Cover an overlap of confidence intervals whose next anchor is outside the previous interval, both rate-limit edges, successive corrections and clipped asymmetric-uncertainty segments. A synthetic force-break flag alone must not count as evidence of a detectable same-generation physical gap. Assert marker error ≤4 ms, exact output frame count and silence; tone fixture adjacent-sample boundary step must stay below 0.02 only at accepted reconciled joins. Rejected joins, epoch/generation boundaries and real gaps/overlaps are excluded from that smoothness assertion and instead checked for correct reset, extent, silence and independently expected summation. Test overlap with distinct source signals and an independent expected sum, not old PCM hashes.

Run `pnpm run compile:native`, then `pnpm test --verbose test/cases/recording/unit/meetingResamplerMapping.test.ts test/cases/recording/native/meetingResampler.test.ts test/cases/recording/integration/meetingAlignmentPersistence.test.ts test/cases/recording/unit/meetingAudioAlignmentPerformance.test.ts`. Compile C with `-Wall -Wextra -Werror`. Run `pnpm run lint` and `pnpm run typecheck:scripts`. Add `test/cases/platform/integration/meetingResamplerBuildCache.test.ts`, executed with `pnpm test --verbose test/cases/platform/integration/meetingResamplerBuildCache.test.ts` before M2. Use an isolated cache and stubbed download/compiler subprocess boundary to assert unchanged-key reuse makes no download/compiler call; changing checksum, flags, compiler identity, architecture or deployment target invalidates the entry; a corrupt archive/output cannot be reused; a complete verified cache succeeds when the download stub rejects all access; and missing source input with that same offline stub fails clearly without publishing a valid cache entry. Then run `pnpm run compile:native` a second time against the actual built cache and verify unchanged helper/library hashes and mtimes, with no download/recompile reported. The isolated script tests prove the offline/error decision paths without changing machine network settings; the real second build proves integration with the normal development command. Package runtime validation waits for M3.

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

Trace ASR, playback, exports and part composition to preserve their selected-source/full-alignment, gain and duration rules. Keep cached validated final files under existing operation IDs; no versioned cache or automatic reprocessing is needed. A currently leased/cached final file can retain the previous algorithm until normal cleanup; a fresh export/preparation can therefore differ slightly. Existing completed artifacts remain unchanged by design.

#### 5.2.3 Acceptance criteria

All four layouts and all consumers use the new path. Original hashes and completed results remain unchanged. Unknown timing, unexpected missing sources, open epochs and truncated audio fail under existing rules. Low-space/write failure, cancellation and helper failure stop owned work and remove intermediates. Restart cleanup removes abandoned derived intermediates before processing continues. Existing final-file leases and Retry behavior remain valid; historical failures are not queued automatically.

#### 5.2.4 Verification

Extend current integration fixtures rather than create a parallel storage harness. Run:

`pnpm test --verbose test/cases/recording/integration/meetingAudioPipeline.test.ts test/cases/recording/integration/meetingAlignmentPersistence.test.ts test/cases/recording/integration/meetingSourceExportAlignment.test.ts test/cases/recording/integration/meetingIntentionalIntervals.test.ts test/cases/recording/integration/meetingNoteAudioContinuity.test.ts test/cases/recording/integration/meetingPlaybackLease.test.ts test/helpers/meetingProcessing.test.ts test/helpers/meetingRecordingStorage.test.ts`

Assertions cover actual Opus → helper → WAV, all layouts, original hashes, selected-track validation with invalid peer, late epoch ends, overlap, muted source, pre-abort/mid-decode/mid-resample/final-publication abort, one-decoder failure stopping its peer, ENOSPC admission and write-time failure including two competing operations after successful admission. Exercise persisted startup recovery, historical error non-retry and caller cleanup using existing fixtures. Add quit/deletion settlement assertions to their existing owner tests if helper integration changes their process ownership; do not simulate success before child close.

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

Record reconciliation decisions in the private M3 report: total candidate joins, accepted joins, rejected joins, the distribution of `abs(A-P)`, and rejection reason. Evaluate confidence before effective rate so exclusive reasons are deterministic (`uncertainty`, then `effective-rate`); count epoch/generation resets separately, outside the candidate denominator. Include accepted share = accepted / candidate joins, or unavailable when there are no candidates. Detailed counts, distributions, coordinates and per-join decisions for real inputs stay outside the repository, PR and CI. Only a rounded aggregate accepted share (without recording identity, duration, exact counts or other call-specific context) may be included in a reviewed public summary. There is no invented minimum acceptance-share target: report the result and verify output quality/performance rather than hiding rejection by changing bounds. Use synthetic cases with known decisions to assert metric totals, reason priority and zero-denominator handling in M1 mapping tests; M3 checks that the report reflects actual production decisions, not recomputed guesses.

Contracts consumed: M2 preparation and cleanup, native package output. Contracts produced: reproducible verification command and measured evidence, no new runtime API.

Run 10-, 60- and 120-minute two-source fixtures with calibration every four seconds, drift up to ±200 ppm and explicit gaps. Report decode-through-final-WAV wall time including intermediate I/O, CPU, maximum child RSS and peak temporary disk; exclude fixture creation and provider calls. Measure three consecutive runs for each 60-/120-minute duration on this Mac without competing builds/benchmarks; record hardware, library versions and build details.

Real inputs must be explicitly supplied as a copied fixture directory outside the checkout: `node test/benchmarks/meeting-resampler.mts --copied-fixture EXTERNAL_DIRECTORY`. No default real-profile discovery or automatic meeting selection. The user chooses the source privately. Replace the prototype camelCase row conversion in `test/benchmarks/copy-meeting-for-prototype.py PROFILE NOTE_ID NEW_DIRECTORY` with export of selected raw rows for reconstruction in an isolated test database; this file is a transport, not a DTO mapper. Read selected recording, epoch, alignment and `meeting_recording_intentional_intervals` rows in one SQLite transaction and copy only their source files with before/after hashes. Preserve nanosecond columns as decimal strings: the current schema already uses TEXT, so do not introduce numeric conversion. Preserve JSON columns as raw JSON text during transport. A WAL read transaction supplies a consistent database view; it does not freeze audio-file deletion. Missing/unreadable WAL sidecars or a changed/deleted source cause an explicit failure, not immutable-mode bypass or a raw database-file copy. No migrations, provider calls or profile writes. Reject an output directory inside the repository; keep copies owner-readable only.

Use the existing `test/helpers/harness/db.ts` createDb fixture to reconstruct the selected rows and minimal note foreign-key context in a new private database. Read them through `DatabaseManager.getMeetingRecording`, `listMeetingRecordingEpochs` and `listMeetingIntentionalIntervals`, which apply production DTO mapping and zod validation, then invoke production preparation for all layouts. Do not trust a TypeScript cast or generic camelCase conversion as validation. Add an integration fixture comparing production reads before/after transport, including intentional empty mic, nested start/end alignment JSON, null values, and decimal nanoseconds above Number.MAX_SAFE_INTEGER. Run it through `pnpm test --verbose test/cases/recording/integration/meetingPrivateFixtureReplay.test.ts`; use synthetic values for committed tests. Keep recording identifiers, exact timings/durations, timestamps, participants, source/output hashes, window-level measurements, audio and transcripts entirely outside Git, PR descriptions/comments and CI artifacts. Publish only synthetic results and reviewed aggregate statements such as pass/fail; pseudonymized detailed call traces are still private. Do not upload private fixtures to providers or CI.

Automated audio checks use the fractional-delay oracle from `test/benchmarks/meeting-waveform-oracle.mts`, with the analytical half-sample-shift control and damaged-window negative control in `meeting-waveform-check.mts`. Preserve the 0.8 comparison threshold and full allowed lag search, not only integer local peaks. Add window comparisons at calibration/generation/gap/overlap boundaries with the expected mixed contributions; center-window success alone is insufficient. Derive five-second excerpts around boundary categories plus start/end for the user to listen to locally. Human listening and macOS permission approval are explicitly user-owned checks: the agent prepares excerpts and objective evidence, but cannot mark listening passed without the user’s result. Keep those results private except an aggregate pass/fail. Absent boundary categories remain covered by synthetic fixtures, not claimed as real-audio coverage.

Build the signed macOS arm64 app and use an explicit temporary user-data directory; do not install over `/Applications/Gristmill.app`.

Update `.memory-bank/architecture/audio-storage.md` derived-file algorithm, peak-space accounting and ownership; `.memory-bank/runbooks/testing.md` reproduction commands/oracles; `.memory-bank/runbooks/local-builds.md` pinned native build prerequisites, library delivery and signing. Include the named license, source archive and build/relink files from §2 in the package. Keep only synthetic one-run evidence in this task/PR. All real-call evidence stays outside the checkout. Document that native checks currently run locally unless macOS CI actually runs them; do not add CI infrastructure merely to imply coverage.

#### 5.3.3 Acceptance criteria

Every measured hour run ≤30 seconds and every two-hour run ≤60 seconds on this Mac. Correctness assertions from M1/M2 pass on the production benchmark. Real speech is synchronized without new boundary clicks or lost content. Packaged helper loads only bundled/system libraries, has valid signatures and works without Homebrew. Current playback/export/cancel and short mic/system capture→Stop journeys pass in an isolated package. No battery or provider-latency claim is inferred from these checks.

#### 5.3.4 Verification

Run `node test/benchmarks/meeting-resampler.mts 600 3600 7200`, then `node test/benchmarks/meeting-resampler.mts 3600 7200` twice, recording all results. The runner must always invoke the canonical Electron runtime because both synthetic and copied-fixture paths use createDb/better-sqlite3 and require its SQLite ABI; it must not rebuild bindings while other work runs. Maintain a short canonical integration smoke in `test/cases/recording/integration/meetingMixerPerformance.test.ts`; do not put hour-scale timing thresholds in ordinary CI.

Run checks sequentially: `pnpm test`, `pnpm run lint`, `pnpm run typecheck`, `pnpm run format:check`, `pnpm run build:mac:arm64:local` (which includes the renderer build). Discover the produced `.app` under `dist/`, run `codesign --verify --deep --strict` on that exact bundle and inspect helper/dylib dependencies with `otool -L`. Reject absolute Homebrew or build-cache dependencies, including transitive ones. Verify all §2 license/source/build files exist under the specified package path, compare the bundled source checksum to the pinned archive, and inspect the configure/build manifest for LGPL-only shared libraries and absence of GPL/nonfree/version3 options. Launch that bundle with an owned `--user-data-dir` path. With user-provided macOS permissions and capture participation, record a short mic/system sample, Stop, exercise local preparation, playback, exports and cancellation without paid provider requests. Reuse existing package smoke tooling where available. Verify effective helper entitlements, not only the parent plist. The existing inherited plist already contains disable-library-validation; do not weaken hardened runtime automatically. Confirm that local self-signed loading works and inspect all bundled Mach-O signing inputs. Developer ID signing/notarization must be exercised when credentials are available; otherwise explicitly mark public-release verification unavailable and do not present a local notarize=false package as release-qualified. Record any hardware permission block honestly; it prevents claiming this milestone complete.

Compare the old observed stalled preparation with the new production timings; do not derive an exact A/B speedup from different fixtures. Report real-audio listening and hardware checks separately from synthetic timing accuracy.

#### 5.3.5 Consumer surfaces impacted

Packaged macOS application and all shared preparation journeys. Build/documentation users receive reproducible native delivery and verification instructions.

#### 5.3.6 Pre-response/loading/success/error/empty states (when applicable)

Verify the unchanged visible journey after Stop, successful playback/export and actionable local failure. Cancellation leaves no working child or unpublished output. Existing completed results remain accessible; old failed recordings require the existing Retry action.

## 6. Execution order (derived from dependencies)

M1 → M2 → M3. Finish each milestone's checks before continuing. Reuse the persistent PlanAct Implementer/Reviewer pair during Act, then perform the final code review. Do not merge or install the task automatically. If timing, correctness or signing fails, reproduce and fix within the approved design and rerun affected checks. Do not weaken thresholds, enable fallback or claim completion. A needed scope/architecture change returns to Brainstorm; missing user permissions or release credentials stay explicitly pending.

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
