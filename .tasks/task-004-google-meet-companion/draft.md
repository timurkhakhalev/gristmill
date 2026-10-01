# task-004 — Gristmill Companion для Google Meet (Draft)

Дата: 2026-10-01. Статус: контракт для review и утверждения; реализация не начата.
Основа: [issue #125](https://github.com/timurkhakhalev/gristmill/issues/125),
родительская [#124](https://github.com/timurkhakhalev/gristmill/issues/124)
и согласованные решения Тимура. Этот документ содержит полный контракт задачи;
решения ниже имеют приоритет над расходящимися предложениями в issue.

## 1. Цель

Пользователь записывает Google Meet в Gristmill. Companion передаёт контекст
выбранного звонка: участников, активность говорящих, mute и подтверждённое
окончание. Mic следует mute, system продолжает записываться. После Stop
обычная обработка выдаёт транскрипт с редактируемыми именами и источником
`Google Meet`. Подтверждённый выход завершает именно привязанную запись без
потери финального аудио.

Весь #125 входит в одну задачу. Clock sync и mic lifecycle — первые проверяемые
этапы этой поставки, а не отдельный продукт или самостоятельная интеграция.

## 2. Объём

- Первое Chrome MV3 расширение: Meet content script, service worker, popup,
  обнаружение уже открытого PiP и корректное освобождение observers/listeners.
- Meet adapter: presence, participants/self, active speaker sets, mute и
  confirmed leave. RU/EN, camera off, одинаковые имена, неполный roster,
  несколько активных speakers, redraw/reload и скрытый контекст.
- Собственный Native Messaging host, ограниченный локальный transport,
  установка/проверка регистрации, разделение Dev/prod и packaged runtime.
- Привязка текущей записи к точному звонку, актуальность событий, reconnect,
  clock sync и сохранение bounded observations.
- Обобщение существующего Zoom evidence pipeline с сохранением исторических
  данных; post-ASR attribution, provenance в UI/Notes CLI/LLM material.
- Реальный mic-only mute, сохранение намеренных интервалов и правильной
  временной шкалы, ручное управление mic и confirmed leave → safe Stop.
- Onboarding/Settings, состояния связи и записи, release preparation и
  изолированная packaged/live проверка.

## 3. Не входит

Телемост, KTalk и другие adapters/domains; поддержка других браузеров или ОС;
watermark, self-video overlay, virtual webcam, изменение камеры/video/layout;
MAIN-world injection, перехват `getUserMedia`, WebRTC или media streams страницы;
OCR/чтение экрана; Meet REST API/OAuth, backend, hosted sync или бот в звонке;
ASR во время capture, новый dashboard, runtime plugin framework или legacy shims.
Публикация в Chrome Web Store и production rollout требуют отдельного запроса.
Код и assets Granola не копируются; статический анализ служит исследованием.

## 4. Ограничения и фиксированные решения

### Продукт и управление

1. Первая платформа — Chrome + macOS Apple Silicon; сервис — Google Meet.
2. Один пользовательский переключатель Companion включает все функции:
   имена, mute-sync и auto-stop. Отдельных feature toggles нет. Capabilities
   и здоровье конкретных наблюдений отображаются как статус, не как настройки.
3. Запись начинает пользователь. Companion сам не запускает capture или ASR.
4. Единственный свежий in-call кандидат привязывается при Start; несколько
   кандидатов требуют выбора. Calendar URL — hint, active tab не выбирается
   автоматически вместо явного разрешения неоднозначности.
5. После reload/rejoin того же звонка в выбранной вкладке привязка
   восстанавливается автоматически только по свежему контексту. Новый
   document/session получает новый binding и clock sync. Старые события
   не действуют; выбор другого звонка не происходит молча.
6. При выключении Companion mic, остановленный platform mute, возобновляется
   как обычная запись Gristmill; этот эффект явно указан у переключателя.
   Ручной mic mute в Gristmill сохраняется и выигрывает platform unmute.
7. Обрыв transport, закрытие вкладки, page unload или heartbeat timeout
   означают context unavailable. Они не являются confirmed leave, не
   останавливают запись и не включают platform-muted mic автоматически.
   Свежий reconnect восстанавливает sync; при отсутствии связи доступно ручное
   управление. Explicit disable из п. 6 отличается от непреднамеренного обрыва.

### Capture и время

8. Raw mono mic/system Ogg/Opus остаются раздельными и неизменяемыми:
   32 kbit/s VBR, complexity 0; capture PCM — только в памяти. Capture не
   зависит от браузерного контекста, сети или provider. Ошибки optional evidence
   не блокируют аудио, сохранение транскрипта или Summary.
9. Mic сейчас принадлежит renderer `meetingRecordingStore.ts` (`getUserMedia`
   и AudioWorklet), system — Swift helper через main. Управление mute идёт
   через существующий coordinator к фактическому mic owner. Перенос всего mic
   capture в Swift не требуется этой задачей.
10. Mute прекращает новые mic samples, сохраняет уже накопленный tail,
    останавливает recovery и закрывает source epoch/stream; system продолжает.
    Unmute открывает новую mic epoch. Настройки устройства и device recovery
    не обходят intentional/manual mute. Late acquisition очищается и не
    прикрепляется к stale/stopped recording.
11. Намеренные mute intervals и mic epoch boundaries сохраняются durable с
    причиной `platform-muted`, отдельно от source failures. Reopen/recovery
    сохраняют смысл этих интервалов. Полностью muted mic — допустимый случай:
    system transcript сохраняется, prepare/ASR/normalize обрабатывают намеренно
    пустой источник явно. Нет fake provider responses или скрытого fallback.
12. В derived timeline mute восстанавливается тишиной. Mute не равен Pause:
    system время продолжается. Pause/Resume сохраняют существующую семантику
    частей Note и не запускают ASR на Pause.
13. Начало/перезапуск дорожек и Meet events привязываются к общей аудиошкале
    через монотонное время и actual-frame anchors. `Date.now()`/UTC и arrival
    time не используются как точное положение события в audio. Уже сохранённые
    исторические epoch offsets не пересчитываются новой эвристикой.
14. Clock sync: nonce round trip от browser monotonic clock к host clock
    настоящего capture helper, offset/rate, upper uncertainty bound, generation
    и freshness; обновление при Start/Resume и периодически, сброс после
    смены документа/helper. RTT, stale sync, потеря seq, missing anchors и
    throttling создают gaps/unknown. Активность через gaps не экстраполируется.
15. Meet indicator delay отдельно от clock error. Начальная Meet policy
    использует гипотезу 300 ms с консервативными guards; Zoom policy сохраняет
    свои значения. Финальные bounds подтверждаются измерением packaged path
    и live indicator timing. Диагностический budget 5 ms из spike не является
    production threshold; synthetic tests не доказывают live accuracy.
16. Confirmed leave использует существующий safe Stop с renderer drain,
    native tail flush/finalization и persisted 15-second processing gate.
    Повторные leave/Stop идемпотентны. Проверка recording/session/binding
    выполняется непосредственно перед действием; чужая или manual/in-person
    запись не останавливается.

### Evidence, имена и сохранность

17. Один typed platform-evidence pipeline вместо копии Zoom pipeline.
    Прямой schema/code cutover сохраняет старые observations, run decisions,
    raw audio и artifacts. Meet и Zoom evidence не смешиваются в одном binding;
    разные recording parts одной Note сохраняют свой источник и offsets.
18. Raw evidence принадлежит recording, решения — processing run. Participants
    IDs отличаются от display names; self/count/soleRemote — hints. Полный
    active set сохраняется с ambiguous state, DOM order не определяет личность.
19. Matcher после ASR/normalize применяет platform names только к system ASR
    clusters: минимум три независимых согласованных speech episodes с минимум
    одной секундой устойчивой речи в каждом и timing guards. Heartbeats одного
    episode не создают новые episodes. Duplicate names, competing speakers,
    mic overlap, uncertain clocks и conflicting evidence сохраняют причины
    отказа. Mic label и global voiceprint не меняются этой attribution.
20. Приоритет `user > voice > platform > model`. Revision/ownership guards
    защищают от manual rename, выбора другого run, отмены и удаления Note.
    Manual rename убирает platform badge и сохраняется после restart.
    UI, Notes CLI и LLM material получают итоговое имя и конкретный источник
    `Google Meet`/`Zoom`, а не только общее значение `platform`.
21. Существующие Notes, blank/manual notes, chat/tools, Dictionary/Snippets,
    календарь, BYOK/Local/поддерживаемые Self-Hosted surfaces, Zoom attribution
    и предыдущие artifacts сохраняются. Нет новых provider fallback/split paths.

### Transport и privacy

22. Existing TypeScript/build toolchain; Meet-specific DOM остаётся в adapter.
    Content script — ISOLATED world, только top frame и Meet domain. Один
    статический adapter registry; будущие adapters не создаются заранее.
23. MV3 permissions: `nativeMessaging`, `storage`, `alarms`, content-script
    matches `https://meet.google.com/*`. Не добавлять широкие permissions или
    неподдержанные domains без доказанной необходимости.
24. Host использует bundled Electron Node-mode runtime отдельным entrypoint,
    а не системный Node/Go или Notes/BB endpoints/token. Native Messaging
    length-prefixed UTF-8 JSON ограничен 64 KiB до allocation; stdout — protocol,
    diagnostics не содержат имён, page dumps или meeting URLs.
25. Profile-scoped Unix socket; directory 0700, socket/credential file 0600;
    отдельный scoped credential host↔main, не доступный content script.
    Main валидирует strict payload schemas/version, extension origin/profile,
    sender tab/frame, connection/binding, sequence и актуальность CallRef.
    Browser не получает raw audio, transcript, notes или provider credentials.
26. Native host registration содержит только реальные allowed extension IDs,
    абсолютный managed executable path; Dev имеет отдельные identity/path/socket.
    Explicit test profiles не пишут real global registration. Installer
    обновляет только свои файлы при перемещении/reinstall приложения.
27. Reconnect получает authoritative main snapshot; cached worker state не
    разрешает actions. Очереди/observations ограничены, EOF/backpressure и
    собственные процессы очищаются. Extension update откладывается до Stop;
    app closed/host missing/version mismatch не показываются как Connected.

## 5. Пользовательский сценарий

1. В Settings/onboarding пользователь устанавливает extension и включает
   Companion целиком. Статус показывает связь либо конкретную причину
   отсутствия связи и способ исправления. DOM-доступ не требует macOS
   Accessibility; mic/system permissions остаются необходимыми.
2. Пользователь входит в Meet и нажимает Start в Gristmill. При необходимости
   выбирает звонок. Recording UI и popup показывают выбранный сервис/звонок,
   recording/mic state и свежесть speaker observations.
3. В Meet mute останавливает mic capture, system остаётся активным. UI это
   объясняет. Unmute возобновляет mic, если пользователь не включил manual mute.
   При потере связи UI показывает stale/unknown и позволяет ручное управление.
4. Reload/rejoin восстанавливает интеграцию того же звонка после fresh checks.
   Выключение Companion возвращает platform-muted mic в обычную запись;
   ручной mute сохраняется. Последующие browser events не управляют записью.
5. Confirmed leave либо пользовательский Stop сохраняет обе дорожки до конца,
   затем запускается existing post-Stop processing. Кнопка Pause сохраняет
   прежнее поведение. При недостаточном evidence запись/обработка продолжаются.
6. Transcript показывает согласованные редактируемые имена с Google Meet badge.
   При недостаточных данных остаются speaker aliases и объяснимый статус;
   исправленное пользователем имя выигрывает автоматическую attribution.

## 6. Проверки

Проверять observable/persisted outcomes на минимальном подходящем уровне;
следовать [quality steering](../../.memory-bank/steerings/quality.md).

- Unit/DOM fixtures: RU/EN, self/camera off, names/rename/duplicates, partial
  roster, multi-active, PiP, screen sharing, redraw, hidden/reloaded context,
  mute unknown и положительный leave без ложного Stop.
- Contract/transport integration: framing fragmentation/partial writes,
  malformed/oversized messages, wrong origin/frame/profile/version,
  replay/order, stale binding, MV3 restart/reconnect, backpressure/EOF,
  owned cleanup, deferred update и изолированная host registration.
- Clock/binding: RTT/asymmetry/drift/wall-clock jumps, stale sync/gaps/anchors,
  несколько вкладок, другой звонок/recording, reload/rejoin, Stop/Resume,
  recording parts и корректная независимость episodes.
- Persistence/processing: migration/reopen старых Zoom data/decisions/audio,
  current-run guards, cancel/delete/retranscribe, name priorities/races,
  UI/CLI/LLM provenance и completely-muted mic для каждого affected route.
- Capture integration: no mic frames during intentional mute, continuous
  system, exact epoch placement, tail drain/ack, concurrent mute/unmute/Stop,
  devicechange/late acquire, manual priority, disable Companion while muted,
  disconnect при muted/unmuted и duplicate leave/Stop.
- Root последовательно выполняет focused tests, lint/typecheck, одну full suite
  после интеграции, renderer build, `pack:dev` и packaged Chrome/native-host
  smoke. Subagents не запускают tests/build/install/native rebuild.
- Live isolated Dev + isolated Chrome: hardware mic/system gate, unmute
  alignment, tail-loss, Pause/Resume/recovery, confirmed leave и Meet names/
  overlap/lag. Второй собственный browser/device с заранее заданным synthetic
  audio допустим для smoke; не требовать группу коллег. Production recordings,
  credentials и исходный OpenWhispr profile не используются как fixtures.
- Отчёт содержит commands, pass/fail/skip, measured clock/indicator bounds,
  версии app/extension/Chrome/Meet UI, фактически проверенные режимы и unknowns.
  Невыполненный обязательный hardware/package check не считается pass.

## 7. Документация

- README: установка/включение Companion, Chrome/macOS scope, один toggle,
  manual mute, disable/reconnect behavior и диагностика host registration.
- `docs/record-then-process.md` и текущая часть `docs/architecture.md`:
  platform evidence, audio timeline, intentional mute/epochs, safe leave и
  реальный capture ownership, implementation/verification status.
- Документ Companion: protocol/trust boundaries, IDs/registration Dev/prod,
  lifecycle, clock policy и измерения, versioned DOM fixtures, packaging,
  relocation/update, cleanup/uninstall и release preparation.
- Сохранить [risk probe](../../docs/companion-risk-probe.md),
  [raw measurements](../../docs/companion-risk-probe-results.json) и relevant
  Zoom evidence/verification notes. Findings из spike отделить от live proof.

## 8. Критерии приёмки

| ID | Наблюдаемый результат / защита |
| --- | --- |
| AC1 | Packaged Gristmill и installed extension соединяются в правильном профиле; popup/desktop достоверно показывают connection/call/state и ошибки. |
| AC2 | Один toggle включает весь Companion; отдельные feature toggles отсутствуют. Disable возобновляет только platform-muted mic и сохраняет manual mute. |
| AC3 | Только selected fresh call управляет записью; неоднозначный выбор требует пользователя; reload/rejoin того же call восстанавливается автоматически с новой актуальной привязкой. |
| AC4 | Platform mute не сохраняет новые mic samples, сохраняет уже накопленный tail, оставляет system непрерывным; unmute занимает правильное место в audio timeline. |
| AC5 | Intentional intervals переживают reopen, отличаются от failures и дают silence в derived timeline; полностью muted mic не ломает system transcription на affected routes. |
| AC6 | Manual mute, stale/late events и recovery не включают mic самовольно; disconnect не равен disable и не вызывает Stop. |
| AC7 | Confirmed leave завершает только bound recording через safe drain/finalize; повторные leave/Stop безопасны, Pause/Resume и processing gate сохранены. |
| AC8 | Имена после ASR опираются на bounded независимое evidence и clock uncertainty; ambiguity/gaps оставляют aliases, mic identity/global voiceprint не меняются. |
| AC9 | User/voice priorities и revision guards сохраняются; names/provenance согласованы между Transcript UI, Notes CLI и LLM material, manual rename переживает restart. |
| AC10 | Миграция сохраняет старые Zoom observations/decisions, raw audio, artifacts/epoch offsets; Notes и existing provider/speaker/capture scenarios проходят проверки. |
| AC11 | Browser не получает audio/notes/transcript/secrets; invalid/wrong-profile/stale protocol traffic не выполняет actions и не повреждает capture. |
| AC12 | Reconnect/update/EOF/cleanup не оставляют duplicate observers/processes или ложный Connected; isolated profiles не меняют real registration. |
| AC13 | Установка, stable Dev/production IDs, allowed origins, packaged runtime/path relocation и uninstall документированы и проверены; store package/data/permission description подготовлены без публикации. |
| AC14 | Focused/full/compile/package checks и обязательные live сценарии подтверждены отдельной воспроизводимой evidence; измеренная область качества имён и remaining unknowns явно указаны. |

## 9. Решения Brainstorm

Материальных открытых вопросов для Draft нет. Тимур выбрал весь #125 одной
задачей; все функции включаются вместе; reload/rejoin восстанавливается
автоматически после fresh checks; explicit disable возобновляет platform-muted
mic. Приоритет manual mute и остальные recording invariants сохраняются.
Эти решения заменяют предложенные в issue отдельные пользовательские flags.

## 10. Основа для Plan

Проверенные точки переиспользования: `meetingRecordingStore.ts`,
`activeMicRecovery.ts`, `meetingCoordinatorIpcHandlers.ts`/`requestSafeStop`,
`meetingCaptureSession.ts`, `meetingAudioTimeline.ts`, `meetingAudioMixer.ts`,
`audioTapManager.ts` и Swift capture helper; Zoom collector/matcher/contracts,
`database.ts`, `meetingProcessing.ts`, corrections/Notes CLI/LLM projection;
bundled runtime launcher pattern `installAgentCli.ts`.

В spike 2026-10-01 прошли 56 focused tests, test typecheck/scoped lint и
изолированный browser/Swift experiment. Это локальный HTTP relay и собственный
synthetic audio graph с actual PCM worklet, не packaged transport или hardware
проверка. Production capture не изменён. Дополнительные проверки не повторять
без изменения соответствующего behavior или конкретного verification gap.

Plan определит sequential milestones, schema migration, точные contract types,
measured timing bounds и покрытие affected consumers на основе этого контракта.
Предварительные этапы: transport/contracts → Meet/binding → clock/platform
evidence → names/provenance → mic gate/safe leave → UX/package/live verification.
Это не разрешение на Act: сначала review и утверждение Draft, затем отдельный Plan.
