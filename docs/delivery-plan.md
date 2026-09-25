# Delivery plan

## Stage 1: cleanup — complete

Scope: [removal-plan.md](removal-plan.md).
Inventories, ownership, baseline and gates: [cleanup-m0.md](cleanup-m0.md).
Implementation and verification results: [cleanup-log.md](cleanup-log.md).

Order: M0 contract/baseline → M1 identity/storage → parallel M2–M6 →
M7 integration → M8 build/dependencies → M9 acceptance.

Do not start removals with unresolved ownership or interpret future batch
requirements as cleanup requirements. Existing realtime, notes, provider modes,
speaker features and full embedded chat remain. Runtime smoke follows M1,
so the original OpenWhispr profile is never used for testing.

Acceptance means preserving agreed features without OW backend or removed
products, not offline durable capture or a new pipeline. Dependency-blocked
baseline checks are not passing checks.

## Stage 2: durable capture and post-Stop processing — implemented

The M1–M4 task branch implements separate durable mic/system PCM epochs, recovery,
capture health, saved provider runs/results, post-Stop processing, selected-result
Notes projection, speaker correction, playback/export, retention, and deletion.
Capture has no ASR/provider dependency. Stop finalizes the original tracks and
queues a durable run; processing builds one derived full timeline WAV. See the
[current architecture](architecture.md) and
[record-then-process flow](record-then-process.md).

M1–M3 focused test runs passed at their root-owned gates. M4 tests, final
typecheck/lint/test/pack checks, packaged-app smoke, and live mic/system hardware
smoke are not complete yet. The hardware tail-loss/recovery guarantee remains
unverified. Exact commands and evidence are listed in
[record-then-process verification status](record-then-process.md).

## Stage 3: model evaluation — user-run after integration

Timur will test the three implemented providers himself on his recordings:
transcript quality, speaker attribution, latency, cost and note factuality.
The hypotheses in record-then-process.md are his evaluation checklist, not
pre-implementation gates. No quality, cost, or billing benchmark has been run.
Preserve separate run results so he can compare the same source recording
without overwriting prior artifacts.
