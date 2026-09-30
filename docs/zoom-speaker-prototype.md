# Zoom speaker attribution prototype (#122)

This is a research checkpoint from 30 September 2026, not an implemented naming
feature. The application capture, database, processing and packaging paths are
unchanged. No speaker assignments have been applied.

## Probes

`scripts/prototypes/zoom-speaker-probe.swift` reads Zoom's AX windows and their
direct `Video render` children. It parses the known English status suffix from
the right, preserving commas in display names. Unknown suffixes are rejected.
It records bounded polling reads, read start/end on `mach_absolute_time`,
window mode, explicit activity, subscriptions, delivered events and AX instance
retirement. It does not focus or change Zoom's windows. A compact-window tile
without an explicit marker is not counted as an active speaker.

The instance keys belong only to one probe run. They are not participant IDs or
Zoom meeting IDs. Disappearing AX objects are retired; names are not used to
merge objects. This probe does not establish continuity across calls or identify
the local participant.

`scripts/prototypes/prepare-audio-clock-probe.py` makes an instrumented temporary
copy of `resources/macos-audio-tap.swift`, failing if the expected edit sites
have changed. The copy reports input/IO/callback timestamps, conversion counts,
converter priming information and RMS. It discards converted PCM and stops
after 15 seconds. It does not produce an audio recording or modify the bundled
helper. Both probes use existing native platform APIs and no new dependencies.

The generator's `--capture-log /tmp/.../clock` mode instead preserves normal PCM
output and the application's Stop lifetime. It writes metadata to a separate
`clock.<pid>.jsonl` for each helper process. A write failure disables metadata
logging and reports a warning without stopping capture. This mode is used only
for a temporary replacement of the Dev bundle's tap; retain the original binary
and restore it after the tap exits. Never replace the production helper.

Compile and run outside the application build:

```sh
mkdir -p /tmp/gristmill-122-prototype
xcrun swiftc scripts/prototypes/zoom-speaker-probe.swift \
  -o /tmp/gristmill-122-prototype/zoom-speaker-probe
/tmp/gristmill-122-prototype/zoom-speaker-probe --self-test
/tmp/gristmill-122-prototype/zoom-speaker-probe --seconds 90 --interval 0.5 \
  > /tmp/gristmill-122-prototype/zoom.jsonl
python3 scripts/prototypes/prepare-audio-clock-probe.py \
  /tmp/gristmill-122-prototype/audio-clock-probe.swift
xcrun swiftc /tmp/gristmill-122-prototype/audio-clock-probe.swift \
  -o /tmp/gristmill-122-prototype/audio-clock-probe
/tmp/gristmill-122-prototype/audio-clock-probe \
  > /tmp/gristmill-122-prototype/audio-stdout.bin \
  2> /tmp/gristmill-122-prototype/audio-clock.jsonl
```

Live AX logs contain display names: keep them outside Git. The audio stdout file
must remain empty. To measure the common clock, run the timing-only tap during a
bounded AX observation; convert audio host ticks to nanoseconds using its emitted
timebase. This does not by itself measure Zoom's delay relative to speech.

## Live results

The current real Zoom call was observed without clicking, changing its layout,
or sending anything to participants. Layout changes happened during observation.
The probes ran from Codex, not as helpers launched by installed Gristmill.

| AX observation | Reads | Single explicit activity | Median read | p95 read | Process CPU, one core |
| --- | ---: | ---: | ---: | ---: | ---: |
| Screen share, 60 seconds | 120 | 115 | 2.27 ms | 3.40 ms | 0.30% |
| Following window changes, 90 seconds | 180 | 169 | 2.85 ms | 11.66 ms | 0.40% |
| Gallery with disconnected/telephone tiles, 20 seconds | 40 | 40 | 8.06 ms | 9.38 ms | 0.53% |

The first 60-second attempt was excluded: the probe incorrectly treated a
childless unrelated window as incomplete. The corrected probe treats AX
`noValue` / `attributeUnsupported` children as absent; other read errors remain
explicit. The two reported runs had no unavailable reads. Missing activity is
still unknown, never the previous active name.

Observed facts:

- Explicit activity remained available during parts of screen share. Screen
  share cannot be classified as uniformly supported or unsupported.
