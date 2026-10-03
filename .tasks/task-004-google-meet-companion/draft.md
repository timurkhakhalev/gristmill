# task-004 — Gristmill Companion для Google Meet (Draft)

Дата: 2026-10-01. Статус: утверждён для Plan; реализация не начата.
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

Функции #125 входят в одну задачу. Production identity и Chrome Web Store
verification вынесены отдельно. Clock sync и mic lifecycle — первые проверяемые
этапы этой поставки. Сохраняется один task PR в `develop` с последовательными
milestones; отдельные промежуточные PR не требуются.

## 2. Объём

- Первое Chrome MV3 расширение: Meet content script, service worker, popup,
  обнаружение уже открытого PiP и корректное освобождение observers/listeners.
- Meet adapter: presence, participants/self, active speaker sets, mute и
  confirmed leave. RU/EN, camera off, одинаковые имена, неполный roster,
  несколько активных speakers, redraw/reload и скрытый контекст. Встроенный
  Meet Companion mode, room transitions и нераспознанный UI проверяются на
  отсутствие ложного mute/leave и смешивания evidence.
- Собственный Native Messaging host, ограниченный локальный transport,
  установка/проверка Dev registration и packaged Dev runtime.
- Привязка текущей записи к точному звонку, актуальность событий, reconnect,
  clock sync и сохранение bounded observations.
- Обобщение существующего Zoom evidence pipeline с сохранением исторических
  данных; post-ASR attribution, provenance в UI/Notes CLI/LLM material.
- Реальный mic-only mute, сохранение намеренных интервалов и правильной
  временной шкалы, ручное управление mic и confirmed leave → safe Stop.
- Новый manual mic mute для любой записи: controls в панели записи Note и
  recording pill, независимо от включения Companion.
- Onboarding/Settings, состояния связи и записи, переводы новых app UI keys
  во всех 11 текущих локалях и изолированная packaged/live Dev проверка.

## 3. Не входит

Телемост, KTalk и другие adapters/domains; поддержка других браузеров или ОС;
watermark, self-video overlay, virtual webcam, изменение камеры/video/layout;
MAIN-world injection, перехват `getUserMedia`, WebRTC или media streams страницы;
OCR/чтение экрана; Meet REST API/OAuth, backend, hosted sync или бот в звонке;
ASR во время capture, новый dashboard, runtime plugin framework или legacy shims.
Production extension ID/public key/allowed origins, создание draft item,
Chrome Web Store verification, store release preparation, публикация и
production rollout — отдельная задача. Beta/Canary и другие Chrome channels
не входят в обязательную матрицу: проверяется Google Chrome Stable.
Код и assets Granola не копируются; статический анализ служит исследованием.

## 4. Ограничения и фиксированные решения

### Продукт и управление

1. Первая платформа — Google Chrome Stable + macOS Apple Silicon;
   сервис — Google Meet. Несколько Chrome profiles поддерживаются одновременно.
2. Один пользовательский переключатель Companion включает все функции:
   имена, mute-sync и auto-stop. Отдельных feature toggles нет. Capabilities
   и здоровье конкретных наблюдений отображаются как статус, не как настройки.
3. Запись начинает пользователь. Companion сам не запускает capture или ASR.
4. Единственный свежий in-call кандидат привязывается автоматически только
   при самостоятельном Start с включённым Companion. Если запись уже идёт,
   появление любого кандидата требует подтверждения пользователя до binding,
   даже при одном кандидате или совпадении Calendar URL. До подтверждения mic,
   auto-end и evidence записи не зависят от этого кандидата. Несколько
   кандидатов всегда требуют выбора, в том числе вкладки одного call в разных
   profiles или обычная вкладка вместе с Meet Companion mode. Calendar URL —
   hint; active tab и совпадение call URL не разрешают неоднозначность.
   Подтверждение повторно проверяет свежесть кандидата и expected session;
   закрытие/отмена предложения ничего не привязывают.
