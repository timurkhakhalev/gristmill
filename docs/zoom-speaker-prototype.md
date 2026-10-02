# Zoom speaker attribution prototype (#122)

This document records the research checkpoint from 30 September 2026 and the
subsequent evidence-path implementation below. Production automatic Zoom names
remain disabled by missing calibrated evidence; no live assignment is claimed.

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
   from measurements, and enable accepted `platform` corrections in the
   already integrated path before model naming.

## Implemented evidence path

The branch now includes production display-name suggestions; the earlier
measurements above remain research results, not measured attribution accuracy.
`macos-meeting-ax --collect-zoom <recording UUID>` runs a read-only 2 Hz collector;
invoking the helper without that flag still performs the bounded call detector
snapshot. Collection reads all AX windows and direct Video render children,
parses camera-off/audio status from the right, and records transitions as
unconfirmed candidates. The second consistent read starts an explicit interval;
continued confirmation ranges follow every two polls. Switch, clear, Stop or
unknown availability closes the interval at the last confirmed read. All ranges
of one uninterrupted turn share one episode ID; a long turn supplies one example.
A poll gap over one second retires activity. These are collection guards, not
measured acceptance thresholds. Unrelated windows with no supported
children are ignored; genuine AX errors or wrong-shaped children remain incomplete. Names are private recording-owned metadata;
trees, names and transcripts do not enter diagnostic logs. Repeated reads of one
active episode do not increase the number of independent examples. New names,
late tiles and rename revisions continue to be discovered until Stop.

Unknown access, malformed tiles, ambiguous activity, window replacement and
process changes retire identities. Display names, PID and tile position are
never participant or meeting identifiers. Availability transitions are persisted
as unavailable observations. Compact/Pin/Spotlight candidates without an explicit
marker are never accepted. Coverage reports gaps without disabling the part's
usable intervals. Self is known only with explicit `(Me)`/`(You)` or Russian
`(я)` name suffixes; other names remain unknown self. No clicks, layout changes
or OCR occur. Simultaneous duplicate display names abstain. AX objects and names
remain evidence strings, not stable participant identities.

The audio helper keeps PCM stdout and emits sparse clock ranges on stderr with a
helper UUID, converted-frame start/end, host nanoseconds and timebase. A bounded
metadata queue runs separately from PCM writes. Every range binds to its actual
source epoch/startFrame and waits until those frames have been delivered. Clock
reorder never changes PCM order; unknown/unbound ranges cannot be extrapolated.
Startup shortening and the last pending PCM flush use the actual converted frame
count. Converter latency remains **uncalibrated**; reported priming data does not
establish its startup or tail alignment. Raw Opus tracks and the existing audio
watchdog remain authoritative. SQLite/AX/metadata failures affect evidence only.
The JSONL reader uses a streaming UTF-8 decoder; incomplete tails reject coverage.
Failed collectors terminate their owned helper and escalate within 500 ms even
while recording continues. Evidence capability is required at the composition
boundary; test doubles implement it explicitly.

`composeMeetingAudioParts` returns the same offset map consumed by ASR preparation
and the matcher. Internal gaps remain; deliberate pauses between parts disappear.
Matching runs on normalized system segments after voice recognition and before
model naming/Summary, including resumed normalization and new provider runs.
It never assigns `mic`, moves diarization boundaries, creates a voice profile,
invents email or carries Speaker N across runs. Per-run rejection/acceptance
records include observation/clock IDs, transcript intervals and the initial
timing policy with its origin. Accepted corrections and decisions share a guarded transaction.
SQLite migrates the correction source CHECK to include `platform` while preserving
old rows. Priority is user > voice > platform > model. Accepted platform names
have a Zoom provenance badge and reach LLM snapshots/prompts with that source.
Manual edits retain priority. Incomplete collection is visible in the transcript
view; it does not mark recorded audio or the transcript failed.

Production uses the fixed `zoom-activity-v1` policy. The 500 ms initial Zoom lag
is a hypothesis motivated by read-only static inspection of an installed client,
not our live latency measurement. We implement the matcher independently without
copying proprietary code. A 500 ms turn-boundary guard, one second of stable
speech, and three independent activity and speech episodes are conservative
product rules, not measured accuracy. Heartbeats or recreated tiles within one
continuous ASR speech bout cannot supply extra independent examples. Decisions
store the policy and evidence IDs without a fictitious measurement ID.
Earlier run decisions retain their original stored evidence and are migrated with
a null timing policy; the new heuristic is never claimed for historical results.

