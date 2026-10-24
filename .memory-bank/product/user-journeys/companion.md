# Browser calls

As a Gristmill user, I want Gristmill to follow my Google Meet or Yandex Telemost call in Chrome, so that mute, Leave and participant names go into the recording.

## Entry points

- **Gristmill app → Settings → Recording → Browser call integration** — set up the Chrome extension.
- **Chrome → Gristmill Companion extension** — connects the call tab to Gristmill.
- **Gristmill app → recording note → Link call** — select the call when several calls are open.

## Paths

### Install the extension

1. Open Settings → Recording and turn on **Browser call integration**. Gristmill registers its connection with Chrome Stable.
2. Click **Install Chrome extension**, then **Show folder to select**.
3. In Chrome, open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and select the folder.
4. Do this one time. An app update does not need a new installation.
5. Gristmill Dev uses its own extension. Each extension connects only to its own app.

### Record a browser call

1. Join a Google Meet or Telemost call in Chrome, before or after you start the recording.
2. Start the recording in Gristmill. When exactly one call is open in the call (not in the lobby), Gristmill links it to the recording automatically. The note shows **Linked to** and the call name.
3. During the call, Gristmill collects the visible participant names and who speaks. After Stop, it uses them to suggest speaker names.

### Link a call manually

1. If several calls are open, Gristmill does not select one. The note shows **Link** and the call names.
2. Click one and confirm. The mute and Leave of the call now affect this recording.

### Mute and leave

1. Mute the microphone in the call, or click **Mute microphone** in the note or the pill. Gristmill discards your microphone audio but keeps the system audio.
2. You can mute in Gristmill without the extension.
3. Click Leave in the call. Gristmill stops the linked recording and shows **You left the call. Restart recording within … s.**
4. Click **Restart recording** if you left by mistake.

### Continue when the connection stops

1. If Chrome or the extension disconnects, Gristmill shows **Connection to the call lost. Recording continues.**
2. The recording continues without the call controls. After five minutes, Gristmill reminds you about the recording.
3. If Gristmill does not recognize the call page, it shows **Call UI is not recognized. Recording continues.**

## BDD acceptance criteria

- Given the extension is installed and a call is open, when I start a recording, then the call is linked automatically.
- Given a recording started without a call, when I join exactly one call, then the call is linked automatically.
- Given several calls are open, when I record, then Gristmill links a call only after I select it.
- Given a linked call, when I click Leave, then the recording stops and I can restart it.
- Given the extension disconnects, when the call continues, then the recording continues.

## Related documents

- [Companion architecture](../../architecture/companion.md) — builds, channels, trust model and protocol.
- [Telemost adapter](../../architecture/companion-telemost.md) — Telemost limits.
- [Speaker evidence](../../architecture/speaker-evidence.md) — how participant names become speaker suggestions.
- [Record a meeting](recording.md) — the recording itself.