- The 90-second run saw two distinct active display names; 164 active reads had
  the camera off. Four active AX instance keys did **not** mean four people:
  one display name appeared under three successive AX objects.
- The inspected video tile attribute lists contained no `AXIdentifier`.
- Four notification subscriptions were accepted. The 90-second run delivered
  55 application `AXValueChanged` and 86 destruction events, but no tile value,
  title or layout events. Two changes into/out of unknown activity had no event
  between adjacent reads. Event delivery alone does not provide reliable activity
  coverage; global events also include unrelated UI changes.
- Polling at 2 Hz was a measurement setting for these short runs. It is not a
  production frequency or a validated sampling policy. Reads are not independent
  evidence examples; repeated reads of one speech turn do not establish identity.

Timing-only audio observations:

- One run emitted 1,476 converted callback observations. Input flags were `7`
  (sample time, host time and rate scalar valid). Input sample/host timestamps
  increased throughout the run. Source rate was 48 kHz, target rate 24 kHz.
- Callback time minus input capture time: median 32.17 ms, p95 32.29 ms in that
  run. The IO `inNow` time was about 32 ms after input time too. These are capture
  timing differences, **not** the measured delay of the Zoom activity indicator.
- A 512-frame source buffer normally produced 256 target frames; the first
  produced 248. A timestamp-to-converted-frame mapping must account for startup
  conversion behavior instead of assuming every buffer halves exactly.
  A third run reproduced this while `AVAudioConverter.primeInfo` reported zero
  leading/trailing frames. That property alone is not an established correction
  for the observed short first buffer.
- A second timing run overlapped AX observation: 32 complete AX read intervals
  fell within the audio host-clock range. This confirms a common clock is
  available; it does not prove that an AX observation identifies an ASR segment.
- All three runs produced zero bytes on audio stdout. No PCM recording was retained.

## Verification and remaining work

Both Swift probes compiled. The AX probe's nine parser checks passed, covering
commas, inactive/muted states, unknown suffixes, missing fields and empty names.
The resumed live attempt exposed `Telephone muted` and `No audio connected`;
these known suffixes were added alongside `Telephone unmuted`. Disconnected
audio has a null mute state. Its first 120-second AX run is excluded from the
measurements because the earlier parser rejected these states. After the parser
change, all 40 reads in the following 20-second run were complete and had one
explicit active speaker.
At the initial standalone checkpoint, application tests/build/package/install
had not been run. The later authorized Dev rebuild is documented below.

The existing packaged Gristmill Dev initially waited in
`SecKeychainFindGenericPassword`. After the user entered the password, its UI
opened. Two attempts on a new test Note (ID 13) stopped immediately with
`CHECK constraint failed: encoding = 'opus'`. Read-only inspection confirmed
that the packaged `database.js` inserts `pcm_s16le`, while the Dev database
schema requires `opus`. Both attempts persisted as incomplete with
`recording-audio-unavailable`; neither is a usable synchronization recording.
A Dev-only rebuild was requested because #122 requires separate authorization
before rebuilding the app. Production Gristmill was not used for recording
and its process was left alone.

## Authorized Dev rebuild and capture

Timur authorized the Dev rebuild. `pnpm run pack:dev` completed successfully,
including native compilation, main TypeScript build, development renderer build,
and packaging validation of bundled binaries/SQLite. The new archive inserts
`opus`. The user handled the new Keychain prompt after rebuilding.

The temporary timing tap was compiled with the usual optimized arm64/macOS 14.2
target and placed only in the Dev bundle. Its original binary was retained.
A new Note was used so earlier failed parts could not contaminate the timeline:

- Dev Note: `14`, title `Zoom AX prototype #122 — capture timing`.
- Recording: `4c0f43d3-9b14-440e-afec-ee2c74b1f516`.
- Capture: `2026-09-30T18:50:16.430Z` through `18:53:18.272Z` (181.842 seconds).
- Both source epochs are `finalized` Opus; recording is `ready`, no capture error.
- Mic: start frame 54,120; 4,309,248 saved frames.
- System: start frame 8,136; 4,356,088 saved frames.
- The same system tap's 17,016 callback records contain **exactly 4,356,088**
  converted frames. Thus its journal covers the actual persisted system audio,
  rather than an independently started tap.
