# Delivery plan

## Stage 1: cleanup

Scope: [removal-plan.md](removal-plan.md).
Inventories, ownership, baseline and gates: [cleanup-m0.md](cleanup-m0.md).

Order: M0 contract/baseline → M1 identity/storage → parallel M2–M6 →
M7 integration → M8 build/dependencies → M9 acceptance.

Do not start removals with unresolved ownership or interpret future batch
requirements as cleanup requirements. Existing realtime, notes, provider modes,
speaker features and full embedded chat remain. Runtime smoke follows M1,
so the original OpenWhispr profile is never used for testing.

Acceptance means preserving agreed features without OW backend or removed
products, not offline durable capture or a new pipeline. Dependency-blocked
baseline checks are not passing checks.

## Stage 2: durable capture and batch

Plan separately after cleanup: separate durable mic/system chunks, manifests,
recovery, health events, queued batch processing, canonical artifacts, retries,
revisions, automatic notes and timestamp citations. Keep the Note product model
and existing local/direct providers. See the future proposal in architecture.md.

## Stage 3: model evaluation

Compare the user's ASR/diarization candidates on consented recordings, with
reference transcripts, speaker attribution, latency, cost and note factuality.
Verify model IDs and prices then. No new adapter or paid benchmark is required
to finish cleanup.
