# Запись встречи и обработка после Stop (Implementation Plan)

## 1. Scope (what to implement)

Перевести meeting flow на запись двух исходных дорожек без ASR во время встречи. После Stop сохранить хвост, подготовить одну синхронизированную общую копию, обработать её выбранным файловым провайдером с диаризацией и создать заметки. Обеспечить восстановление, сохранение ответов и версий, повтор обработки, воспроизведение/экспорт и настраиваемое удаление аудио.

База исследования: `40d9da0a`. ElevenLabs, Deepgram, Gemini, настройки ключей, маршрутизация и парсеры уже реализованы. Переиспользуем их; исправление timestamps ElevenLabs уже включено. Реализация этого плана ещё не начата.

Исключены: live-транскрипт/черновик, ASR и диаризация при capture, минутные ASR-запросы, overlap/dedup, автоматическое переключение провайдеров, второй обязательный ASR-проход, новые ML-модели, hosted sync/backend, брокер очереди, plugin framework, dashboard сравнения, автоматический benchmark. Качество/цену провайдеров Тимур проверяет самостоятельно после реализации.

## 2. Fixed decisions (must follow)

- Do not introduce fallbacks or backward compatibility unless explicitly requested by the user.
- macOS Apple Silicon, Electron/TypeScript, текущая SQLite и Note как корневая сущность. Сохранить пустые/ручные заметки, чат со всеми текущими инструментами, Dictionary/Snippets, календарь, file/direct URL import, Local/поддерживаемые Self-Hosted и остальные используемые вне meeting flow провайдеры. Не расширять их возможности неявно.
- По разрешению Тимура от 2026-09-24 база ветки задачи и Draft PR — `main`, вместо отсутствующей `develop`. Ветка — `task-001-record-then-process`. В исходном checkout есть незакоммиченные продуктовые документы: не переносить их в коммит автоматически, не перезаписывать; текущая работа изолирована в worktree.
- Оригинальные mic/system сохраняются до AEC/микширования. Один ASR-вход — полная общая mono-копия с сохранённой шкалой времени. Не выдавать номер канала за человека и не соединять источники последовательно. Перебивания/эхо остаются проверяемым Тимуром trade-off; новый AEC не строить.
- Источник может быть недоступен/оборваться: показывать неполноту и интервалы потерь. Тишина не доказывает отказ. Успешный ASR не снимает признак неполной записи.
- Capture не зависит от сети, credentials и моделей. Старые jobs не блокируют новую запись; уже отправленный запрос может закончиться и сохранить ответ. Новые ASR и тяжёлая подготовка/локальная inference ждут окончания capture.
- Закрытие окна скрывает его и сохраняет capture; меню управляет записью. Полный выход требует подтверждения: отмена продолжает capture, подтверждение сохраняет хвост и оставляет обработку следующему запуску. Renderer crash прерывает микрофон; бесшовное продолжение не обещается.
- Process crash на исправном диске: восстановить полученное аудио с потерей не более 1 секунды на дорожку. Обычный Stop сохраняет весь хвост. Сбой ОС/питания/накопителя вне этой гарантии. Disk-full/write failure/недопустимое отставание останавливают capture с явной ошибкой.
- После crash восстановленное аудио обрабатывается автоматически с отметкой о неполноте. Истёкшее аудио сначала удаляется; неподдерживаемый вход/неверный ключ требуют действия пользователя.
- Один запуск использует сохранённые provider/model/config. Секреты разрешаются из текущего credential store, не записываются в job/log/artifact. Не обещать exactly-once оплаты при crash между ответом сервера и локальной фиксацией.
- Хранить исходный ответ до парсинга; нормализация/публикация и summary повторяются без нового ASR. Новая обработка другим провайдером создаёт отдельный результат. Speaker IDs и исправления scoped к результату; совпадение номера не переносит имя. Календарь не доказывает личность.
- Retention: default 7 дней от окончания capture, `0` — бессрочно; сохранённые значения не мигрировать. При recovery брать последний восстановленный timestamp, не дату рестарта. Настройка действует на все записи; уменьшение предупреждает об удалении уже просроченного аудио.
- Audio-only cleanup удаляет raw/производные/временные аудиофайлы, сохраняет текст, raw JSON без аудио, версии и speaker corrections. Note-delete удаляет связанные локальные файлы/результаты/jobs/mappings, но не общие speaker profiles. Экспортированные копии вне managed storage не удаляются.
- Cleanup идемпотентен и продолжается после restart; ошибки видны до фактического удаления. Pending/failed jobs не продлевают retention. Поздний ответ не воскрешает удалённые данные. Удаление активной записи требует остановки и подтверждения; без последующего ASR.
- Предыдущие задачи и принятые ADR — исторические источники, не редактировать. Текущие docs обновлять по фактическому cutover, не добавлять новый ADR без изменения принятого архитектурного решения. MIT attribution сохранить.

