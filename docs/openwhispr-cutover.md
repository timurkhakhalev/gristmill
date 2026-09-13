# OpenWhispr cutover

## Current stage: cleanup

Use OpenWhispr as a one-time source pinned at
`4335972b96a62caab0c822b3b9549a1a4fdbb351`. Baseline commit: `49cd2b3`.
Preserve MIT license and attribution. No continuous full upstream merges,
legacy folders, commented-out implementations or compatibility shims.

Scope: [removal-plan.md](removal-plan.md).
Execution order and ownership: [cleanup-m0.md](cleanup-m0.md).

Keep existing notes, blank notes, folders/editor, full embedded chat and AI
Actions, all direct ASR/LLM providers, Local and supported Self-Hosted modes,
realtime capture, all speaker recognition, file/direct URL import, calendars,
Dictionary/Snippets data/tools/management UI and meeting shell controls.

Remove OW accounts/cloud inference/sync/sharing/billing/enterprise policies,
hosted integrations, dictation, standalone assistant, web_search, YouTube,
Qdrant/semantic search, upstream updates and non-macOS-arm64 distribution.
Direct AWS/Azure/Vertex credentials are not OW managed enterprise routing.
Remove Home/Insights entirely and open Notes by default; no replacement dashboard.

Keep shared code while it has preserved consumers. In common modules, make only
changes needed for removal. Do not redesign capture or persistence now.
Isolate app identity and storage before running the imported application.

## Next stage: batch (separate implementation)

Later replace realtime-dependent processing with durable separate tracks,
manifests, restart recovery, stage contracts, revisions and automatic notes.
Design that cutover separately; no legacy parallel pipeline should remain
after that later cutover.

The Note remains the product root. Recordings and processing history attach to
notes; a mandatory Meeting root is not required. Local providers and voice
fingerprinting remain supported. The future architecture is a proposal, not
proof that its guarantees already exist in the imported code.