- The original helper was restored after the tap exited, with SHA-256 verified:
  `3c8f99eecbffab96822e2c9c5f3b430f3a6c79f9db1cb351448fd770735d9eff`.

The selected Deepgram `nova-3` reprocess run
`3a0f1940-5232-494e-aed4-294c9a954e3c` completed and saved transcript/Summary.
The optional action-item extraction showed a model-response format error;
its error did not remove the saved Summary. That stage was not repaired in this
AX prototype.
The transcript has 42 segments, including 38 system segments and one remote
cluster (`system:Speaker 1`). No `platform` corrections were written.

`scripts/prototypes/analyze-zoom-capture.py` converts the helper's host ticks to
nanoseconds, validates contiguous converted offsets and maps AX read times to
the system epoch's position in the same WAV timeline. It rejects extrapolation
through missing capture intervals, ignores mic segments and counts overlapping
ASR IDs as ambiguous. Its output identifies AX instances, without display names.

```sh
python3 scripts/prototypes/analyze-zoom-capture.py --self-test
python3 scripts/prototypes/analyze-zoom-capture.py \
  /tmp/gristmill-122-prototype/dev-capture-ax-v2.jsonl \
  /tmp/gristmill-122-prototype/dev-capture-clock-v2.jsonl.87786.jsonl \
  "$HOME/Library/Application Support/Gristmill-development/meeting-results/3a0f1940-5232-494e-aed4-294c9a954e3c/transcript.json" \
  --epoch-start-frame 8136
```

Of 360 AX reads, 344 mapped inside the tap's captured time range. At zero trial
offset, 287 coincided with system speech across 35 transcript segments; 57 were
outside system speech. All matched the same AX instance and the same ASR cluster.
This demonstrates why an explicit Zoom marker still needs an audio speech check.

The analyzer also sweeps trial offsets from -1 to +1 seconds. This sample retained
one cluster throughout, so the sweep cannot identify Zoom's indicator latency.
Repeated reads from one speaker are not independent identity confirmations.
Neither this run nor its 287 coincidences proves multi-speaker naming accuracy,
participant continuity or a production acceptance threshold. Converter startup
timing also remains uncalibrated even though total saved frame counts match.

Final prototype checks: nine Swift parser assertions and thirteen Python analysis
assertions passed; the Python scripts passed compilation. Both generator modes
compiled as Swift. The application was rebuilt and exercised live; its full test
suite was not run because no application source was changed for this spike.

## Synthetic multi-speaker replay

The analyzer's `--self-test` now replays alternating remote clusters, simultaneous
speech, an absent capture-clock interval, unknown activity, a recreated tile,
muted/disconnected tiles, mic-only speech and a late remote cluster. It also
rejects an inconsistent observation containing multiple active tiles despite its
`usableExplicit` flag. These cases require no additional call participants.
At zero trial offset the replay yields five expected instance/cluster
coincidences, one ambiguous overlap and one interval without remote speech.
No name or accepted identity is inferred from these counts.

The real recording establishes capture/AX/ASR clock pairing; synthetic replay
checks the analyzer's matching and rejection behavior. Neither establishes live
Zoom indicator delay or a naming acceptance threshold. Finding a group of test
speakers is not required to continue building the collector and persistence
paths. Automatic name acceptance must still reflect these unknowns.

Remaining measurements and implementation checks:

1. Measure Zoom indicator delay against known alternating speech using Dev
   recordings; inspect overlap, short answers and late participant coverage.
2. Validate converter timing/priming and transport pairing with exact 24 kHz
   frame positions. Preserve capture audio when timing metadata is unavailable.
3. Establish safe session identity and participant continuity despite recreated
   AX tiles; test duplicate display names and renaming. Never merge by name alone.
4. Check compact window, Pin/Spotlight, fully hidden Zoom and localized statuses.
5. Verify Pause/Resume and restart clocks using the same part offsets as
   `composeMeetingAudioParts()`; persist observations and reasons for rejection.
6. Verify installed Dev helper TCC attribution, permission revocation and audio
   independence. Access inherited by a Codex probe does not prove app access.
7. Only then choose example spacing, uncertainty margins and assignment thresholds
   from measurements, and integrate `platform` corrections before model naming.