5. После reload/rejoin того же звонка в выбранной вкладке привязка
   восстанавливается автоматически только по свежему контексту. Новый
   document/session получает новый binding и clock sync. Старые события
   не действуют; выбор другого звонка не происходит молча.
6. При выключении Companion mic, остановленный platform mute, возобновляется
   как обычная запись Gristmill; этот эффект явно указан у переключателя.
   Новый ручной mic mute сохраняется и выигрывает platform unmute.
   Он доступен для любой записи, включая выключенный/неустановленный Companion:
   кнопка в `NoteRecordControl.tsx` и `MeetingRecordingPill.tsx`, с состоянием
   и доступной keyboard/ARIA подписью. Это recording control, не feature toggle.
   Manual intent сохраняется при Pause/Resume (включая reopen paused Note) и
   Restart, но сбрасывается при новом самостоятельном Start. Restore происходит
   до первых samples. Effective gate закрыт, если manual или platform mute
   активен; снятие manual mute не обходит оставшийся platform gate. Отдельная
   настройка или глобально сохраняемый mute default не добавляются.
7. Обрыв transport, закрытие вкладки, page unload или heartbeat timeout
   означают context unavailable. Они не являются confirmed leave, не
   останавливают запись и не включают platform-muted mic автоматически.
   Свежий reconnect восстанавливает sync; при отсутствии связи доступно ручное
   управление. Explicit disable из п. 6 отличается от непреднамеренного обрыва.
   Пока запись привязана к Meet, эвристический auto-end (`mic-released`,
   `silence`, `process-exit`) отключён, включая context unavailable: завершить
   её могут только confirmed leave или ручной Stop. Получивший привязку session
   инвалидирует уже ожидающий эвристический stop. Companion disable не
   возвращает эвристический auto-end в этом же session; обычные ещё не
   привязанные записи сохраняют существующие правила auto-end.
   После пяти минут непрерывного context unavailable у bound recording
   показывается одно напоминание «Связь с Meet потеряна, запись продолжается»
   с ручным Stop. Timeout сам запись не останавливает и gate не меняет.
   Fresh reconnect сбрасывает ожидание; очередной непрерывный обрыв может дать
   новое напоминание. Stop/смена session/disable инвалидируют timer и action;
   Stop из напоминания проверяет expected recording/session. После sleep/resume
   просроченное ожидание проверяется один раз, не запускает серию уведомлений.
   Переиспользовать существующую notification surface, без новой очереди.
   Нераспознанный Meet UI получает явный health status, а не пустой roster или
   inferred leave. Breakout/room transition без положительного подтверждения
   выхода даёт unknown/gap, не Stop; новый call не привязывается молча.
   Продолжение того же выбранного call требует fresh presence/generation;
   evidence через room transition не экстраполируется и не смешивает комнаты.

### Capture и время

8. Raw mono mic/system Ogg/Opus остаются раздельными и неизменяемыми:
   32 kbit/s VBR, complexity 0; capture PCM — только в памяти. Capture не
   зависит от браузерного контекста, сети или provider. Ошибки optional evidence
   не блокируют аудио, сохранение транскрипта или Summary.
9. Mic сейчас принадлежит renderer `meetingRecordingStore.ts` (`getUserMedia`
   и AudioWorklet), system — Swift helper через main. Управление mute идёт
   через существующий coordinator к фактическому mic owner. Перенос всего mic
   capture в Swift не требуется этой задачей.
