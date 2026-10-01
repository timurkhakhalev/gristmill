# task-004 — Google Meet Companion (Implementation Plan)

Дата: 2026-10-01. Статус: план для review; Act не начат.
Ветка: `task-004-google-meet-companion`, base/PR target: `develop`.
По прямому решению Тимура `develop` создан из текущего `main` — `8d4e19422`.
Approved draft: [draft.md](draft.md), commit `b11a21712`.
Источники: [#125](https://github.com/timurkhakhalev/gristmill/issues/125),
[architecture](../../docs/architecture.md),
[record-then-process](../../docs/record-then-process.md),
[quality](../../.memory-bank/steerings/quality.md),
[commands](../../.memory-bank/steerings/project-commands.md).

## 1. Scope (what to implement)

Весь #125 одной задачей: Chrome MV3 extension для Google Meet, собственный
Native Messaging host, связь с выбранным профилем Gristmill, bounded Meet
observations, clock sync, привязка конкретного звонка/записи, mic mute-sync и
confirmed leave → safe Stop. После Stop общий с Zoom pipeline предлагает
редактируемые имена system speakers с конкретным источником Google Meet.
Настройки/onboarding, popup, запись и Transcript показывают актуальный статус.
Подготовить установку и store package; подтвердить packaged/hardware path.

Не строить другие adapters/domains, другие браузеры/ОС, backend/sync/OAuth/
Meet REST API, OCR, watermark, overlay, virtual webcam, camera/video/layout
controls, MAIN-world injection, перехват getUserMedia/WebRTC/media streams
Meet, ASR во время capture, dashboard, plugin framework или legacy shims.
Не копировать Granola code/assets. Не публиковать в Chrome Web Store и не
делать production rollout.

## 2. Fixed decisions (must follow)

1. Do not introduce fallbacks or backward compatibility unless explicitly requested by the user.
2. Chrome + macOS Apple Silicon, Meet content script в ISOLATED world только
   top frame `https://meet.google.com/*`; MV3 permissions `nativeMessaging`,
   `storage`, `alarms`. TypeScript, существующие Zod/esbuild/build conventions;
   static adapter registry с одним Meet adapter. Без новых runtime dependencies.
3. Один Companion toggle включает names, mute-sync и auto-stop. Capabilities
   и здоровье — статусы. Start ручной; Companion не запускает capture/ASR.
4. Один свежий in-call кандидат выбирается при Start; несколько — только после
   выбора пользователя. Calendar URL — hint. Привязка включает profile,
   recording/session, выбранную tab, document/session и call identity.
5. Reload/rejoin того же call в выбранной tab восстанавливает связь только
   после свежего presence и новой binding/clock generation. Другой call не
   выбирается молча; старые события не действуют. Cached worker state не
   разрешает actions; reconnect получает authoritative main snapshot.
6. Platform mute прекращает новые mic samples, сохраняет tail и закрывает mic
   stream/epoch/recovery. System работает непрерывно. Unmute открывает новую
   epoch, если manual mute не активен. Device selection/recovery и late acquire
   не обходят gate. Mic owner остаётся renderer; system owner — Swift/main.
7. Explicit disable Companion возвращает platform-muted mic к обычному capture,
   сохраняя manual mute. Disconnect/unload/tab close/heartbeat timeout не равны
   disable/confirmed leave: не вызывают Stop и не включают mic сами. При обрыве
   есть manual control; fresh reconnect восстанавливает sync.
8. Raw mono mic/system Ogg/Opus неизменяемы: 32 kbit/s VBR, complexity 0;
   PCM только в памяти. Capture не зависит от сети/provider/evidence. Intentional
   mute intervals durable и отличны от failures; derived audio заполняет их
   тишиной. Полностью muted mic допустим, пропавший без причины source — ошибка.
9. Новые track starts/restarts/events используют общую монотонную аудиошкалу с
   actual-frame anchors, uncertainty/rate/generation/freshness. UTC/Date.now и
   receipt time не становятся точным audio offset. Исторические offsets/raw
   artifacts не пересчитываются. Pause исключает паузу между Note parts;
   mic mute оставляет system timeline. Note sources: startedAt, затем ID,
   независимо от group_id; новые части invalidates pending processing.
10. Clock probe проходит до настоящего capture helper с nonce и native receive/
    send host timestamps. Не подменять его HTTP spike/Node clock. Пробы при
    Start/Resume и периодически, сброс при document/helper changes. RTT,
    drift/stale sync, seq loss, throttling и отсутствующие anchors дают gaps,
    без extrapolation. Meet lag 300 ms — исходная гипотеза отдельно от clock
    uncertainty; сохранить Zoom policy, измерить финальные bounds. Spike 5 ms
    не production threshold; converter calibration проверяется отдельно.
11. Один platform pipeline: recording-owned evidence, run-owned decisions.
    Participant IDs отличны от display names; полный active set и ambiguity;
    self/count/soleRemote — hints. Не выбирать первую tile, не переносить
    имена в global voiceprints. Миграция сохраняет старые Zoom данные.
12. После ASR/normalize именуются только system clusters: минимум три независимых
    согласованных episodes, ≥1 s устойчивой речи каждый, timing guards. Повторы
    heartbeat не новые episodes. Duplicate names/competition/mic overlap/
    uncertain clocks/gaps/conflicts оставляют aliases и причины отказа.
    Приоритет user > voice > platform > model; revision/current-run/cancel/delete
    guards. Manual rename снимает platform badge и сохраняется после restart.
13. UI, Notes CLI и LLM material получают Google Meet/Zoom provenance. Preserve
    Notes/blank/manual content, chat/tools кроме удалённого web_search,
    Dictionary/Snippets, календарь, все текущие BYOK/Local/поддерживаемые
    Self-Hosted surfaces, Zoom, все speaker recognition и предыдущие artifacts.
    Не добавлять новую Self-Hosted meeting ASR route.
14. Confirmed leave останавливает только bound recording через существующий
    requestSafeStop: renderer drain/ack → native tail flush/finalization →
    persisted 15 s processing gate. Повторы идемпотентны, binding/session
    проверяются непосредственно перед действием. Pause не запускает ASR.
15. Host — отдельный bundled Electron Node-mode entrypoint, не системный Node/Go,
    не Notes/BB endpoints/token. Length-prefixed UTF-8 JSON ≤64 KiB до allocation;
    stdout только protocol. Profile socket: dir 0700, socket/credential 0600,
    отдельный scoped host↔main credential, не content script. Strict v1 schemas,
    origin/profile/sender tab/frame/seq/binding/freshness guards. Не передавать
    browser raw audio/notes/transcript/provider secrets; не логировать names,
    URLs или page dumps. Bounded queues, EOF/backpressure/owned cleanup.
16. Реальные стабильные extension IDs и allowed origins для Dev/production;
    managed absolute executable path. Explicit test profiles не пишут global
    registration и не seed production. Refresh/relocation/uninstall меняют
    только собственные файлы. Extension update откладывается до Stop.
17. Current docs обновляются с реализацией. Предыдущие .tasks/ и accepted ADRs
    read-only: corrections записывать здесь с ссылкой на оригинал. В этом scope
    accepted ADR не пересматривается; новый ADR без такого изменения не нужен.
18. Только root запускает tests/build/install/native rebuild, последовательно.
    Subagents могут писать tests и запускать scoped lint/typecheck; не запускают
    tests/build/install, включая focused/watch/hooks. Full suite один раз после
    интеграции; новое поведение требует повторить affected checks.

## 3. Milestone rules (dependencies)

Milestones — последовательные поставки, без parallel ownership или branches.
Каждая содержит реализацию, её regression tests и current docs. Не переходить
дальше до её verification. Consumer scope начинается с Contract sync.
Тесты M1–M3 используют synthetic fixtures; реальные Meet events и end-to-end
связываются в M4/M5 и подтверждаются packaged/live в M6. Это явные границы
доказательства, не разрешение откладывать проверку доступного поведения.

## 4. Milestone index

| ID | Name | Depends on | Notes |
| --- | --- | --- | --- |
| M1 | Audio clock и mic lifecycle | none | Монотонная timeline, gate, intentional intervals, empty mic |
| M2 | Общий platform evidence и provenance | M1 | Cutover Zoom, сохранность, matcher и потребители |
| M3 | Companion protocol и local transport | M1, M2 | Native host, MV3 relay, профиль/identity/registration |
| M4 | Meet adapter, clock sync и bound actions | M1, M2, M3 | Реальные bounded events → evidence/mic/safe Stop |
| M5 | Пользовательский flow и packaged wiring | M4 | Settings/onboarding, выбор call, popup/recording, установка |
| M6 | Integrated verification и release preparation | M5 | Full/package/hardware/Meet, измерения, документы |

## 5. Milestone details

### 5.1 M1 — Audio clock и mic lifecycle

#### 5.1.1 Depends on

Depends on: none.

#### 5.1.2 Scope

- Переиспользовать [meetingRecordingStore](../../src/stores/meetingRecordingStore.ts),
  [coordinator](../../src/helpers/meetingCoordinatorIpcHandlers.ts),
  [capture session](../../src/helpers/meetingCaptureSession.ts),
  [timeline](../../src/helpers/meetingAudioTimeline.ts),
  [audio tap manager](../../src/helpers/audioTapManager.ts) и
  [Swift helper](../../resources/macos-audio-tap.swift). Не переносить mic в native.
- Contracts produced/changed: typed helper clock probe/reply (nonce, native
  receive/send ns, helper generation); recording monotonic origin/frame mapping;
  scoped mic-control/drain ack и persisted intentional source intervals.
  Contracts consumed: ordered PCM packets/session/epoch/sequence и safe Stop.
- Добавить bounded probe reader к stdin живого Swift helper и replies через его
  существующий metadata channel; PCM stdout/order и clock actual-frame anchors
  сохранить. Probe failures не блокируют PCM. Shared clock solver принимает
  source send/receive timestamps, offset interval/rate, generation и freshness.
  Использовать его для renderer→native sync; browser reuse появится в M4.
- Убрать wall-clock расчёт новых restart offsets и новых recording durations из
  capture/timeline/composition. Origin и actual delivered frame ranges определяют
  позицию и конец новой части. UTC сохранить для отображения и chronological
  ordering. Старые saved duration/offsets сохраняются при schema migration;
  старые записи не перемаппить новым clock solver.
- Mic control через coordinator/preload к owner: отдельная mic flush/drain/ack
  без cleanup всего recording/system. Закрывать stream/worklet и recovery при
  mute; unmute — новый source epoch на общей timeline. Serialize transitions
  вместе с Stop; scope/generation инвалидируют late acquisition/acks. System
  capture и native watchdog продолжают работать. Manual mute имеет приоритет.
- Durable intentional interval хранить у recording с source, start/end frame и
  причиной platform-muted/manual-muted; open interval закрывается при unmute/
  Stop, recovery сохраняет намерение и фактическую incomplete state при потере
  tail. Расширить существующий storage/schema, не новый processing subsystem.
  intentional closure не маркируется source-restarted/source-unavailable;
  реальные failures и missing system остаются incomplete.
- Contract sync для [mixer](../../src/helpers/meetingAudioMixer.ts) и
  [processing](../../src/helpers/meetingProcessing.ts): silence only in derived
  inputs; нет usable mic epochs при доказанном полностью intentional mute —
  допустимо. Deepgram сохраняет stereo mic=0/system=1 с тихим mic; отдельные
  ElevenLabs/Gemini/OpenAI routes пропускают ASR пустого mic явно в canonical
  source stage, без fake provider JSON; normalize/retry различают intentional
  empty и unavailable. Local mono включает system; обычные routes не меняются.
- Обновить capture/epochs/prepare sections docs/record-then-process.md и
  docs/architecture.md. Companion transport/DOM/UI пока исключены.

#### 5.1.3 Acceptance criteria

AC4–AC7, AC10: mute не добавляет mic frames после boundary, tail не теряется,
system continuous; unmute точен при wall-clock jumps. Intentional intervals и
empty-source результат переживают reopen/retry. Recovery/devicechange/late
streams не включают muted/stopped mic. Safe Stop/Pause/Resume/15 s gate прежние.
Исторические raw audio/artifacts/offsets неизменны. M1 доказывает gate через
internal contract; события Meet и explicit toggle wire-up проверяются в M4/M5.

#### 5.1.4 Verification

Добавить `test/cases/recording/unit/meetingClockSync.test.ts`: nonce/bounds,
asymmetry/rate/wall-clock jumps/stale generation. Добавить integration
`meetingMicGate.test.ts`: реальный store harness + mocked media/worklet и
ordered coordinator contract, persisted boundaries, controlled recovery clocks,
late acquisition/mute-unmute-Stop races, flush/ack. В
`meetingIntentionalIntervals.test.ts` temporary DB/Opus fixtures доказывают
reopen/empty mic/all affected provider stage contracts и сохранность старых
epoch offsets. Native `audioTapClockProbe.test.ts`: настоящий helper probe
round trip/EOF/queue/PCM isolation; hardware-dependent assertions не скрывать
за synthetic pass, live подтверждение в M6.

Root:
```sh
pnpm test -- test/helpers/activeMicRecovery.test.ts test/helpers/meetingAudioTimeline.test.ts test/helpers/meetingCaptureRecovery.test.ts test/helpers/meetingAudioParts.test.ts test/helpers/meetingProcessing.test.ts test/cases/recording/unit/meetingPcmProcessor.test.ts test/cases/recording/integration/meetingMicrophoneSelection.test.ts test/stores/meetingRecordingStoreAutoEndStop.test.ts test/cases/recording/unit/meetingClockSync.test.ts test/cases/recording/integration/meetingMicGate.test.ts test/cases/recording/integration/meetingIntentionalIntervals.test.ts test/cases/recording/native/audioTapClockProbe.test.ts
pnpm run typecheck
pnpm run compile:audio-tap
```
Unit/integration prove AC4–AC7/AC10; native proves probe implementation, не
live clock/indicator accuracy. Полностью muted mic проверить mock provider
requests/real persisted artifacts для Deepgram, ElevenLabs, Gemini, OpenAI,
Local; реальный missing source должен сохранять ошибку. Test harness cleanup
обязателен. Исследовательские activeMicRecovery cases уже dirty: проверить
авторство/diff и включить нужные регрессии без изменения чужой работы.

#### 5.1.5 Consumer surfaces impacted

Capture renderer/main/preload/native, recording storage/recovery, mixer/export,
prepare/ASR/normalize/retry всех существующих meeting routes. Start/system
permission errors и post-Stop pipeline не смягчаются.

#### 5.1.6 Pre-response/loading/success/error/empty states (when applicable)

Mic: requested transition → draining/acquiring → muted/active. Failed drain
даёт честную incomplete/error state; stale acquisition закрывается. Empty mic
intentional → source skipped, system processed; unavailable без намерения →
ошибка. Clock uncalibrated/stale → unknown evidence, audio продолжается.

### 5.2 M2 — Общий platform evidence и provenance

#### 5.2.1 Depends on

Depends on: M1.

#### 5.2.2 Scope

- Contract sync. Обобщить Zoom schemas из
  [meetingRecording contracts](../../src/contracts/meetingRecording.ts),
  [collector](../../src/helpers/zoomSpeakerCollector.ts) и
  [matcher](../../src/helpers/zoomSpeakerMatcher.ts) в один typed platform path.
  Zoom AX остаётся своим adapter; один общий persistence/matcher, без копии.
- Contracts produced/changed: platform discriminator zoom/google-meet,
  participant identity/name revision/self/activity set/episode/binding,
  bounded host interval + uncertainty/generation, coverage/gap reasons,
  run decision provenance/timing policy. Contracts consumed: M1 clock/epoch
  mapping, existing sourceRecordingIds/partOffsets и correction revision.
- В [database](../../src/helpers/database.ts) transactionally перенести
  meeting_zoom_observations в meeting_platform_observations; historic rows и
  run decisions получают Zoom discriminator без изменения IDs/time/decisions/
  correction priorities. Existing platform coverage/decisions/anchors остаются
  в своих таблицах с нужной schema. Миграция atomic/idempotent/reopen-safe;
  старые методы/schema не остаются runtime aliases или dual write/read paths.
- Matcher после ASR/normalize (включая resume/reprocess): system only, ≥3 episodes
  ≥1 s каждый, guards на clocks/gaps/overlap/duplicates/competition/conflicts;
  policies per platform, Meet initial delay 0.3 s, Zoom policy сохраняется.
  Unknown evidence не экстраполировать. Exceptions evidence не отменяют
  сохранённый transcript/Summary. Decision IDs связывают конкретные observations,
  anchors и timing policy; priorities/current run/revision/cancel/delete guards.
- Contract sync consumers: [MeetingResultsPanel](../../src/components/notes/MeetingResultsPanel.tsx),
  [noteTranscriptReader](../../src/helpers/noteTranscriptReader.ts),
  [LLM transcript](../../src/utils/llmTranscript.ts), Notes CLI formatter/contract
  в [gristmill-cli](../../scripts/gristmill-cli.cjs), meetingProcessing projections.
  source=platform сопровождается concrete platform; manual rename снимает badge,
  voice/user выигрывают. Mic identity/global voiceprint неизменны.
- Обновить current platform sections docs/record-then-process.md,
  docs/architecture.md и implementation/verification section
  docs/zoom-speaker-prototype.md, сохранив historical measurements. Не строить
  browser transport и не доказывать live Meet attribution synthetic fixtures.

#### 5.2.3 Acceptance criteria

AC8–AC10: synthetic Meet/Zoom evidence используют общий matcher и корректные
policies/partOffsets; gaps/ambiguity оставляют aliases с причиной. Старые Zoom
rows/decisions/corrections survive migration/reopen. User/voice/manual rename
races и все UI/CLI/LLM projections сохраняют priorities и concrete provenance.
Ни один test не зависит от runtime legacy Zoom API.

#### 5.2.4 Verification

Расширить существующие Zoom matcher/evidence fixtures общими platform cases,
не удалять их негативные assertions. Unit: episodes vs heartbeat, name changes,
duplicate IDs/names, multi-active/self/soleRemote, calibration/gaps/rate/overlap.
Integration: old DB → migration → reopen/retry/selection/cancel/delete,
atomic decisions и revisions. Consumer tests через existing transcript/prompt/
CLI harness, без layout/screenshot tests.

```sh
pnpm test -- test/cases/recording/unit/zoomSpeakerMatcher.test.ts test/cases/recording/integration/zoomSpeakerEvidence.test.ts test/cases/recording/native/zoomCollectorLifecycle.test.ts test/helpers/meetingProcessing.test.ts test/helpers/noteTranscriptReader.test.ts test/components/meetingResultsPanel.test.ts test/components/meetingTranscriptChat.test.ts test/utils/llmTranscript.test.ts test/cases/transcription/unit/meetingPromptEvidence.test.ts test/scripts/gristmillCli.test.ts
pnpm run typecheck
```
Если rename test files — атомарно обновить команды и test registry. Дополнить `test/components/meetingResultsPanel.test.ts`: его `mountPanel` /
`findNodes` / `textOf` на existing rendererTestHarness проверяют Google Meet
и Zoom badge/tooltip в raw и enhanced view, incomplete evidence notice и
исчезновение badge после accepted manual rename/reload selected bundle.
Assertions на rendered tree и update contract, не source-presence. В
`test/helpers/noteTranscriptReader.test.ts` проверить concrete platform DTO;
`test/scripts/gristmillCli.test.ts` — JSON provenance и human output имени/
источника; `test/utils/llmTranscript.test.ts` и
`test/cases/transcription/unit/meetingPromptEvidence.test.ts` — имя + конкретный
источник в prompt material без internal IDs/неразрешённых hints.
Tests prove AC8–AC10. Real DOM evidence приходит в M4, live quality — M6.

#### 5.2.5 Consumer surfaces impacted

Zoom native collector, DB delete/export/reopen, processing/retranscribe,
Transcript/Notes selected versions, speaker editor, CLI/LLM/BB material.

#### 5.2.6 Pre-response/loading/success/error/empty states (when applicable)

Collecting → complete/incomplete coverage; no supported evidence → aliases.
Accepted suggestion shows platform; declined/ambiguous shows reason, не false
name. Optional evidence error preserves ready transcript/Summary. Migration
failure aborts transaction; manual override removes badge immediately/durably.

### 5.3 M3 — Companion protocol и local transport

#### 5.3.1 Depends on

Depends on: M1, M2.

#### 5.3.2 Scope

- Contract sync. Добавить `src/contracts/companion.ts`: strict Zod v1 messages,
  CallRef (platform/tab/document/session/call), monotonic source timestamps,
  sequence/binding, participants/activity/presence/mute/confirmed leave,
  clock probe/reply и restricted desktop snapshot. Bounds на строках/arrays/
  frames до allocation; unknown payload fields/version reject.
- Contracts produced/changed: browser↔host protocol и profile socket envelope,
  host registration/identity, connection lifecycle и extension status updates.
  Contracts consumed: M1 native probe и mic scope; M2 evidence schemas.
- Собственный `src/helpers/companionNativeHost.ts` entrypoint и
  `companionServer.ts` внутри main, отдельный scoped credential/path от BB/Notes.
  Native frames ≤64 KiB little-endian length-prefix; fragmentation/partial writes
  handled, stdout protocol only. Host validates Chrome origin argument и только
  pinned allowed IDs; main validates scoped credential/profile/session/binding/
  seq and schemas. Browser sender проверяется worker: top frame + Meet origin;
  tab/frame не принимаются от content payload на веру.
- Profile socket directory 0700/file 0600, owned cleanup и finite buffers;
  stale connections не живут после EOF/errors. No state replay authorizes actions:
  main snapshot authoritative. App absent/version mismatch/host missing честно
  unavailable; optional transport не блокирует обычный Start/capture.
- `extension/` с MV3 manifest, TS worker и popup entry; esbuild отдельный browser
  target в existing build pipeline, DOM lib без Node imports. Typecheck extension
  program с минимальными используемыми Chrome declarations; включить в existing
  sequential typecheck/build scripts, без нового dependency/toolchain.
  Упакованный host компилируется existing main build отдельным entry root.
- `installCompanionHost.ts` использует managed launcher pattern
  [installAgentCli](../../src/helpers/installAgentCli.ts), bundled runtime и
  absolute resource path. Pinned public manifest keys → stable отдельные Dev/prod
  IDs; private key вне repo/package. Native host names
  com.khakhalev.gristmill.companion и com.khakhalev.gristmill.companion.dev.
  Registration только для точных IDs, managed marker/ownership; installer
  test target явно isolated. Не перезаписывать чужие manifests/launchers.
- Worker reconnect/alarms/connection status and main snapshot; storage только
  cached hints, не action authority. `runtime.onUpdateAvailable`: defer reload
  while recording, apply after authoritative Stop и cleanup. DOM adapter/actions
  пока не подключать. Popup shell functional status, UX refinement в M5.
- Начать docs/google-meet-companion.md: protocol/trust boundaries, message bounds,
  entrypoints, stable IDs/keys, socket profile, install/ownership/update/cleanup.

#### 5.3.3 Acceptance criteria

AC1/AC11–AC13 transport-level: valid origin/profile establishes protocol and
snapshot; wrong origin/profile/frame/version/replay/oversized frames rejected,
никаких audio/notes/transcript/secrets в browser payload/logs. Worker restart/
reconnect/EOF/backpressure/update не оставляют duplicate processes/false Connected.
Installer refreshes only owned registration; Dev/prod/test isolation работает.
Final packaged Chrome connection проверяется M5/M6.

#### 5.3.4 Verification

`test/cases/platform/unit/companionProtocol.test.ts`: strict payload/bounds
negative cases (AC11). Integration `main/companionTransport.test.ts`: настоящий host
subprocess/socket/temp profile с fake Chrome stdio, fragmented messages, EOF,
wrong origin/credential/version/profile/order и connection snapshot (AC11/12).
`companionHostInstallation.test.ts`: temp home/app paths со spaces/quotes,
relocation/foreign files/uninstall и no real registration (AC13). Unit worker
harness `companionWorker.test.ts`: trusted sender, restart/cache/reconnect,
recording snapshot and deferred update (AC1/12), controlled clocks и cleanup.

```sh
pnpm test -- test/cases/platform/unit/companionProtocol.test.ts test/cases/platform/unit/companionWorker.test.ts test/cases/platform/integration/main/companionTransport.test.ts test/cases/platform/integration/companionHostInstallation.test.ts test/cases/platform/integration/installAgentCli.test.ts
pnpm run typecheck
pnpm run build:main
pnpm run build:companion
```
`build:companion` создаётся в M3 как esbuild command producing extension build
и store-ready source package без публикации; документировать его в project
commands. Native host integration test расположен под `main/`: selection строит
compiled main/host entrypoint один раз.
Если runner уже строит main для selection — отдельный build:main не повторять.

#### 5.3.5 Consumer surfaces impacted

Extension worker/popup, Chrome Native Messaging, packaged runtime/resources,
main startup/shutdown/install status. Notes CLI/BB transports сохраняются отдельными.

#### 5.3.6 Pre-response/loading/success/error/empty states (when applicable)

Disconnected → connecting → connected only after validated main snapshot.
Missing app/host/version mismatch/auth failure → actionable disconnected error.
No call/recording → connected with empty call/idle snapshot. Backpressure/EOF
invalidates connection; no stale cached Connected or command execution.

### 5.4 M4 — Meet adapter, clock sync и bound actions

#### 5.4.1 Depends on

Depends on: M1, M2, M3.

#### 5.4.2 Scope

- Contract sync. Contracts consumed: M1 scoped mic-control/drain/clock probe
  и intentional intervals; M2 platform observations/coverage/decisions/policies;
  M3 strict messages/CallRef/sequence и authoritative snapshot.
  Contracts produced/changed: `src/contracts/companion.ts` — candidate list с
  freshness, select-call request, active binding status (recording/session/tab/
  call/document/generation), stale/unavailable reasons и effective manual/platform
  mic state. `src/contracts/meetingCoordinator.ts` / typed preload — selected
  binding при Start, scoped manual-mic action и binding/status notifications.
  Main owns selection/binding/action validity; extension/renderer snapshots не
  authority. M5 consumes эти stable selection/status/control contracts.
- `extension/src/meetAdapter.ts` — единственный adapter в static
  registry; content-script TS entry isolates DOM. Versioned sanitized RU/EN
  fixtures, не dumps real meetings. Собрать participants/self/count/presence,
  full active set, mute known/unknown и positive confirmed leave. Identity по
  participant ID + document/session, не по display name/DOM order. Self/count/
  soleRemote hints не становятся доказательством для names.
- MutationObserver/coalesced scan и bounded periodic refresh; detach on redraw/
  pagehide/worker connection changes. Обнаруживать уже открытый document PiP,
  enter/close lifecycle; скрытые/unreadable contexts дают unknown/gaps. Camera
  off, partial roster, duplicate/renamed names, screen sharing/Pin/PiP/multi-active
  не дают ложного single speaker. Не менять video/layout, не открывать PiP самим.
- Main `companionCoordinator.ts` подключить к recording coordinator: CallRef
  candidates + explicit selection, fresh binding к recording/session/profile.
  Start не должен блокироваться отсутствием optional Companion; несколько
  свежих кандидатов требуют selection before binding. New document/rejoin same
  selected tab/call → fresh validated binding/generation; wrong call/event ignored.
  Per-Note parts сохраняют собственный platform/binding и offsets.
- Source browser performance clock → M3 host/main → M1 настоящая Swift clock
  probe с четырьмя timestamp/nonce. Reuse M1 solver, refresh Start/Resume/
  periodically; invalidate generation/stale/seq loss/hidden-tab throttling.
  Persist bounded observations mapped to actual audio frames с uncertainty;
  persist gap reasons, не использовать receipt time/10 s hold extrapolation.
- Turn activity episodes требуют continued observations; весь active set и
  ambiguous сохраняется. M2 matcher consumes после Stop, не live ASR.
  Degrade только optional evidence, не capture или saved transcript.
- Bound mute known → M1 mic gate; manual priority, unknown state не unmute.
  Positive leave → existing requestSafeStop after immediate binding/session
  guard; repeated leave/Stop idempotent. Tab close/unload/disconnect/heartbeat
  loss не Stop и не disable. Explicit disable clears platform gate только;
  reconnect reconciles fresh mute with manual gate. Source state/raw metadata
  сохраняют intentional intervals и gaps, cached worker не управляет mic.
- Docs/google-meet-companion.md: adapter evidence/fixture version, source clock,
  validity/gaps/rejoin/disable vs disconnect/safe leave. Video hooks excluded.

#### 5.4.3 Acceptance criteria

AC2–AC9/AC11/AC12: выбранный fresh call управляет только своей записью; reload/
rejoin восстановлены, wrong/stale call не действует. Explicit disable resumes
platform-muted mic only, disconnect preserves state. Real DOM fixtures produce
bounded evidence with uncertainty and full active set; positive leave drains
bound capture. Store/coordinator/worker integration показывает names после
normalization, manual priorities и evidence failures не мешают transcription.
Live DOM recognition/indicator accuracy всё ещё проверяется в M6.

#### 5.4.4 Verification

Native test `test/cases/recording/native/meetAdapterDom.test.ts` запускает
собственный GUI Electron subprocess по existing pattern
`test/helpers/devRendererOrigin.test.ts` + `devRendererOriginElectron.ts`.
TS helper `test/helpers/harness/meetAdapterElectron.ts` компилируется installed
esbuild во временный CJS, actual adapter — во временный browser bundle. Electron
получает fresh temporary userData/sessionData, без ELECTRON_RUN_AS_NODE,
создаёт hidden BrowserWindow и загружает sanitized HTML/CSS fixtures из
`test/fixtures/meet/` (RU/EN/camera-off/duplicate/partial/multi-active/sharing).
Browser bundle выполняет настоящий adapter; transport callback только собирает
emitted observations, не подменяет DOM queries. Real querySelector/computedStyle/
getBoundingClientRect/MutationObserver работают в Chromium; executeJavaScript
меняет атрибуты/tiles/controls и проверяет результат после observer delivery,
не fs/source assertions. Deadline bounded; cleanup child/window/profile/bundles
регистрируется до запуска и выполняется также при failure.

Actual DOM recognition/redraw/name revision/mute/positive leave vs disappearance
доказываются M4. PiP lifecycle детерминированно моделируется test-only
`documentPictureInPicture` EventTarget с same-origin iframe.contentDocument:
already-open/enter/pagehide/close, observer detach и unknown/gap проверяют
адаптерный lifecycle, не native PiP capability. Hidden/unreadable context
моделируется явными visibility/access transitions; реальное Chrome PiP,
hidden-tab throttling и текущий live Meet DOM проверяются в M6. Native fixture
тест имеет explicit non-macOS skip по repo convention; на macOS required pass.

`companionBinding.test.ts` unit: fake clocks, multi-tab/call/rejoin/generation/
seq/Stop/Resume/manual priority. Integration `companionCapture.test.ts`:
worker→host/main→store contract, persisted audio/intervals/evidence, fixture
normalization→names, safe drain + final gate, races/unavailable/errors/cleanup.
Clock tests дополнить source→host mapping RTT/drift/generation/coverage gaps.

```sh
pnpm test -- test/cases/recording/native/meetAdapterDom.test.ts test/cases/recording/unit/companionBinding.test.ts test/cases/recording/integration/companionCapture.test.ts test/cases/recording/unit/meetingClockSync.test.ts test/helpers/meetingCoordinatorIpc.test.ts test/helpers/meetingCoordinatorBridge.test.ts test/stores/meetingRecordingStoreAutoEndStop.test.ts
pnpm run typecheck
pnpm run build:companion
```
Tests prove AC2–AC9/11/12 на доступных границах; popup/user flow — M5;
actual packaged transport/hardware и live indicators — M6.

#### 5.4.5 Consumer surfaces impacted

Meet content script/PiP/worker, main bindings/native probe, renderer mic/Stop,
recording-owned evidence and post-Stop processing/Zoom isolation.

#### 5.4.6 Pre-response/loading/success/error/empty states (when applicable)

No call → empty; candidates → awaiting selection/binding; fresh selected call →
bound; replacing document → unavailable pending fresh checks, then bound.
Mute unknown/context stale → no new command, сохранение effective gate +
manual control. Leave pending → draining → finalized, or truthful incomplete.
Invalid evidence → gaps/aliases, capture/processing continues.

### 5.5 M5 — Пользовательский flow и packaged wiring

#### 5.5.1 Depends on

Depends on: M4.

#### 5.5.2 Scope

- Contract sync. Contracts consumed: M4 candidates/select-call/binding snapshot/
  scoped manual-mic actions, M1 mic gate effective state, M2 concrete provenance,
  M3 installer ownership/connection/version/profile and worker snapshot contracts.
  Contracts produced/changed: persisted single `companionEnabled` preference
  через existing settings store + `src/contracts/desktopSettings.ts`;
  typed install/refresh/check/uninstall result (installed/path/profile/identity/
  error code) через existing desktopSettings preload boundary. Toggle mutation
  применяет M4 explicit-disable semantics; failure не возвращает false success.
  Recording/popup views consume authoritative binding/mic/connection DTO из M4,
  не вводят свой binding или независимые feature flags.
- Existing Settings/onboarding/settings store and typed preload
  surfaces: один persistent Companion toggle; install/refresh/check host status,
  call selection только при нескольких candidates. Disabled toggle объясняет
  возобновление platform-muted mic; manual mute отдельно от platform state.
- Recording UI [MeetingRecordingPill](../../src/components/notes/MeetingRecordingPill.tsx)
  и functional popup: connection/call/recording/mic state, capability freshness,
  context stale/unknown и ручной mic control; no extra dashboard/results tab.
  Existing Transcript names/source/error coverage reuse M2. RU/EN accessibility
  names, keyboard selection и no misleading success.
- Settings enabled state → M4 complete feature lifecycle; установленные actions
  не feature toggles. Installation на requested Dev/prod profile; explicit
  test runtime supplies isolated Chrome registration target. Main startup refresh
  только own previously installed host registration; uninstall removes only own
  artifacts. Нет broad global registration при explicit test profile.
- Package resources/entrypoints via [electron-builder](../../electron-builder.json)
  и [Dev config](../../electron-builder.dev.cjs); extension build/keys/IDs match
  allowed origins. Packaged runtime works without external Node/Go and survives
  app relocation/reinstall; Dev/prod sockets/manifests remain separate.
- README: install extension/enable/Start/call selection/mute/manual override/
  disable/rejoin/reconnect/errors. docs/google-meet-companion.md: concrete paths,
  Chrome permissions/identity/installer/update/uninstall/troubleshooting.
  project-commands.md documents build:companion and isolated package launch.

#### 5.5.3 Acceptance criteria

AC1–AC3/AC6/AC9/AC12/AC13: single toggle drives all functions, no silent call
selection; popup/desktop reflect authoritative state incl app closed, host missing,
wrong profile/version/unknown evidence. Installation detects success/error,
manual mute/rename maintained. Packaged resources/run flags/IDs inspectable;
real Chrome/native connection and relocation proven at M6.

#### 5.5.4 Verification

Integration `test/cases/settings/integration/companionSettings.test.ts`: existing
renderer harness with typed bridge mocks, toggle/disable effect text, install
failure, multi-call selection, fresh reconnect and manual priority. Recording
surface behavior in `test/cases/recording/integration/companionUi.test.ts`:
state→visible label/control and keyboard flow; без CSS/layout snapshots.
Extend worker/installer tests for authoritative snapshots/relocation/profile.

```sh
pnpm test -- test/cases/settings/integration/companionSettings.test.ts test/cases/recording/integration/companionUi.test.ts test/cases/platform/unit/companionWorker.test.ts test/cases/platform/integration/companionHostInstallation.test.ts test/components/meetingTranscriptChat.test.ts
pnpm run typecheck
pnpm run build:renderer
pnpm run build:companion
```
Manual isolated dev review: no call → one/multiple calls → Start → mute/manual
mute → disconnect/rejoin → disable → confirmed leave → Transcript badge/name
edit. UI mock pass не packaged/hardware evidence; package only once M6.

#### 5.5.5 Consumer surfaces impacted

Settings/onboarding, recording controls/status, extension popup, call selection,
Transcript, RU/EN strings, package install/registration/runtime/resource paths.

#### 5.5.6 Pre-response/loading/success/error/empty states (when applicable)

Off/install absent → explanation/install; installing/connecting → pending;
validated connection → connected. Missing host/app/profile/version mismatch →
конкретная причина/repair action, не Connected. No Meet → connected/no call.
Multiple → selection, same-call rejoin → reconnecting/bound. Unknown speakers →
честный unavailable status с usable transcript, manual names без badge.

### 5.6 M6 — Integrated verification и release preparation

#### 5.6.1 Depends on

Depends on: M5.

#### 5.6.2 Scope

- Contract sync. Integrated verification существующего scope, без нового runtime.
  Contracts produced/changed: финальные measured timing policies и truthful
  verification/installation/release documentation. Contracts consumed: M1–M5.
- Однократный integrated full pass и sequential package/native/runtime checks;
  при дефекте focused rerun first и affected checks после исправления.
- Fresh app profile и fresh Chrome profile. Запуск packaged Dev explicit
  user-data-dir, не default dev snapshot/production/OpenWhispr. Isolated host
  registration привязан к тестовому Chrome home/profile, не global real entry.
  Установка расширения из build; фиксировать фактический ID/Chrome/app version.
- Live synthetic second browser/device supplies заранее известные remote turns,
  hardware mic/local voice отдельны; не требовать коллег. Проверить raw samples:
  mute boundary/tail/system continuity/unmute alignment, весь call muted,
  ручной gate/recovery/devicechange/Pause/Resume/Stop/confirmed leave/reload/
  rejoin/tab-close/disconnect/explicit disable и process/resource cleanup.
- Измерить browser→MV3→Native Messaging→main→capture helper RTT/uncertainty/rate,
  hidden/PiP/sleep/restart generations и actual-frame mapping. Измерить converter
  startup/tail и Meet indicator lag отдельно. Сохранить distributions, supported
  domain и rejection bounds в policy; invalid intervals оставляют aliases.
  Если измерение не позволяет доказать bounds, не объявлять live names pass и
  не заменять uncertainty guessed receipt-time policy.
- Names smoke: ≥3 независимых episodes/≥1 s, несколько system speakers,
  overlap/duplicates/rename/self/camera off/PiP; editable suggestions с source,
  manual/voice priority after reopen, CLI/LLM, Zoom regression, canceled/retry/
  deleted Note. Mock provider tests already prove route requests; real provider
  check когда доступен у выбранного isolated config, факт выполнения явно указан.
- Package Dev registration/ID и production resources/identity inspect (без
  установки production profile), managed app relocation/update/uninstall в
  isolated copy; store zip, description/icons/privacy/data/permission text
  собственные Gristmill assets, без publication.
- Завершить README, docs/google-meet-companion.md, docs/architecture.md и
  docs/record-then-process.md current status. Сохранить existing Zoom historical
  evidence и Companion spike, явно HTTP/synthetic≠packaged/live. Verification
  report в этой задаче: команды, counts/durations, версии, измерения, сценарии,
  failures/unknowns, не данные реальных пользователей. Не commit .planact/visual
  projection, runtime token/profile/private key/build artifacts.

#### 5.6.3 Acceptance criteria

AC1–AC14 integrated: все перечисленные outcomes подтверждены appropriate layer,
full suite/typecheck/lint/build/package выполнены. Hardware/real Meet проверены,
финальные clock/indicator bounds известны, unknowns не названы pass.
Невыполненный required hardware/package scenario блокирует milestone/Act
completion. Store подготовлен, не опубликован; production rollout не выполнен.

#### 5.6.4 Verification

Root последовательно:
```sh
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run build:renderer
pnpm run build:companion
pnpm run pack:dev
```
После pack:dev создать временный absolute app profile и запускать:
```sh
./dist-dev/mac-arm64/'Gristmill Dev.app'/Contents/MacOS/'Gristmill Dev' --user-data-dir=/tmp/gristmill-companion-app-smoke
```
Перед использованием выбрать fresh уникальный каталог вместо приведённого
example; Chrome отдельный fresh user-data-dir, test-only registration target.
Приложение/тесты/установки не пересекать; упаковка только при закрытом Dev app.
Manifest/launcher inspect и live checklist AC1–AC14 описаны выше. Репорт хранит
exact effective launch/registration commands и результаты. Process cleanup
проверить после остановки только owned app/browser/host/helper.

#### 5.6.5 Consumer surfaces impacted

Полный recording→Stop→prepare→ASR→names→Summary→Notes flow, все сохранённые
provider/speaker/Notes/chat surfaces, Chrome extension/runtime/install lifecycle.

#### 5.6.6 Pre-response/loading/success/error/empty states (when applicable)

Live наблюдения должны совпасть с M1–M5 states. No evidence/permission failure/
provider error/cancel/empty source не дают ложного complete и не теряют raw
recording. Required unavailable live check — unverified, не successful milestone.

## 6. Acceptance coverage

| Draft AC | Earliest proof / integrated completion |
| --- | --- |
| AC1 Connection/status | M3 transport, M5 consumers, M6 packaged Chrome |
| AC2 One toggle/disable/manual mute | M4 gate semantics, M5 controls, M6 hardware |
| AC3 Call binding/rejoin/selection | M4 binding, M5 selection, M6 live reload/rejoin |
| AC4 Mic gate/tail/system/alignment | M1 PCM/epochs, M4 actions, M6 hardware |
| AC5 Durable intentional intervals/empty mic | M1 storage/provider stages, M6 full-call muted |
| AC6 Manual/stale/recovery/disconnect | M1 races, M4 binding, M5 UI, M6 hardware |
| AC7 Scoped safe leave/drain/Pause/gate | M1 safe Stop regression, M4 leave, M6 live |
| AC8 Conservative names/clock/gaps | M2 matcher, M4 DOM/sync, M6 measured accuracy |
| AC9 Priorities/provenance/revision | M2 persistence/UI/CLI/LLM, M5 consumers, M6 restart |
| AC10 Migration/preservation | M1 epoch/mute cutover, M2 Zoom cutover, M6 full suite |
| AC11 Privacy/trust boundaries | M3 framing/guards, M4 stale actions, M6 package inspect |
| AC12 Reconnect/update/cleanup | M3 worker/host, M4 observer/binding, M6 real lifecycle |
| AC13 IDs/install/relocation/store | M3 installer/keys, M5 package wiring, M6 smoke/prep |
| AC14 Reproducible truthful evidence | Each milestone report + M6 final evidence |

## 7. Execution order (derived from dependencies)

M1 → M2 → M3 → M4 → M5 → M6 → final Code Reviewer → approved corrections.
Не начинать Act без утверждения этого plan. Commit boundaries по milestones,
не требовать parallel work/ownership. После ошибки сначала failing focused
selection; не повторять full suite для comment-only corrections.

Shared commands: pnpm test через canonical runner (≤2 ordinary processes,
compiler/native/shared resources sequential); exact .test.ts paths либо domain
selectors, не combined. New tests TypeScript в test/cases/<domain>/<kind>/,
compiled-main tests под main/, shared resources под serial/; special/multi-domain
membership — test/test-groups.json. При изменении paths обновить commands и
registry вместе. Scoped lint existing root/src config, без unrelated autofix.
Plan stage documentation-only: local links/commands accuracy и git diff --check;
application tests/build пока не нужны. Runtime tokens/private signing keys,
temporary profiles/.planact/visual output никогда не commit.

## Orchestration (managed by orchestrator)

| Milestone | Status | Commits |
| --- | --- | --- |
| M1 — Audio clock и mic lifecycle | not started | |
| M2 — Общий platform evidence и provenance | not started | |
| M3 — Companion protocol и local transport | not started | |
| M4 — Meet adapter, clock sync и bound actions | not started | |
| M5 — Пользовательский flow и packaged wiring | not started | |
| M6 — Integrated verification и release preparation | not started | |
| Reviewer | not started | |
| Code Reviewer | not started | |
