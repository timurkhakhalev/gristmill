# Record a meeting

As a Gristmill user, I want to record a call without a bot and get both sides of the conversation, even if my network or audio devices change.

## Entry points

- **Gristmill app → open note → Record** — record into the open note.
- **Meeting hotkey** (set in Settings → Recording) — start a meeting note from any app.
- **Gristmill meeting notification → Take notes / Join & transcribe** — a calendar reminder or a detected call.
- **Gristmill app → Home → Coming up → Join & transcribe / Take notes** — start from a calendar event.

## Paths

### Start a recording from a note

1. Open a note or make a new note.
2. Click **Record**. The note shows **Preparing local recording…**, then **Recording audio**.
3. Gristmill records your microphone and the system audio (the other people on the call) as two separate tracks on this Mac.
4. You can write notes in the note during the recording.

### Start a recording with the meeting hotkey

1. Press the meeting hotkey in any app.
2. If a calendar meeting is in progress now, Gristmill opens the note of that event and starts the recording.
3. If not, Gristmill makes a new meeting note and starts the recording.

### Start a recording from a notification

1. Gristmill shows a notification before a calendar meeting, or when it finds that you are in a call: **You're in a meeting. Want to take notes?**
2. Click **Join & transcribe** to open the meeting link and record, or **Take notes** to record only.
3. Close the notification to ignore it. Gristmill never starts a recording without your action.

### Watch the recording

1. Open **Recording details** in the note. You see the state of **Microphone** and **System audio**: **Capturing**, **Reconnecting** or **Unavailable**, and the output device.
2. When you leave the note, a small recording pill shows the duration. Click **Return to recording** to go back to the note.
3. If the microphone is not ready, the pill shows **Waiting for microphone**.
4. You can change Wi-Fi, a hotspot or a VPN during the call. The recording does not use the network.

### React to an audio warning

1. If the system audio has no sound, Gristmill shows **No meeting audio detected yet**. Check that the call audio plays on this Mac. For an in-person meeting, ignore it.
2. If the system audio stops for a short time, Gristmill shows **Meeting audio interrupted** and restarts the capture. The gap is recorded.
3. If the system audio stops completely, Gristmill shows **Meeting audio stopped**. Check the output device, or stop and start the recording again.
4. If nobody is heard for some minutes, Gristmill shows **Meeting audio has gone quiet**.

### Pause, resume and mute

1. Click **Pause recording**. The note shows **Paused**. Gristmill does not record during the pause.
2. Click **Resume recording** to continue. Each pause makes a new audio part in the same recording.
3. To mute your microphone in the recording, click **Mute microphone** in the note or in the pill. The system audio continues. Click **Unmute microphone** to continue.

### Stop the recording

1. Click **End call** in the note or in the pill, or click **Stop recording** in the tray menu.
2. The note shows **Saving audio tail…**, then **Audio recording saved**.
3. After a short wait, Gristmill transcribes the recording and makes a Summary. See [Recording results](meeting-results.md).
4. If you start the recording again in the same note, Gristmill adds a new recording group to the note.

### Continue after an automatic stop

1. Gristmill stops the recording automatically when the call ends: you left the call, the meeting app closed, no other app uses the microphone, or there is no audio.
2. Gristmill shows **Meeting recording ended** with the reason and a countdown.
3. Click **Restart recording** before the countdown ends to continue in the same note.

### Recover from a problem

1. If the recording cannot start, the note shows **Recording could not start**. Check the microphone and system audio permissions and try again.
2. If some audio parts were interrupted, the note shows **Some audio parts were interrupted**. Gristmill keeps the audio that it saved before the problem.
3. If Gristmill or the Mac stops during a recording, open Gristmill again. Gristmill recovers the saved audio of the unfinished meeting.
4. If you delete a note during its recording, Gristmill asks **Stop and delete this recording?** and stops the recording safely first.

## BDD acceptance criteria

- Given I record a call, when I change the network, then both tracks continue without a gap.
- Given the system audio stops, when Gristmill finds it, then I see a warning that stays visible.
- Given I click **End call**, when the audio is saved, then transcription starts only after the save.
- Given a notification appears, when I ignore it, then no recording starts.
- Given Gristmill crashed during a recording, when I open it again, then the saved audio of that meeting is available.

## Related documents

- [Product overview](../overview.md) — the product principles for capture.
- [Recording and processing](../../architecture/recording-processing.md) — capture, managed files and processing ownership.
- [Post-Stop processing](../../architecture/post-stop-processing.md) — what happens after Stop.
- [Browser calls](companion.md) — link a Google Meet or Telemost call to the recording.