10. Platform mute закрывает gate в mic AudioWorklet до передачи PCM из owner
    worklet и до encoder/storage. Muted samples сразу отбрасываются: не
    буферизуются для replay, не идут в analyser/activity/speaker/provider paths.
    Уже накопленный допустимый tail сохраняется, encoded epoch завершается;
    `MediaStream`/устройство остаются открытыми. System продолжает запись.
    Unmute открывает gate и новую encoded epoch на том же исправном stream,
    без нового `getUserMedia`. Mute применяется сразу, без debounce; частый
    push-to-talk не закрывает/открывает устройство. Gate ack и frame boundary
    определяют действие; DOM detection/transport delay измеряется отдельно.
    Worklet продолжает render-frame счётчик и обработку quanta при закрытом
    gate, включая отброшенные frames. Audio timeline position отличается от
    числа переданных/encoded samples; gate ack содержит actual render-frame
    boundary. Unmute не сжимает mute interval и не откатывается к Date.now.
    Missing input, suspend и новая AudioContext/device generation требуют
    fresh actual-frame anchors и явно отмеченного gap, не выдуманных samples.
    Manual mute выигрывает platform unmute. Фактическая потеря устройства и
    смена device требуют обычного recovery, которое сохраняет закрытый gate;
    intentional mute само не запускает recovery. Late acquisition очищается и
    не прикрепляется к stale/stopped recording. Stop/Pause освобождают stream.
    UI явно сообщает: во время platform mute аудио не записывается, но mic
    остаётся занят и системный индикатор может оставаться включённым.
11. Намеренные mute intervals и mic epoch boundaries сохраняются durable с
    причиной `platform-muted`/`manual-muted`, отдельно от source failures. Reopen/recovery
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
    Уточнение 2026-10-01 по поручению Тимура самостоятельно решить clock blocker:
    raw capture сохраняет непрерывные source-frame coordinates независимо от
    cross-source calibration. Между probes допустима bounded свежая оценка с
    растущей uncertainty; неизвестное alignment сохраняется явно и не вызывает
    Stop. При невозможности доказать выравнивание после Stop processing сообщает
    `audio-alignment-unavailable`, сохраняя оба raw источника и previous artifacts;
    выдуманная смесь и silent source fallback запрещены. Нового ручного alignment
    UI нет. Конкретный контракт и verification находятся в plan.md §5.1.7.
15. Meet indicator delay отдельно от clock error. Начальная Meet policy
    использует гипотезу 300 ms с консервативными guards; Zoom policy сохраняет
    свои значения. Финальные bounds подтверждаются измерением packaged path
    и live indicator timing. Диагностический budget 5 ms из spike не является
    production threshold; synthetic tests не доказывают live accuracy.
16. Confirmed leave использует существующий safe Stop с renderer drain,
    native tail flush/finalization и persisted 15-second processing gate.
    Повторные leave/Stop идемпотентны. Проверка recording/session/binding
    выполняется непосредственно перед действием; другая или не привязанная к
    Meet запись не останавливается. `requestSafeStop` получает expected
    recording/session и причину stop; проверка действует также при ожидании
    drain/timeout и совместном использовании pending stop. Сигнатура меняется
    прямым cutover у всех consumers, включая quit и delete-all-audio.
    После успешного confirmed leave переиспользуется карточка Restart на
    существующие 30 секунд с причиной выхода из Meet, без второй notification.
    Restart создаёт новую часть той же Note и новый session; старые leave
    события не останавливают её. Автоматический rebind только после свежего
    in-call контекста. 15-second processing gate сохраняется: Restart до/после
    его истечения отменяет устаревшую обработку, сохраняя raw audio/артефакты;
    последующая обработка берёт полный chronological source set. Restart не
    возвращает пользователя в браузерный звонок. Неуспешный Stop не показывает
    успешное завершение или Restart offer.
    Если на Restart свежего контекста прежнего выбранного call нет, новый
    session начинается непривязанным с обычным auto-end и существующим
    5-minute restart grace. Старый binding и platform mute не наследуются;
    manual mute наследуется. Fresh presence того же выбранного call уже во
    время Restart допускает восстановление с новым binding; другой call не
    выбирается автоматически. Если прежний call появился после Restart,
    это поздняя привязка из п. 4 и требует подтверждения даже того же call.

### Evidence, имена и сохранность