## 3. Milestone rules (dependencies)

Milestones выполняются последовательно одним implementer. Каждый завершается своими проверками до следующего. Только root/integrator запускает tests/build/install/native rebuild, последовательно; workers могут typecheck/lint и писать тесты. Не использовать исходный профиль OpenWhispr.

Проверки данных используют временные файлы и отдельную SQLite; mocked API без платных вызовов. Реальную гарантию capture подтверждает macOS smoke, а не только unit test. Пропущенный из-за SQLite ABI тест не считается проверкой данных.

## 4. Milestone index

| ID | Name | Depends on | Notes |
| --- | --- | --- | --- |
| M1 | Хранение записи и результатов | none | SQLite, файлы, recovery и операции удаления |
| M2 | Capture и безопасный Stop | M1 | Оба источника, bounded buffering, окно/quit |
| M3 | Обработка после Stop | M1, M2 | Общий файл, сохраняемый job, три адаптера, summary |
| M4 | Notes, retention и итоговая проверка | M1, M2, M3 | Версии, playback/export, UI и документация |

## 5. Milestone details

### 5.1 M1 — Хранение записи и результатов

#### 5.1.1 Depends on

Depends on: none.

#### 5.1.2 Scope

Contracts produced/changed: типизированные recording/run/result DTO в `src/contracts/meetingRecording.ts`; additive SQLite schema и методы в `src/helpers/database.ts`; файловые операции в `src/helpers/meetingRecordingStorage.ts`, используемые существующим `audioStorage.ts`.

Contracts consumed: Note IDs, текущие транзакции SQLite, app userData и settings retention.

- Определить typed/Zod `MeetingProcessingConfig`: transcription mode (cloud/local), provider, model, language, поддерживаемые vocabulary/dictionary hints, baseUrl только для уже поддерживаемого маршрута, local provider/model/options; summary action/template ID и snapshot текста инструкции, reasoning mode/provider/model, разрешённые endpoint/options и credential references. Данные renderer валидируются в main по существующим route/settings contracts, неизвестные поля отбрасываются, секреты запрещены; произвольный endpoint не создаёт новый provider route. Summary endpoint разрешён только в уже поддерживаемом reasoning mode. Хранить snapshot локально вместе с recording до получения первого audio frame. Credentials reference — существующий key slot, сам ключ main читает из secure store при запуске этапа.
- Renderer строит snapshot текущими settings selectors и передаёт его с capture start, а для явной повторной обработки — с create-run. Capture сохраняется и начинается даже при отсутствующей/неподдерживаемой processing config: записать null/validation reason, initial run будет blocked, сеть и readiness моделей не проверять до capture. Initial run при Stop/recovery копирует сохранённую config записи. Изменение глобальных настроек не меняет pending run; исправление config выполняется явным действием над blocked run с повторной main-validation. Исправление ключа обновляет secure store и разблокирует тот же сохранённый маршрут по retry, не меняя snapshot. При отсутствии summary config ASR может завершиться, summary остаётся blocked. Не подставлять defaults после restart.

