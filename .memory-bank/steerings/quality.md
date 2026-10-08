# Quality steering

## Purpose and ownership

- Select checks from the changed behavior and dependencies.
- Use the smallest set of checks that can find the related regressions. Add more checks when the change crosses boundaries.
- Keep unrelated work. Record limits honestly.

This document owns the verification policy.
[AGENTS.md](../../AGENTS.md) is the entry point.
[Project commands](project-commands.md) owns what the commands do.
Before changing external-data boundaries or type-safety exceptions, read [type safety](type-safety.md).

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

## Working loop

1. Read the diff and trace the direct consumers before you select tests. State the affected behavior, the selected checks and why they are sufficient.
2. During implementation, put related test files into one focused run. After a failure, run the failed files again first.
3. After integration, run the checks for all affected consumers one time. For broad changes, use the full suite as the table below defines. Do not run it one time for each agent or each review round. A comment-only follow-up does not make behavior tests invalid.
4. Stop when the selected checks pass and there is no specific verification gap. A later behavior change needs the affected checks again.

## Checks by change scope

| Change                                                                            | Required verification                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Documentation or comments only                                                    | Review accuracy, local links and the referenced commands. Run `git diff --check`. Do not build or test the application unless executable content or runtime behavior also changed.                                                                                                                                   |
| Small, isolated function or bug fix                                               | Its behavior or regression tests and the tests of affected direct consumers. Lint the changed code with `pnpm run lint`. For type or interface changes, add the related typecheck. A focused pass can be sufficient.                                                                                                 |
| Renderer component or hook                                                        | The related component, hook or store tests, `pnpm run lint` and `pnpm run typecheck:renderer`. For visual or interaction changes, inspect the affected UI state. Unit tests alone do not prove the layout.                                                                                                           |
| Main process or IPC                                                               | The related helper, IPC and bridge tests. When a contract changes, add the matching type probe. The runner builds and typechecks main when the selected tests need its output. If not, run `pnpm run typecheck:main` for main code changes. For emitted graph or preload changes, include the platform graph checks. |
| Provider routing or settings                                                      | Include each affected route and consumer: meeting capture, file upload, note formatting and chat. When the shared settings-selector graph changes, run `pnpm run typecheck:settings-selectors`. Select the affected consumers; use the full suite when their impact cannot be bounded confidently.                   |
| Database or schema, secrets or deletion                                           | The related persistence, reopen, failure and isolation tests. Trace all consumers of the changed table or API. Include affected domains; use the full suite when shared infrastructure or cross-domain effects cannot be bounded confidently. Use synthetic temporary data.                                          |
| Test-only change                                                                  | Run each changed test file. For a shared harness, runner or configuration change, check affected consumers after focused checks; use the full suite if the affected set cannot be bounded confidently. Keep negative cases and failure-path coverage when you optimize.                                              |
| Dependencies, compiler or build configuration, shared contracts or broad refactor | The related focused regressions, lint and typechecks for the affected code. Run the full suite when the change affects the whole application or its impact cannot be bounded confidently. When the output of a build or packaging path changed, run that path.                                                       |
| Release or package validation                                                     | Full suite, lint, typecheck, renderer build and package verification as applicable. After packaging, run the isolated packaged-app smoke test. Capture or native changes also need the related hardware scenario.                                                                                                    |

- When you run the full suite, also run `pnpm run typecheck:renderer`.
- Run the full suite in these conditions:
  - The user asks for it explicitly.
  - The effect crosses several domains and you cannot set its limits with confidence.
  - Release or package validation requires it under the table above.
- Do not require the full suite only because of a large assertion count or a review request.
- Report focused evidence as focused evidence. Never call it a full pass.

## Selecting checks

For renderer imports and new shared-helper entries, use the [renderer import boundary](../architecture/renderer-boundary.md). Keep its positive and negative probes with changes to the policy. The selected shared graph check runs in the canonical test suite; lint alone checks direct imports.

Use `pnpm test --domain <domain> --kind <kind> --list` to inspect a selection before running it. Omit `--kind` when all kinds in the affected domain are needed. Trace the diff and consumers; file names alone do not establish coverage.

See [project commands](project-commands.md) for selectors and [test runner and fixtures](../runbooks/testing.md) when adding tests or changing harnesses.

## Resource and isolation rules

### Shared resources

- Coordinate checks that share a checkout, generated output, dependency directories, profiles, or machine capacity. Different BB environments may use separate worktrees; inspect the actual resources before assuming they conflict.
- Serialize test, build, install and native rebuild operations that mutate or depend on the same output or dependencies. Do not install or rebuild native modules while tests or apps use those dependencies.
- Avoid duplicate runs. Independent environments can run checks concurrently when their resources are isolated and the machine has sufficient capacity.
- Reduce runner concurrency for diagnosis or a resource-constrained machine; see [project commands](project-commands.md).
- Do not stop processes belonging to another task.

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