17. Один typed platform-evidence pipeline вместо копии Zoom pipeline.
    Прямой schema/code cutover сохраняет старые observations, run decisions,
    raw audio и artifacts. Meet и Zoom evidence не смешиваются в одном binding;
    разные recording parts одной Note сохраняют свой источник и offsets.
    Миграция transactional/idempotent: ошибка откатывает изменения, reopen
    сохраняет данные. На develop проверять на копии изолированного профиля;
    перед upgrade сохранять отдельную копию закрытого test profile для возврата
    к прежней сборке. Старую сборку не запускать на мигрированном профиле;
    downgrade требует восстановления копии. Автоматический backup subsystem,
    reverse migration и совместимость со старой схемой не добавляются.
18. Raw evidence принадлежит recording, решения — processing run. Participants
    IDs отличаются от display names; self/count/soleRemote — hints. Полный
    active set сохраняется с ambiguous state, DOM order не определяет личность.
    Имена/evidence — recording metadata: существующий audio retention удаляет
    аудио, но сохраняет их вместе с Note/transcript. Удаление Note удаляет
    observations/decisions/corrections каскадно. Действующие transcript exports
    используют итоговые speaker names; raw roster/evidence не добавляются в
    экспорт. Отдельный срок хранения имён или новый export не вводится.
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
    App profile и Chrome profile не равны. Host registration находится в
    Chrome user-data root и обслуживает несколько Chrome profiles. Каждое
    native connection и installation/session различаются; tab ID/call URL
    сами по себе не идентифицируют caller. Browser profiles дают раздельных
    кандидатов, выбор принадлежит main; чужое connection не наследует binding.
26. Native host registration содержит только реальные allowed extension IDs,
    абсолютный managed executable path и стабильный Dev ID из pinned public key.
    Dev имеет собственные identity/path/socket, не выдаваемые за production.
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
2. Пользователь нажимает Start до или после входа в Meet. Единственный свежий
   кандидат при Start привязывается автоматически; любой появившийся позже
   требует подтверждения. При нескольких пользователь выбирает вкладку/profile.
   Recording UI и popup показывают выбранный сервис/звонок,
   recording/mic state и свежесть speaker observations. В UI использовать
   «Gristmill Companion» и «режим Companion в Google Meet» для разных функций.
3. В Meet mute закрывает gate записи mic, сохраняя открытое устройство;
   system остаётся активным. UI объясняет поведение системного mic indicator.
   Unmute открывает gate, если пользователь не включил manual mute.
   При потере связи UI показывает stale/unknown и позволяет ручное управление.
   Через пять минут без контекста приходит одно напоминание, что запись ещё
   идёт, с возможностью Stop. Manual mic mute доступен также без Companion.
4. Reload/rejoin восстанавливает интеграцию того же звонка после fresh checks.
   Выключение Companion возвращает platform-muted mic в обычную запись;
   ручной mute сохраняется. Последующие browser events не управляют записью.
5. Confirmed leave либо пользовательский Stop сохраняет обе дорожки до конца,
   затем запускается existing post-Stop processing. Кнопка Pause сохраняет
   прежнее поведение. При недостаточном evidence запись/обработка продолжаются.
   После confirmed leave карточка Restart даёт 30 секунд на возобновление
   записи той же Note. Обычный ручной Stop эту карточку не показывает.
   После выхода из Meet Restart продолжает Note непривязанной записью;
   возвращение в Meet позже требует подтверждения привязки.
6. Transcript показывает согласованные редактируемые имена с Google Meet badge.
   При недостаточных данных остаются speaker aliases и объяснимый статус;
   исправленное пользователем имя выигрывает автоматическую attribution.

## 6. Проверки

Проверять observable/persisted outcomes на минимальном подходящем уровне;
следовать [quality steering](../../.memory-bank/steerings/quality.md).

- Unit/DOM fixtures: RU/EN, self/camera off, names/rename/duplicates, partial
  roster, multi-active, PiP, screen sharing, redraw, hidden/reloaded context,
  mute unknown и положительный leave без ложного Stop. Добавить обычную и
  Meet Companion вкладки одного call, breakout/return transition, неизвестный
  UI/сломанные selectors с явным health status и без ложных actions.
