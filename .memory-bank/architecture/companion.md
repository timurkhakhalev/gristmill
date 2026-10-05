# Gristmill Companion (browser extension)

Gristmill Companion is the browser extension for Gristmill.
It connects one call tab to a local recording.
It is different from the Google Meet Companion mode.

- Adapters: Google Meet (this document) and [Telemost](companion-telemost.md). Other call services will use the same extension.
- Supported browser channel: Chrome Stable.
- Chrome Web Store identity and publication are separate work.
- Speaker matching: [speaker evidence](speaker-evidence.md).
- User-facing behavior: [product Companion page](../product/companion.md).

## Builds and app channels

`pnpm run build:companion` makes two unpacked extensions:

| Folder                | Name and look                                            | Connects to                                                                                         |
| --------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `build/companion-dev` | Gristmill Companion (Dev), dark and gold icon, DEV label | `pnpm dev` or the packaged Gristmill Dev app                                                        |
| `build/companion`     | Gristmill Companion, cream and green icon                | The production Gristmill app. Its popup has no diagnostics section and no diagnostic rendering code |

- Load the related folder unpacked from `chrome://extensions`. Both extensions can be installed at the same time.
- Each extension has its own pinned public key and extension ID in `extension/identity.json`, its own native host, launcher and app-profile socket.
- No private signing key is stored or shipped. These are local unpacked identities, not verified Web Store items.
- Dev extension ID: `dpnegebmhlbkdeahjmefpfohabdihohc`.
- Dev native host: `com.khakhalev.gristmill.companion.dev`.
- Production native host: `com.khakhalev.gristmill.companion`.

### Native host registration

- The app packages the built extension and the compiled native-host entry.
- Its managed shell launcher uses the bundled Electron runtime with `ELECTRON_RUN_AS_NODE=1`, the absolute host script, the selected app profile and the channel.
- The registration goes under `NativeMessagingHosts` in the Chrome Stable user-data root, one time for all Chrome profiles.
- Tests use a temporary root. They never change the real browser registration.
- Foreign files and symlinks are not overwritten.
- When the integration is enabled, startup restores a missing registration or launcher and refreshes the paths after an app update.
- A registration that belongs to a different profile does not change.
- When the user disables the integration, the registration and the saved enabled preference are removed.

### Channels

- Chrome has one registration for each host name. When you enable the integration in an app, only the channel of that app is registered.
- Settings has one integration switch. The one-time unpacked extension installation is in an expandable setup section.
- The floating recording indicator is a separate setting.
- Both apps can run at the same time. An extension never tries the other channel when its app is not available.
- In the Dev channel, `pnpm dev` and the packaged Dev app use the same development profile.
- The selected app must stay running to serve its socket.

### Popup

- The compact popup shows recording guidance, the supported functions and the exact app connection.
- The Dev popup has a Diagnostics disclosure (closed by default) for tab, binding and microphone state.
- The production popup has no diagnostic controls.

## Trust and lifecycle

### Desktop IPC

`contracts/meetingCoordinator.ts` owns desktop channel names and the required
Companion methods on `MeetingCoordinatorApi`. `contracts/companion.ts` owns
setup, status, selection, reminder and mute payload schemas. The meeting bridge
validates results and events and returns an unsubscribe function for each listener.
An unavailable extension is represented by setup/status, not an absent API method.
Setup registration stays with host installation in `IPCHandlers`; recording-scoped
commands stay with the coordinator and retain sender and current-session checks.
These desktop operations do not change the browser/native wire protocol.

### Protocol

- Browser-to-native and host-to-app messages use versioned strict schemas.
- Frames use a four-byte little-endian length with a 64 KiB application limit. The limit is examined before allocation.
- Partial headers and payloads are supported.
- Malformed data, a version mismatch, a sequence replay or too much buffered output closes the connection.
- Native stdout contains only protocol frames.

### Authentication

- The host validates the extension-origin argument from Chrome.
- Then it authenticates to an independent app-profile Unix socket. It uses a credential in a private directory (0700) and file (0600).
- This credential is not related to the Notes CLI or BB. It is never sent to the extension.
- The socket directory has an app-profile hash and owner-only permissions.
- Main gives each authenticated connection a new ID.
- Different Chrome profiles can have the same tab IDs or call URLs. Thus extension installation IDs and tab IDs alone never authorize recording actions.

### Message sources

- The worker accepts content messages only from the top-frame Google Meet document of the extension itself.
- It gets the tab, document and call identity from the Chrome sender. It does not accept these fields from the page.
- Main keeps the snapshots of the recording and binding status.
- The Chrome document ID is the original 32-digit hexadecimal token. It does not change for document-scoped replies. It is not a hyphenated UUID.
- Cached storage contains only identifiers.
- A reconnect clears Connected and all authority of the old port.
- Extension updates wait until an authoritative idle snapshot. A missing app or host stays visibly disconnected.

### Message content

