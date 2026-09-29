# Cleanup implementation log

Date: 2026-09-14. Branch: `codex/cleanup-openhercules`.
PR: https://github.com/timurkhakhalev/gristmill/pull/6

The agreed scope is [removal-plan.md](removal-plan.md). Baseline `49cd2b3`
preserves the imported code; removed features can be retrieved from Git,
not from hidden runtime switches or a legacy directory.

## Milestones

| Milestone | Integrated result |
| --- | --- |
| M0 | Product decisions, provider/tool inventory and ownership recorded. pnpm 10.19 lockfile and integrator-only sequential tests/build/install rules established. |
| M1 | Independent Gristmill app/protocol/profile/keychain/cache identity. No old-profile migration or upstream updater. Commit `8635dfd`. |
| M2 | Removed OW auth, account, subscription/paywall, managed policy, cloud sync/sharing/team and hosted service UI/runtime. Local storage requires no account. |
| M3 | Kept direct BYOK/Local/supported Self-Hosted inference, including direct AWS/Azure/Vertex credentials. Removed managed OW inference/catalog routes. Existing realtime/provider error paths remain. |
| M4 | Removed dictation/paste/translation, standalone assistant, screen/selection capture, old windows and native paste/text-monitor helpers. Meeting hotkey, tray, notifications and recording pill remain. |
| M5 | Kept embedded note chat/history and local note/folder/calendar/clipboard/vocabulary tools. Removed web_search, semantic retrieval and Qdrant. Search uses local text. Dictionary/Snippets management remains. |
| M6 | Kept file/direct HTTPS media imports; YouTube is rejected without yt-dlp. Apple calendar remains; Google/Microsoft show not-configured until own OAuth is supplied. |
| M7 | Integrated main/IPC/preload/types, local schema, Notes-first navigation and onboarding. Removed Home/Insights; restored meeting/audio event bridges, settings, window drag and note-tree drop targets. M2–M6: `fd975e9`; initial M7: `075427e`. |
| M8 | macOS arm64 packaging/downloads/dependencies/assets only. Removed foreign-platform and removed-product resources. pnpm CI, manual-only paid canaries, MIT/import attribution in the package. Final integration/runtime fixes: `47cec65`. |
| M9 | Automated verification and isolated packaged smoke; results and limits below. Final integration performed by the root agent without further delegation. |

## Important integration fixes

- Renderer/preload contract tests cover every live `electronAPI` reference and the retained meeting event bridge.
- Main-process helpers are now explicitly included in ESLint (they were excluded by both configs). Restored upload-cancellation and provider-connection imports exposed by packaged startup.
- Composite Zustand selectors use shallow equality in notes/onboarding/settings to avoid React update loops. Smoke verifies rendered UI and caught React errors, not just successful IPC replies.
- Note-tree drag targets, hover expansion, selected state, keyboard navigation and RTL behavior restored after removing team-space UI.
- Hotkeys, microphone selection, system permissions, launch-at-login, start minimized, local debug logging, meeting layout and provider configuration remain available.
- Privacy no longer shows dictation retention controls as though they delete meeting notes/audio. Existing realtime temporary-audio limitations are stated explicitly; no new destructive note retention was added.
- Redirect responses in native downloads are drained and their timers disabled, fixing a downloader process that remained alive after completion.
- Node tests replace SQLite's binary without updating electron-rebuild's marker. Packaging now forces a sequential rebuild and runs an in-memory SQLite query using the packaged Electron executable. An ABI mismatch fails packaging before DMG/ZIP creation.
- The old lockfile-lint parser does not support pnpm. The PR job instead installs the frozen pnpm lockfile, verifies package integrity during installation, and runs lint/typecheck/i18n/audit/tests. Paid provider canaries have no schedule and require explicit manual dispatch.
- Moved the imported npm overrides to `pnpm.overrides`; otherwise the security pins were silently ignored. The audit now has no high/critical issues. One upstream moderate adm-zip symlink-extraction advisory remains visible (no patched release in the advisory); it is pulled by onnxruntime-node's installer.

## Verification

| Check | Result |
| --- | --- |
| Full Node/tsx suite, concurrency 1 | 2385 passed, 0 failed, 0 skipped/todo; 125.0 s, after pnpm overrides and runtime fixes. |
| Native rebuild regression | Included in the final suite; the packaged-runtime guard also passed. |
| Typecheck | Passed. |
| Lint | 0 errors; 43 newly visible existing unused-variable warnings in main helpers, plus 2 React Fast Refresh warnings in icon primitives. |
| i18n keys/placeholders | Passed for all locales. |
| Dependency audit | 0 high/critical; 1 acknowledged upstream moderate installer advisory, not suppressed. |
| Renderer production build | Passed; existing large-chunk warning. |
| Native arm64 prebuild | Passed: capture/listeners, Whisper/llama/sherpa, AEC, VAD/diarization assets. |
| Packaged SQLite ABI guard | Passed against Electron 41.10.5, ABI 145. |
| DMG/ZIP | Passed, unsigned macOS arm64 installers rebuilt after all runtime fixes. |
| Isolated packaged runtime smoke | Passed: startup, Notes default, notes onboarding completion, blank note/folder/edit, local search, chat persistence, Dictionary/Snippets, seeded AI Actions, Settings UI. Screenshots inspected; no caught React or unhandled renderer errors. |
| Package contents / network observation | MIT and upstream attribution included; no `.env`, Qdrant or updater package entries. No OpenWhispr endpoint in the isolated Chromium/Electron net log. |

The first packaged smoke failed on SQLite ABI 137 versus 145. That failure is
not counted as a pass; the forced rebuild and packaged-runtime guard address its cause.
Later startup checks exposed missing IPC imports and unstable Zustand selectors;
these were fixed and the complete package/smoke sequence repeated successfully.
The smoke harness now waits for the first document load before reloading it.

## Verification limits / next stage

- No real paid ASR/LLM calls or private meeting recordings were used. Provider routing, reconnect, stop/cancel, watchdog and speaker behavior are covered by automated tests, not a fresh hardware/provider end-to-end certification.
- Real microphone/system-audio permissions, device changes during a call, renderer loss with live capture, Apple calendar access and OAuth authorization still require a consented hands-on session. This cleanup does not claim new offline durability or recovery guarantees.
- Network observations from the packaged smoke cover Chromium/Electron net logging; they are not a complete OS trace of every possible future SDK/native/provider request.
- Builds are local and unsigned/not notarized. The optional macOS 26 Liquid Glass asset catalogue requires full Xcode; the existing `.icns` icon remains available without it.
- Batch capture, new ASR models, paid benchmarks and own Google/Microsoft OAuth registrations are separate work. The Note model is unchanged.