- Contract/transport integration: framing fragmentation/partial writes,
  malformed/oversized messages, wrong origin/frame/profile/version,
  replay/order, stale binding, MV3 restart/reconnect, backpressure/EOF,
  owned cleanup, deferred update и изолированная host registration. Несколько
  Chrome profiles/параллельных hosts не смешивают tabs, clock и bindings.
- Clock/binding: RTT/asymmetry/drift/wall-clock jumps, stale sync/gaps/anchors,
  несколько вкладок, другой звонок/recording, reload/rejoin, Stop/Resume,
  recording parts и корректная независимость episodes; Start до join,
  поздний один/несколько кандидатов, подтверждение/отмена/stale confirmation,
  живая встреча → не связанный Meet без влияния до подтверждения и отсутствие
  silent switch на другой call.
- Persistence/processing: migration/reopen старых Zoom data/decisions/audio,
  current-run guards, cancel/delete/retranscribe, name priorities/races,
  UI/CLI/LLM/export provenance и completely-muted mic для каждого affected route.
  Audio retention сохраняет Note/имена/evidence, Note deletion удаляет их;
  migration failure/reopen и восстановление pre-upgrade test profile.
- Capture integration: no mic frames during intentional mute, continuous
  system, exact epoch placement, tail drain/ack, concurrent mute/unmute/Stop,
  devicechange/late acquire, manual priority, disable Companion while muted,
  disconnect при muted/unmuted и duplicate leave/Stop. Проверить gate в реальном
  worklet: muted PCM не передаётся и не сохраняется, старый tail допустим;
  частый push-to-talk сохраняет stream и frame placement. Проверить auto-end
  suppression при binding/обрыве, гонки late bind/queued auto-end/Leave/Stop,
  одну Restart notification, Restart до/после 15 s gate, после 30 s expiry,
  stale session и новые recording parts. Обычный auto-end остаётся рабочим.
  Restart без in-call, same-call late rejoin с подтверждением, чужой fresh call
  на Restart, manual intent при Pause/Resume/reopen/Restart и reset при Start.
  Worklet frame position продолжает расти при muted quanta, encoded count —
  нет; после unmute frame offset включает весь mute interval, wall-clock jumps
  его не меняют. Actual context/device restart создаёт новую generation/gap.
  Context reminder: до/после 5 min, reconnect/Stop/disable и stale Stop action,
  sleep/resume, один notification на непрерывный обрыв. Existing ordinary
  auto-end tests покрывают manual-muted silence: manual mute не выдаётся за
  unavailable device и не отключает существующую auto-end policy.
  Mic ownership/activity monitor и `setMicWarmHold`/settings не путают удержание
  устройства во время записи с существующим idle warm hold/detection policy.
- Новые app UI keys во всех 11 текущих локалях проходят существующий
  `test/locales/translationCoverage.test.ts`; RU/EN — отдельный scope Meet DOM.
- Последовательно выполнить focused tests, lint/typecheck, одну full suite
  после интеграции, renderer build, `pack:dev` и packaged Chrome/native-host
  smoke.
- Live isolated Dev + isolated Chrome: hardware mic/system gate, unmute
  alignment, tail-loss, Pause/Resume/recovery, confirmed leave и Meet names/
  overlap/lag. Второй собственный browser/device с заранее заданным synthetic
  audio допустим для smoke; не требовать группу коллег. Production recordings,
  credentials и исходный OpenWhispr profile не используются как fixtures.
  Hardware matrix: встроенный/wired mic и Bluetooth/AirPods, реальное
  переключение устройства и Meet push-to-talk. Измерить событие unmute →
  первый записанный frame, потерю начала известной речи, P50/P95/max,
  audible glitches и ошибочное device recovery; отдельно DOM/transport/gate.
  Потеря начала речи — measurement outcome без порога pass/fail: отчёт обязан
  содержать метод/результаты/ограничения, а величина сама M6 не блокирует.
  Functional gate, tail и system continuity остаются pass/fail проверками.
  Не обещать нулевую потерю первых слов без live measurements. Если AirPods
  недоступны, этот required hardware scenario остаётся невыполненным.
