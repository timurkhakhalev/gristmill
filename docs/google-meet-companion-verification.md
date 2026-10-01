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

- Localized Leave/mic/exit text determined the adapter's control state. The current
  adapter instead uses live-observed `jsname` controls and `data-is-muted`.
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
but did not expose the explicit name/self/speaking attributes consumed by the
current adapter. This check therefore does **not** establish working live speaker
name attribution; the current live name/activity extraction still needs work.

Follow-up verification: focused eight-file adapter/content/worker/popup/coordinator/
transport/evidence/UI selection passed; `pnpm run typecheck` passed; `pnpm run lint`
passed with 31 existing root-config warnings and three renderer warnings (no errors).
`pnpm test` passed all 427 files in 86.852 seconds. `pnpm run pack` passed, including
packaged SQLite verification, and that app plus its rebuilt extension were installed
for the live check. Reload invalidation cleanup has a dedicated content-script test.
