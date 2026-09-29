# Plan: OpenHercules → Gristmill (rename + new images)

Status: code, images and docs renamed on branch task-003-rename-gristmill and merged into main. Remaining: see section 5 and docs/rename-migration.md.

## 0. Decisions needed first

| Item | Proposal |
|---|---|
| Product name (menu bar, Dock, "Quit …") | **`Gristmill`** (decided; wordmark/OG keep `Gristmill AI`) |
| Slug / env prefix | `gristmill`, `GRISTMILL_*` |
| Bundle id | **`com.khakhalev.gristmill`** (decided); dev: `com.khakhalev.gristmill.dev` |
| URL scheme | `gristmill://`, `gristmill-dev://` |
| Wake-word "Hercules" in `defaultTestInput` (11 locales) | **rename to "Gristmill"** (decided) |
| GitHub repo | `timurkhakhalev/gristmill` |
| Local folder | `[repository checkout]` |
| Support email | **`[contact via GitHub issues]`** (decided; replaces `[contact via GitHub issues]`) |

## 1. Pre-flight

1. Merge PR #113 (task-002) first; the rename touches ~190 files and will conflict with it. Rebase/close dependabot PRs #1, #4, #108–110 or let them rebase after.
2. Rename runs on its own branch `task-003-rename-gristmill`, one mechanical commit + one manual-fix commit.
3. Back up `~/Library/Application Support/OpenHercules` (2.5 GB, real meetings + models).

## 2. Code rename (scripted, case-preserving)

Scale: `OpenHercules` 91 files / 717 hits, `openhercules` 74 / 155, `OPENHERCULES` 29 / 70.
Exclude: `pnpm-lock.yaml`, `docs/openwhispr-upstream/**`, `CHANGELOG.md` (upstream history), `.tasks/**` history.

Mapping: `OpenHercules`→`Gristmill`, `openhercules`→`gristmill`, `OPENHERCULES`→`GRISTMILL`, `registerOpenHerculesProtocol`→`registerGristmillProtocol`, `openherculesChannel`→`gristmillChannel` (package.json `extraMetadata` + main.ts).

Hot spots:
- `package.json` name; `electron-builder.json` (appId, productName, protocols, dmg title, `CFBundleIconName`, 5 usage descriptions); `electron-builder.dev.cjs`.
- `main.ts` (`APP_NAME`, channel/userData, env vars), `windowConfig.ts` (`persist:openhercules`), `cliBridge.ts` (`~/.openhercules/cli-bridge.json`), `secretCrypto.ts` (`SERVICE`), export filenames `OpenHercules-*.webm`.
- 11 locale files × 48 hits each. `OpenHercules's` possessive in EN needs a wording fix. Non-Latin locales keep the Latin brand.
- Standalone `Hercules` as a voice-assistant wake word in `defaultTestInput` (11 locales) — decide: rename to "Gristmill" or drop (dictation/assistant is out of scope anyway).
- Tests: ~90 files with `openhercules-*` temp names; `macosIdentitySourceContract.test.ts` asserts `openhercules.icon` exists.
- Docs: README, AGENTS.md, TROUBLESHOOTING, `docs/*` (9), `.memory-bank/steerings/project-commands.md`, `scripts/*` (8, incl. `complete-uninstall.sh`, `launch-macos-electron.js`), Swift/plist native sources (4 files; change bundle ids there too).
- Also fix remaining `OpenWhispr` attributions only where wrong; keep MIT attribution (`LICENSE`, `docs/openwhispr-upstream/IMPORT.md`).
- Update `.github/` workflows/CONTRIBUTING if they reference the name/repo (CONTRIBUTING currently points at upstream OpenWhispr).

Verification (root orchestrator only, sequential): typecheck, lint, then per quality steering; the full test suite once after integration; `grep -ri hercules` returns only intentional leftovers.

## 3. Runtime identity — data-loss risks (do NOT skip)

The rename silently changes these; no compatibility shims per AGENTS.md, so migrate by hand once:

