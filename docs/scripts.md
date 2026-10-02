# Script inventory and execution

Use Node 24 or later and pnpm 10.19.0 from the repository root.
Supported Node tooling is strict TypeScript. `pnpm run typecheck:scripts` checks
its own program and `pnpm run lint` includes it. No loader or installed package
is required to execute a dependency-free `.cts` script: Node strips its types.
CommonJS (`require`, `__dirname`, `require.main`) is intentional for these tools
and electron-builder hooks. Keep their syntax erasable by Node.

Provider canaries are `.mts` and use `node --import tsx` because their application
imports need TS module resolution and transformation. They run only in the
explicitly dispatched CI workflows, with supplied provider credentials.

`build:main` runs `build:runtime-tools` after main/preload compilation. The latter
bundles the three engine downloaders and Notes CLI into standalone CJS in
`resources/local-engine-installers/` and `resources/cli/`. These are generated,
ignored outputs, not maintained copies. The installed application needs neither
TypeScript nor tsx. Development uses the generated CLI too; source engine
installers can run in Electron's Node mode. Packaging copies the generated tools
as extra resources. An install alone still only invokes
`electron-builder install-app-deps`, without requiring compiled scripts.

## Local update

```sh
pnpm run update:local
```

Quit Gristmill and save active/paused recordings first. This checks that the
permanent destination is stopped, builds `build:mac:arm64:local` using the configured `Gristmill Local Signing`
certificate, installs at
`/Applications/Gristmill.app`, then launches that bundle with Launch Services.
The installer rechecks running processes and signatures, stages without a `.app`
suffix, validates the ZIP backup and new bundle, and restores the previous bundle
if replacement or registration fails. The previous version remains in
`/Applications/.gristmill-backup.zip`. It does not reset privacy grants or touch
user settings. Use the same certificate across local updates. This local signature is not a
notarized Developer ID release.

On the first `codesign` request for the signing key, choose **Always Allow** after
entering the login keychain password. **Allow** applies to one operation and can
cause another prompt for every embedded binary. This is separate from the
installed app's permission to access its stored credentials.

Installing an already built bundle without launching remains available:

```sh
node scripts/install-macos-local.cts [path/to/Gristmill.app]
```

For an explicitly authorized test of the entire update command, use both an
isolated destination and profile:

```sh
pnpm run update:local --target /tmp/gristmill-update/Gristmill.app --user-data-dir /tmp/gristmill-update/profile
```

Create the destination's parent directory first. A custom destination requires
`--user-data-dir`. Ordinary verification does not authorize replacing the real
installed application. Update failures exit nonzero; build/install failures never
launch an app. A launch failure leaves the newly installed, validated bundle and
its backup in place.

## Supported sources and consumers

