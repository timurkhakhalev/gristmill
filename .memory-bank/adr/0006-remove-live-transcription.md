# ADR-0006: Remove unused live transcription and speaker recognition

Status: Accepted
Date: 2026-10-04
Decided by: Timur Khakhalev; issue #200

## Context

ADR-0003 moved transcription to after Stop. Realtime ASR clients, the live speaker identifier and microphone heuristics remained without an audio consumer. The Models switch suggested live identification, but it also disabled diarization in new Local processing snapshots.

## Decision

Remove the unused clients, live identifier, Models switch and its settings and IPC contract. Remove their tests, canary workflow and compiler entries. Keep the two silence thresholds used by capture monitoring. Remove the unused native AEC helper.

Enable diarization in all new Local recording snapshots. Keep explicit options in saved processing configurations. Do not rewrite historical recordings or runs.

Keep speaker management, contacts, shared voice profiles and manual corrections. Profile promotion uses the saved note embedding. Capture, mute and recovery continue through the persisted recording pipeline.

## Alternatives considered

- Keep the switch with a warning: this retains a setting that has no live audio consumer.
- Rename the switch to control Local processing: this retains a second mode that the user chose to remove.
- Restore live processing: this conflicts with ADR-0003 and adds an unsupported pipeline.

## Consequences

The Models page no longer offers live speaker recognition. New Local processing always requests diarization. Voice recognition and corrections use the post-Stop pipeline. A future live feature needs a new product decision and a working capture consumer.
