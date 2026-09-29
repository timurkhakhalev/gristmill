# Gristmill working rules

Start with [.memory-bank/index.md](.memory-bank/index.md). Read the
[quality steering](.memory-bank/steerings/quality.md) before selecting or running
checks. Read `README.md` and the relevant documents under `docs/` before making
architectural or product changes.

## Product scope and implementation references

Cleanup is merged; `docs/removal-plan.md` and `docs/cleanup-m0.md` describe its
scope and baseline. Read `README.md` and `docs/record-then-process.md` for the
record-then-process implementation and remaining verification limits.
Preserve existing notes (including blank notes), full embedded chat except
web_search, all BYOK/Local/supported Self-Hosted routes, realtime recording,
all speaker recognition, and Dictionary/Snippets data, tools and management UI.
Keep Home (dictation history) and Insights removed; open Notes by default.
Do not add a replacement dashboard without a product decision.
Use isolated profiles for runtime smoke tests; never use the original
OpenWhispr profile. Do not add compatibility shims.

## Parallel agent resource limits

The [quality steering](.memory-bank/steerings/quality.md) defines check selection,
full-suite triggers, runtime isolation and required verification evidence.

- Subagents may run typecheck and lint, and write or update tests.
- Only the root orchestrator/integrator may run tests, builds, dependency
  installation or native rebuilds. Subagents must not run these, including
  focused tests, watch mode, lifecycle hooks or equivalent direct commands.
- Subagents report the exact test/build/install commands needed instead of
  executing them. Repeat this restriction in every delegated task.
- The orchestrator waits for the parallel wave to finish, then runs expensive
  checks sequentially, never multiple test/build/install processes at once.
  Use the canonical runner's measured two-process limit; compiler/native and
  shared-resource phases stay sequential. After a failure, rerun focused tests
  first. When the quality steering requires the full suite, run it once after
  integration, not once per subagent.

## Recording and processing invariants

Preserve these invariants when changing capture or processing. Automated tests
do not replace live hardware verification; see `docs/record-then-process.md`.

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