| Sources under `scripts/`                                                                                      | Consumers / purpose                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build-native.cts`, `lib/build-macos-swift-binary.cts`                                                        | `compile:native` and five focused `compile:*` commands; Swift helpers, calendar disclaim executable, Mach-O architecture/hash validation. Audio tap retains macOS 14.2 target; other helpers retain 11.0. Cached helpers return to the loop instead of terminating it. |
| `compile-macos-icon.cts`                                                                                      | `compile:mac-icon`, macOS prebuild; optional Xcode `actool`, with existing `.icns` when unavailable.                                                                                                                                                                   |
| `build-main.cts`                                                                                              | `build:main`, dev/start, tests requiring emitted code, packaging; main TS graph, sandboxed preload bundle, runtime CJS tools.                                                                                                                                          |
| `build-companion.cts`                                                                                         | `build:companion`, packaging; production and development browser extension identities/bundles.                                                                                                                                                                         |
| `build-runtime-tools.cts`                                                                                     | `build:main`, direct `build:runtime-tools`; generated CLI and local-engine installers.                                                                                                                                                                                 |
| `beforeBuild.cts`, `afterPack.cts`                                                                            | electron-builder production/Dev hooks; forced Electron ABI rebuild, packaged SQLite/FFmpeg/worker checks, ONNX binary pruning and native signing registration. Loaded directly by Node 24.                                                                             |
| `check-dev-app-build-target.cts`                                                                              | `pack:dev`; rejects rebuilding a running output bundle.                                                                                                                                                                                                                |
| `run-electron.cts`, `launch-macos-electron.cts`, `dev-electron-bundle.cts`                                    | `start`, `dev:main`; ABI check, environment cleanup, Launch Services attribution and cached Dev identity/icons.                                                                                                                                                        |
| `ensure-sqlite-runtime.cts`                                                                                   | app launcher, canonical test runner, direct diagnostic; repairs only an established ABI mismatch.                                                                                                                                                                      |
| `run-tests.cts`, `test-selection.cts`                                                                         | `pnpm test`; selection/classification, full-run lock, two-process ordinary phases and serial native/compiler phases, process-group cleanup.                                                                                                                            |
| `install-macos-local.cts`, `update-local.cts`                                                                 | direct install, `update:local`; stable-path installation, backup/rollback and launch.                                                                                                                                                                                  |
| `gristmill-cli.cts`                                                                                           | generated Notes CLI; read-only profile discovery, private connection, filtering and human/JSON output.                                                                                                                                                                 |
| `download-whisper-cpp.cts`, `download-llama-server.cts`, `download-sherpa-onnx.cts`, `lib/download-utils.cts` | `download:*` commands and application-triggered engine installation; pinned releases, install markers, archive/library handling. Not bundled engine binaries.                                                                                                          |
| `download-diarization-models.cts`, `download-whisper-vad-model.cts`                                           | explicit `download:*` commands; developer asset preparation and offline-cache tests.                                                                                                                                                                                   |
| `check-i18n.cts`                                                                                              | `i18n:check`, PR CI; locale keys, placeholders and plural forms.                                                                                                                                                                                                       |
| `sync-nucleo-icons.cts`                                                                                       | manual regeneration from the local licensed Nucleo catalog; generated icon barrel names it as source. Does not run on install/build.                                                                                                                                   |
| `llm-canary.mts`, `stt-canary.mts`                                                                            | respective workflow_dispatch CI workflows and credential-free regression tests; live APIs require separately supplied credentials.                                                                                                                                     |
| `complete-uninstall.sh`                                                                                       | interactive manual macOS removal entrypoint, source scope check; retained as Bash for its shell prompts, sudo/process/removal commands. Never part of an update or automated verification.                                                                             |

## Removed or consolidated

- `meeting-diarization-eval.js`: no fixtures directory exists in the repository;
  the script could only list zero scenarios. No app, command, workflow, test or
  current operational document consumes it. Removed its explicit knip root too.
- Five `build-*listener.js` / `build-macos-meeting-ax.js` / audio-tap entrypoints:
  folded into `build-native.cts`, preserving every `compile:*` command and native
  source. The separate audio-tap build implementation duplicated the existing
  Swift builder; it now uses that builder with its existing target/frameworks.
- `build-local-engine-installers.js`: absorbed into `build-runtime-tools.cts`.
  `build:runtime-tools` is its current command, also covering the CLI.
- `src/helpers/whisperCppRelease.js`: tooling-only pin with one consumer;
  the downloader now owns the same environment override/default directly.
- `scripts/prototypes/`: deleted at Timur's explicit request after tracing all
  consumers. No app/build/CI entrypoint loads these files; only historical Zoom
  and Companion experiment documents refer to them. Production Swift helpers
  and app regression tests remain. Findings and measurements are archived in
  `docs/zoom-speaker-prototype.md`, `docs/companion-risk-probe.md` and its JSON.
- Migrated JS/CJS/MJS sources have no legacy duplicate or extension shim.
  Historical changelog/stage reports retain their original names.
