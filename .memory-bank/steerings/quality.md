# Quality steering

## Purpose and ownership

- Select checks from the changed behavior and dependencies.
- Use the smallest set of checks that can find the related regressions. Add more checks when the change crosses boundaries.
- Keep unrelated work. Record limits honestly.

This document owns the verification policy.
[AGENTS.md](../../AGENTS.md) is the entry point.
[Project commands](project-commands.md) owns what the commands do.
Steerings are durable rules for how to change and review the current system.
When a rule changes, update its steering in the same change.
Indexes are only for navigation. Plans, task status and historical measurements do not go into steerings.

## Test layers and value

Use the least expensive existing layer that can find the regression:

1. Pure logic and deterministic state transitions: focused `node:test` cases, run through the canonical wrapper (Electron Node mode on macOS).
2. Persistence and IPC boundaries: integration tests with temporary databases, synthetic profiles and the real related bridge or storage contract.
3. Renderer state and interactions: the existing Vite SSR, browser or hook harness, when pure logic tests cannot show the observable behavior.
4. Compile-time contracts: focused TypeScript probes for valid wiring and rejected invalid calls. A positive graph check and a negative probe cover different risks.
5. Electron, packaged or native behavior: an isolated real-runtime smoke test or a hardware scenario, when the behavior depends on those boundaries.

Before you add a test, name the regression that it must find.

- Prefer observable results, persisted state, lifecycle transitions and public contracts.
- Use source or structure assertions only when that structure is an enforced boundary.
- Do not add duplicate broad scenarios, sleeps, snapshots or copy-presence checks without a behavior that they protect.
- A copy assertion is valid when the wording is the contract, for example accessibility labels or formatter output.
- Keep error, cancellation and recovery cases for behavior that can lose recordings, notes or secrets.
- When you optimize a test, keep its assertions and isolation. Replace real waits with controlled clocks. Do not delete timeout coverage.
- Exploratory UI checks add to regression tests.
- A mocked capture test does not prove that real microphone and system audio work.

## Code and review conventions

- Obey the owning ESLint and TypeScript configuration and the local code conventions.
- Do not add another formatter. Do not change unrelated formatting in a task.
- Prefer existing functions, platform APIs and dependencies.
- Add a shared abstraction only when repeated code or a demonstrated requirement needs it.
- Keep typed contracts at IPC, provider and persistence boundaries.
- Do not hide meaningful compiler failures with `any`, casts or suppression comments.
- Report failures accurately. Do not report a save or a processing stage as successful when persistence or execution failed.
- Keep diagnostics useful. Do not log credentials or private recording or transcript contents.
- Do not add compatibility shims or parallel legacy paths, unless a requirement explicitly needs them.
- Review against observable requirements and these rules. Separate a real defect from a style preference or from outdated documentation.

## Working loop

1. Read the diff and trace the direct consumers before you select tests. State the affected behavior, the selected checks and why they are sufficient.
2. During implementation, put related test files into one focused run. After a failure, run the failed files again first.
3. After integration, run the checks for all affected consumers one time. For broad changes, use the full suite as the table below defines. Do not run it one time for each agent or each review round. A comment-only follow-up does not make behavior tests invalid.
4. Stop when the selected checks pass and there is no specific verification gap. A later behavior change needs the affected checks again.

## Checks by change scope

