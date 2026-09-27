# Project commands

Executable command semantics live here. Select checks using the
[quality steering](quality.md); use the repository root as the working directory.

## Test selection

| Command | Selection |
| --- | --- |
| `pnpm test` | Full suite, including compiler probes and native/GUI checks; at most two ordinary files at once |
| `pnpm test -- --processes 1` | Explicit one-process diagnostic mode |
| `pnpm test --domain calendar` | All kinds in one domain |
| `pnpm test --domain calendar --domain notes` | Union of domains, without duplicates |
| `pnpm test --domain calendar --kind unit` | Unit tests in the domain |
| `pnpm test --kind types` | Compiler probes across domains |
| `pnpm test --domain calendar --list` | Read-only plan with kind, domains and build requirement |
| `pnpm test --help` | Available selectors and usage |

Repeated domains are OR; repeated kinds are OR; domain and kind filters intersect.
Unknown options/values, missing values and empty selections fail before preparing
the runtime. `--list` validates the registry but does not prepare SQLite, build or
run tests. No selectors means the full suite.

For a particular regression, `pnpm test -- <explicit test files>` accepts exact
registered paths under `test/` ending in `.test.js` or `.test.ts`. Do not combine
explicit files with domain/kind selectors or pass directories, globs or Node flags.
The optional leading `--` also works with selectors.

- Executed selections prepare SQLite. The runner runs `build:main` once only if
  a selected test requires compiled output. Combine checks in one call; do not
  run a separate main build immediately beforehand when the plan includes it.
- On macOS, tests use Electron's Node mode and background scheduling
  (`taskpolicy -b`, `nice -n 15`). Linux CI uses Node. Ordinary files use at most
  two isolated processes; compiler/native and marked shared-resource files run
  in a later one-worker phase. Preparation and main build each run once. Full
  runs take a lock in the common Git directory across worktrees. Use the canonical wrapper;
  direct `node --test` can bypass the required SQLite runtime setup.
- `pnpm run typecheck:main`, `pnpm run typecheck:renderer` and
  `pnpm run typecheck:settings-selectors` select compiler targets.
  `pnpm run typecheck` runs all three sequentially. A test selection that builds
  main already checks main compilation; other selections do not. Neither replaces
  renderer/selector checks.
- `pnpm run lint` covers both root/main and renderer configurations. For focused
  lint, use the existing config that owns the changed file; root and `src/` have
  different configs. Do not use auto-fix across unrelated dirty files.
- `pnpm run build:renderer` checks renderer bundling. Packaging is a separate,
  heavier check; do it when package output/native integration is relevant.

## Setup and application verification

- `pnpm install --frozen-lockfile`: install the lockfile snapshot explicitly.
  The install hook can rebuild native dependencies; do not overlap with tests or
  a running app. Use the Node/pnpm requirements in [README](../../README.md).
- `pnpm dev`: Vite renderer and the development Electron main process. Its
  preparation includes native helpers and the main build; use a temporary
  explicit profile when testing app startup against synthetic data.
- `pnpm start`: run Electron after the configured preparation steps.
- `pnpm run pack:dev`: build an unsigned development app. Close the packaged
  OpenHercules Dev app first. This is not a prerequisite for ordinary unit tests.

## Command maintenance

[package.json](../../package.json) and
[run-tests.js](../../scripts/run-tests.js) define executable behavior. Update
this reference in the same change when their public semantics change. Confirm
both successful selection and a nonzero exit on invalid selection when editing
the runner. Keep documentation examples executable with installed dependencies.