- Добавить `meeting_recordings`: id, note_id, capture state, start/end time, source metadata/gaps, directory, audio lifecycle/error. `meeting_processing_runs`: id, recording_id, provider/model/config, stage/status/error/retry time, raw-response path, нормализованный transcript, scoped speaker corrections, summary/config и ссылки на использованный результат. Run одновременно является сохраняемым заданием и версией результата; отдельная универсальная jobs/artifacts система не нужна. Один успешный summary на run; failed retry меняет status/error, не удаляя сохранённый результат. Явная регенерация уже успешного summary создаёт отдельный run с ссылкой на исходный transcript run и начинает с summary, без нового ASR. Все версии доступны через один выбор run. Индекс `(recording_id, created_at)` и current run selection у записи; не менять старый текст Notes миграцией.
- Capture states: `recording`, `finalizing`, `ready`, `incomplete`; audio lifecycle: `available`, `deleting`, `deleted`, с ошибкой операции. Run stages: `prepare`, `asr`, `normalize`, `summary`; status: `pending`, `running`, `blocked`, `failed`, `cancelled`, `complete`. Записывать только состояния, которые потребляют worker/UI/recovery.
- Файлы в `userData/audio/meetings/<recording-id>/`: исходный PCM16LE mono 24 kHz каждого source epoch и метаданные их положения. При явном restart источника начинать новый epoch с новым offset; обычный jitter доставки не создаёт разрывы. Один открытый append-файл на текущий epoch, без минутных storage rotation. Run JSON — в `userData/meeting-results/<run-id>/`, отдельно от удаляемого аудио. Производные входы/временные файлы внутри каталога записи.
- Метаданные epoch (источник, формат, начальное положение, path) фиксируются до приёма samples. Длина восстанавливается по целым PCM frames из файла; неполный последний frame игнорируется с отметкой. Исходник при recovery не переписывать. SQLite хранит manifest; дополнительный дублирующий JSON-manifest не нужен.
- Append последовательно с обработкой short writes. Атомарная публикация производных/JSON через временный файл в той же директории и rename; не удалять предыдущий валидный артефакт при retry. Финализированный raw immutable. Stop идемпотентно переводит запись и добавляет один initial run транзакцией после закрытия writer. Явная повторная обработка создаёт новый run.
- Recovery открытых записей определяет последнее читаемое положение каждого epoch, обозначает incomplete, завершает файлы и создаёт initial run, если его нет. Если PCM отсутствует/нечитаем — видимая ошибка, не пустая успешная запись. Незакрытая запись обнаруживается даже когда последний error-write не удался.
- Реализовать операции audio-delete и note-delete с сохраняемым намерением удаления до файловых действий. Сначала блокировать jobs/новые readers, затем удалять файлы; завершать метаданные только после успеха. Для note-delete сохранять row/намерение до очистки файлов, затем транзакционно удалить дочерние runs/mappings/notes. Recovery продолжает удаление; отсутствие файлов уже считается успехом. Все file paths выводятся из IDs в main и проверяются внутри managed roots, renderer не получает произвольное чтение/удаление.

#### 5.1.3 Acceptance criteria

Запись/epochs и отдельные результаты переживают reopen SQLite. Recovery восстанавливает читаемые данные, повторная финализация не дублирует initial run. Аудио и JSON удаляются согласно разным lifecycle; ошибки и незавершённое удаление сохраняются. Старые Notes и shared speaker profiles не затронуты.

#### 5.1.4 Verification

Добавить `test/helpers/meetingRecordingStorage.test.js` и `meetingRecordingPersistence.test.js`. Использовать реальные временные файлы и SQLite по паттерну `databaseLocalBehavior.test.js`: reopen, short/failed write, оборванный frame, два epochs с gap, повтор Stop, crash после rename до DB update, audio-delete vs note-delete, удаление с ошибкой и повтором. Проверяют Draft AC 2/4/8/9/12/13 на уровне storage.

Команда: `node --import tsx --test --test-concurrency=1 test/helpers/meetingRecordingStorage.test.js test/helpers/meetingRecordingPersistence.test.js test/helpers/databaseLocalBehavior.test.js`.

Интеграция с настоящим capture — M2; late network response и cleanup — M3/M4.

#### 5.1.5 Consumer surfaces impacted

Main capture/processing используют один repository; UI подключается в M2–M4. Старый Notes read/write остаётся работоспособным.

#### 5.1.6 Pre-response/loading/success/error/empty states (when applicable)

До создания — нет recording. Recording/finalizing доступны как сохранённые состояния. Ready/incomplete отличаются от processing state. Ошибка файлов не превращается в ready; отсутствие audio и незавершённое deleting явно различимы.

### 5.2 M2 — Capture и безопасный Stop

#### 5.2.1 Depends on

Depends on: M1.

#### 5.2.2 Scope

Contract sync: проверить recording/epoch/write/finalize контракты M1.

Contracts produced/changed: `src/contracts/meetingCoordinator.ts`, `src/preload/meetingCoordinatorBridge.ts` и renderer declarations — capture start/data/ack/stop/status вместо зависимости от realtime connection. Contracts consumed: storage M1, AudioWorklet и `audioTapManager.ts`.

