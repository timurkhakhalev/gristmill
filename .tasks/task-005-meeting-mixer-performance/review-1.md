# Task 005 milestone audit

Status: pass

## Reviewed milestone commits

Reviewed implementation through `75e3dc278`, including the actual changes in the shared-index M2 commit:

- M1: `e35644dbd`, verification record `cfe0311db`.
- M2: `23792c7a1`, verification/blocker record `57270f8ec`.
- M2.1: `ba8f509da`, corrective verification record `0093abdcc`.
- M3: `146ea2533`, evidence record `0b9e3fdcb`, follow-up `b41e03086`, final evidence record `75e3dc278`.

Read the current `plan.md`, complete `implementation_progress.md`, milestone commit summaries and implementation diffs. No earlier review reports exist. The only pre-existing working-tree change is the orchestrator-owned plan update; it was preserved.

This result audits the completed technical scope under the explicit user override permitting reviews while human listening and purposeful microphone/system signal checks remain unverified. It does not certify those checks or public release signing.

## M1 status: pass

The authoritative alignment selector retains eligibility/selection behavior and adds calibrated provenance with the original segment index and `max(endpoint uncertainty) + 1`. Historical ranges receive no invented confidence. The mapper uses the fixed next anchor, preceding uncertainty, contiguous coverage, generation identity and inclusive effective-rate bounds. Rejected joins retain their original coordinates; epoch/generation changes reset. Candidate metrics preserve deterministic uncertainty-before-rate reason priority and exclude boundary resets.

The C helper validates numeric mapping, complete coverage and exact decoded length before creating output; processing uses fixed buffers, compensation includes emitted output and buffered delay, overlaps are added to the existing timeline, and success requires closed output with exact extent. M2.1 supersedes the original 24 kHz decoded-input contract with one 48 kHz input path while retaining 24 kHz coordinates/output. No duration/range-count cap, runtime Homebrew dependency or alternate preparation path was introduced.

Build/cache/package code implements the pinned shared LGPL-only source build, key invalidation, offline/error cases, macOS 12.0 arm64 validation, relative library loading and package source/license delivery. Native/mapping tests exercise real helper output, independent markers/tone/overlap values, rate/confidence edges, successive corrections, asymmetric clipped uncertainty, actual boundaries, invalid input and lengths beyond prototype caps. Progress records passing native/cache verification and actual second-build hash/mtime reuse.

Issues: none.

## M2 status: pass

All four layouts use the shared decode → native correction → fixed-track assembly path. Public prepared results and existing caller ownership remain unchanged. Selected-source export still validates the selected track while mixed preparation remains strict. Original validation, intentional-empty semantics, gains, channel identity, exact extent, cached final validation and atomic publication are retained.

At most two source decoders run concurrently; epochs remain ordered per source. Managed operation directories contain scratch files, decoded epochs/mappings are released after use, and timelines are removed before final validation/publication. Admission accounts for actual 48 kHz decoded bytes and peak file coexistence. Failure/abort stops owned child groups and awaits close; no scheduler or reservation subsystem was added.

Integration evidence covers real Opus in every layout, independent signal sums, original/durable artifact preservation, invalid-peer source export, partial/missing alignment, cancellation at preparation/publication boundaries, peer settlement, ENOSPC admission/write/publication and competing operations. Existing owner tests verify quit/deletion settlement and persisted startup cleanup; historical failed runs remain failed until explicit Retry. The former tiny-input blocker is resolved by M2.1 rather than hidden by weakened source validation.

Issues: none.

## M2.1 status: pass

The corrective implementation preserves short valid signals through a single 48 kHz decode and native 24 kHz conversion. Reflection is normal bounded filter context for every run after actual real input has been read and validated; it does not fabricate missing source coverage. Endpoint discrepancy remains bounded by two samples, and missing endpoint signal fails instead of being filled with silence.

Tests inspect nonzero content, not only successful exit/length: required short lengths and filter-boundary neighbors are covered standalone, in embedded runs and real epochs, through flush/reset and end-to-end Opus preparation. Independent mature-length reflected FFmpeg oracles check every short sample. Shortened/missing/corrupt input retains hard failures. Earlier mapping, overlap, gain/channel, publication, original-file and lifetime guarantees remain covered in the combined corrective run.

Issues: none.

## M3 status: pass

The benchmark reconstructs persisted synthetic metadata with `createDb` and calls production preparation in canonical Electron Node mode. The injected dependency hook reports actual mapping decisions. Timed work includes decoding, intermediate I/O, native correction and final assembly; fixture generation/oracles are excluded. The recorded seven duration cases meet the hour/two-hour limits, with three runs at each long duration and child CPU/RSS plus sampled derived disk accounting. Obsolete preparation prototypes were removed.

Private transport uses a read-only WAL transaction, raw JSON/TEXT nanoseconds, before/after source hashes and external owner-only output. Replay reconstructs raw rows and minimal note context, then uses all three production DTO readers. Synthetic integration tests prove round-trip DTO equality, nested interval data, nulls, large decimal nanoseconds, intentional-empty mic, unchanged database/WAL and missing-sidecar rejection.

The user-directed follow-up separates production alignment rejections from eligible parts, propagates other errors, fails with no verified part and isolates part reports. It does not change application alignment/recovery. Audible windows retain the fractional oracle threshold and lag search; approved quantization-level quiet windows inspect every central sample at zero lag with bounded absolute error. Negative controls include damaged speech, noise, absent audible signal and a spike between correlation samples. Excerpts stay within their own published WAV extent. No private call details were inspected or reproduced in this report.