- Отчёт содержит commands, pass/fail/skip, measured clock/indicator bounds,
  версии app/extension/Chrome/Meet UI, фактически проверенные режимы и unknowns.
  Невыполненный обязательный hardware/package check не считается pass.

## 7. Документация

- README: установка/включение Companion, Chrome/macOS scope, один toggle,
  manual mute, disable/reconnect behavior и диагностика host registration.
  Указать, что manual mute — новая функция для любой записи, где controls,
  как сохраняется intent и когда сбрасывается; late binding confirmation и
  пятиминутное напоминание без автоматического Stop.
- `docs/record-then-process.md` и текущая часть `docs/architecture.md`:
  platform evidence, audio timeline, intentional mute/epochs, safe leave и
  реальный capture ownership, implementation/verification status.
- Документ Companion: protocol/trust boundaries, Dev ID/registration,
  lifecycle, clock policy и измерения, versioned DOM fixtures, packaging,
  relocation/update, cleanup/uninstall, Chrome Stable/profile scope, mic hold
  и Restart/processing semantics, retention/export, migration/downgrade limits.
  Production identity/store verification явно обозначить отдельной задачей;
  не включать фиктивный production ID или непроверенные allowed origins.
- Сохранить [risk probe](../../docs/companion-risk-probe.md),
  [raw measurements](../../docs/companion-risk-probe-results.json) и relevant
  Zoom evidence/verification notes. Findings из spike отделить от live proof.

## 8. Критерии приёмки

| ID | Наблюдаемый результат / защита |
| --- | --- |
| AC1 | Packaged Gristmill и installed extension соединяются в правильном профиле; popup/desktop достоверно показывают connection/call/state и ошибки. |
| AC2 | Один toggle включает весь Companion. Новый manual mic mute доступен для любой записи в Note controls/pill, сохраняется при Pause/Resume/reopen paused Note/Restart и сбрасывается при самостоятельном Start. Disable Companion снимает только platform gate, сохраняя manual intent. |
| AC3 | Только selected fresh call управляет записью; один кандидат при самостоятельном Start привязывается автоматически, любой поздний требует подтверждения, несколько — выбора. До подтверждения чужой Meet не влияет на mic/Stop/auto-end/evidence. Chrome profiles/Meet Companion mode и reload/rejoin требуют точной свежей привязки. |
| AC4 | Muted PCM отбрасывается до передачи/записи; tail и system непрерывность сохранены, устройство остаётся открытым, unmute без getUserMedia. Worklet считает discarded frames и сохраняет реальную позицию на audio timeline. Hardware/PTT/Bluetooth loss/latency измерены и описаны без порога pass/fail для потери начала речи. |
| AC5 | Intentional intervals переживают reopen, отличаются от failures и дают silence в derived timeline; полностью muted mic не ломает system transcription на affected routes. |
| AC6 | Manual mute, stale/late events и recovery не открывают gate самовольно; disconnect, unknown UI и room transition не вызывают Stop или inferred unmute. Через 5 min непрерывного context unavailable приходит одно напоминание с session-scoped ручным Stop; timeout не возвращает эвристический auto-end. |
| AC7 | У bound Meet recording эвристический auto-end отключён; confirmed leave завершает expected recording/session через safe drain/finalize и одну существующую 30 s Restart карточку. Restart сохраняет Note/все части/manual intent; без свежего прежнего call он непривязан, с обычным auto-end/restart grace, поздний rejoin требует подтверждения. Stale processing/events защищены; Pause/Resume и 15 s processing gate сохранены. |
| AC8 | Имена после ASR опираются на bounded независимое evidence и clock uncertainty; ambiguity/gaps оставляют aliases, mic identity/global voiceprint не меняются. |
| AC9 | User/voice priorities и revision guards сохраняются; names/provenance согласованы между Transcript UI, Notes CLI и LLM material, manual rename переживает restart. |
| AC10 | Atomic migration/reopen сохраняют старые Zoom observations/decisions, raw audio, artifacts/epoch offsets; audio retention сохраняет имена/evidence, Note deletion удаляет их. Existing provider/speaker/capture/export сценарии проходят проверки; downgrade выполняется только через pre-upgrade profile copy. |
| AC11 | Browser не получает audio/notes/transcript/secrets; invalid/wrong-profile/stale protocol traffic не выполняет actions и не повреждает capture. |
| AC12 | Reconnect/update/EOF/cleanup не оставляют duplicate observers/processes или ложный Connected; isolated profiles не меняют real registration. |
| AC13 | Установка, стабильный Dev ID/allowed origins, packaged Dev runtime/path relocation и uninstall проверены в изоляции; параллельные Chrome profiles безопасны. Production identity и Chrome Web Store verification явно вынесены в отдельную задачу. |
| AC14 | Focused/full/compile/package checks и обязательные live сценарии подтверждены отдельной воспроизводимой evidence; измеренная область качества имён и remaining unknowns явно указаны. |