- Изменить `meetingCoordinatorIpcHandlers.ts` и `meetingRecordingStore.ts`: prepare проверяет локальный capture/storage, не ключи/модели; system tap и microphone стартуют без ASR. Удалить вызовы realtime/local chunk inference из meeting ветки и её live segment publication. Не удалять модули, используемые импортом или другими сохранёнными маршрутами.
- Переиспользовать renderer `getUserMedia`/AudioWorklet, native tap PCM и `meetingAudioTimeline.ts`/watchdog. Записывать raw до существующего AEC/гейтов/echo suppression. Сохранять фактически используемый формат. Общую шкалу задаёт session origin в main; epoch offset и sample count определяют положение, не время прихода каждого IPC пакета. На restart источника фиксировать gap и новый offset; synthetic silence не выдавать за захваченный raw.
- Worklet пакеты не длиннее 100 ms, sequence/epoch/sample offset; main подтверждает только завершённую запись. Ограничить все очереди: не более 500 ms неподтверждённого PCM на источник и контроль возраста старейшего sample; при приближении к 1 s прекращать capture с ошибкой. Не переносить неограниченную очередь в MessagePort/IPC/native stdout. Watchdog обнаруживает отсутствие ack/записи, включая медленный writer; memory cap и age check действуют до enqueue. Порог 500 ms оставляет запас для capture/IPC; реальный секундный предел подтверждается smoke, при нарушении M2 не принимается.
- Worklet Stop должен возвращать явный flush-complete с последней sequence; заменить текущий sleep `MEETING_STOP_FLUSH_TIMEOUT_MS` на drain handshake. System tap stop также ждёт вывод хвоста/close до закрытия writer. Reject/timeout ведёт в incomplete, а не успешный complete. Нормальный Stop сначала запрещает новые samples, дожидается обоих drains/writes, закрывает файлы и только затем финализирует.
- Disk-full/write failure/overflow останавливает обе capture цепочки, оставляет доступное аудио и причину. Missing system source показывает incomplete с самого начала; mic-only не выглядит dual-track complete. Автоматическая остановка проходит тот же Stop; повторные Stop/quit используют один pending promise.
- `main.ts` и `windowManager.ts`: before-quit до unregister/teardown показывает confirmation активной записи. Cancel не меняет isQuitting/locks/hotkeys; confirm await safe Stop с defer-processing, затем shutdown. При renderer crash finalize surviving source data incomplete; после restart применить recovery M1.
- Закрытие окна оставляет renderer живым (существующий hide-on-close), меню/tray показывает статус и Stop. Capture UI показывает время, здоровье дорожек и запись на диск; ручные заметки доступны, live text убран.

#### 5.2.3 Acceptance criteria

Без сети/ключей/моделей обе дорожки пишутся. Обычный Stop сохраняет хвост; повторный не создаёт job дважды. Close/reopen не прерывает; cancel quit продолжает; confirm quit сохраняет до shutdown. Ошибки диска/renderer/source видны и не теряют уже записанное. Process crash теряет не более 1 s полученного звука на источник.

#### 5.2.4 Verification

Обновить `meetingCoordinatorIpc.test.js`, `meetingAudioTimeline.test.js`, `meetingRecordingStoreAutoEndStop.test.js`, `meetingRecordingStoreSystemAudioInterrupted.test.js` под новый контракт; старые assertions realtime meeting удалить вместе с их удалённым поведением. Добавить `meetingCaptureRecovery.test.js`: child process пишет известный PCM, kill в разных позициях, reopen, сравнение количества frames; fake delayed ack/short write/disk full. Отдельно проверить flush barrier и поздние chunks, gap/epoch restart, renderer fatal event, quit cancel/confirm (mock app/dialog). Проверяют AC 1/2/3/4/11 на уровне integration.

Команда: `node --import tsx --test --test-concurrency=1 test/helpers/meetingCoordinatorIpc.test.js test/helpers/meetingAudioTimeline.test.js test/helpers/meetingCaptureRecovery.test.js test/stores/meetingRecordingStoreAutoEndStop.test.js test/stores/meetingRecordingStoreSystemAudioInterrupted.test.js`.

На изолированном macOS профиле записать контрольный непрерывный сигнал в mic/system, проверить offline, hide/reopen, Stop посреди речи, quit/cancel, device restart и process kill в разных моментах. Сравнить конец восстановленных дорожек с capture reference: ≤1 s каждая; обычный Stop без потери. Зафиксировать реальные длительности/размеры/потери. Без аппаратного smoke секундная гарантия не считается принятой.