The three named Memory Bank documents match the implementation. Package inputs include source/license/build materials, relative bundled dependencies and the existing signing path. Read-only audit checks independently confirmed document links, packaged materials/source/checksum/flags and exact-bundle signature validity. Progress records isolated packaged runtime and basic capture/Stop/playback/export/cancel/quit checks without provider calls or production installation. Human listening and purposeful source participation remain pending under the explicit user override; Developer ID/notarization is unavailable. No audio-quality listening or public-release qualification is inferred.

Issues: none.

## Plan gaps

None. The plan is self-contained for implementation; it does not delegate execution-critical requirements to the draft. M2.1 explicitly governs the corrective input contract. The user-directed M3 handoff governs the remaining human checks; their absence is recorded, not treated as a pass.

## Summary

Critical: 0. High: 0. Medium: 0. Minor: 0.

No introduced fallback/compatibility path, invented product restriction, schema/provider/capture/scheduling change or destructive-history regression was found in the scoped milestone audit. Universal runtime/code-quality review runs separately.

## Verification evidence

Cited from `implementation_progress.md`; shared mutable builds/tests were not duplicated. Final application/native behavior predates the M3 full/package run; the later verification-tooling changes have their own final focused evidence, and `75e3dc278` changes only the evidence log.

- `pnpm run compile:native`: passed with `-Wall -Wextra -Werror`; second actual invocation reused verified cache with 3/3 unchanged binary hashes and mtimes.
- `pnpm test --verbose test/cases/platform/integration/meetingResamplerBuildCache.test.ts`: 12 passed, 0 failed, 0 skipped after the corrective build.
- Corrective combined command: `pnpm test --verbose test/cases/recording/unit/meetingResamplerMapping.test.ts test/cases/recording/native/meetingResampler.test.ts test/cases/recording/unit/meetingAudioAlignmentPerformance.test.ts test/cases/recording/integration/meetingAudioPipeline.test.ts test/cases/recording/integration/meetingAlignmentPersistence.test.ts test/cases/recording/integration/meetingSourceExportAlignment.test.ts test/cases/recording/integration/meetingIntentionalIntervals.test.ts test/cases/recording/integration/meetingNoteAudioContinuity.test.ts test/cases/recording/integration/meetingPlaybackLease.test.ts test/helpers/meetingProcessing.test.ts test/helpers/meetingRecordingStorage.test.ts`: 285 passed, 0 failed, 0 skipped; 17.027 s runner wall time.
- `node test/benchmarks/meeting-resampler.mts 600 3600 7200`, then `node test/benchmarks/meeting-resampler.mts 3600 7200` twice: all seven synthetic cases passed. Hour runs 7.549702–7.683796 s; two-hour runs 15.241932–15.760203 s.
- `pnpm test`: all 462 selected files across three phases exited 0; 130.839 s. Assertion/skip totals are unavailable in the quiet-runner evidence.
- `pnpm run lint`, `pnpm run typecheck`, `pnpm run format:check`, `pnpm run build:mac:arm64:local`: passed sequentially. Package output is `dist/mac-arm64/Gristmill.app`.
- Final affected command scope: `pnpm test --verbose test/cases/recording/unit/meetingWaveformOracle.test.ts test/cases/recording/integration/meetingMixerPerformance.test.ts test/cases/recording/integration/meetingPrivateFixtureReplay.test.ts`: 5 passed, 0 failed, 0 skipped; 1.341 s test duration. Final oracle separately passed 3/3. Final lint, tests typecheck, formatting and diff checks passed.
- `node test/benchmarks/meeting-resampler.mts --copied-fixture EXTERNAL_DIRECTORY`: progress records eligible-part verification passing with separate rejected-part evidence; no private path, identifiers or measurements are published.
- Signed packaged-runtime production smoke: 1 passed, 0 failed, 0 skipped. Recorded basic isolated GUI journeys passed; listening/source-signal qualification remains unverified.

Read-only checks run during this audit:

- `git diff --check develop..75e3dc278` and `git diff --check`: passed.
- `codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Gristmill.app`, with approved read-only access outside the sandbox: passed; valid on disk and designated requirement satisfied.
- `otool -L dist/mac-arm64/Gristmill.app/Contents/Resources/bin/meeting-resampler dist/mac-arm64/Gristmill.app/Contents/Resources/bin/libswresample.6.dylib dist/mac-arm64/Gristmill.app/Contents/Resources/bin/libavutil.60.dylib`: helper and transitive dylib dependencies are sibling `@loader_path` or system paths.
- A read-only `python3` assertion script: 8 local Markdown targets valid; 7/7 package materials present; source archive SHA-256 equals the pinned input; packaged helper source/build recipe match current repository inputs; shared LGPL-only flags and arm64/macOS 12.0 target match the plan.

## Unrelated failures and residual notes

Initial sandbox `codesign` verification reported invalid signatures and unavailable signing authority, including on an unchanged existing helper. The exact-bundle verification outside the sandbox passed. This is a resolved verification-environment restriction, not a scoped implementation failure.

Human listening and purposeful mic/system signal participation remain unverified. Developer ID signing/notarization remains unavailable. Rejected private parts remain preserved and uncertified; the earlier rejected attempt's packet-disorder cause is unknown and no repair is claimed. These limits survive this technical review pass.
