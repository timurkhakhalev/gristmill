# Google Meet integration verification — 2026-10-02

Implementation branch: `task-004-google-meet-companion`, targeting `develop`.
Production extension identity and Chrome Web Store release are excluded.

## Automated verification

- `pnpm test`: all 425 selected files passed, 79.700 seconds. The canonical runner
  used its normal two-process limit and sequential compiler/native phases.
- `pnpm run typecheck`: main, renderer, settings selectors, tests and extension passed.
- `pnpm run lint`: passed with three existing warnings and no errors.
- Focused protocol/worker/transport/coordinator/UI tests passed after adding popup
  manual mute. They reject page-origin commands, another profile's binding,
  changed recording IDs and disconnected state.
- `git diff --check`: passed.

Tests cover bounded framing, origin/ownership/sequence checks, migration rollback
and reopen, audio retention, alignment/continuity, mute frame boundaries,
Pause/Resume/Restart, scoped Stop, auto-end arbitration, stale documents/profiles,
late confirmation, unknown UI, context-loss reminder and speaker provenance.
RU/EN adapter fixtures run in an isolated Electron renderer. They are synthetic
contract fixtures, not snapshots proving today's production Meet selectors.

## Packaged runtime

`pnpm run pack` produced an unsigned local arm64 app. Smoke testing used an explicit
fresh temporary profile with fake Chromium microphone flags. No production Notes,
credentials or browser registration were used. Native host registration used the
profile's isolated `chrome-test` directory.

Verified in the packaged UI:

- Dev integration Enable and Remove registration, including the expected pinned
  extension origin and an existing bundled-runtime launcher.
- Real launcher/native-host subprocess handshake returned an authoritative idle
  snapshot and exited cleanly after stdin closed.
- Capture started without provider credentials using `Fake Default Audio Input`
  plus native system capture. The permission label initially said Not allowed,
  while actual native capture succeeded; this label is not used as capture proof.
- Manual mute in pill was reflected in Note. Pause/Resume retained manual mute;
  unmute resumed microphone capture. Both recording parts finalized `ready`, with
  no capture error. Each system epoch remained continuous through microphone mute.
- First part: microphone frames `[0, 378880)`, intentional mute
  `[378880, 1562368)`. Resumed part: intentional mute `[0, 357888)`, then microphone
  epoch starting at frame `357888`. These are source-frame coordinates, not inferred
  wall-clock positions. Persisted alignment segments covered the raw capture.
- Processing reached ASR and was honestly blocked by `api-key-missing`; no provider
  quality or transcription result is claimed.

## Packaged binding and Leave smoke

The final rebuilt app was also driven through its installed native-host launcher
with synthetic recognized Meet context (no real browser DOM). Verified:

- One fresh muted candidate auto-bound at Start and started with the microphone
  gate closed. Native snapshots reported the selected call and platform mute.
- Browser-protocol manual mute reached the renderer gate. Removing platform mute
  kept manual mute; clearing manual mute then opened the gate.
- Positive Leave finalized capture as saved and showed “You left Meet. Restart
  recording within … s.” Clicking Restart created a new recording ID without a
  binding while the synthetic call remained left.
- A later in-call update did not auto-bind or mute that restarted recording. The
  Note displayed the explicit Link confirmation. Clicking it applied binding and
  the current Meet mute. Manual Stop then finalized the restarted part.

This verifies packaged main/host/preload/renderer wiring, not Chrome content-script
installation or real Meet recognition.

## Still unverified

Live participant indicator/name accuracy, hidden-tab/PiP behavior and speech-onset
loss on actual devices remain unverified. Built-in, wired and Bluetooth/AirPods,
rapid push-to-talk, sleep/wake and device switching need the hardware matrix.
Onset loss is a measurement without a numerical pass/fail threshold; no zero-loss
claim follows from worklet or synthetic-microphone tests.

This report does not mark issue #125 or the hardware acceptance complete.

## Live Chrome controls and popup — 2026-10-02

The unpacked Dev extension was updated in the user's Chrome Stable profile. Its
native host points to the separately packaged `Gristmill Meet Dev.app`, using an
explicit `Gristmill Meet Dev` profile. The regular app/profile was not replaced.
The one-person test call used disabled Meet microphone and camera.

Two causes of the earlier unrecognized/unbound state were fixed:

- Localized Leave/mic/exit text determined the adapter's control state. That
  revision switched to live-observed `jsname` controls and `data-is-muted`;
  the later Granola follow-up below replaces mic/Leave IDs with semantic icons.
  Technical exit markers require a prior trusted Leave click; missing controls
  never imply Leave. Synthetic regression fixtures use arbitrary button/heading
  text and opposite camera/mic states.
