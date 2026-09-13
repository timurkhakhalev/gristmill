# OpenHercules

OpenHercules is a local-first macOS meeting client that records microphone and system audio without joining the call as a bot. It keeps the original audio under the user's control, then runs replaceable cloud or local processing stages to produce a transcript, speaker labels, meeting notes, and a meeting-scoped chat.

The product is intended to use OpenWhispr as a one-time source for its Granola-like interface, macOS capture code, calendar integration, and selected provider adapters. OpenHercules is not planned as a long-lived rebrand that continuously merges all upstream OpenWhispr features.

## Core promise

The recording is the source of truth. A transcript, diarization result, summary, or chat index is a reproducible artifact that can be regenerated with another provider or model.

OpenHercules must never silently present a meeting as complete when one audio channel is missing or a processing stage handled only part of the recording.

## Product shape

- Capture microphone and system audio as separate durable tracks.
- Keep recording locally through network, VPN, and cloud-provider failures.
- Transcribe the completed recording with a selectable batch ASR provider.
- Diarize remote speakers when needed and let the user correct speaker identities.
- Generate notes automatically after the final transcript is ready.
- Ask questions about one meeting, with answers linked to transcript timestamps.
- Export or reprocess the original audio, transcript, and notes.
- Associate meetings with calendars, participants, categories, tags, and templates.

Realtime transcription is optional. Reliable post-meeting processing is the primary flow.

## Current status

OpenWhispr source has been imported as a baseline. The OpenHercules product cutover is planned in [the removal plan](docs/removal-plan.md).

## Documents

- [Product requirements](docs/product.md)
- [Target architecture](docs/architecture.md)
- [OpenWhispr cutover](docs/openwhispr-cutover.md)
- [Delivery plan](docs/delivery-plan.md)

## Working name

The project is named **OpenHercules**. Its core promise remains preserving original meeting audio and producing reproducible transcripts and notes.