Intervals map through actual clock anchor ranges inside one finalized epoch.
Adjacent ranges require frame and host continuity; rate checks use 1 ms boundary
and 2 ms range-duration tolerances. The shared multipart map removes intentional
pauses. The matcher never extrapolates beyond startup/tail or across missing
clocks. Unknown spans reject intersecting ranges locally. It trims turn boundaries,
shifts by the lag hypothesis, then rejects mic overlap or competing system speech
and known self names. Several separate episodes must agree before naming the
whole run-local system cluster. Sequential tile recreation or Pause/Resume may
agree; simultaneous same-name tiles, conflicting names or one name mapping to
competing clusters abstain. Unknown self is allowed. Exclusive Zoom audio and
one person per tile are unavailable proofs and are no longer acceptance gates.
A Zoom label is an editable display-name suggestion, not a verified identity;
other system audio can still cause errors.

New synthetic fixtures use the actual native candidate/confirmation/continued/end
shape with unknown self, system-wide provenance and uncalibrated clocks. They
exercise production matching, atomic corrections, reprocessing and the shared
Note/CLI transcript reader. Their acceptance does not establish live accuracy.
Known-signal conversion, real indicator lag and multi-speaker accuracy remain open.

The audio probe generator has been reconciled with the new timestamp callback.
It suppresses production sparse clock events only in its generated temporary
probe, retaining the historical detailed probe format. Neither source helper,
existing app bundle nor running profile is modified by the generator.

## Working-label verification — 1 October 2026

Implementation used GPT-6.1 Sol with medium reasoning. Root reviewed the native
interval/self output, clock mapping, matcher aggregation, historical-decision
migration and production processing/Note/CLI consumers. The multipart fixture
initially failed because it tried to claim two concurrent runs; root corrected
its setup to complete each earlier run under the existing single-worker guard.
No outstanding defects were found in the final reviewed diff.

- Focused matcher, persistence, lifecycle and processing checks passed after the
  fixture correction. The production worker fixture assigns platform names,
  publishes the Note projection, exposes CLI provenance, and re-matches new IDs
  on another run. Provider-normalization fixtures cover Deepgram, ElevenLabs
  and Gemini. These are synthetic inputs, not provider network calls.
- `pnpm run lint` and `pnpm run typecheck` passed, including strict renderer and
  test programs; existing lint warnings remain.
- `pnpm test -- --verbose`: **2945 passed, 0 failed, 0 skipped**, 73,288 ms:
  2785 ordinary, 57 serial, 103 native/type checks.
- `pnpm run compile:meeting-ax` and the permission-free native collector self-test
  passed. `pnpm run pack:dev` passed, including bundled helper and packaged
  Electron SQLite validation. The Dev bundle is unsigned.
- An isolated packaged Dev profile received a synthetic Note via the actual
  production worker's resumed normalization path, without provider credentials
  or external requests. The UI showed `Synthetic Guest` and Zoom badges for the
  whole cluster. Editing the name in the UI updated all turns, removed the badge
  and changed CLI `name_source` from `platform` to `user`. JSON and plain-text
  CLI exports both used the assigned name. Reopening the app preserved it.
- A fresh 87.351-second hardware recording finalized as ready with no capture
  error. Mic/system Opus EOS and granules matched persisted frame counts
  (2,079,104 / 2,088,440). All 87 system clock anchors were saved; the last ended
  exactly at the saved system frame count. The quit sheet remained open more
  than eight seconds without stopping capture; Cancel continued recording and
  Stop and Quit saved it. No owned native helpers remained. Existing mic,
  system-audio and Accessibility grants worked without a password.
- Zoom had no active meeting. The collector recorded 175 reads and an unavailable
  observation with `no-call-window`; this did not affect audio readiness. The
  packaged native collector also exited cleanly after a bounded direct probe.