#### 5.2.5 Consumer surfaces impacted

Recording buttons/горячая клавиша/календарный prompt, auto-end, tray/menu, Note editor, preload. Существующие источники управления вызывают один lifecycle.

#### 5.2.6 Pre-response/loading/success/error/empty states (when applicable)

Preparing локального capture → Recording с обеими дорожками/видимым missing source → Saving tail → Saved/Incomplete. Start failure сохраняет причину; во время Saving повторные действия не создают новую сессию. Пустой Stop не перезаписывает ручной текст или старый transcript.

### 5.3 M3 — Обработка после Stop

#### 5.3.1 Depends on

Depends on: M1, M2.

#### 5.3.2 Scope

Contract sync: M1 run/result и M2 capture-active/finalized. Contracts produced/changed: `src/helpers/meetingProcessing.ts`, расширение существующих file helpers для сохранения raw response, run status/retry/list IPC в meeting contract. Contracts consumed: existing `RemoteTranscriptionResult`, provider route/credentials, Notes и reasoning.

- Один main-process worker читает pending runs из SQLite, без брокера и отдельной in-memory истины. Запуск при startup после recovery/retention sync, Stop, явном retry и due retry timer. Processing config берётся только из persisted snapshot M1, повторный renderer handoff для неё не требуется. При ещё не загруженной retention policy job ждёт её отдельного подтверждения; тест без renderer проверяет исполнение по snapshot после такой policy readiness, а также отсутствие запуска до неё. DB claim условным update; один active run. Новая запись имеет приоритет: подготовку ffmpeg остановить и повторить позже, новые network/локальные inference этапы не начинать. Уже отправленный HTTP разрешить завершить и атомарно сохранить ответ, normalize/summary отложить. Не блокировать start ожиданием запроса.
- Подготовить одну mono WAV PCM16 24 kHz из source epochs существующим ffmpeg: offsets/gaps сохраняются, концевая длительность — общая capture timeline; raw не изменяется. Проверить размер/duration производной до отправки, достаточность диска. Ограничить mixer gain для предотвращения clipping. Файл строится через temporary→rename; partial output не используется. Существующий AEC не переносить в raw: первая реализация использует согласованное смешивание без нового алгоритма подавления эха.
- Переиспользовать `transcribeAudioFileByok` как main execution entry и его route, transports, `deepgramFileTranscription.ts`, `elevenLabsFileTranscription.ts`, `geminiFileTranscription.ts`. Добавить внутренний awaitable sink исходного ответа до парсера для meeting run; upload callers сохраняют свой текущий контракт. Sink не exposed в IPC. Gemini сохраняет исходный Interactions response до нормализации/cleanup. При failed validation raw остаётся для повторного normalize. Чувствительные headers/credentials не сериализовать.
- Models/routes остаются текущими: Nova (`nova-3` default), `scribe_v2`, `gemini-3.5-transcribe`; diarization включена в запросе meeting. Неподдерживаемый provider/model/input — blocked, UI предлагает выбор, нет truncation/splitting/fallback. Использовать current size guards и Gemini duration probe; сверить документацию перед кодированием затронутого запроса. Транспортные upload chunks не создают несколько ASR jobs.
- После successful raw save normalize из файла: сохранять текст/segments/speaker labels, проверять finite ordered interval bounds внутри полной timeline и отсутствие обязательных метаданных. Пустой корректный transcript обозначить «речь не обнаружена», не генерировать выдуманный summary; ошибку/пустой результат провайдера не превращать в успешную диаризацию. Нормализацию/публикацию транзакционно связать с run, без дублирующих сегментов.
- Recovery: `prepare` можно пересоздать из raw audio; наличие валидного response выбирает normalize без ASR. `running/asr` без сохранённого ответа — pending с явной отметкой неизвестного исхода/возможной повторной оплаты. Offline/429/временный network failure — pending с backoff `min(300, 5 * 2 ** attemptCount)` секунд, максимум 3 автоматических повтора с сохраняемым attemptCount через restart, затем failed с ручным retry; явный ручной retry начинает новый цикл попыток, пауза capture не расходует попытку. Сохранять attemptCount/retryAt; credentials можно исправить без копирования секрета в snapshot. Поздний callback проверяет существование и status run перед сохранением.
- Transcript фиксируется до summary. Переиспользовать prompts/settings и reasoning transport из `actionProcessingStore.ts`, `builtinActions.ts`, `ReasoningService`/`reasoningIpcHandlers.ts`; выделить только вызываемое ядро existing Generate Notes для main job, без второй реализации provider routing. Summary использует snapshot model/template/config из M1, сохранённый при capture start или явном create-run; изменённые глобальные defaults не подменяют его. Сохранить generated summary отдельно от manual note content и прежних summaries. Сбой summary повторяет только этот этап; никакого нового ASR. Длительные local summary stages подчиняются приоритету capture.
- В новом meeting flow подключить три утверждённых file adapters и сохранить уже поддерживаемый Local meeting path с текущей независимой локальной диаризацией после Stop. Self-Hosted сохраняется только в существующих рабочих потребителях (например file import); текущий Note Recording его не поддерживает, новый Self-Hosted meeting route не добавлять. Его выбор для meeting даёт явный blocked/unsupported без cloud fallback. Неподдерживаемая встроенная диаризация не обещается; отсутствие локальной модели/метаданных остаётся явным состоянием.