- Messages contain bounded call context, participants, activity, mute and Leave events and clock probes.
- They never contain audio, Note contents, transcripts, model credentials or profile secrets.
- An optional transport failure must not stop ordinary recording.
- Real Chrome and Google Meet verification is necessary in addition to protocol, subprocess, packaged-app and synthetic DOM tests.

## Recording behavior

### Binding

- At an independent Start, exactly one new recognized call can bind automatically.
- If a call appears later, or if there are several calls, the user selects **Link** in the recording Note.
- The selection is examined again against the current recording, connection, tab, document and call.
- Browser profiles and Google Meet Companion-mode tabs are different candidates.
- A replacement document in the same selected tab and call starts a new evidence generation. Retired documents cannot send Leave or mute.
- A room change without a positive Leave keeps the recording. When the call identity changes, a new selection is necessary.

### Mute

- A bound session stops heuristic auto-end until that capture session ends. This includes connection loss and an explicit disable of the integration.
- A recognized mute controls the microphone gate. Unknown UI never opens the gate.
- During mute, the microphone stays open and counts frames. Discarded PCM is not transferred or encoded. The system audio continues.
- Manual mute is available in the Note and in the recording pill. It stays through Pause, Resume and Restart. An independent Start resets it.
- Device mute and Google Meet mute cannot cancel each other.
- The extension popup shows connection and context health. It can change the manual mute of its own active bound recording.
- Main examines the recording and the binding again. Then it sends the request to the same capture gate that the desktop controls use.

### Leave and Stop

- Only a positively observed Leave followed by the exit screen requests a scoped safe Stop.
- A successful finalization uses the 30-second Restart card and the processing gate again.
- Restart makes a new recording part. Only a new former call can bind again.
- Without Restart, the recording is independent, and the ordinary auto-end and restart grace apply.
- To join again later needs a confirmation.
- A tab close, a browser failure, hidden UI and missing selectors never mean Leave.
- After five continuous minutes without context, Gristmill shows one reminder with a manual, recording-scoped Stop action.

## Google Meet adapter and evidence limits

### DOM contract

- `extension/src/meetAdapter.ts` is adapter version 1.
- Sanitized Russian and English DOM fixtures are in `test/fixtures/meet/v1`. An isolated Electron renderer tests the actual DOM API against them.
- These fixtures are adapter contract fixtures. They do not prove that the current production Google UI still has each selector.
- The adapter reads participant IDs (`data-participant-id`) and names from tiles and `span.notranslate`. Controls, tooltips and icon text are excluded.
- Colored borders, outlines and narrow activity bars give activity hints.
- Local effects and reframe tools and mirrored video identify local tiles. An English "(you)" match is not necessary.
- Ambiguous names, hidden indicators, focused outlines and control-button decorations cannot make an accepted activity observation.
- All simultaneous active IDs are kept.
- These visual hints need a measured indicator delay and multi-speaker verification. They do not prove voice identity.

### Controls

- The semantic icon tokens `call_end`, `mic` and `mic_off` in `i.google-symbols` identify the Leave and microphone controls.
- `data-is-muted` gives the state.
- Generated `jsname` and class IDs do not identify these controls now.
- The exit screen still needs the observed internal `h1[jsname="r4nke"]` together with the rejoin `button[jsname="W6suGc"]`. That screen has no semantic rejoin attribute.
- These two version-dependent markers are a positive exit check. The adapter does not interpret their absence as Leave.
- Translated labels never decide presence, mute, mode or confirmed Leave.
- The separate `data-is-muted` of the camera is excluded.
- Missing or conflicting technical controls stay unknown. They never authorize Stop or unmute.
- Unknown UI is reported explicitly.
- The extension does not change the layout and does not open PiP.
- An already open document PiP is read together with the main document.

### Popup and reload

- The popup shows the new browser observation of the active tab separately from the authoritative recording, binding and microphone gate of the app.
- For an unbound recording, the popup says that Google Meet mute and Leave have no effect. It tells the user to use Link in the Note.
- When the app disconnects, browser observations stay as explanations. They cannot authorize recording controls.
- An extension reload makes the old content observer and timer invalid and disposes them. Reload the Google Meet page to load the new script.

### Clock probes

- Browser performance-clock probes go to the real native audio helper. They return nonce-correlated samples with four timestamps.
- Only the bound document probes the helper.
- Shared clock fitting needs bounded uncertainty. Adjacent continued observations cover only their calibrated range.
- These conditions prevent a name assignment: a gap, a changed generation, several active participants, duplicate names or insufficient speech.
- Native audio anchors stay independent of Zoom Accessibility failures.
- Platform evidence failures never stop raw capture.

## Verification that needs the real environment

- These need live checks: production Google Meet DOM and indicator accuracy, built-in, wired and Bluetooth microphones, push-to-talk, sleep and wake, and system device changes.
- Measure the speech-onset loss at unmute and report the result. AC4 has no numeric pass or fail threshold.
- Synthetic fixtures and clock and Worklet tests do not prove real hardware quality.
- Production extension ID and store validation are separate work.