| Change | Required verification |
| --- | --- |
| Documentation or comments only | Review accuracy, local links and the referenced commands. Run `git diff --check`. Do not build or test the application unless executable content or runtime behavior also changed. |
| Small, isolated function or bug fix | Its behavior or regression tests and the tests of affected direct consumers. Lint the changed code with its owning ESLint configuration. For type or interface changes, add the related typecheck. A focused pass can be sufficient. |
| Renderer component or hook | The related component, hook or store tests, renderer lint and `pnpm run typecheck:renderer`. For visual or interaction changes, inspect the affected UI state. Unit tests alone do not prove the layout. |
| Main process or IPC | The related helper, IPC and bridge tests. When a contract changes, add the matching type probe. The runner builds and typechecks main when the selected tests need its output. If not, run `pnpm run typecheck:main` for main code changes. For emitted graph or preload changes, include the platform graph checks. |
| Provider routing or settings | Include each affected route and consumer: meeting capture, file upload, note formatting and chat. When the shared settings-selector graph changes, run `pnpm run typecheck:settings-selectors`. A shared store or registry change usually needs the full suite. |
| Database or schema, secrets or deletion | The related persistence, reopen, failure and isolation tests. Trace all consumers of the changed table or API. Shared database infrastructure or a reset or deletion across domains needs the full suite. Use synthetic temporary data. |
| Test-only change | Run each changed test file. A shared harness, runner or configuration change needs the full suite after the focused checks. Keep negative cases and failure-path coverage when you optimize. |
| Dependencies, compiler or build configuration, shared contracts or broad refactor | The related focused regressions, `pnpm run lint`, `pnpm run typecheck`, then one full suite after integration. When the output of a build or packaging path changed, run that path. |
| Release or package validation | Full suite, lint, typecheck, renderer build and package verification as applicable. After packaging, run the isolated packaged-app smoke test. Capture or native changes also need the related hardware scenario. |

- When you run the full suite, also run `pnpm run typecheck:renderer`.
- Run the full suite in these conditions:
  - The user asks for it explicitly.
  - The effect crosses several domains and you cannot set its limits with confidence.
  - The table requires it.
- Do not require the full suite only because of a large assertion count or a review request.
- Report focused evidence as focused evidence. Never call it a full pass.

## Selecting domains and kinds

- Select behavior with `--domain` and the test environment with `--kind`.
- The executable registry owns membership and main-build requirements. This document does not keep a second list of test files.
- A test can belong to several domains. It runs one time.
- Selection is explicit. It is not automatic impact analysis.

| Domain | Behavior |
| --- | --- |
| `notes` | Notes, editor, folders, search, imports and note output |
| `recording` | Capture, microphone and system tracks, Stop, recovery and speakers |
| `transcription` | Files, transcription routes, queue, diarization and cancellation |
| `calendar` | OAuth, events, reminders, availability and meeting cards |
| `ai` | Models, providers, chat, tools and generated content |
| `settings` | Preferences, migrations, secrets and onboarding |
| `platform` | Electron, windows, builds, runtime and shared infrastructure |

| Kind | Test environment |
| --- | --- |
| `unit` | Pure logic or isolated behavior with mocked dependencies |
| `integration` | Real database, file system, renderer harness, subprocess or IPC contract |
| `types` | TypeScript compiler probes. A file can also contain runtime assertions |
| `native` | GUI, Swift or native helpers, or OS process integration |

- Classification is for each file. For mixed files, use the stronger requirement.
- A unit selection gives a fast development loop. It does not replace the integration, type or native checks that the changed behavior needs.
- For a local change, start with the least expensive related kind. Before completion, add the checks that the scope table requires.
- For public contract changes, include type and integration checks for consumers.
- For cross-domain changes, select each affected domain, or the full suite when you cannot set the limits of the effect.
- Read the diff and the consumers. Do not guess a domain only from a file name.

```sh
pnpm test --domain calendar --kind unit --list
pnpm test --domain calendar --kind unit
pnpm test --domain calendar --domain notes
```

### Test locations

- Write new ordinary tests and shared test helpers in TypeScript.
- Keep deliberate compiler-error fixtures under `test/scripts/type-probes/`. The probe runner examines their expected diagnostics. The regular strict test typecheck excludes these fixtures.
- Put new ordinary tests under `test/cases/<domain>/<kind>/`. The runner finds their domain and kind without a path registration.
- A `main/` subdirectory marks compiled main and preload consumers. `serial/` marks a shared-resource test.
- Use `test/test-groups.json` for tests that need several domains or a non-standard location. Update those entries when you rename or remove tests or change their dependencies.
- Unknown locations and stale, duplicate or invalid registrations fail before runtime preparation.
- Mark consumers of compiled main and preload output with `buildMain: true`. The runner builds one time if a selected test needs it.
- Use narrow patterns only for tests with the same domain and environment contract.