#### 5.3.3 Acceptance criteria

Все три готовых provider route доступны после Stop. Raw response предшествует нормализации; crash после ответа не требует ASR, если ответ сохранён. Jobs/config/results переживают restart. Ошибка summary сохраняет transcript/manual content. Новая запись стартует при старом pending/in-flight job. Лимиты блокируют только выбранный запуск; повтор другим провайдером оставляет старый результат.

#### 5.3.4 Verification

Добавить `test/helpers/meetingProcessing.test.js` с настоящей временной SQLite/storage и injected transports/clock/ffmpeg: finalize→prepare→ASR→response→normalize→summary; restart на каждой границе, response validation error+повтор normalize, offline/backoff/key/limit, duplicate Stop, новая запись при pending/HTTP, cancellation/delete+late result, empty transcript, summary failure/retry, ручной текст; restart без renderer с сохранённой config и готовой retention policy, отсутствие запуска до policy readiness, изменение глобальных settings после capture, отсутствующий и затем исправленный ключ без смены provider/config. Mixer test на двух искусственных epochs проверяет слышимый/измеряемый offset, gap и end duration. Test drain/cancel transport на mocked server, не платном API. Проверяют AC 5/6/7/8/9/14.

Расширить существующие fixtures адаптеров на sink-before-parse, не дублировать их наборы. Команда: `node --import tsx --test --test-concurrency=1 test/helpers/meetingProcessing.test.js test/helpers/remoteTranscriptionIpc.test.js test/helpers/geminiFileTranscription.test.js test/helpers/retryTranscriptionHandler.test.js test/helpers/transcriptionRoute.test.js test/services/fileTranscriptionDiarizationWarning.test.js`.

#### 5.3.5 Consumer surfaces impacted

Main worker, существующий импорт, Notes transcript/summary, provider settings. Простая новая meeting result API возвращает status/results, не raw provider payload.

#### 5.3.6 Pre-response/loading/success/error/empty states (when applicable)

Saved → Queued (включая ожидание capture/сети) → Preparing → Transcribing → Transcript ready → Generating notes → Complete. Blocked показывает исправляемую причину/provider limit, failed — этап и retry. При summary failure transcript остаётся доступен; неполнота capture всегда видна. Empty transcript имеет отдельное сообщение без пустой выдуманной заметки.

### 5.4 M4 — Notes, retention и итоговая проверка

#### 5.4.1 Depends on

Depends on: M1, M2, M3.

#### 5.4.2 Scope

Contract sync: M1 storage/deletion, M2 capture status, M3 runs/results. Contracts produced/changed: Notes consumer state, managed playback/export IPC и retention integration. Contracts consumed: existing NoteEditor/meetingTranscriptPersistence/speaker management, AudioStorageManager, retention settings and cleanup.

