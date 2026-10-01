# Gristmill for Google Meet

This integration connects one Google Meet tab to a local recording. It is distinct
from Google's own Companion mode. Chrome Stable is the supported browser channel.
Production extension identity and Chrome Web Store verification are a separate task.

## Development build and identity

Run `pnpm run build:companion`, then load `build/companion-dev` unpacked from
`chrome://extensions`. The public manifest key is pinned in
`extension/identity.json`; no private signing key is stored or shipped.
Dev extension ID: `dpnegebmhlbkdeahjmefpfohabdihohc`.
Native host: `com.khakhalev.gristmill.companion.dev`.

The app packages the built extension and the compiled native-host entry. Its
managed shell launcher uses the bundled Electron runtime with
`ELECTRON_RUN_AS_NODE=1`, the absolute host script and the selected app profile.
The registration belongs under Chrome Stable's user-data root
`NativeMessagingHosts`, once for all its profiles. Tests use a temporary root;
they never change the real browser registration. Foreign files and symlinks are
not overwritten. Reinstall refreshes the owned launcher after app relocation.

## Trust and lifecycle

Browser/native and host/app messages are versioned strict schemas. Frames use a
four-byte little-endian length with a 64 KiB application limit, checked before
allocation. Partial headers and payloads are supported; malformed data, version
mismatch, sequence replay and excess buffered output close the connection.
Native stdout contains protocol frames only.

The host validates Chrome's extension-origin argument. It then authenticates to
an independent app-profile Unix socket using a credential stored in a private
0700 directory/0600 file. This credential is unrelated to Notes CLI and BB; it is
never sent to the extension. The socket directory has an app-profile hash and
owner-only permissions. Main assigns each authenticated connection a fresh ID.
Multiple Chrome profiles may have the same tab IDs or call URLs, so extension
installation IDs and tab IDs alone never authorize recording actions.

The worker accepts content messages only from the extension's own top-frame
Google Meet document. It derives tab, document and call identity from Chrome's
sender rather than accepting those fields from the page. Main snapshots own
recording/binding status. Chrome's document ID is the original 32-digit hexadecimal
token, kept unchanged for document-scoped replies; it is not a hyphenated UUID.
Cached storage carries identifiers only. Reconnect
clears Connected and all old-port authority. Extension updates are deferred until
an authoritative idle snapshot; missing app/host stays visibly disconnected.

Messages carry bounded call context, participants, activity, mute/leave and clock
probes. They never carry audio, Note contents, transcripts, model credentials or
profile secrets. Optional transport failure must not stop ordinary recording.
Real Chrome/Meet verification remains required separately from protocol,
subprocess, packaged-app and synthetic DOM tests.

## Recording behavior

At an independent Start, exactly one fresh recognized call can bind automatically.
If a call appears later, or several calls are present, the user chooses **Link**
in the recording Note. Selection is rechecked against the current recording,
connection, tab, document and call. Browser profiles and Meet Companion-mode tabs
are distinct candidates. A replacement document in the same selected tab/call
starts a new evidence generation; retired documents cannot send Leave or mute.
Changing rooms without positive Leave keeps recording and needs a fresh selection
when the call identity changes.

A bound session suppresses heuristic auto-end until that capture session ends,
including connection loss and explicit integration disable. Recognized mute
controls the microphone gate; unknown UI never opens it. The microphone stays
open and counts frames while muted; discarded PCM is neither transferred nor
encoded and system audio continues. Manual mute is available in the Note and
recording pill, survives Pause/Resume and Restart, and resets on independent Start.
Device mute and Meet mute cannot cancel each other. The extension popup shows
connection and context health, and can change manual mute for its own active bound
recording. Main rechecks the recording and binding before forwarding the request
to the same capture gate used by the desktop controls.

Only a positively observed Leave followed by the exit screen requests scoped safe
Stop. Successful finalization reuses the 30-second Restart card and processing
gate. Restart is a new recording part; only a fresh former call may rebind. Without
it, recording is independent and ordinary auto-end/restart grace applies. Later
rejoining requires confirmation. Tab close, browser failure, hidden UI and missing
selectors never imply Leave. Five continuous minutes without context show one
reminder with a manually chosen, recording-scoped Stop action.

## Adapter and evidence limits

`extension/src/meetAdapter.ts` is adapter version 1. Sanitized RU/EN DOM fixtures
live under `test/fixtures/meet/v1`; an isolated Electron renderer exercises the
actual DOM API against them. These are adapter contract fixtures, not evidence
that Google's current production UI still exposes every selector. A live Chrome
check on 2026-10-02 observed Leave `jsname="CQylAd"`, microphone `jsname="hw0c9"`
with `data-is-muted`, and the exit screen's `h1[jsname="r4nke"]` together with
rejoin `button[jsname="W6suGc"]`. The adapter uses these technical attributes;
translated labels never determine presence, mute, mode or confirmed Leave.
Camera's separate `data-is-muted` is excluded. Missing or conflicting technical
controls stay unknown and never authorize Stop or unmute. Unknown UI is reported
explicitly. No layout or PiP-opening actions are performed by the extension.
Already-open document PiP is read alongside the main document.

The popup distinguishes the active tab's fresh browser observation from the
app's authoritative recording, binding and microphone gate. An unbound recording
explicitly says that Meet mute and Leave have no effect and directs the user to
Link in its Note. Browser observations remain explanatory when the app disconnects;
they cannot authorize recording controls. Reload invalidates and disposes the old
content observer/timer; reload the Meet page to load the replacement script.

Browser performance-clock probes reach the real native audio helper and return
nonce-correlated four-timestamp samples. Only the bound document probes the
helper. Shared clock fitting requires bounded uncertainty; adjacent continued
observations cover only their calibrated range. A gap, changed generation,
multiple active participants, duplicate names or inadequate speech prevents a
name assignment. Native audio anchors remain independent of Zoom Accessibility
failure. Platform evidence failures never stop raw capture.

## Verification still requiring the real environment

Production Meet DOM/indicator accuracy, built-in/wired/Bluetooth microphone
behavior, push-to-talk, sleep/wake and system device changes need live checks.
Measure speech-onset loss on unmute and report the result; AC4 defines no numeric
pass/fail threshold. Synthetic fixtures and clock/worklet tests do not establish
real hardware quality. Production extension ID/store validation is a separate task.