## Compiler and renderer fixtures

### Type probes

- For compatible compiler checks, add fixtures to an existing group under `test/scripts/type-probes/`. Do not start another compiler program.
- A `<group>.test.ts` file calls `test/lib/typeProbeBatch.ts`. Its `<group>-NN.ts` fixtures name each case and list its expected diagnostic codes.
- Keep those codes and the clean implementation-graph check of the batch helper when you change probes.
- Register a new group test in `test/test-groups.json` with its domain and the `types` kind.
- An ordinary `types` test under `test/cases/<domain>/<kind>/` does not go into the batch. The runner selects batch groups by their `test/scripts/type-probes/` path.
- Keep separate compiler programs when compiler options are not compatible or when fixtures change implementation sources. Do not combine those environments until you prove that they can share one program.

### Renderer tests

- Import pure renderer modules directly when this keeps the tested behavior.
- Use the existing `test/lib/rendererTestHarness.ts` when you need Vite SSR, browser globals or module mocks.
- Compatible cases in one file can share a Vite server. Restore stores, globals, mocks and singleton state between cases.
- Keep different module-mock environments separate until their isolation is proved.
- Do not disable test process isolation globally.

## Resource and isolation rules

### Orchestration

- Only the root orchestrator or integrator runs tests, builds, dependency installs or native rebuilds.
- Subagents can edit tests and run scoped lint and typecheck. They report the exact test and build commands to the root.
- Repeat this limit in each delegated task. Do not run several whole-project typechecks at the same time.
- Wait until delegated implementation is complete. Then run expensive checks in sequence.
- Run the canonical command at normal priority. Do not use `taskpolicy -b` or `nice` as routine load controls.
- The runner permits a maximum of two ordinary test files at the same time. Then it runs compiler, native and shared-resource files with one worker.
- Use `--processes 1` for diagnosis or on a host with limited resources.
- Do not run test, build or install processes at the same time.
- Different agent chats share the same checkout and generated output. Look for an existing run before you start another. Do not stop the processes of a different task.

### Native dependencies

- Do not install dependencies or rebuild packaging or native modules while tests or apps run.
- The common Electron ABI prevents dev and tests from switching SQLite between ABIs on macOS. It does not make concurrent dependency writes safe.

### Profiles and data

- Keep temporary-profile isolation.
- Never test against the original OpenWhispr profile or real production data or credentials.
- For app smoke tests, use an explicit new `--user-data-dir`. Explicit profiles skip the Dev data copy.

### Cleanup

- Register cleanup immediately when a test creates a resource.
- Restore globals and module patches. Close timers, servers and owned child processes, also when an assertion fails.
- Passing cases do not prove that owned processes stopped.
- Do not stop unrelated processes. Do not use force-exit as a replacement for cleanup.
- Prefer fake clocks for timeout behavior. Prefer owned child processes that close quickly.
- Use compiler caches only through supported compiler behavior. Keep test state and outputs isolated.
- Do not make assertions weaker or skip checks to decrease the reported duration.

### Quiet tests

- A quiet test can be compiling Swift or TypeScript. Inspect its owned process and log before you decide that it is stuck.
- Do not start a duplicate run, increase timeouts without a reason or kill all Node and Electron processes.

## Evidence to report

- Record the exact command, the scope, the pass, fail and skip counts, the duration when you compare performance, and the checks that you did not do.
- Keep unit and integration evidence separate from GUI, hardware and real-provider verification.
- Record failures and remaining risks. A required check that was not available is not a pass.
- Measure wall time or RSS against a baseline for an optimization task or a suspected slowdown. Do not measure them for routine test, fixture or runner changes.