- A temporary timing probe mapped 899 native-shaped confirmation ranges over a
  synthetic 15-minute recording in about 350 ms. It is a spot measurement, not
  a performance guarantee for longer recordings.

**Still unverified:** live multi-speaker name accuracy and usable-example coverage,
self-suffix availability across Zoom versions/locales, actual converter/indicator
latency, hidden/screen-share/compact/Pin/Spotlight regimes and denied/revoked TCC.
Synthetic UI acceptance and successful audio capture do not establish these.

## Verified baseline before the working-label policy

Implementation was delegated to GPT-6.1 Sol with medium reasoning, then reviewed
and verified by the root agent. Review fixes cover model-name revisiting,
malformed timestamps, unrelated childless AX windows, UTF-8 chunk boundaries,
stable activity confirmation, metadata failures and bounded helper termination.
At that baseline the accepted path used synthetic measured-policy inputs and
production was rejection-only. The working-label policy above changes that
behavior; the checks below do not verify the new implementation.

- Focused matcher, persistence, collector lifecycle, clocks, multipart audio,
  processing, recovery, IPC, bridge and type-probe tests passed through
  `pnpm test`. Final `pnpm test -- --verbose`: 2,939 passed, zero failed,
  zero skipped, 77,988 ms (2,780 ordinary + 57 serial + 102 native/type tests).
- Final `pnpm run lint` and `pnpm run typecheck` passed, including renderer
  and test checks. Existing lint warnings remain.
- `pnpm run compile:meeting-ax`, the native
  `--self-test-zoom-collector` and `pnpm run compile:audio-tap` passed.
  Both temporary clock-probe modes compiled; the prototype parser passed 9
  checks and the analyzer passed 13, including synthetic multi-speaker replay.
- `pnpm run pack:dev` passed with bundled-helper and packaged SQLite checks.
  This is an unsigned Dev package; production was not installed or changed.

The packaged Dev runtime used an isolated, credential-free profile. Existing
microphone, system audio and Accessibility access worked without a separate AX
helper permission prompt. Zoom was running without an active call: evidence
reported `no-call-window` while both audio tracks continued. This establishes
that unavailable Zoom evidence does not break capture, not live attribution
accuracy or permission-revocation behavior.

Runtime review also found two existing quit hazards: main shutdown preempted the
capture confirmation, and a windowless macOS alert blocked capture IPC long
enough to overflow the mic queue. Shutdown now runs at `will-quit`, after the
existing `before-quit` guard. Capture joins bounded sidecar shutdown through
`requestSafeStop()`; the live control-panel confirmation is a window sheet.
The [Electron implementation](https://github.com/electron/electron/blob/v41.0.0/shell/browser/ui/message_box_mac.mm)
uses a blocking modal loop for windowless alerts.

The final runtime recording `7238aa58-32e4-4d45-94a5-b767a241219f` remained
active through more than 8 seconds in the quit sheet, Cancel, and another quit
attempt. Stop and Quit finalized it as `ready` with no capture error before
process exit. Its microphone track has 1,174,784 frames and system track
1,183,992 at 24 kHz. Direct Ogg granule/EOS inspection matches both saved epoch
counts. All 50 sparse anchors persisted; the last ends exactly at system frame
1,183,992. Coverage persisted 100 reads and one unavailable observation with
`no-call-window`, independently of successful audio. No owned native helper
remained. Earlier failed smoke recordings were preserved.

Known-signal converter calibration, Zoom indicator latency, multiple real remote
speaker changes, false assignments, hidden/screen-share/compact windows,
permission denial/revocation and production collector CPU/usable-example
coverage remain unverified. Synthetic Pause/Resume/restart and provider
normalization checks do not replace those measurements. Issue #122 remains open;
the user does not need to organize a new test group for source implementation
or synthetic verification.

### Shared platform implementation (2026-10-01)

Zoom remains an AX adapter. Its observations now enter the shared platform
schema, persistence and `meetingPlatformMatcher.ts`, also used by Google Meet.
The Zoom 0.5 s lag policy and conservative episode/clock guards remain unchanged.
Historical measurements above remain Zoom-only; synthetic Meet cases do not
establish real-browser attribution quality. Metadata migration and rollback-on-
failure, provenance consumers, retention and manual priority have focused tests.
