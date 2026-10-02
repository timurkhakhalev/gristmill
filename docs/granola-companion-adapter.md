# Granola Companion adapter inspection — 2026-10-02

Reference: the user's installed Granola Companion 0.4.18, extension ID
`opaadbjlebbbnmjjgdmdllingedoleml`. Read the installed distribution's
`content-scripts/speaker-detection.js`, `content.js` and
`meeting-end-detection.js`; formatted copies were kept only in `/tmp`.
No Granola account, meeting history, credentials or native-host connection was
read. No vendor bundle or telemetry implementation is included in Gristmill.

## Observed behavior and adopted detection

| Surface | Granola 0.4.18 | Gristmill adapter |
| --- | --- | --- |
| Participant identity | `data-participant-id` | Same document-scoped tile identity |
| Name | `data-self-name`, tile aria-label, `span.notranslate`, descendant aria-labels, text walker | Explicit self-name and unambiguous `span.notranslate`, excluding controls, tooltips and icon text |
| Local tile | Mirrored video, effects/reframe icon tools, English `(you)`, cached IDs/names, sole-participant/count hints | Mirrored video and effects/reframe tools; no translated token or count/name inference |
| Activity | Colored border/outline at least 2 px, or a colored bar at most 10 px wide; visible tiles at least 50 × 50 px | Same visual approach, excluding hidden/transparent indicators, control decorations and focused outlines; preserve the whole active set |
| Mic | First `button[data-is-muted]`, then English microphone/aria-label logic | Semantic `mic`/`mic_off` icon plus `data-is-muted`; camera ignored, conflicting state unknown |
| Presence/end | English Leave button or participant tiles; sustained absence and page unload emit end | Semantic `call_end`; trusted Leave click followed by positive exit screen. Close/unload never requests Stop |
| PiP | Main and already-open document PiP scanned | Existing Gristmill document/PiP lifecycle retained |

Google Symbols icon ligatures are identifiers of the rendered icon, not translated
button labels. They still depend on Meet's rendering, but avoid opaque generated
IDs for mic and Leave. The exit screen has no equivalent semantic rejoin marker
in the inspected DOM; the two internal exit IDs remain explicitly version-dependent.

## Verification boundaries

The one-person live Chrome call confirmed icon markup, microphone/camera
separation, a name in `span.notranslate`, local effects tools with camera off,
and the positive exit structure. Isolated Electron DOM tests cover colored
rings/bars, overlap, noise/hidden/transparent/focus rejection, conflicting names,
local filtering, mic state conflicts and trusted versus unrequested exit.

This change replaces the old synthetic `data-participant-name`, `data-is-self`
and `data-is-speaking` assumptions. Visual indicator lag, pin/screen-share
ambiguity, remote speaker accuracy and final name attribution still require
multi-speaker live verification and timing measurements. No measured accuracy
or zero-loss audio claim is made here.
