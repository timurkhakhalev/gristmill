> Research archive: `scripts/prototypes/` was removed on 2 October 2026.
> The commands below are historical; the findings and recorded results remain.

# Companion #125: clock and microphone lifecycle spike

Measured on 2026-10-01, 08:07 UTC, from main baseline `138df7620`.
This spike checks feasibility before implementing the Companion protocol.
It does not implement Google Meet integration or change production capture.
The raw measurements are in [companion-risk-probe-results.json](companion-risk-probe-results.json).

## Clock round trip

The path was Headless Chrome 154.0.0.0 `performance.now()` → localhost HTTP
relay → Swift stdin/stdout → `mach_absolute_time()`. The Swift helper uses
the same timebase conversion as `resources/macos-audio-tap.swift`; it does not
open an audio tap or a microphone. The browser sends a nonce and records send
and receive times; the helper records receive and send host timestamps.

For browser times b0/b3 and native times h1/h2, the offset interval is
`[h2 - b3, h1 - b0]`. Half its width is the conservative uncertainty of a
midpoint estimate, assuming equal clock rate during this short exchange.
That bound covers transport asymmetry; the midpoint alone is not an accurate
source timestamp. It does not cover audio converter or Meet indicator delay.

| Round | Samples | Minimum uncertainty | P95 uncertainty | Maximum uncertainty |
| --- | ---: | ---: | ---: | ---: |
| Initial | 40 | 0.149 ms | 0.599 ms | 4.055 ms |
| Relay delayed by 80 ms before native receipt | 8 | 41.145 ms | 43.133 ms | 43.133 ms |
| Browser `Date.now()` advanced by one hour | 8 | 0.597 ms | 1.343 ms | 1.343 ms |
| After a ten-second wait | 40 | 0.248 ms | 0.796 ms | 2.438 ms |

All 96 intervals had a common offset range, width 0.298 ms, over 10.753 s.
The diagnostic wall-clock substitution did not affect monotonic sync.
An illustrative 5 ms uncertainty budget admitted all 88 ordinary samples
and none of the eight delayed samples. This budget is a spike diagnostic,
not an approved production threshold. Short observations do not establish
long-term rate/drift or behavior across machine sleep, document replacement,
hidden tabs, PiP, Native Messaging, or capture-helper queue delays.

Conclusion: explicit synchronization is feasible on this host. Production
must include uncertainty and sync generation in evidence, periodically refresh
offset/rate, and reject stale or uncertain mapping. Run the same measurement
through the packaged Native Messaging/capture-helper path before choosing the
actual policy; validate mapping against persisted audio anchors.

## Microphone lifecycle

The browser created independent synthetic 220 Hz system and 440/660 Hz mic
MediaStreams at 24 kHz. It used the actual PCM AudioWorklet source extracted
from `meetingRecordingStore.ts`, following the existing processor test.
Audio was routed through zero-gain sinks, without playing sound or acquiring
hardware. The probe has its own graph and immediate acknowledgments: it does
not exercise the store's IPC write queue or the native system audio tap.

The sequence was capture → flush mic and stop its track → keep system
running for 570 ms → create a new mic stream/processor → flush both.

- First mic: 12,928 frames, including a final partial packet of 928 frames.
- During mic gate: zero new mic frames; system delivered 14,400 frames,
  including nonzero tone samples. The mic track was `ended`.
- Restarted mic: 13,568 frames, including a final partial packet of 1,568 frames.
- System: 40,192 frames, including a final partial packet of 1,792 frames.
- Packet sequences/sample offsets remained contiguous within each processor.
  The audio context was closed after cleanup.

The existing recovery controller can be stopped before retiring the mic
stream. Two added regression cases verify that a pending mute-grace timer
and an unavailable-device retry cannot reacquire it after `stop()`.
Existing tests also cover late acquisition cleanup, microphone replacement
without stopping the recording, source epochs, raw-audio recovery, safe Stop,
and clock-anchor ownership.

## Required changes confirmed by inspection

1. `meetingRecordingStore.ts` currently computes a new mic epoch's offset from
   `Date.now()` and the saved UTC origin. Calling its actual offset helper with
   an unmute two seconds after origin returns 48,000 frames. Moving wall time
   forward one hour yields 86,448,000 frames; moving it backward yields zero.
   Bind unmute to the recording's audio timeline, not diagnostic UTC. A system
   wall-clock jump was not made during this experiment.
2. `MeetingCaptureSession` treats source restarts as `source-restarted` and a
   missing mic epoch as `source-unavailable`; finalization marks these recordings
   incomplete. Intentional mute needs its own durable intervals/epoch reason,
   separate from failed capture and recovery. Preserve error detection for
   genuine unavailability and missing system audio.
3. Provider routes preparing separate mic/system WAVs currently require usable
   epochs for each source. An entirely muted mic needs an explicit intentional
   empty-source path through prepare/ASR/normalize, preserving timeline silence
   and the system transcript. Do not disguise it as successful provider output.
4. The current native helper has no clock-request channel; a probe command must
   be added to the actual helper and integrated with its PCM/clock lifecycle.

The graph-level gate is feasible. Coordinator commands, manual mute priority,
binding freshness, persistence, restart recovery and precise unmute placement
remain implementation work. Real microphone/system hardware behavior, final
packetized transport and live Meet indicator timing remain unverified.

## Verification and reproduction

Root ran the following focused selection after adding the two recovery tests:

```sh
pnpm test -- --verbose test/helpers/activeMicRecovery.test.ts test/helpers/meetingCaptureRecovery.test.ts test/helpers/meetingAudioTimeline.test.ts test/helpers/meetingAudioParts.test.ts test/cases/recording/unit/zoomSpeakerMatcher.test.ts test/cases/recording/integration/zoomSpeakerEvidence.test.ts test/cases/recording/integration/meetingMicrophoneSelection.test.ts test/stores/meetingRecordingStoreAutoEndStop.test.ts test/cases/recording/unit/meetingPcmProcessor.test.ts
```

Result: 56 passed, zero failed/cancelled/skipped, 4.503 s runner wall time.
`pnpm run typecheck:tests`, scoped ESLint, `node --check` for the relay, and
`git diff --check` passed. The Swift clock helper compiled with `swiftc`.
No full suite or application/package build was run: production code did not
change. No real Gristmill or Chrome profile, Notes data, native host
registration, provider request, or live meeting was used.

Reproduce the browser spike on macOS with Xcode command-line tools installed:

```sh
mkdir -p /tmp/gristmill-125-risk
swiftc scripts/prototypes/companion-host-clock.swift -o /tmp/gristmill-125-risk/host-clock
node scripts/prototypes/companion-risk-probe.mjs /tmp/gristmill-125-risk/host-clock
```

Open the printed localhost URL in an isolated Chrome profile and click
**Run probes**. The page and relay stdout contain the report and all clock
samples. Use Ctrl-C to stop the relay and its owned clock helper. The HTTP
relay is a local experiment, not the Companion transport implementation.