- Chrome sends a 32-digit hexadecimal document token. The worker and shared
  protocol had incorrectly required a hyphenated UUID. The strict shared contract
  now accepts the actual token unchanged; worker and real native-host tests use
  Chrome-shaped IDs. Hyphenated UUIDs, zero tokens and foreign/top-frame failures
  remain rejected. Chromium's implementation is
  [ExtensionApiFrameIdMap::DocumentIdFromString](https://github.com/chromium/chromium/blob/main/extensions/browser/extension_api_frame_id_map.cc).

Observed through the installed browser/app path:

- Idle popup: Connected, In call, Meet microphone Muted, recording Stopped.
- Start in a separate test Note: automatic binding to the single fresh call;
  Note displayed Linked to Meet, with the microphone gate held by platform mute.
- Popup during capture: Recording · linked, Linked to this call, Meet microphone
  Muted, Recorded microphone Muted by platform. Local DOM detection and app-owned
  recording/binding/gate state are displayed separately.
- Clicking Leave reached the technical exit screen, ended capture and showed the
  saved recording's 15-second processing countdown. Without provider credentials,
  processing then waited for settings. No successful ASR result is claimed.

The live participant tiles had participant IDs and visible names in `span.notranslate`,
but did not expose the explicit name/self/speaking attributes consumed by that
revision's adapter. This check therefore did **not** establish working live speaker
name attribution; the extraction was subsequently replaced as described below.

Follow-up verification: focused eight-file adapter/content/worker/popup/coordinator/
transport/evidence/UI selection passed; `pnpm run typecheck` passed; `pnpm run lint`
passed with 31 existing root-config warnings and three renderer warnings (no errors).
`pnpm test` passed all 427 files in 86.852 seconds. `pnpm run pack` passed, including
packaged SQLite verification, and that app plus its rebuilt extension were installed
for the live check. Reload invalidation cleanup has a dedicated content-script test.

## Granola reference and adapter replacement — 2026-10-02

Inspected the installed Granola Companion 0.4.18 distribution. The adapter now
reads actual tile name markup and adopts its colored ring/bar activity approach,
with explicit exclusions for hidden indicators, focus outlines, button decoration
and local tiles. All active IDs remain available for conservative overlap rejection.
The old synthetic participant-name/self/speaking attributes have been removed.
Mic and Leave use live-observed semantic icon identifiers rather than generated
`jsname` values; only the two positive exit-screen markers remain version-dependent.
See [inspection details and limitations](granola-companion-adapter.md).

Focused verification: adapter DOM, content lifecycle, speaker evidence, coordinator
and worker — five files passed in 2.562 s. Companion/test typechecks and scoped
ESLint passed; `pnpm run build:companion` passed. This is a focused follow-up,
not a new full-suite or packaged-app pass. One-person Chrome inspection confirmed
the input markup, not remote speaker accuracy. The rebuilt unpacked extension
was reloaded by the user after the browser tool blocked opening Chrome's internal
extension-management page. Hardware/onset measurements and multi-speaker
attribution remain outstanding.

After Reload, the installed Dev popup was checked against a separate one-person
call with the real `pnpm dev` app running: Connected, Recording Stopped, In call,
Meet microphone Muted. Turning on only the microphone changed the popup to On
while the camera remained off. A trusted Leave click reached the exit screen and
changed the popup to Not in call. No recording or Note was created for this
follow-up, so it does not repeat the earlier binding/gate/Stop check. The test call
was left and its agent-created tab closed. Screenshot:
`/tmp/gristmill-granola-adapter-live.png`.

## Compact popup and separate channels — 2026-10-02

The popup now uses the existing Gristmill brand assets, compact recording guidance
and an explicit app-connection footer. Dev diagnostics are closed by default;
production HTML and JavaScript exclude the diagnostics section and renderer.
Both manifests carry native toolbar/action icons at 16/32/48/128 px and version
0.2.0. The existing Dev extension ID is unchanged. A separate pinned public key
provides a local unpacked production identity; this is not a Web Store item.

`build:companion` creates `build/companion-dev` and `build/companion`. Main selects
its channel using the existing app-channel resolver, registers only that native
host and reveals/packages its matching extension. Native launchers include the
channel; both the host and app socket reject an origin from the other channel.
Neither worker tries the other channel when its app is closed. Production and Dev
registrations can coexist, and removing one preserves the other.

Verification:

- Six focused popup/worker/installer/native-host/UI/locale files passed in 2.997 s.
- Full `pnpm test`: all 427 files passed, 84.706 s, normal sequential native/type
  phases. Full `pnpm run typecheck` and `pnpm run lint` passed (existing warnings).
- `pnpm run build:companion` passed for both channels. Emitted manifest keys,
  icons, exact host constants, absence of production diagnostics and both
  electron-builder resource mappings were inspected. No macOS package rebuild
  or Web Store installation is claimed for this change.
- CUA Chrome preview used the real built HTML/JS with a clearly labeled simulated
  desktop connection: both idle channels, Dev diagnostic disclosure, recording,
  manual mute, and disconnected production. Production has no diagnostic
  section; muted audio state changes without disturbing the closed disclosure.
  Screenshot: `/tmp/gristmill-companion-redesign.png`.
- The idle real `pnpm dev` app was quit and restarted through the project command.
  Native compilation/main build passed and startup refreshed the Dev launcher
  with the new channel argument. At the first installed-popup check, connection
  remained unavailable: the main-thread sample showed a synchronous macOS
  Keychain read waiting inside `SecKeychainFindGenericPassword`. The user was
  asked to handle the system prompt; the UI tool denies access to SecurityAgent.
  After the user handled that prompt, the installed popup showed Connected to
  Gristmill Dev with recording stopped. Dev diagnostics were checked closed by
  default, opened and closed again. Live screenshot:
  `/tmp/gristmill-companion-dev-installed.png`.
  Chrome still reported the loaded manifest as 0.1.0: its popup reads the rebuilt
  files and displays 0.2.0, but that does not confirm extension Reload. The new
  toolbar icon and loaded manifest version remain pending the user's Reload.
