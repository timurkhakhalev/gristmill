# Gristmill Companion (user-facing behavior)

## Setup

1. Open Settings → Recording → Gristmill Companion.
2. Enable the integration. This installs the native host for the app channel in Chrome Stable.
3. Open the extension folder for the same channel.
4. Load the folder as an unpacked extension in `chrome://extensions`.

`pnpm run build:companion` makes two extensions: production and Dev.
They have different icons, IDs and native hosts.
The Dev extension connects only to Gristmill Dev (and `pnpm dev`).
The production extension connects only to Gristmill.
Only the Dev popup has technical diagnostics, behind a disclosure.
Chrome Web Store delivery is separate work.

## Behavior during a call

- At Start, Gristmill links one new call automatically.
- If Gristmill finds a call later, link it manually with the Link action in the recording Note.
- Manual microphone mute is available in the Note and in the recording pill. It works without the extension.
- Mute discards the microphone audio but keeps the device open. The system audio continues.
- A confirmed Leave stops the linked recording and offers Restart.
- If the browser connection stops, the recording continues. After five minutes, Gristmill shows a reminder.

Telemost support recognizes connected calls, local mute and the verified organizer Leave flow.
It collects visible participant and activity evidence for speaker suggestions.
This uses an initial timing estimate, not a measured value.

Technical design, trust model and limits: [Companion architecture](../architecture/companion.md), [Telemost adapter](../architecture/companion-telemost.md).
