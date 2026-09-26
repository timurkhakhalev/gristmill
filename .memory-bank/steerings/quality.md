# Quality steering

## Purpose and ownership

Choose checks from the behavior and dependencies changed. Use the smallest set
that can detect the relevant regressions, and expand it when the change crosses
boundaries. Preserve unrelated work and record limitations honestly.

This document owns verification policy. [AGENTS.md](../../AGENTS.md) is the entry
point; [project commands](project-commands.md) owns executable command semantics.
Steerings are durable rules for changing and reviewing the current system. Update
them in the same change when a rule changes. Keep indexes as navigation only;
plans, task status and historical measurements belong outside steerings.

## Test layers and value

Use the cheapest existing layer that can detect the regression:

1. Pure logic and deterministic state transitions: focused `node:test` cases,
   executed through the canonical wrapper (Electron's Node mode on macOS).
2. Persistence and IPC boundaries: integration tests with temporary databases,
   synthetic profiles and the real relevant bridge/storage contract.
3. Renderer state and interactions: the existing Vite SSR/browser or hook harness
   when pure logic tests cannot express the observable behavior.
4. Compile-time contracts: focused TypeScript probes for valid wiring and rejected
   invalid calls. A positive graph check and a negative probe serve different risks.
5. Electron/packaged/native behavior: isolated real-runtime smoke or a hardware
   scenario when the behavior depends on those boundaries.

Before adding a test, name the regression it should catch. Prefer observable
results, persisted state, lifecycle transitions and public contracts. Use source
or structure assertions only when that structure is itself an enforced boundary.
Do not add duplicate broad scenarios, sleeps, snapshots or copy-presence checks
without a behavior they protect. Copy is a valid assertion when wording itself
is the contract, such as accessibility labels or formatter output.

Keep error, cancellation and recovery cases for behavior that can lose recordings,
notes or secrets. Optimizing a test must preserve its assertions and isolation;
replace real waits with controlled clocks rather than deleting timeout coverage.
Exploratory UI checks complement regression tests. A mocked capture test does
not establish that real microphone/system audio works.

## Code and review conventions

- Follow the owning ESLint/TypeScript configuration and local code conventions.
  Do not introduce another formatter or change unrelated formatting for a task.
- Prefer existing functions, platform APIs and dependencies. Introduce a shared
  abstraction only when repeated code or a demonstrated requirement warrants it.
- Preserve typed contracts at IPC, provider and persistence boundaries. Do not
  silence meaningful compiler failures with `any`, casts or suppression comments.
- Propagate failures accurately; do not report a save or processing stage as
  successful when persistence or execution failed. Keep diagnostics useful
  without logging credentials or private recording/transcript contents.
- No compatibility shims or parallel legacy paths unless explicitly required.
- Review against observable requirements and these rules. Distinguish a real
  defect from a stylistic preference or outdated documentation.

## Working loop

1. Read the diff and trace direct consumers before choosing tests. State the
   affected behavior, selected checks and why they are sufficient.
2. During implementation, batch related test files into one focused invocation.
   After a failure, rerun the failing files first.
3. After integration, run the checks for all affected consumers once. Use the
   full suite for broad changes as defined below, rather than once per agent or
   review round. A comment-only follow-up does not invalidate behavior tests.
4. Stop when the selected checks pass and no concrete verification gap remains.
   A later behavior change requires rerunning the affected checks.

## Checks by change scope

| Change | Required verification |
| --- | --- |
| Documentation or comments only | Review accuracy, local links and referenced commands; `git diff --check`. No application build or tests unless executable content or runtime behavior also changed. |
| Small, isolated function or bug fix | Its behavior/regression tests and tests of affected direct consumers; lint changed code with its owning ESLint config. Add the relevant typecheck for type/interface changes. A focused pass can be sufficient for this scope. |
| Renderer component or hook | Relevant component/hook/store tests, renderer lint and `pnpm run typecheck:renderer`. Inspect the affected UI state for visual/interaction changes; unit tests alone do not prove layout. |
| Main process or IPC | Relevant helper, IPC and bridge tests, plus the matching type probe when a contract changes. The runner builds and typechecks main when selected tests require its output; otherwise run `pnpm run typecheck:main` for main code changes. Include platform graph checks for emitted graph/preload changes. |
| Provider routing or settings | Include each affected route and consumer: meeting capture, file upload, note formatting and/or chat. Run `pnpm run typecheck:settings-selectors` when changing that shared graph. A shared store or registry change usually needs the full suite. |
| Database/schema, secrets or deletion | Relevant persistence, reopen, failure and isolation tests; trace all consumers of the changed table/API. Shared database infrastructure or reset/deletion across domains requires the full suite. Use synthetic temporary data. |
| Test-only change | Run every changed test file. A shared harness/runner/config change requires the full suite after focused checks. Preserve negative cases and failure-path coverage when optimizing. |
| Dependencies, compiler/build configuration, shared contracts or broad refactor | Relevant focused regressions, `pnpm run lint`, `pnpm run typecheck`, then one full suite after integration. Run the affected build/packaging path when its output changed. |
| Release/package validation | Full suite, lint, typecheck, renderer build and package verification as applicable. Run the isolated packaged-app smoke after packaging. Capture/native changes additionally need the relevant hardware scenario. |

Run the full suite when explicitly requested, when impact spans several domains
and cannot be bounded confidently, or when the table requires it. Do not infer a
full-suite requirement merely from a large assertion count or a review request.
Report focused evidence as focused evidence; never call it a full pass.

## Selecting domains and kinds

Select behavior with `--domain` and test environment with `--kind`. The executable
registry owns membership and main-build requirements; this document does not
maintain a second inventory of test files. A test can belong to several domains
and is still executed once. Selection is explicit, not automatic impact analysis.

| Domain | Behavior |
| --- | --- |
| `notes` | Notes, editor, folders, search, imports and note output |
| `recording` | Capture, microphone/system tracks, Stop, recovery and speakers |
| `transcription` | Files, transcription routes, queue, diarization and cancellation |
| `calendar` | OAuth, events, reminders, availability and meeting cards |
| `ai` | Models, providers, chat, tools and generated content |
| `settings` | Preferences, migrations, secrets and onboarding |
| `platform` | Electron, windows, builds, runtime and shared infrastructure |

| Kind | Test environment |
| --- | --- |
| `unit` | Pure logic or isolated behavior with mocked dependencies |
| `integration` | Real database, filesystem, renderer harness, subprocess or IPC contract |
| `types` | TypeScript compiler probes; a file may also contain runtime assertions |
| `native` | GUI, Swift/native helpers or OS process integration |

Classification is per file. Use the stronger requirement for mixed files. A unit
selection provides a fast development loop; it does not replace the integration,
type or native checks required by the changed behavior.

For a local change, start with the cheapest relevant kind. Before completion,
add the checks required by the scope table. For public contract changes, include
type and integration checks for consumers. Select every affected domain for
cross-domain changes, or the full suite when impact cannot be bounded. Read the
diff and consumers rather than inferring a domain from a filename alone.

```sh
pnpm test --domain calendar --kind unit --list
pnpm test --domain calendar --kind unit
pnpm test --domain calendar --domain notes
```

Maintain `test/test-groups.json` when adding, renaming or removing tests, or when
their dependencies change. Missing, stale, duplicate and invalid registrations
fail before runtime preparation. Mark consumers of compiled main/preload output
with `buildMain: true`; the runner builds once if any selected test requires it.
Use narrow patterns only for tests with the same domain and environment contract.

## Resource and isolation rules

- Only the root orchestrator/integrator runs tests, builds, dependency installs
  or native rebuilds. Subagents may edit tests and run scoped lint/typecheck;
  they report exact test/build commands for the root. Repeat this limit in each
  delegated task and avoid several concurrent whole-project typechecks.
- Wait for delegated implementation to finish. Run expensive checks sequentially,
  with `--test-concurrency=1`; no overlapping test/build/install runs. The same
  checkout and generated output are shared across Codex chats: check for an
  existing run before starting another, and do not stop another task's processes.
- Keep installs and packaging/native rebuilds separate from running tests and
  apps. The common Electron ABI prevents dev/tests from switching SQLite back
  and forth on macOS; it does not make concurrent dependency writes safe.
- Preserve temporary-profile isolation. Never test against the original
  OpenWhispr profile or real production data/credentials. Use an explicit fresh
  `--user-data-dir` for app smoke tests; explicit profiles skip dev reseeding.
- Prefer fake clocks for timeout behavior and owned, promptly closed child
  processes. Reuse compiler caches through supported compiler behavior; keep
  test state and outputs isolated. Do not weaken assertions or skip checks to
  improve reported duration.
- A quiet test can be compiling Swift or TypeScript. Inspect its owned process
  and log before treating it as hung. Do not launch a duplicate run, increase
  timeouts blindly, or kill all Node/Electron processes.

## Evidence to report

Record the exact command, scope, pass/fail/skip counts, duration when comparing
performance, and any checks not performed. Separate unit/integration evidence
from GUI, hardware and real-provider verification. Capture failures and remaining
risks; an unavailable required check is not a pass.
