# Recording results

As a Gristmill user, I want to review audio, transcript and Summary and retry processing.

## User journey

1. Open a note with recordings.
2. Read Notes or Summary, or open the Transcript/Audio popover.
3. Play and seek an audio part, or click a transcript timestamp.
4. Use processing controls to transcribe, make Summary, cancel or retry.
5. Use an audio part menu to transcribe that part, export its mixed audio or delete it with confirmation.

## Behavior and limits

- Results are inside the Note editor. Start/Stop groups appear newest first; Pause/Resume parts within a group appear in time order.
- The popover initially opens on Audio. Play and export require available audio. New ASR also waits for capture/processing restrictions and the saved post-Stop deadline.
- The note-wide action processes available ready/incomplete parts in time order. Without a saved Summary it offers Transcribe & Summary; with one, Transcribe and Summary are separate.
- Provider/model choices come from Settings; Results has no per-launch provider picker.
- Cancel processing is available for pending/running work, including the post-Stop wait, and keeps audio. Failed or blocked runs can be retried; missing configuration has Settings and Update run settings actions.
- Automatic Summary requires both 180 seconds and 2,500 transcript characters. A short-transcript notice explains the skip; manual Summary remains available for a ready transcript.
- Results appends transcript segments in batches of 60; already shown rows remain in the DOM. The separate fallback MeetingTranscriptChat uses row virtualization.
- Runs are persisted, but Results has no user control to select a previous completed version.
- Copy transcript is available. File export as Markdown/text/JSON/SRT exists in backend without a UI control.
- Audio export covers the selected part mixed audio. There is no original-track picker or whole-meeting export control here.

## What to check

- Cancel retains audio for later processing.
- Timestamp playback starts at the selected segment.
- Short transcripts can still receive a manual Summary.

## BDD acceptance criteria

- Given processing is pending or running, when I cancel it, then saved audio remains available.
- Given automatic Summary thresholds are not met, when transcription completes, then Summary is skipped with a notice and can be requested manually.

## Entry points

- [MeetingResultsPanel.tsx](../../../src/components/notes/MeetingResultsPanel.tsx) — results and processing controls.
- [NoteEditor.tsx](../../../src/components/notes/NoteEditor.tsx) — results placement.
- [meetingProcessing.ts](../../../src/helpers/meetingProcessing.ts) — processing and cancellation.
- [MeetingTranscriptChat.tsx](../../../src/components/notes/MeetingTranscriptChat.tsx) — fallback transcript display.
