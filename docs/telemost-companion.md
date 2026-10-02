# Telemost Companion — 2026-10-02

Implementation started on `codex/telemost-companion`, based on `origin/main` at
`a88cc9c0b`. Both Companion channels support Telemost in the same extension.
The installed application has not been replaced by this work.

## Observed in real Chrome

The user completed entry after an initial loading failure and joined from a
second device. A connected two-person call, muted/unmuted local control, remote
speech, participant panel, grid and speaker view were inspected through CUA.
No chat messages, invitations or moderation actions were sent.

- Room paths: `/j/<14 digits>`, embedded `/private-join/<same room>`;
  settings temporarily use `/@/j/<room>`. Device/account query parameters are
  ignored and never sent to Gristmill.
- A same-origin `iframe[allowfullscreen]` contains the actual call. The root
  content script reads only the frame for its own room, using the root clock.
- Prejoin exposes `enter-conference-button`. Shell `call-widget-end` and
  `call-widget-audio` already exist before connection and cannot prove entry.
- Connected controls include `end-call-alt-button`, `share-button`, camera and
  mic controls in a common toolbar. The nearest bounded ancestor containing
  Share and Camera scopes local mic detection. Participant-list mic buttons use
  the same test IDs with inverted semantics and must be excluded.
- Local microphone: `turn-off-mic-button` means currently on;
  `turn-on-mic-button` means currently muted. Conflicting/missing controls give
  unknown. No localized labels or generated CSS class names are used.
- Video tiles under `[data-video-root="true"]` contain `span[title]` names.
  Mirrored video identifies local; other tiles keep self=unknown. No service
  participant ID was exposed; `data-g_track_*` were empty with cameras off.
- During remote speech the video overlay has a green `::after` border:
  `4px solid rgb(29, 204, 102)`. The speaker view renders the same person twice.
  A muted tile supplies no activity. CSS changes cause abstention.
- Organizer Leave opens a choice. The verified final **Leave this meeting**
  button is `end-call-button`. Clicking it returned to `/chats`, removed the
  iframe and call widget, and showed `#home-hub-page-title`. End for everyone
  was not selected. A second live entry under the other account verified that
  `end-call-alt-button` exits directly for a non-organizer, to the same home
  marker. For an organizer, seeing the confirmation cancels the opener intent.

## Behavior and boundaries

A recognized connected call can use the existing Start-only single-candidate
binding. A later call requires explicit Link. Existing scoped mute, manual mute,
Restart, clock mapping, microphone PCM gating and system capture are reused.
No second capture pipeline or chat notification system was introduced.

Confirmed Leave requires a trusted click on the observed final control, a
positive home transition within ten seconds and the same room/document scope.
Changing rooms cancels the pending action. Prejoin, lost iframe, network failure,
reload, hidden context or extension disconnect never imply Leave. The shell End flow is deliberately not accepted.

Participant IDs describe DOM video-node observations, not Telemost accounts or
voice identity. Replaced or renamed nodes get new observation IDs. Names and
avatars never merge people. Speaker-view copies with the same nonempty
`data-g_track_id`, name and local hint are collapsed within each snapshot.
Distinct or missing track IDs remain separate; duplicate names then suppress
activity. A live two-person call on 2026-10-02 exposed three video elements:
the main remote tile and its thumbnail shared one track ID. No participant
history was being accumulated. Roster completeness stays false; pagination is not traversed.
Hidden context is unreadable; PiP has not been verified.

Remote activity uses the common guarded matcher with an **initial 300 ms lag
hypothesis**, selected with the user, not a measured calibration. The existing
500 ms boundary guard, three independent speech episodes, full active-set checks,
clock coverage, overlap, local-name and duplicate-name rejection remain in force.
Google Meet and Zoom timing policies are unchanged.

### Client source inspection

Inspected the browser-loaded [Telemost bundle](https://telemost.yastatic.net/s3/telemost/_/main.ru.f7c12534af3d1ccd60d0.js)
through the read-only Chrome debugger. Offsets below are zero-based character
offsets in that exact minified revision; no source map was advertised.

- Around 2832344–2836972: remote `slot.vad` becomes `isVAD`; the overlay applies
  `rootStroke_Kb2PJ` when VAD is true and the audio track is unmuted. There is no
  explicit appearance timer in this render path.
- Around 4171338–4173344: `updateSlots` converts received DTOs; `slotsFromDto`
  carries `e.vad` through to the participant slot, then emits `slotsChanged`.
- Around 3794255 and 4194910: the separate local VAD filter defaults to probability
  0.8, five activation samples, ten samples to cancel pending deactivation, and a
  5000 ms deactivation debounce. Server hello can override that configuration.
  **5000 ms is not the remote frame's onset delay.**

A plausible working onset estimate is 200–500 ms; 300 ms is the chosen heuristic.
The client code does not establish server VAD timing or its offset from local
system-audio playback. No measured error bound or onset-loss claim is made.

Shared schemas, platform labels, binding/clock keys and speaker-correction SQL
accept Telemost. The SQL cutover copies existing data atomically, with rollback
and reopen coverage. Internal Meet IPC names stay unchanged without aliases.

## Verification

Before connected-call work: full typecheck and lint passed; `pnpm test` passed
428/428 selected files (88.444 s); both Companion outputs and renderer built.
Those results establish the shared groundwork, not live in-call integration.

Connected-call regressions use sanitized observed markup in
`test/fixtures/telemost/v1/`. An isolated Electron profile checks toolbar mic
scoping, participant/local hints, activity, duplicate speaker tiles, hidden and
unknown context, and positive Leave. These are fixtures, not a hardware test.

Installed Chrome extensions require Reload to load the newly built 0.3.0 code.
The browser tool previously blocked extension management; the user must perform
Reload. A real extension-to-isolated-app binding/mute/Leave run, microphone/system
recording verification and speaker timing measurement remain unverified. Current
Dev popup was offline during earlier inspection; no Keychain/security workaround
was attempted. Production and original OpenWhispr profiles must not be used for
smoke tests.

Final checks after connected-call implementation and the 300 ms policy:

- Full `pnpm run typecheck` passed; final content changes also passed Companion
  and test typechecks.
- Full `pnpm run lint` passed with 31 root and 3 renderer existing warnings;
  changed adapter/content/tests/build script passed focused ESLint.
- `pnpm test`: 428/428 files passed, zero failures, 81.792 s. Subsequent
  non-organizer Leave change passed both affected DOM/content files (1.582 s);
  the added confirmation-cancellation regression passed (0.305 s).
- Both `pnpm run build:companion` 0.3.0 outputs passed. Inspected manifest keys,
  distinct native hosts, icons, Telemost access and description bounds.
- `git diff --check` passed. No installed Reload or live app capture is claimed.