1. **Keychain service `"OpenHercules"`** (`secretCrypto.ts:7`): new name = old encrypted secrets (API keys) become undecryptable. Copy the keychain item to service `Gristmill` (`security find-generic-password` / `add-generic-password`) before first launch.
2. **userData** `~/Library/Application Support/OpenHercules[-development][-task-001-zoom-test]` → `mv` to `Gristmill…`. Includes DB, raw audio, models.
3. **Session partition** `persist:openhercules` lives in `userData/Partitions/openhercules` → rename folder to `gristmill` (else localStorage/settings in renderer reset).
4. **`~/.openhercules/`** (cli-bridge) → `~/.gristmill/`; BB integration docs mention it.
5. **macOS TCC**: new bundle id = microphone, system audio, calendar, accessibility prompts re-appear. Expected.
6. Env vars `OPENHERCULES_*` in your shell/`.env` files → `GRISTMILL_*`.
7. Installed `/Applications/OpenHercules.app` → remove after first Gristmill run.

Write a short `docs/rename-migration.md` with the exact commands (a doc, not code).

## 4. Images

| File | Action |
|---|---|
| `src/assets/icon.icns` | replace with `app/icon.icns` |
| `src/assets/openhercules.icon/` → `gristmill.icon/` | rename bundle; replace `Assets/ICON.png` (1024); change `icon.json` fill (currently blue gradient) to cream; update `compile-macos-icon.js`, `CFBundleIconName`, test. `Assets.car` is gitignored and regenerated |
| `src/assets/iconDev.icns` / `iconDev.png` | inverted colours (dark bg, cream G) — **done**: `app/iconDev.icns`, `app/iconDev.png` |
| `src/assets/iconTemplate@3x.png` (48px) | replace — **done**: `app/iconTemplate@3x.png` (48px) |
| `src/assets/iconDevMenubar@3x.png` (48px) | inverted coloured (non-template) — **done**: `app/iconDevMenubar@3x.png` |
| `src/assets/logo.svg` | new single-colour mark; `MeetingCompanion.tsx` draws it with `currentColor`, so needs a one-path mono version (not two-colour) |
| `onboarding-bg-light/dark.svg` | check colours vs. new palette |
| `onboarding-*.webp` (7) | inspect for OpenWhispr/OpenHercules branding; `onboarding-founder.webp` (photo of an upstream person) has zero references in code — just delete it |
| README banner, GitHub avatar, social preview (1280×640), OG | from `app/*`; social preview needs 1280×640 (I made 1200×630) |
| DMG | no background image configured; icon only |

All images generated. `logo.svg` → `app/logo.svg` (squircle, same role as the old file). `MeetingCompanion.tsx` has an inline `AppMark` (circle+bars, `currentColor`) → replace with `app/mark-mono.jsx.txt`. Icon Composer layer → `app/ICON.png` (full-bleed cream, opaque, like the old one); set `icon.json` fill to cream.

## 5. GitHub + local folder (last, after merge)

1. `gh repo rename gristmill` (old URL redirects; issue links in `.tasks` keep working).
2. `git remote set-url origin git@github.com:timurkhakhalev/gristmill.git`.
3. Update the repo description/topics; upload social preview and avatar (manual in Settings).
4. Rename the folder `openhercules` → `gristmill` **only after** all BB threads/agents are finished:
   - ~25 git worktrees (BB, Codex, `openhercules-15/-20/-21/-3a/-task-001`, `/tmp`) store absolute paths → `git worktree repair` from the new location; prune the dead ones first.
   - BB project registration path, and Claude memory/project dir (`~/.claude/projects/-Users-…-openhercules`) are keyed by path → re-register/move.
   - `pnpm install` not needed; `node_modules` moves with the folder, but native rebuild may be safer.
5. Keep `upstream` remote (OpenWhispr) unchanged.

## 6. Order of work

1. Decisions (§0) → 2. merge #113 → 3. generate missing images → 4. rename branch: code (§2) + images (§4) → 5. verify → 6. merge → 7. migration commands on your machine (§3) → 8. GitHub rename → 9. folder rename.

## Open risks
- Grist Labs name overlap (you decided to ignore it); trademark check still open.
- `Gristmill` bundle id/URL scheme cannot be changed later without repeating §3.
- I did not verify other Keychain/TCC consumers beyond `secretCrypto.ts`; grep again during implementation.