- В существующей Note показать capture health, этап обработки, ошибку и retry; новый ASR создаёт run по выбранному provider/model, summary retry использует тот же transcript. Компактный выбор результата по provider/model/date, transcript и generated notes выбранной версии, без comparison dashboard. Ручной content отдельный и не заменяется автоматикой. Старые результаты открываются и после нового run.
- Speaker corrections хранятся по `(runId, speakerId)`. Existing known voice recognition запускается после Stop по сохранённому аудио с использованием текущих speaker tools, не в capture. Смена результата выбирает его corrections; shared speaker profiles сохраняются. Не подставлять имя из календаря или source mic без подтверждения.
- `meetingTranscriptPersistence.ts` перестаёт публиковать пустой live transcript на Stop; publish выбранного результата обновляет существующую Notes projection атомарно. Notes chat/text export работают с выбранной версией в обычном формате; временные позиции переводить из relative seconds с одним session origin, не менять gaps и не сдвигать первый spoken segment к нулю playback.
- Playback общей WAV + seek из transcript; export общей WAV или отдельных оригинальных source tracks как читаемые WAV с сохранённым расположением epochs/gaps (raw PCM не перезаписывается). Использовать существующий механизм локального audio access и save dialog. Path только через recording ID/разрешённый destination, без произвольного renderer FS. Экспорт не считается успешным до close/успешной записи; ошибка видна. Export text форматы сохранить.
- Изменить default audioRetentionDays 30→7 во всех default/reset источниках `retentionSettings.ts`, `settingsStore.ts`; сохранённые 30/0/etc не менять. В существующих Settings дать число дней ≥0, пояснить 0, предупредить при уменьшении. Startup worker ждёт достоверную синхронизацию retention, чтобы не удалить бессрочно хранимое по default до загрузки настройки.
- Расширить существующий startup/6-hour cleanup и delete-all в `ipcHandlers.ts`/`audioStorage.ts`, без второго sweeper. Использовать capture end/last recovered sample time, не mtime derived files. Сначала закончить pending deletion/expire, затем запускать jobs. При expiry/explicit delete отменить active reader/transport/ffmpeg и дождаться закрытия; job cancelled с причиной. Audio-only может сохранить уже полученный non-audio result, но не создавать аудиокопии после deleting; note-delete запрещает все поздние публикации. Ошибку provider-side file cleanup не выдавать за гарантированное удаление удалённой копии.
- Delete note и delete all audio активной записи: confirmation→safe stop без queue→delete. Отмена ничего не удаляет. Старый transcript/history retention не удаляет Notes runs/results. UI при deleted audio отключает ASR retry/playback/audio export с причиной, оставляет text/summary regeneration.
- Документация: обновить README current status/flow, `docs/product.md` (один смешанный вход, без track transcript merge), `docs/architecture.md` (реальные SQLite/storage/jobs и общая timeline), `docs/delivery-plan.md` (этапы и evidence), `docs/removal-plan.md` раздел следующего этапа, `docs/openwhispr-cutover.md` актуальный milestone. Создать/обновить `docs/record-then-process.md` из этого утверждённого контракта: recovery/retention/лимиты, quality/cost гипотезы Тимура. В исходном checkout есть незакоммиченные версии этих документов и `docs/transcription-chunking-research.md`: при интеграции согласовать содержимое без потери заметок; историческое исследование сохранить как superseded preview/chunk proposal, не как реализационный план. Результаты smoke и реальные ограничения описать в существующем verification log либо разделе документа, без нового registry.

#### 5.4.3 Acceptance criteria

В Notes доступны все версии и их speakers, ручной текст сохраняется. Playback/seek/export соответствуют timeline. Default7/custom/0 соблюдаются для новых/старых записей; после expiry audio удалено, текст доступен. Delete/restart/late callback не воскрешают данные. Ошибка удаления не выглядит успехом. Все сохранённые функции продукта работают в прежних пределах.

#### 5.4.4 Verification

Добавить `test/helpers/meetingRecordingRetention.test.js`, `test/services/meetingResults.test.js`: fake clock+real tempfiles/SQLite для7/custom/0, старого сохранённого30, уменьшения срока, restart, pending/in-flight expiry, note-delete/deleteall, delete failure+retry, shared profiles. Проверить selected run projection, scoped correction, manual content, timestamps/gaps, export copy/failure и audio unavailable. В `meetingResults.test.js` отдельно выполнить post-Stop путь узнавания голоса на сохранённом аудио с injected embeddings/identifier: существующий известный профиль назначается только совпадающему speaker выбранного run, неизвестный остаётся без имени; другой run с тем же numeric speaker ID не наследует назначение. Проверить, что calendar/source mic сами не создают identity. Расширить `test/services/uploadNotes.test.js`, `test/helpers/retentionSettings.test.js`. Проверяют AC 7/9/10/12/13/15.

