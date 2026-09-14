# OpenHercules working rules

Read `README.md` and the documents under `docs/` before making architectural or product changes.

## Current milestone: cleanup

The current contract is `docs/removal-plan.md`; delegation and verification are
in `docs/cleanup-m0.md`. Complete cleanup before implementing batch processing.
Preserve existing notes (including blank notes), full embedded chat except
web_search, all BYOK/Local/supported Self-Hosted routes, realtime recording,
all speaker recognition, and Dictionary/Snippets data, tools and management UI.
Remove Home (dictation history) and Insights entirely; open Notes by default.
Do not build a replacement dashboard during cleanup.
Isolate identity and storage in M1 before runtime smoke tests; never use the
original OpenWhispr profile. Do not add compatibility shims.

## Parallel agent resource limits

- Subagents may run typecheck and lint, and write or update tests.
- Only the root orchestrator/integrator may run tests, builds, dependency
  installation or native rebuilds. Subagents must not run these, including
  focused tests, watch mode, lifecycle hooks or equivalent direct commands.
- Subagents report the exact test/build/install commands needed instead of
  executing them. Repeat this restriction in every delegated task.
- The orchestrator waits for the parallel wave to finish, then runs expensive
  checks sequentially, never multiple test/build/install processes at once.
  Use `--test-concurrency=1` for Node tests. After a failure, rerun focused tests
  first; run the full suite after integration, not once per subagent.

## Future batch invariants (not cleanup acceptance criteria)

These describe the next stage, not guarantees of the imported baseline.
Do not implement new capture, queues or stage contracts during cleanup.

- The original microphone and system tracks are the source of truth.
- Capture must not depend on network access or a model provider.
- Never silently fall back from dual-track capture to an apparently complete mic-only meeting.
- Do not delete or overwrite raw audio or previous processing artifacts during retry.
- Keep provider-specific payloads behind canonical stage contracts.
- Persist long-running processing state so it can resume after restart.
- Keep the product macOS Apple Silicon only; preserve the existing notes model.
- Prefer a static TypeScript provider registry over a plugin framework until dynamic plugins are required.
- Do not preserve old OpenWhispr product paths through compatibility shims after cutover.

## Scope discipline

Do not reintroduce dictation, a general voice assistant, team collaboration, hosted sync, enterprise controls, or cross-platform support without an explicit product decision.

When importing OpenWhispr code, preserve its MIT license and attribution. Import only the code and assets needed by the documented product surface.
