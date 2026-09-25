# OpenWhispr cutover

## Current stage: record-then-process integration

Use OpenWhispr as a one-time source pinned at
`4335972b96a62caab0c822b3b9549a1a4fdbb351`. Baseline commit: `49cd2b3`.
Preserve MIT license and attribution. No continuous full upstream merges,
legacy folders, commented-out implementations or compatibility shims.

Cleanup scope and historical results: [removal-plan.md](removal-plan.md) and
[cleanup-m0.md](cleanup-m0.md). M1–M4 implementation status and verification
evidence: [record-then-process.md](record-then-process.md).

Keep existing notes, blank notes, folders/editor, full embedded chat and AI
Actions, all direct ASR/LLM providers, Local and supported Self-Hosted modes,
realtime capture, all speaker recognition, file/direct URL import, calendars,
Dictionary/Snippets data/tools/management UI and meeting shell controls.

Remove OW accounts/cloud inference/sync/sharing/billing/enterprise policies,
hosted integrations, dictation, standalone assistant, web_search, YouTube,
Qdrant/semantic search, upstream updates and non-macOS-arm64 distribution.
Direct AWS/Azure/Vertex credentials are not OW managed enterprise routing.
Remove Home/Insights entirely and open Notes by default; no replacement dashboard.

Keep shared code while it has preserved consumers. Do not add compatibility
shims. The active cutover stores mic/system epochs separately, processes only
after Stop, and attaches recording/run history to Notes. The live mic/system
hardware smoke remains unverified pending final integration.

## Implemented record-then-process path

Capture saves immutable mic/system PCM epochs independently of network/provider
availability. Stop finalizes the recording and creates a durable processing run.
The worker waits for retention settings and gives active capture priority. It
uses one derived mono full-timeline WAV, persists the raw provider response
before normalization, and stores transcript/summary artifacts by run. Selection
projects one completed transcript version into Notes. See the current
[flow, limits, and verification status](record-then-process.md).

The Note remains the product root. Recordings and processing history attach to
notes; a mandatory Meeting root is not required. Existing Local meeting
processing and Local/Self-Hosted/direct routes on their existing surfaces remain.
