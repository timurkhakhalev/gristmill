# Recording results

As a Gristmill user, I want to review the audio, the transcript and the Summary of a meeting, and to process it again when necessary.

## Entry points

- **Gristmill app → open meeting note → Notes / Summary** — your notes and the Summary.
- **Gristmill app → open meeting note → Transcript/Audio popover** — the audio parts and the transcript.

## Paths

### Read the result after a meeting

1. Open the note after Stop. During processing, the note shows the stage: preparing audio, transcribing, saving the transcript, writing the Summary. You can write notes during this time.
2. When processing completes, read the Summary.
3. Open the Transcript/Audio popover. It opens on Audio first. Switch to the transcript to read who said what.
4. Click **Copy** to copy the transcript.

### Listen to a part of the meeting

1. Open the Transcript/Audio popover on Audio.
2. Each Start/Stop group is a part. The newest group is first. Pause and Resume make smaller parts inside a group, in time order.
3. Click **Play audio** and drag the position to seek.
4. In the transcript, click a timestamp. Playback starts at that line.

### Make a Summary for a short meeting

1. Gristmill does not make a Summary automatically when a meeting is shorter than three minutes or the transcript is short. The note shows **Automatic Summary skipped**.
2. Click **Summary**. Gristmill makes the Summary from the ready transcript.

### Transcribe again or make a new Summary

1. If the note has no Summary, click **Transcribe & Summary**. If it has a Summary, use **Transcribe** and **Summary** separately.
2. Gristmill uses the provider and the model from Settings. There is no provider picker here.
3. Gristmill makes a new result. The earlier results stay saved.

### Cancel processing

1. While processing waits or runs, click **Cancel processing**.
2. The note shows **The recording is saved. You can transcribe it later.**
3. Start the transcription again later.

### Fix a failed or blocked run

1. If a run fails, the note shows the failed stage and **Your audio is saved.** Check the connection and the API key, then click **Retry**.
2. If a run waits for settings, click **Open settings**, select a provider or a model, then click **Retry with current settings**.

### Work with one audio part

1. Open the menu of an audio part.
2. Click **New transcription** to transcribe only this part.
3. Click **Export mixed MP3** to save the part as one audio file.
4. Click **Delete audio** and confirm to delete the original audio of the part. If the deletion fails, click **Retry audio deletion**.

## BDD acceptance criteria

- Given processing waits or runs, when I cancel it, then the saved audio stays available.
- Given the meeting is too short for an automatic Summary, when transcription completes, then Gristmill shows a notice and I can still make a Summary.
- Given I click a transcript timestamp, when playback starts, then it starts at that line.
- Given a run failed, when I click **Retry**, then Gristmill uses the saved audio again.

## Related documents

- [Recording and processing](../../architecture/recording-processing.md) — runs, results panel rules, retention and deletion.
- [Post-Stop processing](../../architecture/post-stop-processing.md) — pipeline and Summary thresholds.
- [Correct speakers](speakers.md) — speaker names in the transcript.