Команда: `node --import tsx --test --test-concurrency=1 test/helpers/meetingRecordingRetention.test.js test/services/meetingResults.test.js test/services/uploadNotes.test.js test/helpers/retentionSettings.test.js`.

Затем по очереди: `pnpm run typecheck`, `pnpm run lint`, `pnpm test`, `pnpm run pack`, `node scripts/smoke-electron.js`. Packaging с отдельным профилем; после pack при повторном Node DB тесте сначала восстановить Node SQLite ABI командой `pnpm --dir node_modules/better-sqlite3 exec prebuild-install`. У worktree node_modules symlink: никаких параллельных native rebuild/test с основным checkout.

Ручной изолированный smoke: запись offline → hide/reopen → Stop → mocked/тестовый выбранный provider result → transcript/summary; replay после app restart; выбор другого provider и старой версии; correction; seek/export; expiry; confirm/cancel quit; manual note/chat/import/Local; Self-Hosted проверить только в существующем file import, в meeting — явный unsupported. При наличии подходящего профиля и контрольной записи проверить post-Stop узнавание известного голоса и неизвестного участника; без sample/model отметить реальный recognition путь непроверенным. Повторить аппаратные crash/device/disk проверки M2 на интегрированной сборке. API quality/billing benchmark не запускать; невыданный ключ/нет устройства обозначить как непроверенное, не засчитывать smoke. AC16 требует честного отчёта о выполненных/непроведённых проверках.

#### 5.4.5 Consumer surfaces impacted

NoteEditor/Transcript/Chat, settings, existing menu/tray, provider/model picker, text/audio export, note deletion и audio cleanup. Empty Notes, dictionaries/snippets, calendar/import не заменяются новым UI.

#### 5.4.6 Pre-response/loading/success/error/empty states (when applicable)

Нет записи — обычная пустая/ручная Note. Recording/queued/stages — видимые статусы. Ready result — transcript/summary/версии. Failed summary — transcript+retry. Incomplete capture — постоянная отметка. Audio expired — текст и reason disabled actions. Deleting — operation in progress; failed delete — явная ошибка с повтором, success только после файловой очистки. Export — pending/success/error назначения.

## 6. Execution order (derived from dependencies)

M1 → review/verification → M2 → review/verification → M3 → review/verification → M4 → интеграционная проверка → финальный code review. Не запускать следующий milestone до закрытия блокирующих findings текущего.

Общие команды из корня worktree: `pnpm run typecheck`, `pnpm run lint`, focused Node commands выше; полный `pnpm test` один раз после интеграции, при ошибке сначала focused rerun. Не устанавливать новые библиотеки для очереди, кодирования или тестов: SQLite, Node fs, ffmpeg и node:test уже есть. Tests/build/install выполняет только root.

Официальные контракты для проверки затронутых адаптеров: [Deepgram diarization](https://developers.deepgram.com/docs/diarization), [ElevenLabs file ASR](https://elevenlabs.io/docs/api-reference/speech-to-text/convert), [Gemini Transcribe](https://ai.google.dev/gemini-api/docs/transcribe). Проверены страницы 2026-09-24; текущие code guards размера 2/3/2 GiB и Gemini30min — ограничения реализации, не результат платного e2e. Новые ограничения показывать явно, без обхода делением аудио.

## Orchestration (managed by orchestrator)

| Milestone | Status | Commits |
| --- | --- | --- |
| M1 — Хранение записи и результатов | done | `bd0d603b`, `52714ef9`, `0e0f08fd`, `2ceb4a44` |
| M2 — Capture и безопасный Stop | done | `9028b992`, `485b17dd`, `58ef1f5c`, `c49cb910`, `30ce4434`, `1485e2fb`, `b7901205`, `e6d99434`, `beda40d5`, `4f157947`, `0f6331de`, `8e99ea4e` |
| M3 — Обработка после Stop | done | `e192dd51`, `7dcf9f86`, `c871bf01` |
| M4 — Notes, retention и итоговая проверка | in progress | |
| Reviewer | not started | |
| Code Reviewer | not started | |

M2 verification: 50/50 focused tests, `pnpm run pack`, and packaged Notes smoke passed. On 2026-09-24 Timur explicitly deferred the live mic/system hardware smoke until the end of the task; its tail-loss guarantee remains unverified. This is an accepted verification-order deviation, not a passing hardware result.
