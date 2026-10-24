# ADR-0010: Leave out epoch fragments that can never get clock alignment

Status: Accepted
Date: 2026-10-14
Decided by: Timur Khakhalev; pull request "Leave out uncalibratable epoch fragments"

## Context

Preparation for ASR uses only parts with proven alignment ([recording processing](../architecture/recording-processing.md#clock-alignment)). ADR-0008 also requires alignment of every nonempty track for mixed playback, mixed export, ASR and part composition.

A fresh Web Audio graph can move its render clock forward after the first quanta. The worklet then started a new epoch. The first epoch kept only 128 to 2400 frames (5 to 100 ms). The clock solver needs a probe span of 250 ms. Thus this short epoch can never get a segment. The full recording then became unusable, and processing failed with `audio-alignment-unavailable`, although all other epochs had full proven alignment.

## Decision

- An epoch is an uncalibratable fragment when all these conditions are true: it has frames, it has fewer than 6000 frames (250 ms at 24 kHz), it has a source generation, it has no timeline anchor and it has no alignment segment.
- `alignedAudioRanges` gives no ranges for a fragment. Mixed and source preparation leave it out. The original audio file and the epoch row do not change.
- A source that has audio only in fragments has no proven coverage. Processing omits that part with `audio-alignment-unavailable`, as before.
- An epoch that has segments but incomplete coverage, or an epoch of 250 ms or more without segments, still fails.
- Capture: before the first packet of a recording, a forward render-clock gap drops the unsent frames. The first epoch starts again after the gap. This does not apply after a mute or a later epoch.

## Alternatives considered

- Guess a position for the fragment from the next epoch. Rejected: no new alignment is guessed.
- Only the capture fix. Rejected: saved recordings with a fragment stay unusable.
- Leave out all unaligned epochs. Rejected: this can silently drop long audio.

## Consequences

- Preparation can lose a maximum of 250 ms of audio for each fragment. The ASR result does not include it.
- The startup clock gap of main (`meetingCaptureSession.ts`) stays for saved and older captures.
- Tests: `meetingAudioAlignmentPerformance`, `meetingResamplerMapping`, `meetingPcmProcessor`, `meetingSourceExportAlignment`.
