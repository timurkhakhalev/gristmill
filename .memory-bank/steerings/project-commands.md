# Project commands

Executable command semantics live here. Select checks using the
[quality steering](quality.md); use the repository root as the working directory.

## Test selection

| Command | Selection |
| --- | --- |
| `pnpm test` | Full suite, including compiler probes and native/GUI checks; at most two ordinary files at once |
| `pnpm test --verbose` | Same selection with full live output |
| `pnpm test -- --processes 1` | Explicit one-process diagnostic mode |
| `pnpm test --domain calendar` | All kinds in one domain |
| `pnpm test --domain calendar --domain notes` | Union of domains, without duplicates |
| `pnpm test --domain calendar --kind unit` | Unit tests in the domain |
| `pnpm test --kind types` | Batch and standalone compiler probes across domains |
| `pnpm test --domain calendar --list` | Read-only plan with kind, domains and build requirement |
| `pnpm test --help` | Available selectors and usage |

Repeated domains are OR; repeated kinds are OR; domain and kind filters intersect.
Unknown options/values, missing values and empty selections fail before preparing
the runtime. `--list` validates test classification but does not prepare SQLite,
build or run tests. New ordinary tests under `test/cases/<domain>/<kind>/` are
discovered automatically; exceptional classifications remain in
`test/test-groups.json`. Put compiled main/preload consumers under a `main/`
subdirectory and shared-resource tests under `serial/`. No selectors means the
full suite.

Test and build command output is hidden by default. The runner announces this
and shows captured output for a failed command. Use `--verbose` to stream all
output as it runs; selection, exit codes and timing stay the same.

For a particular regression, `pnpm test -- <explicit test files>` accepts exact
registered paths under `test/` ending in `.test.ts`. Do not combine
explicit files with domain/kind selectors or pass directories, globs or Node flags.
The optional leading `--` also works with selectors.

- Executed selections prepare SQLite. The runner runs `build:main` once only if
  a selected test requires compiled output. Combine checks in one call; do not
  run a separate main build immediately beforehand when the plan includes it.
- On macOS, tests use Electron's Node mode. Linux CI uses Node. Ordinary files use at most
  two isolated processes; compiler/native and marked shared-resource files run
  in a later one-worker phase. Preparation and main build each run once. Full
  runs take a lock in the common Git directory across worktrees. Use the canonical command;
  direct `node --test` can bypass the required SQLite runtime setup.
- Selected group tests under `test/scripts/type-probes/` run in their own
  one-worker batch phase. Only this phase uses `--test-isolation=none` to share
  one compiler program from `test/lib/typeProbeBatch.ts`. Other `types` tests
  run serially outside this batch; discovery under
  `test/cases/<domain>/types/` does not add a test to it.
- `pnpm run typecheck:main`, `pnpm run typecheck:renderer`,
  `pnpm run typecheck:settings-selectors` and `pnpm run typecheck:tests` select
  compiler targets with the native TypeScript 7 `tsc`. `pnpm run typecheck`
  runs those targets and `typecheck:companion` sequentially. `pnpm run build:main` uses the same native
  compiler for emitted Electron code. The `typescript` dependency aliases
  TypeScript 6 for compiler-API consumers (test probes and ESLint); its
  executable is `tsc6`. Keep the CLI and API packages distinct until
  TypeScript 7 provides a supported programmatic API. The test
  target automatically includes ordinary TypeScript tests and helpers, excluding
  intentionally invalid type-probe fixtures. A test selection that builds main
  already checks main compilation; other selections do not. `pnpm test` runs
  compiler probes, but does not replace the renderer or test typecheck. When a
  full suite is required, run `pnpm run typecheck:renderer` separately from
  `pnpm test`.
- `pnpm run lint` covers both root/main and renderer configurations. For focused
  lint, use the existing config that owns the changed file; root and `src/` have
  different configs. Do not use auto-fix across unrelated dirty files.
- `pnpm run build:renderer` checks renderer bundling. Packaging is a separate,
  heavier check; do it when package output/native integration is relevant.

## Google Meet extension

- `pnpm run build:companion` typechecks and bundles the MV3 browser code into
  `build/companion-dev`; load that directory unpacked in Chrome Stable.
- `pnpm run typecheck:companion` checks the DOM-only extension graph. Browser
  entries must not import Node/Electron code. The native host is a separate
  entry in `build:main` and runs with the bundled Electron Node runtime.
- Packaging commands build and copy the Dev extension to `companion-dev` in app
  resources. No production extension ID or Web Store registration is supplied.

## Setup and application verification

- `pnpm install --frozen-lockfile`: install the lockfile snapshot explicitly.
  The install hook can rebuild native dependencies; do not overlap with tests or
  a running app. Use the Node/pnpm requirements in [README](../../README.md).
- `pnpm dev`: Vite renderer and the development Electron main process. Its
  preparation includes native helpers and the main build; use a temporary
  explicit profile when testing app startup against synthetic data.
- `pnpm start`: run Electron after the configured preparation steps.
- `pnpm run pack:dev`: build an unsigned development app. Close the packaged
  Gristmill Dev app first. This is not a prerequisite for ordinary unit tests.
- `pnpm run build:mac:arm64:local`: build the production app with an ad-hoc
  signature using `com.khakhalev.gristmill` for local macOS permission prompts.
  Close the running app before packaging; this is not a Developer ID release.
  macOS can require fresh privacy grants after each ad-hoc signed rebuild.
  The build packages local engine installers but does not download or bundle
  Whisper, llama.cpp or sherpa-onnx engines.

## Command maintenance

[package.json](../../package.json) and
[run-tests.js](../../scripts/run-tests.js) define executable behavior. Update
this reference in the same change when their public semantics change. Confirm
both successful selection and a nonzero exit on invalid selection when editing
the runner. Keep documentation examples executable with installed dependencies.
