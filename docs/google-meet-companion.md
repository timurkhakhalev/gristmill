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
recording/binding status. Cached storage carries identifiers only. Reconnect
clears Connected and all old-port authority. Extension updates are deferred until
an authoritative idle snapshot; missing app/host stays visibly disconnected.

Messages carry bounded call context, participants, activity, mute/leave and clock
probes. They never carry audio, Note contents, transcripts, model credentials or
profile secrets. Optional transport failure must not stop ordinary recording.
Real Chrome/Meet and packaged-app verification remain required separately from
protocol, subprocess and synthetic DOM tests.