## 9. Решения Brainstorm

Материальных открытых вопросов для Draft нет. Тимур выбрал весь #125 одной
задачей; все функции включаются вместе; reload/rejoin восстанавливается
автоматически после fresh checks; explicit disable возобновляет platform-muted
mic. Приоритет manual mute и остальные recording invariants сохраняются.
Эти решения заменяют предложенные в issue отдельные пользовательские flags.
После review Тимур подтвердил автоматическую привязку единственного свежего
кандидата при самостоятельном Start и подтверждение любой поздней привязки,
отключение эвристического auto-end у bound recording с переиспользованием
Restart после confirmed leave, Dev-only identity/store scope и открытый mic
stream с discard gate вместо закрытия stream на каждый platform mute.
При длительном обрыве контекста — одно напоминание через 5 min с ручным Stop,
без автоматического возврата эвристики. Manual mute — новая функция для всех
записей в Note controls/pill с сохранением на Pause/Resume/Restart и сбросом
на самостоятельном Start. Потеря начала речи измеряется без pass/fail порога.
Эта редакция утверждена Тимуром для переноса в Plan. Обновлённый `plan.md`
требует отдельного утверждения перед Act.

## 10. Основа для Plan

Проверенные точки переиспользования: `meetingRecordingStore.ts`,
`activeMicRecovery.ts`, `meetingCoordinatorIpcHandlers.ts`/`requestSafeStop`,
`meetingCaptureSession.ts`, `meetingAudioTimeline.ts`, `meetingAudioMixer.ts`,
`audioTapManager.ts` и Swift capture helper; Zoom collector/matcher/contracts,
`database.ts`, `meetingProcessing.ts`, corrections/Notes CLI/LLM projection;
bundled runtime launcher pattern `installAgentCli.ts`.
Дополнительные direct consumers: `meetingDetectionEngine.ts`,
`meetingAutoEndController.ts`, `meetingAutoEndLifecycle.ts`,
`MeetingRecordingMount.tsx`, `meetingAudioActivityMonitor.ts`,
`audioActivityDetector.ts`, `settingsStore.ts`, `NoteRecordControl.tsx`,
`MeetingRecordingPill.tsx`, `meetingRecordingSession.ts`, retention/deletion IPC и
существующие transcript export formatters. Plan фиксирует produced/consumed
contracts для stop reason/scope, auto-end arbitration, Restart и mic gate.

В spike 2026-10-01 прошли 56 focused tests, test typecheck/scoped lint и
изолированный browser/Swift experiment. Это локальный HTTP relay и собственный
synthetic audio graph с actual PCM worklet, не packaged transport или hardware
проверка. Production capture не изменён. Дополнительные проверки не повторять
без изменения соответствующего behavior или конкретного verification gap.

Plan определит sequential milestones, schema migration, точные contract types,
measured timing bounds и покрытие affected consumers на основе этого контракта.
Текущие этапы Plan: audio clock/mic gate → platform evidence → Dev transport →
Meet/binding/auto-end arbitration → UX/package/locales → integrated/live proof.
Это не разрешение на Act: сначала review и утверждение Draft, затем отдельный Plan.
