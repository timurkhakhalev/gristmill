# Telemost Companion adapter

Both Companion channels support Telemost in the same extension (`extension/src/telemostAdapter.ts`).

- Shared builds, trust model and recording lifecycle: [Companion](companion.md).
- Matcher: [speaker evidence](speaker-evidence.md).

## DOM contract

These markers come from a live Chrome inspection of a connected call. Telemost can change them.

### Pages and frames

- Room paths: `/j/<14 digits>` and the embedded `/private-join/<same room>`. Settings use `/@/j/<room>` for a short time.
- Device and account query parameters are ignored. They are never sent to Gristmill.
- A same-origin `iframe[allowfullscreen]` contains the actual call. The root content script reads only the frame for its own room. It uses the root clock.

### Entry and controls

- Prejoin has `enter-conference-button`.
- The shell `call-widget-end` and `call-widget-audio` exist before the connection. They cannot prove entry.
- Connected controls include `end-call-alt-button`, `share-button`, and camera and microphone controls in a common toolbar.
- The nearest bounded ancestor that contains Share and Camera sets the scope of local microphone detection.
- Microphone buttons in the participant list use the same test IDs with inverted meaning. Exclude them.
- Local microphone: `turn-off-mic-button` means that the microphone is on. `turn-on-mic-button` means that it is muted.
- Conflicting or missing controls give unknown.
- The adapter does not use localized labels or generated CSS class names.

### Tiles and activity

- Video tiles under `[data-video-root="true"]` contain `span[title]` names.
- Mirrored video identifies the local tile. Other tiles keep self=unknown.
- Telemost did not show a service participant ID. `data-g_track_*` were empty when the cameras were off.
- During remote speech, the video overlay has a green `::after` border: `4px solid rgb(29, 204, 102)`.
- The speaker view shows the same person two times.
- A muted tile supplies no activity.
- CSS changes cause abstention.

### Leave

- For an organizer, Leave opens a choice. The verified final **Leave this meeting** button is `end-call-button`.
- A click on it went back to `/chats`, removed the iframe and the call widget, and showed `#home-hub-page-title`. "End for everyone" was not selected.
- A second live entry with the other account verified that `end-call-alt-button` exits directly for a non-organizer. It goes to the same home marker.
- For an organizer, the confirmation dialog cancels the intent of the first button.

## Behavior and boundaries

### Reused behavior

- A recognized connected call can use the existing Start-only single-candidate binding.
- A later call needs an explicit Link.
- The adapter uses the existing scoped mute, manual mute, Restart, clock mapping, microphone PCM gating and system capture.
- There is no second capture pipeline and no chat notification system.

### Confirmed Leave

A confirmed Leave needs all of these:

- A trusted click on the observed final control.
- A positive home transition within ten seconds.
- The same room and document scope.

- A room change cancels the pending action.
- Prejoin, a lost iframe, a network failure, a reload, a hidden context or an extension disconnect never mean Leave.
- The adapter deliberately does not accept the shell End flow.

### Participant identity

- Participant IDs describe DOM video-node observations. They are not Telemost accounts or voice identities.
- Replaced or renamed nodes get new observation IDs.
- Names and avatars never merge people.
- Speaker-view copies with the same non-empty `data-g_track_id`, name and local hint are collapsed in each snapshot.
- Different or missing track IDs stay separate. Then duplicate names suppress activity.
- The main remote tile and its thumbnail can have one track ID.
- The adapter does not accumulate participant history.
- Roster completeness stays false. The adapter does not go through pagination.
- A hidden context cannot be read. PiP is not verified.

### Timing policy

- Remote activity uses the common guarded matcher with an **initial 300 ms lag hypothesis**. It is not a measured calibration. A plausible onset is 200–500 ms.
- These rules stay in force: the 500 ms boundary guard, three independent speech episodes, full active-set checks, clock coverage, and overlap, local-name and duplicate-name rejection.
- The Google Meet and Zoom timing policies do not change.

### Client VAD facts

- The Telemost client shows the remote activity border when the server VAD flag is true and the audio track is not muted. The render path has no appearance timer.
- The local VAD filter has a 5000 ms deactivation debounce. **5000 ms is not the onset delay of the remote frame.**
- The client code does not show the server VAD timing or its offset from the local system audio playback.

## Verification boundaries

- Connected-call regressions use sanitized observed markup in `test/fixtures/telemost/v1/`.
- An isolated Electron profile tests toolbar microphone scope, participant and local hints, activity, duplicate speaker tiles, hidden and unknown context, and positive Leave.
- These are fixtures, not a hardware test.
- These are not verified: a real extension-to-isolated-app binding, mute and Leave run, microphone and system recording, and speaker timing measurement.
- Installed Chrome extensions need a Reload to load newly built code.
