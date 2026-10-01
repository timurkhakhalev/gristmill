# task-004 — Google Meet Companion (Implementation Plan)

Дата: 2026-10-01. Статус: план для review; Act не начат.
Ветка: `task-004-google-meet-companion`, base/PR target: `develop`.
По прямому решению Тимура `develop` создан из текущего `main` — `8d4e19422`.
Approved draft: [draft.md](draft.md), commit `e96d1523b`.
Источники: [#125](https://github.com/timurkhakhalev/gristmill/issues/125),
[architecture](../../docs/architecture.md),
[record-then-process](../../docs/record-then-process.md),
[quality](../../.memory-bank/steerings/quality.md),
[commands](../../.memory-bank/steerings/project-commands.md).

## 1. Scope (what to implement)

Функции #125 одной задачей: Chrome MV3 extension для Google Meet, собственный
Native Messaging host, связь с выбранным профилем Gristmill, bounded Meet
observations, clock sync, привязка конкретного звонка/записи, mic mute-sync и
confirmed leave → safe Stop. После Stop общий с Zoom pipeline предлагает
редактируемые имена system speakers с конкретным источником Google Meet.
Настройки/onboarding, popup, запись и Transcript показывают актуальный статус.
Добавить manual mic mute для любой записи и подтвердить packaged Dev/hardware
path. Один task PR в `develop`, последовательные milestone commits; отдельные
промежуточные PR не требуются.

Не строить другие adapters/domains, другие браузеры/ОС, backend/sync/OAuth/
Meet REST API, OCR, watermark, overlay, virtual webcam, camera/video/layout
controls, MAIN-world injection, перехват getUserMedia/WebRTC/media streams
Meet, ASR во время capture, dashboard, plugin framework или legacy shims.
Не копировать Granola code/assets. Production ID/public key/allowed origins,
draft item и Chrome Web Store verification/release preparation/publication,
production rollout — отдельная задача. Проверяем Google Chrome Stable;
Beta/Canary/другие channels не входят в обязательную матрицу.

## 2. Fixed decisions (must follow)

1. Do not introduce fallbacks or backward compatibility unless explicitly requested by the user.
2. Google Chrome Stable + macOS Apple Silicon, несколько Chrome profiles;
   Meet content script в ISOLATED world только
   top frame `https://meet.google.com/*`; MV3 permissions `nativeMessaging`,
   `storage`, `alarms`. TypeScript, существующие Zod/esbuild/build conventions;
   static adapter registry с одним Meet adapter. Без новых runtime dependencies.
3. Один Companion toggle включает names, mute-sync и auto-stop. Capabilities
   и здоровье — статусы. Start ручной; Companion не запускает capture/ASR.
4. Один свежий in-call кандидат автоматически выбирается только при новом
   самостоятельном Start с включённым Companion; несколько — после выбора.
   Любой кандидат, появившийся во время уже идущей непривязанной записи,
   требует подтверждения до binding, даже единственный/с Calendar URL match.
   До подтверждения нет влияния на mic/Stop/auto-end/evidence. Cancel/stale
   confirmation не привязывают; fresh candidate/expected session проверяются
   заново. Calendar URL — hint. Привязка включает app profile, native connection,
   extension installation/session, recording/session, tab/document/call identity;
   одинаковые call URL/tab IDs между Chrome profiles не объединяются.
5. Reload/rejoin того же call в выбранной tab восстанавливает связь только
   после свежего presence и новой binding/clock generation. Другой call не
   выбирается молча; старые события не действуют. Cached worker state не
   разрешает actions; reconnect получает authoritative main snapshot.
6. Platform/manual mute закрывает gate в AudioWorklet до передачи/encoding/
   хранения PCM; muted samples отбрасываются сразу, без replay и analyser/
   activity/speaker/provider paths. Допустимый tail сохраняется, encoded epoch
   закрывается; исправный stream/worklet/устройство остаются открытыми. Unmute
   открывает gate и encoded epoch без getUserMedia; mute без debounce, PTT не
   перезапускает устройство. Render-frame счётчик включает discarded frames,
   отличается от encoded count; gate ack содержит actual boundary, timeline
   не сжимает mute и не использует wall-clock. Missing input/suspend/device или
   AudioContext restart дают generation/gap и fresh anchors. Recovery/late acquire
   не обходят manual/platform intent; mute не запускает recovery. Stop/Pause
   освобождают stream. Mic owner renderer, system Swift/main. UI объясняет
   удержание устройства и системный mic indicator во время mute.
7. Explicit disable Companion возвращает platform-muted mic к обычному capture,
   сохраняя manual mute. Disconnect/unload/tab close/heartbeat timeout не равны
   disable/confirmed leave: не вызывают Stop и не включают mic сами. При обрыве
   есть manual control; fresh reconnect восстанавливает sync.
   Manual mute — новая функция для любой записи, независимо от Companion;
   controls в NoteRecordControl и MeetingRecordingPill. Intent сохраняется при
   Pause/Resume/reopen paused Note/Restart до первых samples; самостоятельный
   Start сбрасывает его. Effective closed gate = manual OR platform mute:
   снятие manual не обходит platform gate; отдельного persisted default нет.
   Bound Meet session отключает heuristic auto-end (mic-released/silence/
   process-exit), включая unknown UI/transport loss и последующий disable;
   late binding инвалидирует queued heuristic stop. Только confirmed leave или
   ручной Stop; обычные непривязанные записи сохраняют auto-end. Через 5 min
   непрерывного context unavailable одно существующее notification surface
   напоминает о продолжающейся записи и предлагает scoped ручной Stop.
   Timeout не меняет gate и не возвращает эвристику. Reconnect сбрасывает timer;
   Stop/session change/disable инвалидируют timer/action; sleep/resume проверяет
   истёкший срок один раз. Unknown Meet UI имеет явный health status. Room
   transition без positive leave — unknown/gap; свежий тот же выбранный call
   восстанавливается новой generation, другой call не выбирается молча.
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
    Migration transactional/idempotent/reopen-safe с rollback on failure.
    Develop upgrade проверяется на копии закрытого isolated test profile;
    pre-upgrade copy — единственный путь downgrade, старую сборку не запускать
    на новой схеме. Без backup subsystem/reverse migration/shims. Имена/evidence
    являются recording metadata: audio retention их сохраняет вместе с Note/
    transcript, Note deletion удаляет каскадно. Existing exports используют
    итоговые speaker names, без нового raw roster/evidence export или retention.
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
    requestSafeStop меняется прямым cutover: expected recording/session и reason
    проверяются при dispatch, pending-stop reuse и drain/timeout; quit/delete-all
    consumers меняются вместе. После успешного Leave одна существующая 30 s
    Restart карточка с причиной выхода из Meet; failed Stop не предлагает Restart.
    Restart — новая часть той же Note/session и сохранённый manual intent.
    Fresh прежний selected call при Restart допускает новый binding; иначе
    запись непривязана, platform gate/binding не наследуются, обычный auto-end
    с существующим 5-minute restart grace. Другой call не autobind; поздний
    same-call rejoin требует подтверждения по п. 4. Restart не возвращает в
    браузерный звонок. До/после 15 s gate новая часть отменяет stale processing;
    raw audio/старые artifacts сохраняются, sources chronological/full Note.
15. Host — отдельный bundled Electron Node-mode entrypoint, не системный Node/Go,
    не Notes/BB endpoints/token. Length-prefixed UTF-8 JSON ≤64 KiB до allocation;
    stdout только protocol. Profile socket: dir 0700, socket/credential 0600,
    отдельный scoped host↔main credential, не content script. Strict v1 schemas,
    origin/profile/sender tab/frame/seq/binding/freshness guards. Не передавать
    browser raw audio/notes/transcript/provider secrets; не логировать names,
    URLs или page dumps. Bounded queues, EOF/backpressure/owned cleanup.
16. Реальный стабильный Dev extension ID из pinned public key и allowed origin;
    managed absolute executable path. Explicit test profiles не пишут global
    registration и не seed production. Refresh/relocation/uninstall меняют
    только собственные файлы. Extension update откладывается до Stop.
    Chrome host manifest расположен в user-data root, не отдельной Profile N;
    несколько Chrome profiles дают независимые native connections/candidates,
    выбранный binding не наследуется другой connection. Production identity и
    Store не подменяются собственным Dev key; никаких фиктивных prod IDs.
17. Current docs обновляются с реализацией. Предыдущие .tasks/ и accepted ADRs
    read-only: corrections записывать здесь с ссылкой на оригинал. В этом scope
    accepted ADR не пересматривается; новый ADR без такого изменения не нужен.
18. Только root запускает tests/build/install/native rebuild, последовательно.
    Subagents могут писать tests и запускать scoped lint/typecheck; не запускают
    tests/build/install, включая focused/watch/hooks. Full suite один раз после
    интеграции; новое поведение требует повторить affected checks.
    M6 onset-loss/unmute-latency — измерение с P50/P95/max/методом/ограничениями,
    без порога pass/fail для потери начала речи; величина не блокирует milestone.
    Само выполнение required hardware measurements, functional gate/tail/system
    checks и доказательство clock/attribution bounds остаются обязательными.

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
| M1 | Audio clock и mic lifecycle | none | Continuous frame position, held-device gate, manual intent, empty mic |
| M2 | Общий platform evidence и provenance | M1 | Cutover Zoom, сохранность, matcher и потребители |
| M3 | Companion protocol и local transport | M1, M2 | Native host, MV3 relay, профиль/identity/registration |
| M4 | Meet adapter, clock sync и bound actions | M1, M2, M3 | Binding confirmation, auto-end arbitration, scoped Stop/Restart |
| M5 | Пользовательский flow и packaged wiring | M4 | Controls, selection, reminder, 11 locales, Dev installation |
| M6 | Integrated verification и Dev verification report | M5 | Full/package/hardware/Meet, измерения, документы |

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
  Mic command/ack содержит expected recording/session/source generation,
  manual/platform intent, effective gate и actual render-frame boundary.
  Start/Pause/Resume/Restart context переносит manual intent явно, до samples;
  existing paused-meeting storage хранит его для reopen, independent Start reset.
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
- Mic control через coordinator/preload к owner: gate + отдельная mic tail
  flush/drain/ack без cleanup всего recording/system. Не закрывать исправный
  MediaStream/AudioContext/worklet при mute: после boundary отбрасывать input
  до postMessage/encoder/storage, без buffered muted PCM/replay; завершить
  encoded epoch. Gate закрыт при manual OR platform intent. Unmute — новая
  encoded epoch на том же stream без getUserMedia. Manual/platform commands
  serialize со Stop; scope/generation инвалидируют late acquisition/acks.
  Реальная device failure/selection recovery сохраняет intent; intentional
  mute не запускает recovery. Stop/Pause освобождают устройство. Не путать это
  с existing RMS/bleed policy в src/helpers/meetingMicGate.ts: она не substitute
  discard-before-transfer. System/native watchdog работают непрерывно.
- Непрерывный worklet render-frame count включает muted quanta и отличается от
  sent/encoded sample offset. Gate ack/новые chunks дают actual-frame ranges
  и generation; новые encoded epoch offsets включают discarded interval.
  Worklet остаётся processing при закрытом gate. Missing input/context suspend/
  device restart не выдавать за recorded silence: новые anchors/gap/generation.
  Ни Date.now, ни сумма отправленных samples не заменяют capture position.
- Contract sync consumers manual intent: meetingRecordingSession.ts Restart
  context, paused Note restore и recording store; analyser/activity paths не
  получают muted mic. meetingAudioActivityMonitor.ts, audioActivityDetector.ts,
  coordinator setMicWarmHold и settingsStore idle micWarmHoldSeconds сохраняют
  смысл ownership/detection. Manual mute — intentional, не source unavailable;
  обычный auto-end policy остаётся прежним, bound suppression вводится M4.
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
Discarded quanta увеличивают timeline position, не encoded count; исправный
stream сохраняется при PTT/mute/unmute. Manual intent survives Pause/Resume/
reopen/Restart, independent Start resets; controls появляются в M5.

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
Расширить existing `test/cases/recording/unit/meetingPcmProcessor.test.ts`:
выполнить actual worklet code в VM с controlled currentFrame/quanta; loud muted
samples не дают chunk, tail flush сохраняется, counters/acks включают discarded
frames, unmute chunk занимает правильный offset после wall-clock jumps.
Store harness проверяет отсутствие getUserMedia/track.stop на PTT, но cleanup
на Pause/Stop; generation при device recovery. В existing
`test/helpers/meetingRecordingSession.test.ts` и store integration проверить
Pause/Resume/paused reopen/Restart manual intent и fresh Start reset.

Root:
```sh
pnpm test -- test/helpers/activeMicRecovery.test.ts test/helpers/meetingAudioTimeline.test.ts test/helpers/meetingCaptureRecovery.test.ts test/helpers/meetingAudioParts.test.ts test/helpers/meetingProcessing.test.ts test/helpers/meetingRecordingSession.test.ts test/helpers/meetingAudioActivityMonitor.test.ts test/helpers/meetingAutoEndController.test.ts test/cases/recording/unit/meetingPcmProcessor.test.ts test/cases/recording/integration/meetingMicrophoneSelection.test.ts test/stores/meetingRecordingStoreAutoEndStop.test.ts test/cases/recording/unit/meetingClockSync.test.ts test/cases/recording/integration/meetingMicGate.test.ts test/cases/recording/integration/meetingIntentionalIntervals.test.ts test/cases/recording/native/audioTapClockProbe.test.ts
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
Recording session/paused restore, analyser/audio activity/detection/warm hold,
settingsStore mic device/idle hold; M5 controls consume M1 manual intent API.

#### 5.1.6 Pre-response/loading/success/error/empty states (when applicable)

Mic: requested transition → gate/tail drain → muted/active on held device;
acquiring/reconnecting только при Start или реальной device change/failure.
Manual/platform gate reasons показываются раздельно. Failed drain
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
  Injected migration failure доказывает rollback, не partial cutover. Upgrade
  isolated develop profile проверять после сохранения копии закрытого profile;
  downgrade только restore копии, без запуска old binary на migrated DB.
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
  Existing transcriptFormatter.ts / transcriptionDataIpcHandlers.ts exports
  (TXT/SRT/MD/JSON) используют итоговые speaker mappings и manual priorities;
  не включать raw roster/evidence. Audio retention оставляет recording metadata/
  names/decisions при удалении audio; Note deletion каскадно удаляет их.
  Existing retention/delete/export API и сроки сохраняются.
- Обновить current platform sections docs/record-then-process.md,
  docs/architecture.md и implementation/verification section
  docs/zoom-speaker-prototype.md, сохранив historical measurements. Не строить
  browser transport и не доказывать live Meet attribution synthetic fixtures.

#### 5.2.3 Acceptance criteria

AC8–AC10: synthetic Meet/Zoom evidence используют общий matcher и корректные
policies/partOffsets; gaps/ambiguity оставляют aliases с причиной. Старые Zoom
rows/decisions/corrections survive migration/reopen. User/voice/manual rename
races и все UI/CLI/LLM projections сохраняют priorities и concrete provenance.
Audio expiry сохраняет Note/имена/evidence, Note deletion удаляет их, export
согласован с итоговыми именами. Migration rollback/reopen и test-profile restore
проверены; новый backup/retention/export subsystem не создаётся.
Ни один test не зависит от runtime legacy Zoom API.

#### 5.2.4 Verification

Расширить существующие Zoom matcher/evidence fixtures общими platform cases,
не удалять их негативные assertions. Unit: episodes vs heartbeat, name changes,
duplicate IDs/names, multi-active/self/soleRemote, calibration/gaps/rate/overlap.
Integration: old DB → migration → reopen/retry/selection/cancel/delete,
atomic decisions и revisions. Consumer tests через existing transcript/prompt/
CLI harness, без layout/screenshot tests.
Расширить `test/helpers/meetingRecordingRetention.test.ts`: audio expiration/
delete-all vs Note deletion проверяют platform observations/decisions/corrections.
`test/helpers/transcriptFormatter.test.ts` проверяет финальные имена во всех
существующих форматах и отсутствие добавленного raw evidence. Migration fixture
с failure injection проверяет rollback/reopen; isolated profile copy/restore
обосновывает documented downgrade procedure, без автоматического backup runtime.

```sh
pnpm test -- test/cases/recording/unit/zoomSpeakerMatcher.test.ts test/cases/recording/integration/zoomSpeakerEvidence.test.ts test/cases/recording/native/zoomCollectorLifecycle.test.ts test/helpers/meetingProcessing.test.ts test/helpers/meetingRecordingRetention.test.ts test/helpers/transcriptFormatter.test.ts test/helpers/noteTranscriptReader.test.ts test/components/meetingResultsPanel.test.ts test/components/meetingTranscriptChat.test.ts test/utils/llmTranscript.test.ts test/cases/transcription/unit/meetingPromptEvidence.test.ts test/scripts/gristmillCli.test.ts
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
  CallRef (platform/installation/session/tab/document/call), connection scoped
  main identity, monotonic source timestamps,
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
  App profile credential не определяет Chrome profile. Native host argv даёт
  extension origin, не verified Chrome Profile N; каждому authenticated native
  connection main назначает отдельную identity, extension installation/session
  не заменяет её. Одинаковые tab IDs/call URL в нескольких profiles не collide;
  connections остаются отдельными кандидатами, selection/binding — M4.
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
  absolute resource path. Pinned public manifest key → stable Dev ID;
  private key вне repo/package. Единственный host name этой задачи —
  com.khakhalev.gristmill.companion.dev; prod host/ID/manifest не создавать.
  Registration только для точных IDs, managed marker/ownership; installer
  test target явно isolated. Не перезаписывать чужие manifests/launchers.
  Chrome Stable NativeMessagingHosts лежит в user-data root, не Profile N.
  Один manifest обслуживает все browser profiles этого root; explicit smoke
  root отдельный temporary user-data-dir. Не менять real registration в тестах.
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
Installer refreshes only owned Dev registration; Dev/test vs production profile
isolation работает, production identity/registration не поставляются.
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
Transport integration добавляет две native connections с одинаковыми browser
tab IDs/call URL: distinct identities/snapshots, EOF одной не закрывает другую.
Installer доказывает один manifest на root, без per-Profile N registrations.

```sh
pnpm test -- test/cases/platform/unit/companionProtocol.test.ts test/cases/platform/unit/companionWorker.test.ts test/cases/platform/integration/main/companionTransport.test.ts test/cases/platform/integration/companionHostInstallation.test.ts test/cases/platform/integration/installAgentCli.test.ts
pnpm run typecheck
pnpm run build:main
pnpm run build:companion
```
`build:companion` создаётся в M3 как esbuild command producing extension build
и Dev installable extension package; документировать его в project
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
  Добавить late-binding confirmation intent с expected recording/session и
  точным кандидатом; context unavailable since/deadline/reminder status, scoped
  reminder Stop action. Reminder timer принадлежит main, UI отображает статус.
  M1 manual mic API доступен для любой записи, без обязательного browser binding.
  Changed runtime contract в meetingCoordinatorIpcHandlers.ts:
  requestSafeStop(options с expected recording/session, reason и suppressProcessing),
  current recording scope для administrative callers; direct cutover quit/
  delete-all в ipcHandlers.ts и их tests, без bool alias. Pending stop keyed by
  expected scope, mismatch не останавливает и не переиспользует чужой promise.
  Detection/Restart contracts в meetingCoordinator.ts/meetingDetectionEngine.ts/
  meetingAutoEndLifecycle.ts: bound-session suppression, platform leave reason,
  single existing 30 s Restart offer и fresh/new-session restore semantics.
  Main owns selection/binding/action validity; extension/renderer snapshots не
  authority. M5 consumes эти stable selection/status/control contracts.
- `extension/src/meetAdapter.ts` — единственный adapter в static
  registry; content-script TS entry isolates DOM. Versioned sanitized RU/EN
  fixtures, не dumps real meetings. Собрать participants/self/count/presence,
  full active set, mute known/unknown и positive confirmed leave. Identity по
  participant ID + document/session, не по display name/DOM order. Self/count/
  soleRemote hints не становятся доказательством для names.
  Meet UI health: recognized vs unrecognized/unreadable с cause; пропавшие
  selectors не означают пустой roster, unmute или leave. Обычная и встроенная
  Meet Companion вкладки одного call — отдельные кандидаты/capabilities;
  отсутствие mic controls в Companion mode означает unknown/unsupported mute,
  не подтверждённый mute. Breakout/return transition без positive leave даёт
  gap/new generation; same selected call после fresh checks восстанавливается,
  другой call требует selection. Evidence через переход не экстраполировать.
- MutationObserver/coalesced scan и bounded periodic refresh; detach on redraw/
  pagehide/worker connection changes. Обнаруживать уже открытый document PiP,
  enter/close lifecycle; скрытые/unreadable contexts дают unknown/gaps. Camera
  off, partial roster, duplicate/renamed names, screen sharing/Pin/PiP/multi-active
  не дают ложного single speaker. Не менять video/layout, не открывать PiP самим.
- Main `companionCoordinator.ts` подключить к recording coordinator: CallRef
  candidates + explicit selection, fresh binding к recording/session/profile.
  Start не блокируется отсутствием optional Companion. Один fresh candidate
  автоматически только на independent Start; несколько требуют selection.
  После Start любой кандидат требует confirmation с fresh recheck при ответе;
  до этого никакого mic/evidence/auto-end влияния. Cancel/stale confirmation
  не создают binding. New document/rejoin same
  selected tab/call → fresh validated binding/generation; wrong call/event ignored.
  Per-Note parts сохраняют собственный platform/binding и offsets.
  Если выбранный fresh call уже muted на Start, initial platform intent передать
  M1 gate до первых mic samples. Позднее подтверждение применяет fresh mute
  только со своей actual frame boundary, не переписывает уже сохранённое аудио.
  Binding commit и stop claims serialize на recording lifecycle: не bind
  stopped/draining session. Binding инвалидирует queued heuristic request;
  уже принятый Stop выигрывает, поздняя confirmation отвергается. Engine,
  renderer auto-end dispatch и coordinator проверяют актуальную policy/scope,
  чтобы queued owner message не обошёл bound-session suppression.
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
  Bound Meet session отключает engine heuristic auto-end при healthy/unknown/
  disconnected/disabled Companion до конца этого session. Обычные непривязанные
  записи сохраняют controller/audio activity/warm hold правила. После успешного
  safe Stop по Leave reuse MeetingRecordingMount/meetingRecordingSession /
  engine notification lifecycle: одна карточка, причина platform leave, 30 s
  Restart; failed drain/finalize — честная ошибка, без success offer.
  Restart сохраняет manual intent и Note/group, создаёт новую часть/session;
  старые binding/platform mute/leave events не наследуются. Fresh прежний call
  на Restart допускает новый binding; без него обычный unbound auto-end и
  existing 5 min restart grace. Другой call не auto-select, поздний same-call
  rejoin требует confirmation. До/после 15 s gate отменять stale processing
  новой частью, сохраняя artifacts и полный chronological source set.
  Notification union/model/overlay поддерживают platform leave reason;
  новые Restart/reminder strings во всех 11 локалях добавить здесь для этих
  consumers; остальные settings/recording strings поставляет M5.
- Unavailable context reminder: main держит один 5 min deadline на bound
  session/непрерывный обрыв, reuse windowManager/MeetingNotificationOverlay /
  MeetingNotificationCard, не новая queue. Fresh reconnect reset; Stop/session
  replacement/disable invalidate. Sleep/resume проверяет expired deadline один
  раз. Reminder action validated by expected scope и requestSafeStop, не
  автоматически; отображение/refinement и оставшиеся strings в M5.
- Docs/google-meet-companion.md: adapter evidence/fixture version, source clock,
  validity/gaps/unknown UI/room transition/late confirmation, auto-end arbitration,
  scoped safe Stop, Restart и reminder semantics. Video hooks excluded.

#### 5.4.3 Acceptance criteria

AC2–AC9/AC11/AC12: выбранный fresh call управляет только своей записью; reload/
rejoin восстановлены, wrong/stale call не действует. Explicit disable resumes
platform-muted mic only, disconnect preserves state. Real DOM fixtures produce
bounded evidence with uncertainty and full active set; positive leave drains
bound capture. Store/coordinator/worker integration показывает names после
normalization, manual priorities и evidence failures не мешают transcription.
Live DOM recognition/indicator accuracy всё ещё проверяется в M6.
Late confirmation не захватывает live/in-person recording молча. Queued
heuristic stop и Leave/Stop/binding race имеют один актуальный winner и одну
notification. Restart без прежнего call остаётся unbound с ordinary grace.
Unknown UI/Companion mode/room transition не дают false control/leave;
5 min reminder не меняет gate/auto-end, stale reminder action не Stop.

#### 5.4.4 Verification

Native test `test/cases/recording/native/meetAdapterDom.test.ts` запускает
собственный GUI Electron subprocess по existing pattern
`test/helpers/devRendererOrigin.test.ts` + `devRendererOriginElectron.ts`.
TS helper `test/helpers/harness/meetAdapterElectron.ts` компилируется installed
esbuild во временный CJS, actual adapter — во временный browser bundle. Electron
получает fresh temporary userData/sessionData, без ELECTRON_RUN_AS_NODE,
создаёт hidden BrowserWindow и загружает sanitized HTML/CSS fixtures из
`test/fixtures/meet/` (RU/EN/camera-off/duplicate/partial/multi-active/sharing/
meet-companion-mode/breakout-return/unrecognized-ui).
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
Binding unit cases: two Chrome profiles same tab/call IDs, normal + Meet
Companion tabs, independent Start vs late candidate, confirmation/cancel/stale
scope and live meeting → unrelated Meet with zero effect until confirmation.
Existing meetingDetectionEngineAutoEnd/meetingAutoEndController/
meetingAutoEndLifecycle/meetingRecordingSession tests: suppression on bound
and context loss, queued auto-end vs bind/Stop/Leave, single offer, ordinary
auto-end unchanged; Restart before/after 15 s gate/30 s expiry, fresh/absent/
different previous call, late rejoin confirmation. Coordinator tests include
expected scope at dispatch/pending-promise reuse/drain timeout, quit/delete-all
callers. Controlled main clocks test 5 min reminder/reset/invalidation/resume
and stale actions; windowManager/model tests verify existing notification path.

```sh
pnpm test -- test/cases/recording/native/meetAdapterDom.test.ts test/cases/recording/unit/companionBinding.test.ts test/cases/recording/integration/companionCapture.test.ts test/cases/recording/unit/meetingClockSync.test.ts test/helpers/meetingCoordinatorIpc.test.ts test/helpers/meetingCoordinatorBridge.test.ts test/helpers/meetingDetectionEngineAutoEnd.test.ts test/helpers/meetingAutoEndController.test.ts test/helpers/meetingAutoEndLifecycle.test.ts test/helpers/meetingRecordingSession.test.ts test/helpers/meetingRecordingRetention.test.ts test/helpers/transcriptionDataDeleteAllAudio.test.ts test/helpers/windowManagerMeetingNotification.test.ts test/helpers/meetingNotificationModel.test.ts test/locales/translationCoverage.test.ts test/stores/meetingRecordingStoreAutoEndStop.test.ts
pnpm run typecheck
pnpm run build:companion
```
Tests prove AC2–AC9/11/12 на доступных границах; popup/user flow — M5;
actual packaged transport/hardware и live indicators — M6.

#### 5.4.5 Consumer surfaces impacted

Meet content script/PiP/worker, main bindings/native probe, renderer mic/Stop,
recording-owned evidence and post-Stop processing/Zoom isolation.
meetingDetectionEngine/controller/audio activity/warm hold, MeetingRecordingMount,
meetingRecordingSession, scoped safe Stop administrative consumers, notification
model/overlay/window manager и Restart translations всех locales.

#### 5.4.6 Pre-response/loading/success/error/empty states (when applicable)

No call → ordinary unbound capture; late candidate → awaiting confirmation без
control/evidence effects; candidates at Start → auto-one/awaiting selection.
Fresh selected/confirmed call →
bound; replacing document → unavailable pending fresh checks, then bound.
Mute unknown/context stale → no new command, сохранение effective gate +
manual control. Leave pending → draining → finalized, or truthful incomplete.
Invalid evidence → gaps/aliases, capture/processing continues.
Unrecognized UI/room transition → explicit unknown/gap, не inferred leave.
Unavailable ≥5 min → one reminder/optional manual Stop; reconnect clears deadline.
Leave finalized → Restart offer 30 s → restarted same Note/new session or expired;
no previous call → ordinary unbound + existing grace, later call → confirmation.

### 5.5 M5 — Пользовательский flow и packaged wiring

#### 5.5.1 Depends on

Depends on: M4.

#### 5.5.2 Scope

- Contract sync. Contracts consumed: M4 candidates/select-call/binding snapshot/
  late confirmation/reminder/scoped Stop, M1 manual intent API/effective gate,
  M2 concrete provenance,
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
  call selection при нескольких candidates и confirmation любого late candidate.
  Confirmation до binding, с cancel и fresh scope recheck, без влияния на уже
  идущую запись до согласия. Disabled toggle объясняет
  возобновление platform-muted mic; manual mute отдельно от platform state.
- Recording UI [MeetingRecordingPill](../../src/components/notes/MeetingRecordingPill.tsx)
  и functional popup: connection/call/recording/mic state, capability freshness,
  context stale/unknown и ручной mic control; no extra dashboard/results tab.
  Existing Transcript names/source/error coverage reuse M2. Новый manual mute
  control в NoteRecordControl.tsx + NoteEditor/PersonalNotesView wiring и pill
  доступен также при off/uninstalled Companion; keyboard/ARIA label и отдельные
  manual/platform/effective reasons. Pause/Resume/reopen paused Note/Restart
  используют M1 intent, independent Start reset. Unmute manual не обещает
  active mic при оставшемся platform gate; disable снимает только platform.
  Explain held-device/system mic indicator, system capture continues.
  M4 one-shot 5 min reminder отображается на существующей notification surface
  с ручным scoped Stop и dismiss, без auto-stop/нового dashboard. UI/docs различают
  «Gristmill Companion» и встроенный «режим Companion в Google Meet».
  Все новые desktop UI keys во всех 11 current locales (`src/locales/*`),
  placeholders/plural categories сохраняются; RU/EN относится к Meet DOM fixtures.
- Settings enabled state → M4 complete feature lifecycle; установленные actions
  не feature toggles. Installation только Dev; explicit
  test runtime supplies isolated Chrome registration target. Main startup refresh
  только own previously installed host registration; uninstall removes only own
  artifacts. Нет broad global registration при explicit test profile.
- Package resources/entrypoints via [electron-builder](../../electron-builder.json)
  и [Dev config](../../electron-builder.dev.cjs); extension build/keys/IDs match
  allowed origins. Packaged runtime works without external Node/Go and survives
  app relocation/reinstall; Dev/test sockets/manifests не трогают production.
- README: install extension/enable/Start/call selection/mute/manual override/
  disable/rejoin/reconnect/errors. docs/google-meet-companion.md: concrete paths,
  Chrome permissions/identity/installer/update/uninstall/troubleshooting.
  Late confirmation, reminder/manual controls/intent lifetime, Restart без
  in-call и late rejoin, Chrome Stable/multi-profile scope, unknown UI/room
  transitions, retention/export и migration/downgrade через pre-upgrade copy.
  Production identity/Store отдельны; не документировать их как проверенные.
  project-commands.md documents build:companion and isolated package launch.

#### 5.5.3 Acceptance criteria

AC1–AC3/AC6/AC9/AC12/AC13: single toggle drives all functions, no silent call
selection; popup/desktop reflect authoritative state incl app closed, host missing,
wrong profile/version/unknown evidence. Installation detects success/error,
manual mute/rename maintained. Packaged resources/run flags/IDs inspectable;
real Chrome/native connection and relocation proven at M6.
Manual controls работают без Companion, подтверждение late call защищает
живую запись, notification Stop scoped; новые locale keys complete во всех 11.

#### 5.5.4 Verification

Integration `test/cases/settings/integration/companionSettings.test.ts`: existing
renderer harness with typed bridge mocks, toggle/disable effect text, install
failure, multi-call selection, fresh reconnect and manual priority. Recording
surface behavior in `test/cases/recording/integration/companionUi.test.ts`:
state→visible label/control and keyboard flow; без CSS/layout snapshots.
Use existing rendererTestHarness/mountPanel-style event harness: actual
NoteRecordControl/pill and NoteEditor/PersonalNotesView wiring; manual toggle
off/uninstalled Companion, platform OR manual state, intent restored до samples,
late candidate confirmation/cancel/stale result and reminder Stop/dismiss.
Existing meetingNotificationModel/windowManager tests покрывают reason/reminder
rendering. translationCoverage проверяет все locales, не только RU/EN.
Extend worker/installer tests for authoritative snapshots/relocation/profile.

```sh
pnpm test -- test/cases/settings/integration/companionSettings.test.ts test/cases/recording/integration/companionUi.test.ts test/cases/platform/unit/companionWorker.test.ts test/cases/platform/integration/companionHostInstallation.test.ts test/helpers/meetingNotificationModel.test.ts test/helpers/windowManagerMeetingNotification.test.ts test/locales/translationCoverage.test.ts test/components/meetingTranscriptChat.test.ts
pnpm run typecheck
pnpm run build:renderer
pnpm run build:companion
```
Manual isolated dev review: no call → Start → late candidate confirm/cancel,
live recording → unrelated Meet без actions до confirmation; one/multiple calls
at Start; off Companion manual mute → Pause/Resume/reopen/Restart/reset Start;
bound call → mute/manual
mute → disconnect/rejoin → disable → confirmed leave → Transcript badge/name
edit. UI mock pass не packaged/hardware evidence; package only once M6.

#### 5.5.5 Consumer surfaces impacted

Settings/onboarding, recording controls/status, extension popup, call selection,
Transcript, NoteRecordControl/NoteEditor/PersonalNotesView/pill, notification
model/overlay/card, all 11 app locales, settingsStore, Dev package registration.

#### 5.5.6 Pre-response/loading/success/error/empty states (when applicable)

Off/install absent → explanation/install; installing/connecting → pending;
validated connection → connected. Missing host/app/profile/version mismatch →
конкретная причина/repair action, не Connected. No Meet → connected/no call.
Multiple → selection, late candidate → awaiting confirmation, cancel → unbound;
same-call bound rejoin → reconnecting/bound. Unavailable 5 min → reminder,
user Stop pending → draining/finalized, never timer-based Stop. Manual muted
with Companion off remains visible/controllable. Unknown speakers →
честный unavailable status с usable transcript, manual names без badge.

### 5.6 M6 — Integrated verification и Dev verification report

#### 5.6.1 Depends on

Depends on: M5.

#### 5.6.2 Scope

- Contract sync. Integrated verification существующего scope, без нового runtime.
  Contracts produced/changed: финальные measured timing policies и truthful
  verification/Dev installation documentation. Contracts consumed: M1–M5.
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
  Добавить Start до join/late confirmation/cancel/live meeting → unrelated Meet,
  normal + Meet Companion вкладки, multi-profile same-call, unrecognized UI,
  breakout/return без false leave и reminder через 5 min context loss; sleep/
  resume без серий notifications. Leave → Restart до/после processing gate,
  без in-call → unbound/grace → late rejoin confirmation. Manual mute без
  Companion/Pause/Resume/Restart/новый Start подтверждает intent lifetime.
- Hardware matrix: встроенный/wired mic и Bluetooth/AirPods, push-to-talk и
  реальный devicechange. Для известной local speech последовательности измерить
  unmute event → DOM observation → gate boundary → первый записанный frame:
  P50/P95/max, потерянное начало речи, glitches и false device recovery.
  Метод/версии/результаты/ограничения сохранить. Это measurement outcome без
  pass/fail порога для onset loss: величина сама M6 не блокирует и нулевую потерю
  не обещаем. Выполнение measurement обязательно; functional no-muted-PCM,
  tail/system continuity и корректный frame placement проверяются отдельно.
  Не измеренные AirPods/hardware не обозначать pass, required scenario unverified.
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
- Package Dev registration/ID, allowed origin и managed app relocation/update/
  uninstall в isolated copy; two Chrome profiles/native connections в одном
  test root не смешивают bindings. Production host/identity/Store zip/item/
  verification не готовить и не выдавать за результат задачи.
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
completion. Onset loss — измерение без порога; functional checks и measured
attribution bounds — pass/fail. Поставлен проверенный Dev path; production
identity/Chrome Web Store verification остаются отдельной задачей.

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
| AC2 Toggle/new universal manual mute/intent | M1 intent/gate restore/reset, M4 disable, M5 controls/11 locales, M6 hardware |
| AC3 Binding/late confirmation/profiles/rejoin | M4 binding, M5 confirmation, M6 live join/rejoin/live meeting |
| AC4 Held-device gate/discarded frames/onset measurement | M1 actual worklet/epochs, M4 actions, M6 hardware measurement без loss threshold |
| AC5 Durable intentional intervals/empty mic | M1 storage/provider stages, M6 full-call muted |
| AC6 Manual/stale/recovery/unknown/reminder | M1 races, M4 suppression/timer/scoped Stop, M5 UI, M6 live |
| AC7 Scoped Leave/Restart/unbound/grace/processing | M1 intent/Pause, M4 Leave/races/Restart/new parts, M5 cards, M6 live |
| AC8 Conservative names/clock/gaps | M2 matcher, M4 DOM/sync, M6 measured accuracy |
| AC9 Priorities/provenance/revision | M2 persistence/UI/CLI/LLM, M5 consumers, M6 restart |
| AC10 Migration/retention/export/downgrade | M1 epoch/mute cutover, M2 Zoom/rollback/retention/export, M6 full suite |
| AC11 Privacy/trust boundaries | M3 framing/guards, M4 stale actions, M6 package inspect |
| AC12 Reconnect/update/cleanup | M3 worker/host, M4 observer/binding, M6 real lifecycle |
| AC13 Dev ID/install/profiles/relocation | M3 installer/Dev key, M5 package wiring, M6 Dev smoke; production/Store out of scope |
| AC14 Reproducible truthful evidence | Each milestone report + M6 final evidence |

## 7. Execution order (derived from dependencies)

M1 → M2 → M3 → M4 → M5 → M6 → final Code Reviewer → approved corrections.
Не начинать Act без утверждения этого plan. Commit boundaries по milestones,
не требовать parallel work/ownership. После ошибки сначала failing focused
selection; не повторять full suite для comment-only corrections.

Shared commands: pnpm test через canonical runner (≤2 ordinary processes,
compiler/native/shared resources sequential); exact .test.ts paths либо domain
selectors, не combined. New tests TypeScript в `test/cases/<domain>/<kind>/`,
compiled-main tests под `main/`, shared resources под `serial/`; special/multi-domain
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
| M6 — Integrated verification и Dev verification report | not started | |
| Reviewer | not started | |
| Code Reviewer | not started | |
