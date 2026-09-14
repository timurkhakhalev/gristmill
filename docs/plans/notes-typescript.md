# Следующий этап: точные типы и отдельные IPC-обработчики Notes

Статус: план для реализации другим агентом. Этот PR меняет только документацию.
Сам по себе документ не означает, что описанный код уже написан.

## 1. Задача и исходная точка

Сделать одну законченную вертикаль Notes: renderer → preload → main → SQLite
→ результат/событие обратно в renderer. Убрать расхождение между типами заметки
и локальными данными, вынести семь обработчиков из большого IPC-файла и
связать их с типами preload. Сохранить существующее поведение.

Рабочий репозиторий: `timurkhakhalev/openhercules`. Исследован commit
`429cbb35f589bbdb6994a2232d35a662dfb7f5f2` на `main` после merge PR #11.
Основание — шаг 2 [issue #10](https://github.com/timurkhakhalev/openhercules/issues/10).
Не нужны история чата или другие неопубликованные материалы.

Перед работой прочитать:

- `AGENTS.md`, `README.md`;
- `docs/removal-plan.md`, `docs/cleanup-log.md` — текущая продуктовая граница;
- `docs/typescript-build.md` — уже реализованная сборка;
- этот документ полностью. При расхождении с новым HEAD проверить изменённые
  места и обновить план, а не возвращать старый код поверх чужих изменений.

Первый этап уже сделал `dist-main`, Node/Electron tsconfig с `strict: true`,
отдельную renderer-проверку и упаковку собранного main/preload/worker.
JS пока имеет `checkJs: false`. `constants.mts` — сознательное ESM-исключение
из CommonJS для сохранения `import.meta.env`. Не переделывать эту схему.

Последние **локальные** проверки первого этапа: 2390 tests pass, без skips;
main/renderer typecheck, lint без ошибок, unsigned arm64 `.app` и isolated
smoke pass. Это историческая база, не результат проверки будущих изменений.
GitHub CI нужно проверять отдельно; локальный pass не равен зелёному CI.

## 2. Что входит и что не входит

Входит:

1. Локальный `NoteItem`, точный `NoteUpdate` и контракт семи запросов/трёх событий.
2. Типизированный модуль Notes в preload и отдельная регистрация Notes в main.
3. Удаление из Note-типов полей удалённого cloud-продукта и соответствующая
   корректировка живых потребителей. Без изменения данных SQLite.
4. Проверки форм данных, реального прохождения IPC и сохранения побочных эффектов.

Не входит: перенос всей `database.js`, всей `ipcHandlers.js` или всей
`preload.js` на TS; рефакторинг folders/spaces, export, chat, provider adapters,
settings, recording orchestration; новая SQLite schema; batch pipeline,
очередь обработки встреч, revisions, новые модели, OAuth-регистрации.
Существующая очередь файлового/HTTPS-импорта остаётся функцией приложения.

Сохраняются Notes, пустые заметки, папки/редактор/AI Actions, полный embedded
chat с локальными cross-note tools, Dictionary/Snippets, все BYOK/Local и
поддержанные Self-Hosted ASR/LLM, файл/direct HTTPS import, календари, realtime
mic+system, диаризация и межвстречные speaker identities, hotkey/pill/tray/
уведомления. Платформа — macOS Apple Silicon.

Не возвращать OW cloud/backend/auth/paywalls, dictation, standalone assistant,
web_search, YouTube, Qdrant. Не добавлять backcompat aliases, dual paths,
DI-контейнер, generic repository, plugin framework или code generation framework.

## 3. Подтверждённые проблемы и точки кода

Все номера строк ниже относятся к исследованному commit; ориентироваться также
по именам символов.

| Место | Факт и следствие |
| --- | --- |
| `src/types/electron.ts:158`, `NoteItem` | Требует `cloud_id`, `is_shared`, `share_token`, `client_note_id`, `sync_status`, `deleted_at`; локальная таблица их не содержит. Компилятор обещает несуществующие поля. |
| `src/types/electron.ts:843`, `updateNote` | Описывает cloud-only updates, но не описывает поддержанные SQL поля `source_file`, `audio_duration_seconds`, `note_type`. |
| `src/helpers/database.js:564–654`, `saveNote/getNote/getNotes/updateNote/deleteNote` | Данные возвращаются напрямую из SQLite; `getNote` — `SELECT *`, отсутствующая запись — `null`. SQL уже централизован, перенос всего класса не нужен. |
| `src/helpers/ipcHandlers.js:1038–1093` | В одном блоке смешаны DB-вызовы, broadcast, Markdown mirror и speaker callbacks. Перенос только DB-вызова потеряет поведение. |
| `preload.js:134–157,211–225` | Имена методов, каналов и payload записаны вручную отдельно от TS-деклараций. |
| `preload.js:3–6`, `src/helpers/windowConfig.js` | Некоторые окна используют sandbox. Такой preload не может загружать произвольный локальный модуль через require. Простой перенос Notes в отдельный файл сломает эти окна. |
| `test/helpers/rendererBridgeContract.test.js` | Проверяет наличие методов, но не аргументы, результаты и события. После выделения модуля harness должен читать конечный собранный preload. |
| `src/helpers/meetingRecordingSession.ts:72,89`, `src/stores/meetingRecordingStore.ts:1726` | Проверки `deleted_at` основаны на отсутствующем поле. Сохранить защиту от работы с удалённой заметкой через `getNote() === null`. |

`NotePushSnapshot`, `NoteCreateSnapshot`, `NoteUpdateSnapshot`, `NoteCreateAckResult`,
`NoteUpdateAckResult` сейчас встречаются только в `src/types/electron.ts`.
Они зависят от удалённых cloud-полей: удалить вместе с Note type debt после
повторного поиска usages. Другие cloud-типы этого большого файла не входят
в задачу, если не мешают конкретно новому NoteItem.

Не доказано, что приложению нужны отдельные repositories по каждой таблице,
новый event bus или перенос записи в другой процесс. В план они не включены.

## 4. Точный контракт текущего поведения

### Запросы

Оставить публичные имена, имена каналов, порядок аргументов и форму результата.
Переходить на единый object payload или универсальный Result-envelope не нужно.

| Метод preload | Канал | Аргументы и результат |
| --- | --- | --- |
| `saveNote` | `db-save-note` | `title, content, noteType?, sourceFile?, audioDuration?, folderId?, spaceId?` → `{ success: true, note }`; DB defaults: personal, nullable fields null, private space. |
| `getNote` | `db-get-note` | `id` → NoteItem или null. |
| `getNotes` | `db-get-notes` | `noteType?, limit?, folderId?, spaceId?` → NoteItem[]; DB default limit 100. |
| `getSpaceNotes` | `db-get-space-notes` | `spaceId, limit?` → NoteItem[]; DB default limit 50. |
| `updateNote` | `db-update-note` | `id, updates` → `{ success, note?, error? }`. Пустой update → `{success:false}`; missing note/folder → false с существующим сообщением. |
| `deleteNote` | `db-delete-note` | `id` → `{success:boolean}`; отсутствующий id → false. |
| `searchNotes` | `db-search-notes` | `query, limit?, spaceId?, folderId?` → NoteItem[]; DB default limit 50, пустой FTS query → []. |

Не объединять `getNotes` и `getSpaceNotes`: при заданном spaceId и пустом
folderId первый выбирает только `folder_id IS NULL`, второй — все заметки
space, включая папки. `getNotes` сортирует по updated_at DESC, поиск — по FTS
rank. Не менять фильтры, сортировку, размеры выдачи и default-folder selection.
`saveNote` для meeting выбирает Meetings, иначе Personal при отсутствии folderId;
переданная папка определяет space. Не добавлять новые правила названий/сортировки.

### Локальная заметка

Схема `CREATE TABLE notes` в `database.js:123` — источник истины для row shape:

| Поля | Тип |
| --- | --- |
| `id`, `space_id` | number |
| `title`, `content`, `note_type`, `created_at`, `updated_at` | string |
| `source_file`, `enhanced_content`, `enhancement_prompt`, `enhanced_at_content_hash`, `transcript`, `calendar_event_id`, `participants` | string или null |
| `audio_duration_seconds`, `folder_id`, `diarization_enabled`, `expected_speaker_count` | number или null |

`note_type` в SQLite — TEXT без CHECK, а save API принимает string. Не вводить
runtime enum, который отвергнет ранее сохранённое значение; UI по-прежнему
использует personal/meeting/upload. Для row type использовать string, исправив
только нужные места, где старый узкий TS union мешает компиляции.

`participants`/`transcript` остаются строками: не менять JSON-формат,
таймстампы или speaker labels. Не конвертировать SQLite integers в boolean.
Не подставлять фиктивные cloud-поля, не превращать undefined в null повсюду.

`NoteUpdate` разрешает ровно SQL whitelist `database.js:updateNote`:
`title`, `content`, `enhanced_content`, `enhancement_prompt`,
`enhanced_at_content_hash`, `folder_id`, `space_id`, `transcript`,
`calendar_event_id`, `participants`, `diarization_enabled`,
`expected_speaker_count`, `source_file`, `audio_duration_seconds`, `note_type`.
Обязательные row-поля не становятся обязательными для update.
`undefined` означает «не менять», null допустим для nullable columns,
пустая строка — допустимое значение текста. Не применять truthiness к updates.

### Побочные эффекты и события

- Успешный save: запланировать `note-added(note)` через setImmediate,
  вызвать `_asyncMirrorWrite(note)`, вернуть DB result.
- Успешный update: запланировать `note-updated(note)`, вызвать mirror write;
  **только при truthy `updates.participants`**, как сейчас, вызвать сначала
  `_tryAutoLabelOneOnOne(id)`, затем `_refreshMeetingSpeakerConfigFromNote(id,note)`.
  Строка `"[]"` truthy, пустая строка и null — нет. Это сохранить, не «улучшать».
- Speaker refresh повышает derived cap только для активной той же заметки,
  не понижает его и не меняет explicit choice. Эти helpers не переписывать.
- Удаление остаётся через `deleteNoteInternal`: DB delete, при success
  отложенное `note-deleted({id})` и `_asyncMirrorDelete(id)`. Этот метод также
  вызывается `cliBridge.js:432`: оставить единственную действующую реализацию,
  не дублировать broadcast/mirror в новом handler.
- События `note-added` и `note-updated` несут NoteItem; `note-deleted` — `{id:number}`.
  Preload не передаёт IpcRendererEvent в renderer и возвращает unsubscribe,
  удаляющий именно установленный listener. Нет события на неуспешной мутации.
- `_asyncMirrorWrite/Delete` сами планируют работу и учитывают feature setting.
  Не делать mirror синхронным и не менять обработку его ошибок в этом этапе.

## 5. Предлагаемые файлы и границы

### `src/contracts/notes.ts` — общий контракт

Один небольшой module для NoteItem, NoteUpdate, аргументов/результатов семи
каналов и трёх событий. Без Electron, React, stores, DB или секретов.
Использовать уже установленный Zod для схем и выводить TS-типы из этих схем;
не вести отдельные вручную синхронизируемые schema/interface для одних данных.

Схемы нужны не для изменения бизнес-правил, а потому что SQLite/JS и Electron
сейчас возвращают нетипизированные значения. На входе чтения результата брать
`unknown`, после parse получать тип. Не писать `as NoteItem`, generic cast
над `ipcRenderer.invoke`, any или ts-ignore вместо проверки.

Сохранить optional/null/trailing undefined аргументы. Не trim/coerce тексты,
не вводить новые лимиты длины/числа элементов, не ограничивать limit сверху
(есть вызовы 99999). Не менять существующий SQLite limit=-1, если он передан
числом. Wrong shape/type → отклонённый IPC Promise до DB; не сериализовать
полный note/transcript в сообщение ошибки. Корректные args не менять.

Unknown update keys сейчас игнорируются SQL whitelist: сохранить это поведение
при runtime parsing, но не объявлять index signature в типе NoteUpdate.
Update только с неизвестными ключами должен вести себя как пустой update.
Нет coercion старых cloud-значений или поддержки прежней модели.
SQL errors по-прежнему reject, `{success:false}` остаётся результатом;
не превращать все ошибки в один новый envelope. Missing note остаётся null.

Определить именованные `NotesRequests`/`NotesEvents` и `NotesApi` для семи
методов/трёх подписок. Контракт должен связывать channel с tuple args и result,
а не оставаться справочником строк. Не распространять generic IPC abstraction
на всё приложение.

### `src/helpers/notesIpcHandlers.ts` — регистрация Notes

Перенести семь регистраций и логику save/update из `ipcHandlers.js` сюда.
Публичная функция `registerNotesHandlers(ipcMain, deps)`; зависимости узкие:
операции DB, mirror-write callback, participants callbacks и действующий
`deleteNoteInternal` callback. Не передавать весь IPCHandlers/manager bag.

DB пока JS. Описать её семь вызываемых методов с точными args и результатом
`unknown`; валидировать raw results общими схемами. Это честная проверяемая
граница, не объявление старого DatabaseManager полностью типизированным.
SQL и schema оставить в `database.js`. Извлекать SQL repository сейчас не нужно.

События save/update отправлять через типизированную Notes-функцию поверх
существующего `windowBroadcast`; реальный schedule и порядок оставить.
Delete callback уже отправляет событие — не отправлять второй раз.
Сохранить this-binding зависимостей через замыкания/явную привязку в wiring.

В `IPCHandlers.setupHandlers` заменить старые семь registrations одним вызовом.
Не оставлять оба набора. Остальные регистрации и внутренние callers helpers
остаются на месте. Не менять `serializeIpcError` провайдеров.

### `src/preload/notesBridge.ts` + узкое изменение сборки preload

Выделить семь методов и три listener в `createNotesBridge(ipcRenderer)`.
`preload.js` подключает этот модуль и добавляет его API в существующий
`electronAPI`; старые копии этих методов удалить. Остальная поверхность
preload и secret-key manifest сохраняются.

**Sandbox-решение:** конечный preload должен остаться одним CJS-файлом.
После успешного tsc добавить в `scripts/build-main.js` сборку исходного
`preload.js` через esbuild с `bundle:true`, `format:'cjs'`, `platform:'node'`,
`target:'node24'`, `external:['electron']`, output `dist-main/preload.js`.
ESBuild должен быть явной devDependency; версия 0.28.1 уже есть в lockfile
первого этапа. Не полагаться на транзитивную доступность пакета.

Это единственное необходимое расширение сборки: tsc по-прежнему проверяет
новые TS-модули и emits main/worker. Bundle выполняется после tsc, до любого
запуска/упаковки. Если bundle упал, build обязан завершиться ошибкой и не
оставлять unbundled preload как пригодный к запуску результат. Нельзя снимать
sandbox, включать nodeIntegration, менять contextIsolation, копировать
скомпилированные куски вручную или добавлять runtime TS loader.

В Notes bridge результат invoke сначала `unknown`, затем parse; события тоже
проверять перед callback. Невалидное событие не должно ломать обработку других
событий: диагностировать без содержимого заметки и не передавать неправильный
payload потребителю. Не публиковать пустую/фиктивную заметку вместо ошибки.

### Renderer и действующие потребители

В `src/types/electron.ts` удалить старые NoteItem/NoteUpdate/Notes-method copies.
`Window.electronAPI` должен включать `NotesApi` через пересечение с оставшейся
существующей поверхностью; не переписывать все 1906 строк API. NoteItem для
оставшихся типов можно импортировать из contracts, но не реэкспортировать
старый путь как compatibility alias. Перенести импорты 13 текущих файлов с
NoteItem на новый модуль; повторить поиск на свежем HEAD.

Исправить payload builders, использующие широкий `Record<string, unknown>`
вместо NoteUpdate, прежде всего `services/uploadNotes.ts` и локальные note tools.
Убрать только мешающие точной типизации assertions; не переписывать всю tool
систему. В uploadNotes исправить устаревший комментарий о duration whitelist,
но сохранить двухшаговое сохранение и best-effort metadata update.

В `meetingRecordingSession.ts` убрать deleted_at из Pick и использовать
отсутствие note для отмены restart. В `meetingRecordingStore.ts` убрать
deleted_at-проверку после getNote, сохранив отсутствие note, request failure,
stale session и pending-state behavior. В относящихся к этим случаям fixtures
заменить tombstone на null/реальное удаление. Не удалить сами race tests.
Остальной realtime store не рефакторить.

## 6. Порядок реализации

1. **Сверить базу и зафиксировать поведение тестами.** Найти все семь вызовов,
   callbacks и подписчиков. Добавить DB characterization на изолированной базе
   для сохранения, фильтров, обновления и удаления. Проверить default/null/empty
   cases до переноса. Начать с фактической SQLite schema, не с старых интерфейсов.
2. **Ввести контракт.** Общие схемы/types, перенести NoteItem, убрать его мёртвые
   зависимые типы, поправить typed consumers. Проверить компиляцию renderer.
3. **Выделить main Notes registrations.** Raw DB result → validation → typed
   result; сохранить эффект-порядок. Старые registrations удалить в том же шаге.
4. **Выделить preload bridge и собрать его одним файлом.** Обновить сборку,
   `Window.electronAPI` и harnesses. Проверить фактический emitted preload
   со stub require, разрешающим только electron.
5. **Проверить всю цепочку.** Через реальный собранный preload вызвать
   зарегистрированные handlers с временной SQLite; проверить данные, события,
   ошибки, unsubscribe и отсутствие двойных registrations/side effects.
6. **Завершить миграцию потребителей и проверки.** Notes editor/list, upload
   persistence, chat tools, restart/deletion race. Обновить inventory сборки
   и кратко описать границу оставшегося JS. Не объявлять дальнейшие шаги готовыми.

Шаги зависимы. Для одного исполнителя делать последовательно. Если задача
всё же делегируется, соблюдать правила AGENTS: только интегратор запускает
tests/build/install/rebuild, после окончания работы исполнителей.

## 7. Тесты, которые должны доказать результат

Предлагаемые новые тестовые файлы: `test/helpers/notesContract.test.js`,
`test/helpers/notesIpc.test.js`, `test/helpers/notesBridge.test.js`.
Названия можно скорректировать, смысл проверок обязателен.

- **SQLite, а не нарисованный mock row:** blank title/content, save/get/update,
  nullable fields, source_file/duration/note_type, unknown/empty update, missing
  note/folder, folder→space derivation, getNotes root vs getSpaceNotes all,
  FTS query/ranking, delete/missing delete. Schema не меняется.
- **Type probes:** неверный id/argument tuple; результат без обязательного
  локального поля; cloud-only NoteUpdate; неправильный event payload. Компилятор
  должен выдавать ожидаемую ошибку. Положительный пример проходит. Использовать
  compiler harness как в `mainBuild.test.js`, не подавления TS в runtime-файлах.
- **Настоящий bridge→handler→DB:** stub ipcRenderer.invoke передаёт вызов
  обработчику из Map, наполняемой реальной registerNotesHandlers; DB использует
  отдельный temp userData. Сохранённая заметка читается тем же preload API.
  Неверный аргумент не достигает DB, null возвращается как null, SQL exception
  не превращается в success. Никаких файлов/профилей пользователя.
- **Effects:** после save/update ровно один правильный broadcast и mirror-call;
  нет эффектов при false/throw; participants callbacks с порядком и условием
  из раздела 4. Delete through shared method не удваивает событие.
- **Subscriptions:** stripped Electron event, валидный payload, каждый
  unsubscribe удаляет только свой listener; две подписки работают независимо;
  malformed event не доставляется, следующий valid event продолжает работать.
- **Regression consumers:** upload note metadata, локальные create/update/search
  tools, pending editor save, container lists, удаление между stop/restart,
  diarization completion после удаления не воскрешает заметку.
- **Build/sandbox:** `dist-main/preload.js` требует только electron; локальные
  Notes/Zod зависимости встроены. Полная сохранённая electronAPI surface,
  onboarding и meeting bridge остаются. main/worker пути и `.mts` исключение
  первого этапа не сломаны.

Переиспользовать существующие `databaseLocalBehavior.test.js`,
`databaseLocalSchema.test.js`, `rendererBridgeContract.test.js`,
`preloadOnboardingBridge.test.js`, `mainBuild.test.js`, `noteListOps.test.js`,
`meetingRecordingSession.test.js`, `markdownMirror.test.js`,
`test/lib/noteEditorPendingSave.test.js`, `test/services/uploadNotes.test.js`,
`test/services/searchNotesTool.test.js`, `test/stores/meetingRecordingStoreAutoEndStop.test.js`
и `test/stores/meetingRecordingStoreDiarizationPublish.test.js`.

Source regex tests, читающие preload.js, нужно перевести на конечный bundled
preload там, где проверяется runtime API, а не просто поменять regex, чтобы он
проходил. Source-policy tests на удалённые продукты сохраняют свой смысл.
Не требовать old handler location после его переноса.

## 8. Команды и ограничения проверки

Использовать pnpm. Не запускать запись или платные ASR/LLM; тестовые provider/
speaker callbacks должны быть заглушками. Не использовать `pnpm run clean`:
на исследованной базе cleanup.js обращается к старому профилю OpenWhispr.
Не трогать этот профиль даже для «восстановления окружения».

Зависимости устанавливать только при необходимости. При добавлении esbuild
достаточно `pnpm add -D esbuild@0.28.1 --ignore-scripts`; native ABI готовится
отдельно перед DB tests. Не менять другие версии и настройки GitHub.

```sh
pnpm run typecheck
pnpm run lint
pnpm run build:main
# Только если SQLite сейчас собран для Electron, а тесты идут под Node:
pnpm --dir node_modules/better-sqlite3 exec prebuild-install
pnpm exec node --import tsx --test --test-concurrency=1 --test-timeout=30000 test/helpers/notesContract.test.js test/helpers/notesIpc.test.js test/helpers/notesBridge.test.js test/helpers/databaseLocalBehavior.test.js test/scripts/mainBuild.test.js
# Затем focused regression tests из раздела 7.
# После интеграции, один полный прогон:
pnpm test
# Только после тестов; pack восстанавливает Electron ABI:
pnpm run pack
node scripts/smoke-electron.js
```

Все tests/build/install/rebuild выполнять последовательно. После ошибки сначала
focused rerun; полный suite — после исправления/интеграции, не после каждого
файла. DB tests обязаны реально выполниться: skipped из-за ABI не равен pass.
Проверка упаковки unsigned `.app` достаточна, DMG/notarization не требуются.
Smoke использует новый temp профиль OpenHercules. Node/Electron ABI различаются;
после pack не запускать DB tests без подготовки Node ABI.

## 9. Известные соседние долги — не смешивать с этим этапом

При чтении найдено два несоответствия вне семи каналов:

- `_mirrorDeleteFolderIfUnshared` в ipcHandlers.js:425 обращается к
  `folders.deleted_at`, которого нет в локальной schema. Source test
  `folderDeleteRelocationContract.test.js` проверяет строки кода, хотя текущий
  `database.deleteFolder` возвращает только success и не relocatedNotes.
- `cliBridge.js` create/update вызывают `_asyncVectorUpsert`, определения
  которого в текущем src нет. CLI delete использует живой deleteNoteInternal.

Это подтверждённые расхождения исходников, не результаты нового runtime repro.
Не добавлять отсутствующие поля/заглушки и не восстанавливать Qdrant ради них.
Не включать незаметно их исправление в Notes TS refactor. Если они мешают
проверке затронутого сценария, воспроизвести отдельно и явно выделить baseline
failure в отчёте; новые регрессии текущих изменений обязательно исправить.

## 10. Критерии готовности и отчёт исполнителя

- [ ] Семь операций/три события имеют один согласованный контракт, применённый
  renderer, bundled preload и main handlers. Негативные type/runtime tests работают.
- [ ] NoteItem совпадает с локальной row shape, NoteUpdate — с SQL whitelist.
  Нет фиктивных cloud полей, aliases прежнего пути или broad any/assertions.
- [ ] Старые Notes registrations/bridge copies удалены. Нет двойных listeners,
  событий или изменения порядка mirror/participants callbacks.
- [ ] SQL/schema, Notes UX, все сохранённые функции и realtime behavior сохранены;
  исправлены только обязательные typed consumers и проверки отсутствующей note.
- [ ] Sandbox и упаковка сохранены; preload является одним собранным файлом,
  main/worker используют существующий dist-main. build/typecheck/lint покрывают
  новые файлы; неверные значения не проходят из-за непроверяемого JS wrapper.
- [ ] Focused, полный suite без DB skips и isolated packaged smoke выполнены.
  Не заявлена свежая hardware/provider certification без её проведения.
- [ ] В PR перечислены изменения, точные результаты и оставшиеся ограничения.
  Указано, что DatabaseManager/остальной IPC остаются JS и следующий этап
  providers/settings/realtime ещё не выполнен. Issue #10 целиком не закрывать.

В отчёте достаточно: что изменилось в контракте и wiring; какие тесты прошли;
какие baseline failures отделены от регрессий; какие файлы/настройки не удалось
проверить и почему. Не выдавать только план или перечень переименованных файлов
вместо завершённой вертикали.
