# Product overview

## What Gristmill is

Gristmill is a meeting recorder and note-taking app for macOS on Apple Silicon.
It does not add a bot to the call.
During a call, it records your microphone and the system audio on your Mac as two separate tracks.
After you stop the recording, it transcribes the audio with the provider that you selected, finds the speakers and writes a Summary in the meeting note.
You can then read, correct, search and ask questions about your meetings.

Gristmill has no server of its own. Recordings, transcripts, notes, settings and history stay on your Mac.
AI providers receive only the audio or text that Gristmill sends with your own API key, or nothing when you use models on your Mac.

## The problem

Meeting assistants can write good notes, but they often lose the most important thing: the conversation itself.
If the system audio stops during a network or device change, and the app did not keep the original recording, you cannot recover the meeting or process it again.
Cloud processing is useful, but the recording must not depend on a stable connection.
You must be able to change Wi-Fi, a hotspot or a VPN during a call without loss of either side of the conversation.

## Who it is for

A technical person who:

- joins calls from a Mac and does not want a visible bot in the meeting;
- uses their own cloud provider keys, models on the Mac, or self-hosted models;
- needs a correct final result more than a live transcript;
- wants control of the recordings and the possibility to process them again;
- wants to change prompts and integrations;
- often speaks Russian in meetings, as well as English.

## Principles

1. **Audio first.** The original audio is the source of truth.
2. **Recording works offline.** A recording never depends on a transcription or AI connection.
3. **No silent loss.** A missing or interrupted track is always visible and stays recorded as a gap.
4. **Each result is replaceable.** You can process a recording again with a different provider. Earlier results stay.
5. **Separate tracks stay separate.** Gristmill does not mix your microphone and the system audio into one internal file.
6. **Process after Stop.** There is no live transcript. Transcription starts only after the audio is saved. If the network fails, the audio stays for a retry.
7. **You own your data.** You can export and delete audio, transcripts and notes.
8. **No invented identities.** Calendar participants are hints. A speaker name needs evidence or your confirmation.

## What you can do

| Area      | What the user does                                     | Journey                                                         |
| --------- | ------------------------------------------------------ | --------------------------------------------------------------- |
| Start     | Set up permissions, a provider and calendars           | [First launch](user-journeys/onboarding.md)                     |
| Start     | See upcoming meetings and recent notes                 | [Home and navigation](user-journeys/home.md)                    |
| Record    | Record a call without a bot                            | [Record a meeting](user-journeys/recording.md)                  |
| Record    | Link a Google Meet or Telemost call in Chrome          | [Browser calls](user-journeys/companion.md)                     |
| Record    | Transcribe audio files and links                       | [Import audio](user-journeys/upload.md)                         |
| Results   | Read the transcript and Summary, listen, process again | [Recording results](user-journeys/meeting-results.md)           |
| Results   | Give speakers their correct names                      | [Correct speakers](user-journeys/speakers.md)                   |
| Notes     | Write notes, use folders, search                       | [Notes and folders](user-journeys/notes.md)                     |
| Notes     | Keep a Markdown copy of notes on disk                  | [Note files](user-journeys/note-files.md)                       |
| AI        | Ask questions about one note or all notes              | [AI conversations](user-journeys/chat.md)                       |
| AI        | Change the Summary, Follow-up and Recap prompts        | [AI Actions](user-journeys/actions.md)                          |
| AI        | Select a model for each task                           | [Choose processing routes](user-journeys/providers.md)          |
| AI        | Teach special words and keep reusable text             | [Dictionary and Snippets](user-journeys/dictionary-snippets.md) |
| Connect   | Connect Google, Microsoft or Apple calendars           | [Connect calendars](user-journeys/calendars.md)                 |
| Connect   | Read notes from the terminal                           | [Gristmill CLI](user-journeys/gristmill-cli.md)                 |
| Configure | Change all settings                                    | [Settings](user-journeys/settings.md)                           |

## Guarantees

Gristmill must keep these promises. Each change that touches recording or processing must keep them true.

1. A change of Wi-Fi, a hotspot or a VPN during a meeting does not interrupt either track.
2. A provider outage keeps the meeting saved and ready for a retry.
3. A missing system audio track shows a warning that stays, and the meeting is marked as incomplete.
4. After a crash, the audio that was saved before the crash is recoverable.
5. You can process a poor transcript again with a different provider. The original recording does not change.
6. After a failed Summary, the audio and the transcript stay. You can make the Summary again on its own.
7. A speaker correction changes what you see. It does not change the original provider result.
8. Each transcript line can be traced to a part of the recording and to the processing run that made it.
9. A recording starts without a network connection or a loaded transcription model. No transcription runs during the recording.
10. Stop saves all recorded audio before processing starts.

Hardware checks for the recording guarantees need an isolated profile and real devices. See [quality steering](../steerings/quality.md).

## Not in the product

These are deliberate decisions. To change one, write a new [ADR](../adr/index.md).

- No bot in the call, no live transcript, no draft during the recording.
- No account, no Gristmill server, no sync, no sharing, no teams, no billing, no enterprise controls.
- No dictation, no paste at the cursor, no global voice assistant.
- No web search in the chat, no YouTube import, no semantic search across meetings.
- No public web sharing and no plugin marketplace.
- macOS on Apple Silicon only.
- The local HTTP bridge is internal. It is not a public API.

Gristmill started from a one-time import of OpenWhispr ([ADR-0001](../adr/0001-openwhispr-one-time-import.md)).
The cleanup removed the OpenWhispr surfaces above ([ADR-0002](../adr/0002-cleanup-scope.md)). The removed code is in the baseline commit `49cd2b3`. Do not bring it back through hidden flags, commented-out code or legacy directories.
The Note is the root of the product. Home is a start view and does not replace Notes.
