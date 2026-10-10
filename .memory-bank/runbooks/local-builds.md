# Local builds, signing and profiles

Commands and their cost: [project commands](../steerings/project-commands.md).
Update and install script details: [scripts](../steerings/scripts.md#local-update).

## Production local build and signing

- To build the macOS arm64 app, run `pnpm run build:mac:arm64`. You must have the Xcode command-line tools.
- For a local installation, run `pnpm run build:mac:arm64:local`. This command uses the persistent self-signed `Gristmill Local Signing` identity from your login keychain.
- The local build does not notarize the app. It is not a Developer ID release.
- Create or import the signing identity on each build Mac before you use the local command.
- Keep the private key. Then each new build keeps the same signing identity.

An ad-hoc signature changes with each build.
The persistent local certificate keeps the signing requirement of the app stable across builds.
The first change to this identity can need new Keychain and privacy permissions.
When macOS asks for Keychain access, select **Always Allow**.
To distribute the app to other Macs, use a Developer ID Application certificate and notarization.

During the first local build, `codesign` can ask for access to the private key of the certificate:

1. Enter your login keychain password.
2. Select **Always Allow**.

**Allow** gives access for one operation only. Then packaging can ask again for each embedded binary.
This build-time permission is different from the Keychain access of the installed app.

The package does not include Whisper, llama.cpp or sherpa-onnx executables.
The first use of a downloaded local model installs the necessary engine into the user data of the app.
Cloud routes do not install engines.

Renderer-only packages are development dependencies. Vite includes them in the renderer bundle; the app does not need a second copy in `node_modules`.
The packaging hook replaces an identical versioned ONNX Runtime library with a relative link to its SONAME library before signing. Different binaries are kept.

## Local update

1. Save active or paused recordings.
2. Quit Gristmill.
3. Run `pnpm run update:local`.

The command builds the local production bundle, installs it at `/Applications/Gristmill.app` and starts it.
The previous version stays in `/Applications/.gristmill-backup.zip`.
If the installation fails, the installer restores the previous version.

- Do not keep renamed backups such as `previous.app`. macOS can track them as applications in its permission lists.
- Remove old Accessibility entries manually in System Settings. The installer does not change privacy permissions.

## Dev app and Dev profile

To build a separate unsigned development app, run `pnpm run pack:dev`.
The app is `dist-dev/mac-arm64/Gristmill Dev.app`.
It uses its own `Gristmill-development` profile.
It has the Notes Debug menu and orange icons.
Debug states are interactive and stay in memory. They do not save notes, record audio or call providers.

At its first start, the Dev profile copies a snapshot of the production profile. The copy only adds files and goes in one direction.

- `pnpm dev` and the packaged Dev app use the same development database.
- Existing Dev data stays. `GRISTMILL_REFRESH_SNAPSHOT=1` copies only missing production files.
- Reset All App Data in Dev stops the automatic copy at later starts.
- Explicit `--user-data-dir` test profiles never import production data.

## Native SQLite ABI

- On macOS, focused and full tests run in Electron Node mode. They use the same SQLite ABI as `pnpm dev`.
- The test command examines the binding and repairs a mismatch before it starts.
- Linux CI runs tests in Node with the Node ABI.
- `pnpm dev` and `pnpm start` examine the Electron binding and repair a mismatch before the app opens.
- Do not install dependencies or rebuild packages while tests or the app run. These operations replace the native binary.
- The packaging hook restores the Electron ABI and validates SQLite with the packaged runtime before it makes installers.

pnpm does not run scripts when `node_modules` does not agree with the lockfile of the worktree.
In that case, run `pnpm install --frozen-lockfile` in that worktree first.
The dependency installation builds one child package at a time.

## Logs

The production app writes meeting capture errors to `userData/logs/capture-errors.log` without Debug mode.
It keeps this file and one rotated file, `capture-errors.1.log`. Each file is 1 MiB or less.
To open the logs folder, use Settings → Developer.
Debug mode writes its own detailed log.

## Meeting resampler delivery

`pnpm run compile:native` builds the private meeting helper for arm64 macOS 12 or
later. Xcode command-line tools, clang, make, curl and tar are build prerequisites.
Runtime preparation uses bundled libraries and does not require Homebrew.

The build pins FFmpeg 8.1.1 source, SHA-256
`b6863adde98898f42602017462871b5f6333e65aec803fdd7a6308639c52edf3`.
It builds shared libswresample/libavutil under LGPL-2.1-or-later, with GPL,
nonfree, version3, network and OpenSSL disabled. The separately bundled decoder
remains ffmpeg-static; its version need not equal the helper library version.

The verified cache key covers source checksum, configure options, compiler,
architecture, minimum OS, helper source/flags and build recipe. Verified cached
outputs work offline; a missing or invalid cache requires the pinned archive.
The cache is build-only and must not appear in runtime load paths.

Packages include `resources/licenses/meeting-resampler`: `COPYING.LGPLv2.1`,
`NOTICE.txt`, the exact source archive, `meeting-resampler.c`,
`build-meeting-resampler.cts`, `build.json` and `BUILDING.md`. These supply the
license, corresponding source and reproducible build/relink instructions.
`@loader_path` links load the sibling dylibs from `resources/bin`. Inspect every
helper/dylib with `otool -L`, including transitive dependencies; reject absolute
Homebrew and build-cache paths.

Build with `pnpm run build:mac:arm64:local`, then discover the exact `.app` under
`dist/` and run `codesign --verify --deep --strict APP_PATH`. Inspect effective
helper entitlements with `codesign -d --entitlements :- HELPER_PATH`. Do not weaken
hardened runtime to make loading succeed. Launch that exact bundle with an owned
`--user-data-dir` outside the checkout. Do not install over the production app.

With user-approved macOS permissions, record a short mic/system sample, Stop,
prepare locally, play, export and cancel without a paid provider request. Record
listening and hardware results separately from synthetic timing. A local
self-signed package with notarization disabled does not qualify a public release.
Exercise Developer ID signing/notarization when credentials are available;
otherwise record that public-release verification is unavailable.
