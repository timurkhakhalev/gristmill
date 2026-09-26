# Сборка Electron перед миграцией на TypeScript

Первый шаг [issue #10](https://github.com/timurkhakhalev/openhercules/issues/10).
Функции приложения, настройки провайдеров и realtime flow не меняются.

## Как запускается приложение

`pnpm run build:main` очищает только `dist-main/` и компилирует код Electron
через `tsconfig.main.json`. TypeScript сам проходит по импортам от `main.js`,
`preload.js` и отдельно загружаемого ONNX worker; копирует используемые JSON.
Никакие `.env`, assets или native binaries в этот каталог не копируются.

Sandboxed preload не может require локальные модули, поэтому после успешного
tsc `build-main.js` бандлит исходный `preload.js` (вместе с
`src/preload/notesBridge.ts`, `src/preload/urlDownloadBridge.ts`,
`src/preload/vocabularyBridge.ts`, `src/preload/containerBridge.ts`,
`src/preload/chatBridge.ts`, `src/preload/actionsBridge.ts` и
`src/contracts/*.ts`) в один файл
`dist-main/preload.js` через esbuild (`bundle`, `format=cjs`,
`platform=node`, `target=node24`, `external:electron`; devDependency
`esbuild@0.28.1`). Ошибка bundle завершает сборку и удаляет промежуточный
unbundled preload. Main и worker остаются под tsc без бандлинга.

`package.json#main` указывает на `dist-main/main.js`. И `pnpm start`, и
`pnpm run dev:main` сначала собирают этот каталог. `build:mac:arm64`, `pack`
и `dist` тоже собирают его перед упаковкой. После изменения main-кода в dev
нужно перезапустить `pnpm run dev:main`; hot reload renderer остаётся у Vite.
Прямой запуск `electron .` требует предварительного `pnpm run build:main`.

Основной формат — CommonJS. Единственное ESM-исключение в текущем графе:
`src/config/constants.mts` → `dist-main/src/config/constants.mjs`, поскольку
там уже используется `import.meta.env`. Смысл настроек сохранён. Node/Electron
загружают этот модуль через поддерживаемый require(ESM), без TS loader.
Остальные TS-файлы получают расширение `.js`; TypeScript переписывает
явные относительные `.ts`/`.mts` импорты в соответствующие выходные расширения.

Пути к preload и worker остаются относительными к собранным модулям.
ONNX worker распаковывается в `app.asar.unpacked/dist-main/src/workers/`;
родитель загружает его через виртуальный asar path, как раньше. Пути к
`.env`, иконкам и dev native binaries используют `app.getAppPath()`, потому
что эти ресурсы принадлежат корню приложения, а не каталогу с JS.
Renderer по-прежнему собирается в `src/dist`; native binaries поставляются
через существующий `extraResources`. В пакет не входят исходные main/helpers.

## Проверка типов и lint

- `pnpm run typecheck:main`: Node/Electron target, `strict: true`, без DOM globals.
- `pnpm run typecheck:renderer`: существующий browser target в `src/tsconfig.json`.
- `pnpm run typecheck:settings-selectors`: strict noEmit target
  (`tsconfig.settings-selectors.json`, `types: []`) над чистым графом
  provider-настроек: `contracts/inferenceSettings.ts`,
  `config/settingsSelectors.ts`, `config/inferenceScopes.ts`,
  `config/transcriptionCapabilities.ts`, `helpers/reasoningRouting.ts`,
  `helpers/meetingTranscriptionRouting.ts`.
  Граф не импортирует store/Zustand/localStorage/i18n/Electron — только
  contracts и статические capabilities; compiler probes в
  `test/helpers/settingsSelectorsTypes.test.js` проверяют отказ на неверный
  scope, неверные типы полей и DOM-зависимость.
- `pnpm run typecheck`: все три проверки последовательно.
- `pnpm run lint`: включает TS в helpers/utils и `.mts` в renderer/shared code.

Оставшийся JS включён в сборку с `allowJs: true`, но пока не проверяется
(`checkJs: false`). Это явная граница первого шага, а не утверждение, что весь
Electron уже типобезопасен. TS-модули графа проверяются строго уже сейчас.
При переводе следующего файла JS → TS он попадает под strict по своему импорту;
не добавлять any/assertions/ts-ignore, чтобы обходить ошибки.
Типизация IPC и согласование NoteItem с SQLite относятся к следующему шагу.

## Проверки сборки

`pnpm test` собирает main, если выбранные тесты используют результат сборки.
Полный прогон и проверка mainBuild требуют сборки. Для отдельного прогона:

```sh
pnpm test -- test/scripts/mainBuild.test.js
```

Эти тесты проверяют относительные зависимости всего выходного графа,
отсутствие runtime-импортов TypeScript, sandbox preload и unsubscribe,
загрузку route + ESM constants обычным Node без TS loader. Отдельная
compiler-проверка подтверждает отказ на неверный аргумент и DOM global в main.
Пакет и native ABI проверяются существующими afterPack и изолированным smoke.
Tests/build/install/rebuild запускаются последовательно. Никакая проверка
этого шага не требует записи, платных API или профиля OpenWhispr.

## Результат проверки этого шага

14 сентября 2026:

- `pnpm run typecheck` — обе проверки прошли.
- `pnpm run lint` — 0 ошибок, 46 предупреждений: прежние 45 и один
  ранее не проверявшийся unused `MODIFIERS` в `hotkeyValidator.ts`.
- `pnpm test` — 2390 passed, 0 failed/skipped, последовательный прогон.
- `pnpm run pack` — renderer/main/native сборки и macOS arm64 `.app` готовы;
  afterPack проверил SQLite ABI и распакованный worker. Без подписи.
- Дополнительно: настоящий Electron utilityProcess загрузил worker из
  `app.asar/dist-main` и ответил на `ping`, без загрузки модели или аудио.
  В asar проверено отсутствие исходных main/preload/helpers и `.env`.

Первый полный прогон обнаружил 15 ошибок в трёх test harnesses без
`app.getAppPath()`. Заглушки обновлены; сначала прошли 33 focused tests,
затем полный прогон выше. Это не ошибки, скрытые fallback-кодом приложения.
Реальная запись и платные API не использовались. Проверки hardware realtime
и качества распознавания этот шаг не заявляет.

## Этап 3a: чистые selectors конфигурации providers

14 сентября 2026 (issue #10, пункт 3, подэтап 3a). Вычисление effective
provider-конфигурации вынесено из `stores/settingsStore.ts` в чистый TS-граф:

- `src/config/settingsSelectors.ts` — единственное место четырёх
  `selectResolved*` функций и их Resolved* типов. Store импортирует их для
  внутренних вызовов; `setResolvedLLMConfig`, hydration, migrations и
  secure-key persistence остались в store.
- `src/contracts/inferenceSettings.ts` — узкие snapshot-типы входа селекторов
  (только читаемые поля) плюс `InferenceMode`, `SelfHostedType`,
  `LocalTranscriptionProvider`, `CloudReasonPurpose` (перенесены из
  `types/electron.ts`, который ре-экспортирует их).
- `src/config/inferenceScopes.ts` — без импорта SettingsState: storeKeys
  типизированы по snapshot, fallbackScope ограничен `InferenceScopeId`.
- `src/config/transcriptionCapabilities.ts` — `STREAMING_ONLY_PROVIDERS`
  (перенесён из `helpers/transcriptionRoute.ts`) и
  `DEFAULT_CLOUD_TRANSCRIPTION_PROVIDER` (одна копия для store и селектора).
- `src/helpers/reasoningRouting.ts` — типизирован (был `.js`).

Границы владения: store (`stores/settingsStore.ts`) — загрузка, migrations,
persistence, setters; `config/settingsSelectors.ts` — чистое вычисление из
snapshot; callers (meeting/upload/AI Actions/chat) — только вызов селекторов
поверх `getSettings`/`useSettingsStore`. Чистый граф проверяется strict-таргетом
`typecheck:settings-selectors` (см. «Проверка типов и lint»), поведение —
characterization-тестами `test/helpers/settingsSelectors*.test.js` с прямым
импортом без browser harness. Интеграционные проверки миграций и follow-flags
сохранены через store harness.

## Inventory на первом шаге

Срез определяется реальным графом `tsc -p tsconfig.main.json --listFilesOnly`,
а не всеми файлами в каталоге helpers. В нём **80 JS, 105 TS, 1 MTS и 25 JSON**
(только `src/`; main/preload/worker — отдельные entry points). Entry points:
main, preload и ONNX worker. Тесты и tooling в граф не входят.
Модули helpers, которые используются только renderer, остаются в Vite-графе.

Исходный срез репозитория после cleanup: `src` — 168 JS, 2 JSX, 1 MJS,
188 TS, 252 TSX. На этом шаге constants.ts переименован в constants.mts.
Отдельно: root main/preload; 335 JS-тестов на исходной точке; scripts — 21 JS
и 2 MJS; root cleanup.js/eslint.config.js — tooling. В этом PR добавлены
build-main.js и mainBuild.test.js. Перевод тестов/tooling на TS не входит в шаг.
К 14 сентября 2026 срез стал `src` — 166 JS, 196 TS (+MTS), 252 TSX: этап 3a
(types/electron → contracts/inferenceSettings и reasoningRouting.js → .ts) и
этап «общий speaker count» (speakerCount.js → .ts) уменьшили JS-инвентарь.

Список ниже — текущие входные файлы графа Electron; сторонние библиотеки
и type declarations исключены. При изменении entry points или импортов
список можно сверить командой выше.

- `main.js`
- `preload.js`
- `src/contracts/notes.ts`
- `src/contracts/urlDownload.ts`
- `src/contracts/vocabulary.ts`
- `src/contracts/containers.ts`
- `src/contracts/chatPersistence.ts`
- `src/contracts/actions.ts`
- `src/contracts/localFileTranscription.ts`
- `src/contracts/uploadTranscription.ts`
- `src/contracts/reasoning.ts`
- `src/contracts/calendar.ts`
- `src/contracts/calendarAvailability.ts`
- `src/config/constants.mts`
- `src/config/secretKeys.ts`
- `src/constants/speakerDetection.json`
- `src/constants/whisperVad.json`
- `src/helpers/abortError.ts`
- `src/helpers/agentStreamRequestRegistry.ts`
- `src/helpers/anthropicResponse.ts`
- `src/helpers/appleCalendarManager.ts`
- `src/helpers/assemblyAiStreaming.js`
- `src/helpers/audioActivityDetector.ts`
- `src/helpers/audioStorage.ts`
- `src/helpers/audioTapManager.ts`
- `src/helpers/autoStart.js`
- `src/helpers/autoStartPolicy.js`
- `src/helpers/notesEvents.ts`
- `src/helpers/notesIpcHandlers.ts`
- `src/preload/notesBridge.ts`
- `src/preload/urlDownloadBridge.ts`
- `src/preload/vocabularyBridge.ts`
- `src/preload/containerBridge.ts`
- `src/preload/chatBridge.ts`
- `src/preload/actionsBridge.ts`
- `src/preload/localFileTranscriptionBridge.ts`
- `src/preload/uploadTranscriptionBridge.ts`
- `src/preload/reasoningBridge.ts`
- `src/preload/calendarBridge.ts`
- `src/preload/calendarAvailabilityBridge.ts`
- `src/helpers/bedrockCatalog.ts`
- `src/helpers/binaryResolver.ts`
- `src/helpers/builtinActions.ts`
- `src/helpers/calendarReminderScheduler.ts`
- `src/helpers/calendarSyncInterval.ts`
- `src/helpers/cliBridge.ts`
- `src/helpers/cortiAuth.ts`
- `src/helpers/cortiStreaming.js`
- `src/helpers/cortiTranscription.ts`
- `src/helpers/database.ts`
- `src/helpers/dbTimestamp.ts`
- `src/helpers/debugLogger.js`
- `src/helpers/deepgramStreaming.js`
- `src/helpers/devServerManager.js`
- `src/helpers/diarization.js`
- `src/helpers/diarizationPolicy.js`
- `src/helpers/dockManager.js`
- `src/helpers/dockPolicy.js`
- `src/helpers/downloadUtils.ts`
- `src/helpers/dragManager.js`
- `src/helpers/electronProcessIds.js`
- `src/helpers/enterpriseAiProviders.ts`
- `src/helpers/enterpriseProviderErrors.js`
- `src/helpers/environment.ts`
- `src/helpers/externalUrlOpener.js`
- `src/helpers/ffmpegUtils.ts`
- `src/helpers/geminiLiveStreaming.js`
- `src/helpers/geminiTranscription.ts`
- `src/helpers/ggufMetadata.js`
- `src/helpers/globeKeyManager.js`
- `src/helpers/googleCalendarManager.ts`
- `src/helpers/googleCalendarOAuth.ts`
- `src/helpers/granolaImport.ts`
- `src/helpers/hotkeyList.js`
- `src/helpers/hotkeyManager.js`
- `src/helpers/hotkeyRepeatGate.js`
- `src/helpers/i18nMain.js`
- `src/helpers/ipcHandlers.js`
- `src/helpers/liveSpeakerIdPolicy.js`
- `src/helpers/liveSpeakerIdentifier.js`
- `src/helpers/llamaContextPolicy.js`
- `src/helpers/llamaCppInstaller.js`
- `src/helpers/llamaServer.js`
- `src/helpers/localModelDownloadStatus.js`
- `src/helpers/localServerPolicy.js`
- `src/helpers/localTranscriptionModels.js`
- `src/helpers/markdownMirror.ts`
- `src/helpers/meetingAudioActivityMonitor.ts`
- `src/helpers/meetingAudioTimeline.ts`
- `src/helpers/meetingAutoEndController.js`
- `src/helpers/meetingAutoEndLifecycle.js`
- `src/helpers/meetingDetectionEngine.js`
- `src/helpers/meetingDiarizationInput.ts`
- `src/helpers/meetingEchoLeakDetector.ts`
- `src/helpers/meetingJoinUrl.js`
- `src/helpers/meetingMicGate.ts`
- `src/helpers/meetingMicHoldback.ts`
- `src/helpers/meetingProcessDetector.js`
- `src/helpers/meetingStreamingProviders.js`
- `src/helpers/meetingSystemAudioWatchdog.ts`
- `src/helpers/meetingTranscriptionLifecycle.js`
- `src/helpers/menuManager.js`
- `src/helpers/microsoftCalendarManager.ts`
- `src/helpers/microsoftCalendarOAuth.ts`
- `src/helpers/modelDirUtils.ts`
- `src/helpers/modelManagerBridge.js`
- `src/helpers/navigationGuard.js`
- `src/helpers/networkErrors.ts`
- `src/helpers/noteSearch.ts`
- `src/helpers/notificationTimer.js`
- `src/helpers/oauthLoopbackFlow.ts`
- `src/helpers/onboardingWindowBounds.js`
- `src/helpers/onnxWorkerClient.js`
- `src/helpers/openaiRealtimeStreaming.js`
- `src/helpers/ownProcessPids.js`
- `src/helpers/parakeet.js`
- `src/helpers/parakeetCapability.js`
- `src/helpers/parakeetModelInfo.js`
- `src/helpers/parakeetServer.js`
- `src/helpers/parakeetWsResult.js`
- `src/helpers/parakeetWsServer.js`
- `src/helpers/processListCache.js`
- `src/helpers/providerConnectionTest.ts`
- `src/helpers/realtimeTokenProviders.js`
- `src/helpers/retentionSettings.ts`
- `src/helpers/safeTempDir.ts`
- `src/helpers/secretCrypto.ts`
- `src/helpers/selfHostedTranscription.ts`
- `src/helpers/sidecarPidFile.ts`
- `src/helpers/sidecarReaper.ts`
- `src/helpers/sidecarRegistry.ts`
- `src/helpers/speakerAssignmentPolicy.js`
- `src/helpers/speakerCount.ts`
- `src/helpers/speakerEmbeddings.js`
- `src/helpers/speakerMerge.js`
- `src/helpers/stripThinking.js`
- `src/helpers/systemDefaultMicrophone.ts`
- `src/helpers/systemTar.ts`
- `src/helpers/urlDownloadIpcHandlers.ts`
- `src/helpers/vocabularyEvents.ts`
- `src/helpers/vocabularyIpcHandlers.ts`
- `src/helpers/containerEvents.ts`
- `src/helpers/containerIpcHandlers.ts`
- `src/helpers/chatPersistenceIpcHandlers.ts`
- `src/helpers/actionsEvents.ts`
- `src/helpers/actionsIpcHandlers.ts`
- `src/helpers/localFileTranscription.ts`
- `src/helpers/localFileTranscriptionIpcHandler.ts`
- `src/helpers/remoteTranscriptionIpcHandler.ts`
- `src/helpers/fileDiarizationIpcHandlers.ts`
- `src/helpers/uploadCancelIpcHandler.ts`
- `src/helpers/uploadCancelRegistry.ts`
- `src/helpers/reasoningIpcHandlers.ts`
- `src/helpers/calendarIpcHandlers.ts`
- `src/helpers/calendarEvents.ts`
- `src/helpers/calendarAvailability.ts`
- `src/helpers/calendarAvailabilityService.ts`
- `src/helpers/calendarAvailabilityIpcHandler.ts`
- `src/helpers/tinfoilCatalog.ts`
- `src/helpers/tinfoilRealtimeStreaming.js`
- `src/helpers/tinfoilSecureClient.ts`
- `src/helpers/tinfoilTranscription.ts`
- `src/helpers/transcriptFormatter.ts`
- `src/helpers/transcriptText.ts`
- `src/helpers/transcriptionRoute.ts`
- `src/helpers/transcriptionTimeout.js`
- `src/helpers/tray.js`
- `src/helpers/uploadTimestamps.ts`
- `src/helpers/urlAudioDownloader.ts`
- `src/helpers/whisper.js`
- `src/helpers/whisperServer.js`
- `src/helpers/whisperVadConfig.js`
- `src/helpers/windowBroadcast.js`
- `src/helpers/windowConfig.js`
- `src/helpers/windowManager.js`
- `src/locales/ar/prompts.json`
- `src/locales/ar/translation.json`
- `src/locales/de/prompts.json`
- `src/locales/de/translation.json`
- `src/locales/en/prompts.json`
- `src/locales/en/translation.json`
- `src/locales/es/prompts.json`
- `src/locales/es/translation.json`
- `src/locales/fr/prompts.json`
- `src/locales/fr/translation.json`
- `src/locales/it/prompts.json`
- `src/locales/it/translation.json`
- `src/locales/ja/prompts.json`
- `src/locales/ja/translation.json`
- `src/locales/pt/prompts.json`
- `src/locales/pt/translation.json`
- `src/locales/ru/prompts.json`
- `src/locales/ru/translation.json`
- `src/locales/zh-CN/prompts.json`
- `src/locales/zh-CN/translation.json`
- `src/locales/zh-TW/prompts.json`
- `src/locales/zh-TW/translation.json`
- `src/models/modelRegistryData.json`
- `src/services/localReasoningBridge.ts`
- `src/services/transcriptionBaseUrl.ts`
- `src/utils/audioUtils.ts`
- `src/utils/process.ts`
- `src/utils/serverUtils.ts`
- `src/utils/urlUtils.ts`
- `src/workers/onnxWorker.js`

## Этап «общий normalizer числа спикеров»

14 сентября 2026 (issue #10, пункт 3). Дубликат `normalizeStoredSpeakerCount`
убран: `src/helpers/speakerCount.js` → `src/helpers/speakerCount.ts`
(`value: unknown → number | null`), локальная копия в
`src/services/uploadNotes.ts` удалена — оба процесса (main: `ipcHandlers.js`
через emitted `.js`; renderer: `uploadNotes.ts` через Vite) используют одну
TS-функцию. Extensionless `require("./speakerCount")` в `ipcHandlers.js`
разрешается в emitted `.js` после `build:main`; неиспользуемый импорт из
`database.js` удалён. Coercion-семантика `Number()` зафиксирована
characterization-тестами (`test/helpers/speakerCount.test.js`): строки и
одноэлементные массивы coercion-ятся, `false`/`0`/дробные/`NaN` → `null`,
Symbol по-прежнему бросает TypeError. Parity-тест «копия равна оригиналу»
заменён явными assertions результата `buildUploadNoteMetadata`. Diarization
algorithm, metadata policy и SQL не менялись.

Проверка: `pnpm run typecheck` 0 ошибок; `pnpm run lint` 0 errors; focused —
26 passed (`speakerCount`, `uploadNotes`, `uploadDiarizationPersistence`,
`mainBuild`); `pnpm run build:renderer` OK; emitted
`dist-main/src/helpers/speakerCount.js` загружен в plain Node без tsx и дал
ожидаемые значения. Полный `pnpm test` — 2451 passed, 0 failed/skipped.
Inventory обновлён (граф Electron: 133 JS, 9 TS, 1 MTS, 25 JSON).

## Этап «типизированный IPC импорта по HTTPS»

14 сентября 2026 (issue #10, пункт 3, план PR #16). Три канала download
вертикали вынесены из `ipcHandlers.js` в `src/helpers/urlDownloadIpcHandlers.ts`
с общим контрактом `src/contracts/urlDownload.ts` (Zod, типы выводятся из схем)
и bridge `src/preload/urlDownloadBridge.ts` (подключён к bundled preload).
Downloader `urlAudioDownloader.js` не переписан: он передаётся узкой
зависимостью `download`/`sweepStaleTempArtifacts` (+ `getSafeTempDir`), его
результаты и progress валидируются схемами на границе; SSRF/proxy/redirect/
content-limit логика осталась в прежних regression-тестах. Характеристика
(`test/helpers/urlDownloadIpc.test.js`, 24 теста): targeted progress,
генерация `dl-N`, tolerant cancel-all, identity guard при reuse id, passthrough
ошибок с fallback `DOWNLOAD_FAILED`, basename/realpath/relative-guard
временного cleanup, per-registration Map. E2E
(`test/helpers/urlDownloadBridge.test.js`, 7 тестов) гоняет настоящий bundled
preload → handler Map → fake downloader; malformed progress отбрасывается
на границе preload. Compile probes (`test/scripts/urlDownloadTypeProbe.test.js`)
под strict-настройками main: обращение к `error` внутри success-ветки не
компилируется (2339), корректная пара bridge/handler компилируется.

Проверка: typecheck 0 ошибок; lint 0 errors (baseline 44+2 warnings); focused
55 passed (`urlDownloadIpc`, `urlDownloadBridge`, `urlAudioDownloader`,
`rendererBridgeContract`, `mainBuild`, type probes); `build:main` OK.
Inventory графа Electron: 131 JS, 37 TS, 1 MTS, 25 JSON.

## Этап «типизированный IPC Dictionary/Snippets»

14 сентября 2026 (issue #10, пункт, план PR #20). Десять каналов словаря и
snippets вынесены из `ipcHandlers.js` в
`src/helpers/vocabularyIpcHandlers.ts` с общим контрактом
`src/contracts/vocabulary.ts` и bridge `src/preload/vocabularyBridge.ts`
(подключён к bundled preload). SQL остаётся в `database.js`: он передаётся
узкой зависимостью, его нормализация (trim, lowercase-dedupe, фильтр невалидных
snippets) не ужесточена схемами — исторические throws (`words/add/remove/
snippets must be an array`), tolerant null-delta, quiet-fail undo и
re-read-from-SQLite broadcast payloads сохранены и зафиксированы
characterization-тестами (`test/helpers/vocabularyIpc.test.js`, 10 тестов).
Оба события идут через senders `src/helpers/vocabularyEvents.ts`
(`sendDictionaryUpdated`/`sendSnippetsUpdated`) — их используют хендлеры и
`cliBridge.js`; malformed payload дропается с логом, не попадая в renderer.
Main-only каналы (hard delete, broadcast pull, undo) без renderer consumer не
попадают в bridge API. Fallback «older preload → setDictionary(optimistic)» в
`settingsStore.ts` удалён: delta-канал теперь обязателен. E2E
(`test/helpers/vocabularyBridge.test.js`, 4 теста) гоняет настоящий bundled
preload → handlers → временный SQLite; malformed события инжектируются прямо
на вход preload и дропаются на нём.

Проверка: typecheck 0 ошибок; lint 0 errors (baseline 44+2 warnings); focused
74 passed (vocabularyIpc, vocabularyBridge, cliBridgeDictionary,
cliBridgeSnippets, dictionaryStartup, databaseLocalBehavior,
rendererBridgeContract, mainBuild, vocabularyTypeProbe, dictionaryTool,
snippetTool, snippets);
`build:main` OK. Inventory графа Electron: 131 JS, 37 TS, 1 MTS, 25 JSON.

## Этап «типизированный IPC папок и пространств (containers)»

14 сентября 2026 (issue #10, план PR #21). Восемь каналов folders/spaces
вынесены из `ipcHandlers.js` в `src/helpers/containerIpcHandlers.ts` с
контрактом `src/contracts/containers.ts` и bridge
`src/preload/containerBridge.ts` (подключён к bundled preload). Схемы
отражают локальные таблицы SQLite (folders/spaces, kind=private) — облачные
поля эры OpenWhispr (cloud_id, sync_status, teams, my_role и др.) удалены из
типов вместе с FolderPushSnapshot/FolderAckResult/SpaceTeamRef; consumers
(noteStore, SpacesTree, CommandSearch, useContainerChat, UploadAudioView,
overview components, NoteEditor, shared, searchNotesTool, utils) берут
FolderItem/SpaceItem из общего контракта. Пять событий идут через senders
`src/helpers/containerEvents.ts` (хендлеры и CLI folder-created);
malformed payload дропается с логом. Недостижимая relocatedNotes-ветка
удалена: `database.deleteFolder` возвращает только `{success}`, notes
переживают удаление через ON DELETE SET NULL —
`folderDeleteRelocationContract.test.js` теперь проверяет фактическое
сохранение notes и порядок mirror-вызовов вместо grep по тексту кода.
`onSpacePurged` не имеет producer и в bridge не экспонируется;
main-only события (folder-created/renamed/synced, space-synced) без
renderer-подписок в bridge не попадают.

Проверка: typecheck 0 ошибок; lint 0 errors (baseline 44+2 warnings);
`build:main` OK; focused tests (containerIpc 8, containerBridge 4,
folderDeleteRelocationContract 2, rendererBridgeContract, mainBuild,
notesIpc, databaseLocalBehavior/Schema, notesDatabase,
spacesTreeNoteActionClearance, toolUtils, searchNotesTool); compiler probe
на неполную DB deps; полный `pnpm test`; `pnpm run pack`; Node ABI
Inventory графа Electron: 131 JS, 37 TS, 1 MTS, 25 JSON.

## Этап «типизированная граница chat persistence»

14 сентября 2026 (issue #10, план PR #24). Тринадцать каналов embedded-chat
персистенции (`db-*-agent-conversation*`, `db-get-conversations-for-*`,
`db-add/get-agent-messages`) вынесены из `ipcHandlers.js` в
`src/helpers/chatPersistenceIpcHandlers.ts` с контрактом
`src/contracts/chatPersistence.ts` и bridge `src/preload/chatBridge.ts`
(подключён к bundled preload; события у каналов нет — broadcast не
добавлялся). Формы отражают локальные таблицы SQLite: обычные списки —
`SELECT *`-строки без вымышленных полей, `getConversationsForContainer`
добавляет `message_count`, preview-список — nullable `preview`, create/get
— detail (row + messages). Ложное обещание `message_count` у
note-списков удалено вместе с cloud-era `ConversationPreview`
(`cloud_id`, `client_conversation_id`, `sync_status`, `folder_delete_pending`);
`NoteConversationItem`/`ContainerConversationItem` в потребителях
схлопнуты в `ConversationRow`/`ContainerConversation` из контракта,
`chatStore.ConversationItem` — алиас shared row. Metadata остаётся
непрозрачной областью: structured payload на записи (сериализует DB-слой),
JSON-строка на чтении; renderer сохраняет разбор toolCalls. Null-семантика
отсутствующих id, дефолты (Untitled, 50/20, offset 0, exclude archived),
LIKE-поиск и каскады зафиксированы characterization-тестами на реальной
SQLite (`chatPersistenceBehavior.test.js`, включая одно-секундную
гранулярность `CURRENT_TIMESTAMP` в тестах порядка).

Проверка: typecheck 0 ошибок; lint 0 errors (baseline 44+2 warnings);
`build:main` OK; focused tests (chatPersistenceBehavior 13,
chatPersistenceIpc 9, chatBridge e2e через bundled preload 4 — включая
guard от повторной регистрации канала после дефекта #23,
chatPersistenceTypeProbe 3: неполная DB TS2741, wrong role TS2345,
полный контракт + bridge под strict); notesIpc, databaseLocalBehavior/
Schema, notesDatabase, conversationTitle, chatMessageSubmissionLock,
chatRouting, containerIpc/containerBridge, rendererBridgeContract, mainBuild;
полный `pnpm test` 2547 passed; pack + isolated smoke. Inventory графа
Electron: 133 JS, 23 TS, 1 MTS, 25 JSON.

## Этап «типизированная граница каталога AI Actions»

14 сентября 2026 (issue #10, план PR #25). Пять каналов каталога
(`db-get-actions`, `db-get-action`, `db-create-action`, `db-update-action`,
`db-delete-action`) вынесены из `ipcHandlers.js` в
`src/helpers/actionsIpcHandlers.ts` с контрактом `src/contracts/actions.ts`,
sender-модулем `src/helpers/actionsEvents.ts` и bridge
`src/preload/actionsBridge.ts` (5 методов + 3 подписки). Каталог отделён от
выполнения: prompt execution остаётся в useActionProcessing/
actionProcessingStore. `ActionItem` отражает локальную таблицу actions:
`is_builtin` — SQLite 0|1 (не boolean), `translation_key` nullable, update
whitelist строго name/description/prompt/icon/sort_order — is_builtin и
translation_key в API не входят, неизвестные поля отбрасывает DB-слой.
События — как раньше: setImmediate после успешного результата (create/
update несут полную строку, delete — `{id}`), failures/events не отправляют;
malformed payload дропается с диагностикой на обеих границах. Семантика
зафиксирована characterization: ORDER BY sort_order,id (Generate Notes при
sort_order 0 выигрывает id-тай-брейк), icon default только при omitted,
builtin редактировать можно, удалять нельзя, seeding не перезаписывает
пользовательский prompt (включая перезапуск БД в e2e).

Проверка: typecheck 0 ошибок; lint 0 errors (baseline 46+2 warnings);
`build:main` OK; focused (actionsCatalogBehavior 7, actionsIpc 6,
actionsBridge e2e через bundled preload 4 — включая shared registration
guard, actionsTypeProbe 3: неполная DB TS2741/2554+2345 wrong bridge call,
positive под strict; actionProcessingNoteOutput, chat/container suites,
rendererBridgeContract, mainBuild); полный `pnpm test` 2567 passed;
pack + isolated smoke. Inventory графа Electron: 133 JS, 27 TS, 1 MTS,
25 JSON.

## Этап «типизированная граница локальной транскрипции файла»

14 сентября 2026 (issue #10, план PR #28). Первый ограниченный шаг
миграции file transcription: только локальный маршрут `transcribe-audio-file`.
Чтение файла и whisper-vs-sherpa dispatch вынесены в
`src/helpers/localFileTranscription.ts` — общий модуль, через который идут
и IPC handler, и CLI bridge (composition entrypoint в
`IPCHandlers.transcribeLocalFile`, второй реализации нет). Тонкий
`src/helpers/localFileTranscriptionIpcHandler.ts` владеет проверкой
allowed-path до чтения, регистрацией requestId в существующем
uploadCancelRegistry (один реестр, не создаётся на запрос), переводом
исключений в IPC failure (abort → Cancelled/UPLOAD_CANCELLED) и release в
finally. Контракт `src/contracts/localFileTranscription.ts` сохраняет
реальные формы результатов managers — message у whisper no-audio,
warning=truncated у sherpa, code=NO_SPEECH_DETECTED, invalid_response —
вместо узкой старой декларации. Soft-cancel семантика сохранена: runId
подавляет поздний результат, hard cancel IPC не добавлялся; вводящие в
заблуждение комментарии handler'а исправлены. Managers, VAD resolver и
approved-path registry остаются владельцами своей логики; options идут
насквозь (whisper получает noteRecording VAD merge, sherpa — signal).

Проверка: typecheck 0 ошибок; lint 0 errors (baseline 47+2 warnings);
`build:main` OK; focused (localFileTranscriptionBehavior 7,
localFileTranscriptionIpc 6, localFileTranscriptionBridge e2e через
bundled preload 4 — включая shared registration guard,
localFileTranscriptionTypeProbe 3: неполные deps TS2345/2741, wrong bridge
call TS2345, positive под strict; uploadCancelRegistry,
fileTranscriptionCustomEndpoint/DiarizationWarning/Managed/Timestamps,
rendererBridgeContract); полный `pnpm test` 2587 passed; pack + isolated
smoke. Inventory графа Electron: 131 JS, 37 TS, 1 MTS, 25 JSON.

## Этап «типизированная граница календарной доступности»

14 сентября 2026 (issue #10, план PR #29). Расчёт свободных интервалов и
канал `calendar-get-availability` переведены в strict TS без изменения
правил времени и privacy-проекции. `src/helpers/calendarAvailability.ts`
(конвертация из JS, ESM-исходник сохранён) — чистый расчёт с typed
normalized request/intervals/slots и внутренним результатом с busy;
`calendarAvailabilityService.ts` — узкий DB callback + provider/manager
connection status, injectable clock, apple только darwin, валидация до
connection check, query range ±buffer; wire-проекция (range/timezone/
isEntireRangeFree/availableSlots/hasMore/coverage, никогда busy) в
`src/contracts/calendarAvailability.ts` с discriminated response.
`calendarAvailabilityIpcHandler.ts` — одна регистрация, логирование и
Error/non-Error политика сообщений; preload `calendarAvailabilityBridge.ts`
валидирует ответ, так что extra private fields от main-мока не достигают
renderer. Tool сохраняет независимую fail-closed проекцию недоверенных
model args и allowlist user-correctable errors — отдельная граница
доверия. Все существующие правила (explicit-offset RFC3339, leap year,
5-minute tolerance, 31-day horizon, slot/buffer/maxResults bounds,
all-day local dates, declined/canceled/free исключения, слияние/clip/
truncation) не менялись; сообщения ошибок не заменялись generic Zod
errors.

Проверка: typecheck 0 ошибок; lint 0 errors (baseline 47+2 warnings);
`build:main` OK; focused (calendarAvailability 12, calendarAvailabilityService 3,
calendarAvailabilityBridge e2e через bundled preload 5 — включая shared
registration guard, calendarAvailabilityTypeProbe 3: неполные deps
TS2741/2345, wrong response usage TS2339, positive под strict;
calendarAvailabilityTool 14, calendarDatabase/Tool/ReminderScheduler 26,
rendererBridgeContract); полный `pnpm test` 2596 passed; pack + isolated
smoke. Inventory графа Electron: 131 JS, 37 TS, 1 MTS, 25 JSON.

## Этап «upload execution, remote transcription и hard cancel»

15 сентября 2026 (issue #32). Вертикаль Audio Upload для удалённой
транскрипции и локальной диаризации переведена в strict TS с явной отменой
одного upload execution. Каналы `transcribe-audio-file-byok`,
`diarize-audio-file`, `merge-speaker-text` и новый `cancel-upload-transcription`
описаны одним контрактом `src/contracts/uploadTranscription.ts` (Zod, типы
выводятся из схем) и bridge `src/preload/uploadTranscriptionBridge.ts`;
ручные методы удалены из `preload.js` и `src/types/electron.ts`.

- `src/helpers/remoteTranscriptionIpcHandler.ts` — удалённая транскрипция,
  вынесена из `ipcHandlers.js` с узкими зависимостями (path resolution,
  read/stat, route resolver, provider clients, multipart transport,
  credentials, logging). Невалидный payload отклоняется до path resolution,
  чтения файла и сети; присутствующий `requestId` валидируется как непустой.
  `buildMultipartBody`/`AUDIO_MIME_TYPES` переехали сюда; реальный
  `postMultipart` (Electron net) остался в `ipcHandlers.js` и передаётся
  зависимостью. Provider payloads принимаются как `unknown` и проецируются
  в проверенный wire result (diarized_json/`speakers`, verbose segments,
  непустой `text`); local-маршрут на этом канале закрывается fail-closed.
  `byokSizeCapError`, `MISTRAL_TRANSCRIPTION_URL` и `XAI_STT_URL` переехали
  в `transcriptionRoute.ts` (их по-прежнему используют retry и proxy-каналы).
- `src/helpers/fileDiarizationIpcHandlers.ts` — только file-oriented
  diarize/merge. Cancel проверяется после ленивой подготовки моделей и между
  стадиями, `AbortSignal` передаётся в `convertToWav` и диаризатор,
  временный WAV и регистрация освобождаются в `finally`. Нормализующее
  поведение merge (sanitization, лимиты как error result) сохранено.
- `src/helpers/uploadCancelIpcHandler.ts` + `src/helpers/uploadCancelRegistry.ts`
  (переведён из JS в strict TS, поведение без изменений) — один app-scoped
  реестр; `cancel-upload-transcription` абортит все операции requestId
  (параллельные transcription+diarization), повторный/поздний cancel — no-op.
- Транспорты получили сигнал: generic/self-hosted multipart, OpenAI/
  custom/Azure, Mistral/xAI, Gemini, Tinfoil и каждый сетевой шаг Corti
  (токен через `AbortSignal.any`, cleanup DELETE — на собственном
  `AbortSignal.timeout`, не на уже aborted signal). `ffmpegUtils.convertToWav`
  убивает child по abort и отвергает AbortError только после закрытия child.
  Отмена возвращает `Cancelled`/`UPLOAD_CANCELLED`, не provider error.
- Renderer: `transcribeFile` передаёт один `requestId` одновременно в
  транскрипцию и диаризацию (раньше BYOK-вызов его терял — дефект #32);
  Stop одиночного upload вызывает hard cancel до UI reset и проверяет
  generation после асинхронной подготовки настроек; `cancelBatch()` отменяет
  текущий item, фоновой очереди навигация по-прежнему не касается;
  `FileTranscriptionResult` наследует общие поля обоих wire-контрактов.
  Передача ключей и settings не менялась (перенос секретов в main — отдельное
  решение).

Проверка: `pnpm run typecheck` 0 ошибок; `pnpm run lint` 0 errors (baseline
47+2 warnings); strict compiler probes в
`test/scripts/uploadTranscriptionTypeProbe.test.js`. Characterization и
отмена: `test/helpers/remoteTranscriptionIpc.test.js`,
`fileDiarizationIpc.test.js`, `uploadCancelIpc.test.js` (включая e2e
параллельной отмены transcription+diarization одного id),
`uploadTranscriptionBridge.test.js` через bundled preload,
`test/stores/batchQueueCancel.test.js` (hard cancel текущего item и
игнорирование позднего результата). Inventory графа Electron:
130 JS, 43 TS, 1 MTS, 25 JSON.

## Этап «main-owned reasoning IPC и enterprise streaming»

15 сентября 2026 (issue #33). Оставшаяся main-owned reasoning граница
переведена в strict TS: локальный one-shot reasoning и его availability,
Anthropic one-shot proxy, enterprise one-shot reasoning (с sender-scoped
Bedrock cleanup lifecycle), cancel Bedrock one-shot и полный жизненный цикл
enterprise stream (start/cancel/part). Контракт `src/contracts/reasoning.ts`
задаёт channel/event names, точные позиционные аргументы, дискриминированные
success/failure results и envelope стрима; bridge `src/preload/reasoningBridge.ts`
валидирует responses и дропает malformed envelopes до callback. Ручные
reasoning-методы удалены из `preload.js` и `src/types/electron.ts`.

- `src/helpers/agentStreamRequestRegistry.js` → strict TS (+`isActive`):
  identity — `(senderId, requestId)`; повторный id того же sender абортит
  прежний stream, complete идентичность-защищён. Глобальный
  `enterpriseStreamAborts` заменён sender-scoped registry; enterprise
  streaming использует отдельный экземпляр от Bedrock one-shot cleanup
  (`_enterpriseReasoningRequests` / `_enterpriseStreams`), cancel одной
  операции не затрагивает другую. Cancel lookup идёт по sender текущего
  event; терминальный done/error отправляется только пока живой controller —
  late terminal заменённого stream не доходит до нового stream с тем же id.
- `src/services/localReasoningBridge.js` → strict TS (default-instance export
  сохранён): one-active-request policy, config defaults, complete-output и
  thinking cleanup без изменений.
- `src/helpers/reasoningIpcHandlers.ts`
- `src/helpers/calendarIpcHandlers.ts`
- `src/helpers/calendarEvents.ts`: все шесть операций с узкими
  зависимостями (environment keys, local service, provider model factory,
  error mapper, retry/timeout helpers, transports, logger). JS provider
  factories описаны узкими интерфейсами на границе (`EnterpriseStreamModel`
  с compile-time pin против `LanguageModelV3`); их внутренняя конвертация —
  отдельный этап. Bedrock retry/timeout/cancel policy, SSRF endpoint
  validation и provider error mapping сохранены; raw provider errors в
  renderer-facing result не попадают.
- Stream parts: main читает `LanguageModelV3StreamPart` (SDK union) и
  применяет узкий structured-clone adapter — обычные части (tool/input/
  reasoning/usage/finish, binary, metadata) клонируются как есть, непереносимые
  `raw`/`error` payload деградируют до описания; JSON-stringify всего part и
  cast произвольного unknown в SDK part отсутствуют. Envelope-валидация
  (`streamId` + ровно один из part/done/error) — это проверка конверта, не
  полей SDK part. Navigation/destroy абортят provider request и снимают
  listeners; pre-aborted signal не запускает запрос.
- Renderer: `enterpriseChatModel` подписывается до start, фильтрует по своему
  streamId, снимает envelope-listener и abort-listener ровно один раз во всех
  исходах, пересылает AbortSignal в cancel operation, обрабатывает abort
  между subscribe и start, failed invoke и late terminal events; explicit
  cancel закрывает локальный поток без ожидания main terminal. Провайдеры
  local/anthropic/enterprise переведены на контракт (`result.success === false`
  вместо `!result.success` — в не-strict renderer только равенство сужает
  дискриминированный union). BYOK/LAN streaming, useChatStreaming, tool
  registry и chat persistence не рефакторились.

Проверка: `pnpm run typecheck` 0 ошибок; `pnpm run lint` 0 errors (baseline
47+2 warnings); strict compiler probes в
`test/scripts/reasoningTypeProbe.test.js` (неполные deps, неверные payloads,
failure-arm использование, положительный граф). Characterization:
`test/helpers/agentStreamRequestRegistry.test.js` (sender isolation,
replacement protection), `reasoningIpc.test.js` (one-shot shapes для
Local/Anthropic/Bedrock, cancel sender isolation, retry policy, stream
start/parts/done/error, duplicate id, navigation/destroy, structured-clone
roundtrip и деградация raw/error), `reasoningBridge.test.js` через bundled
preload, `test/services/enterpriseChatModel.test.js`. Inventory графа
Electron: 130 JS, 48 TS, 1 MTS, 25 JSON (оба конвертированных .js не входили
в tsc-граф — они достижимы только через require; новые .ts вошли).

## Этап «calendar connections, sync и renderer contract»

15 сентября 2026 (issue #34). Оставшаяся calendar-граница вокруг уже
типизированной availability переведена в strict TS: Google/Microsoft/Apple
connection status, accounts, calendar list/selection, provider-neutral
upcoming/event reads, sync/подключение-события, Apple connect/disconnect и
Calendar privacy settings. Контракт `src/contracts/calendar.ts` владеет
channel/event names (существующие имена без aliases), аргументами,
дискриминированными results и event payload-схемами; bridge
`src/preload/calendarBridge.ts` валидирует responses и дропает malformed
events до callback, подписки возвращают idempotent unsubscribe. Ручные
calendar entries/listeners удалены из `preload.js` и `src/types/electron.ts`;
`CalendarEvent`/account/status/attendee типы переехали из
`src/types/calendar.ts` в контракт (там остались только meeting-detection и
contacts), consumers обновлены без compatibility re-export.

- `src/helpers/calendarIpcHandlers.ts`: один registration module с узкими
  Google/Microsoft/Apple manager interfaces (обязательные методы — required
  dependencies), отдельными `getUpcomingEvents`/`getCalendarEventById`
  callback-ами (текущие владельцы: Google manager над общей `calendar_events`
  таблицей и прямой DB lookup), injected opener для Calendar privacy и
  logger. OAuth/sync/reminders/data cleanup остаются в менеджерах; managers
  остаются JS. Invalid window/event ID/selection args отклоняются до
  manager/DB call.
- Status DTO фиксирует absence-vs-false: Google fallback — `{connected:false,
email:null}` без `configured/accounts`; Microsoft fallback — без
  `configured`; Apple fallback — `{connected:false, sourceNames:[]}`.
  Malformed успешный status не проходит как валидный (parse-fallback на
  disconnected-форму).
- Wire projection: `projectCalendarEvent` — allowlist из 14 полей
  `calendar_events`, используемых UpcomingMeetings/useUpcomingEvents/
  calendarTool/note metadata lookup (all-day локальные даты и SQLite
  timestamps остаются в stored строковой форме); `synced_at` не пересекает
  preload. `projectGoogleCalendarSummary` убирает `sync_token`/
  `sync_token_expires_at`/`created_at` (sync tokens остаются только в
  хранении). OAuth/access/refresh tokens и raw provider responses в renderer
  DTO не входят. Malformed row дропается, валидные сохраняются.
- `src/helpers/calendarEvents.ts` — typed senders для шести событий;
  менеджеры (google/microsoft/appleCalendarManager.js) вызывают их вместо
  raw `broadcastToWindows`, malformed payload дропается с диагностикой до
  отправки.
- Renderer: `useUpcomingEvents`, UpcomingMeetings, IntegrationsView,
  CalendarConnectionsStep, settingsStore, `calendarTool` (типизированная
  projection над validated DTO вместо map по `Record<string,unknown>`) и
  PersonalNotesView на shared типах. `join-calendar-meeting` остался в
  meeting-detection boundary; availability contract не объединён с
  connection management.

Проверка: `pnpm run typecheck` 0 ошибок; `pnpm run lint` 0 errors
(42+2 warnings — ниже прежнего baseline 47+2: часть предупреждений ушла с
удалённым кодом); strict compiler probes в
`test/scripts/calendarTypeProbe.test.js`. Characterization:
`test/helpers/calendarIpc.test.js` (configured/unconfigured absence forms,
OAuth/disconnect failure detail, selection/primary-only валидация,
provider-neutral reads с invalid-input и malformed-row деградацией,
privacy opener), `calendarEvents.test.js` (senders: валидные broadcast,
malformed дропаются), `calendarBridge.test.js` через bundled preload
(все три провайдера, malformed events, idempotent unsubscribe, junk
responses, отсутствие duplicate registrations). Существующие manager tests
(Google sync-token expiry, Microsoft delta, Apple restart/denied/snapshot)
не менялись — менеджеры продолжают ту же работу через typed senders.
Inventory графа Electron: 130 JS, 52 TS, 1 MTS, 25 JSON.

## Этап «inventory оставшегося JS и удаление подтверждённых остатков»

15 сентября 2026 (issue #35). Воспроизводимая ревизия достижимости
оставшегося JS и удаление только доказанно мёртвых исходников.

### Команды и категории

```sh
# main compiler graph (entry points: main.js, preload.js, ONNX worker)
./node_modules/.bin/tsc -p tsconfig.main.json --listFilesOnly \
  | grep -v node_modules | grep -v dist/ | sed 's|.*/openhercules/||' | sort

# tracked runtime-кандидаты (без tests/scripts/tooling)
git ls-files '*.js' '*.mjs' '*.jsx' | grep -v '^test/' | grep -v '^scripts/' \
  | grep -v eslint.config.js | grep -v cleanup.js

# референс-свип по каждому basename: импорты/require/dynamic import,
# worker/config/build/native пути, CLI, тесты
git grep -ln "<basename>" -- ':!docs' ':!<сам файл>'
```

Категории: (1) main compiler graph — 130 JS + 52 TS + 1 MTS + 25 JSON;
(2) renderer-only JS (достижимы из Vite-графа, не в main graph) — живые
consumers в src; (3) build-scripts (scripts/) — whisperCppRelease и др.;
(4) tests/scripts/config — не входят в runtime count; (5) подтверждённо
мёртвые — нет ни одного production caller. Отсутствие файла в main graph
само по себе dead code не означает: renderer и динамическая загрузка
учитывались отдельным git grep-свипом по basename по всем tracked-файлам
(включая строковые require/import, workers, electron-builder.json,
package.json scripts).

### Удалено (нет production caller; единственные ссылки — собственные тесты)

- `src/helpers/autoLearnSetting.js`, `mainWindowPlacementCoordinator.js`,
  `onboardingInputPolicy.js`, `smartSpacing.js`, `toastPresentation.js`,
  `translationChain.js`, `tokenStore.js`, `linuxSession.js`
  (последний — ни одной ссылки вообще, даже теста; окно-менеджмент читает
  session-env сам через `resolveOverlayWindowType`);
- `src/utils/dictionaryEchoFilter.js`, `dictionaryKeywords.js`,
  `windowSizeLadder.js` (windowSizeLadder — ноль ссылок);
- `src/hooks/useHotkey.js` (живой остаётся `useHotkeyRegistration.ts`);
- их монотесты: `autoLearnSetting`, `mainWindowPlacementCoordinator`,
  `onboardingInputPolicy`, `smartSpacing`, `toastPresentation`,
  `translationChain`, `dictionaryEchoFilter`, `dictionaryKeywords`
  (`.test.js`); source-removal контракты не затронуты — их нет по этим
  файлам;
- устаревший mock `./tokenStore` в `test/helpers/bedrockEnterpriseIpc.test.js`
  (ipcHandlers больше ничего не требует оттуда).

### Проверено и оставлено

- `src/helpers/appVersion.js` — оставлен по решению issue: parity-тест
  `test/helpers/appVersion.test.js` фиксирует совпадение main/renderer
  валидации версий; в debugLogger поле версии берётся из Electron
  `app.getVersion()`.
- `src/helpers/whisperCppRelease.js` — используется
  `scripts/download-whisper-cpp.js` (production build path prebuild/pack).
- Остальные 18 renderer-side JS вне main graph (activeMicRecovery,
  agentNameDictionary, chatRouting, dictionaryImport/Startup/PromptCap,
  geminiResponse, llmRequestTimeout, localModelSelections,
  meetingTranscriptionRouting, micDeviceSelection/micSelectionRecovery/
  microphoneSelection, noteFormattingOverrides, regenerableNoteTitle,
  useControlPanelWindowDrag, chineseScript, retiredPrompts) — каждый имеет
  живой consumer в src; владельцы миграции — соответствующие renderer issues
  roadmap #10.
- ONNX worker остаётся в graph и в `asarUnpack` (mainBuild.test.js);
  `appVersion` доступен в dist-main, динамических require путей удалённые
  файлы не имели.

Проверка: `pnpm run typecheck` 0 ошибок; `pnpm run lint` 0 errors
(42+2 warnings, без изменений — удалённые файлы предупреждений не несли).
Graph Electron не изменился: 130 JS, 52 TS, 1 MTS, 25 JSON (ни один
удалённый файл не входил в main compiler graph). Срез `src` после удаления:
148 JS, 2 JSX, 1 MJS, 235 TS, 252 TSX, 1 MTS.

## Этап «общие text/config helpers и renderer entrypoints»

15 сентября 2026 (issue #36). Оставшиеся небольшие shared helpers, два
renderer entrypoint и конфиг retired-prompts переведены в strict TS; один
TS-источник работает и в emitted Node CJS graph, и в renderer ESM (Vite).
Общие модули не импортируют Electron/DOM/`import.meta.env`; boot остаётся
в renderer graph и не входит в tsconfig.main.

- Helpers: `agentNameDictionary`, `builtinActions` (+`BuiltInAction`),
  `chatRouting` (+`ChatRoute`), `dictionaryImport`, `dictionaryStartup`,
  `noteFormattingOverrides` (+типы scope-override), `regenerableNoteTitle`,
  `retentionSettings` (CJS→ESM exports, узкие deps хендлера), `stripThinking`,
  `transcriptFormatter` (типы export-сегментов/заметки; NUL speaker-key и
  вся логика merge/timestamps без изменений), `transcriptText`,
  `uploadTimestamps` (+тип verbose-сегмента), `config/retiredPrompts`
  (узкий `PromptOverrideStorage`), `utils/chineseScript` (типизированные
  script-target/preference; opencc-js грузится динамически как раньше),
  `utils/dictionaryPromptCap`. Nullable-входы описаны по реальным callers —
  прежняя нормализация (Array.isArray/typeof-гарды) сохранена, строгих
  reject нет.
- Entrypoints: `main.jsx` → `main.tsx`, `AppRouter.jsx` → `AppRouter.tsx`,
  `index.html` ссылается на `/main.tsx`; отсутствующий root `#root` теперь
  явный throw. Порядок providers, HMR (`import.meta.hot`), document-language
  binding, notification route, onboardingCompleted и открытие transcription
  settings после onboarding не менялись.
- Strict-область: глобальный renderer остаётся нестрогим; strict для
  entrypoints обеспечивает `tsconfig.renderer-entrypoints.json` +
  `test/scripts/rendererEntryTypeProbe.test.js` — компилирует программу
  entrypoints под strict и требует нуля diagnostics в самих `main.tsx`/
  `AppRouter.tsx` (strict-ошибки legacy-модулей в замыкании не скрыты и не
  чинятся здесь; их ~144 строк — предмет будущих renderer issues). Общие
  helpers проверяются двумя armами `sharedHelpersTypeProbe.test.js`:
  Node-таргет (NodeNext, `types: node`, без DOM lib — заодно доказывает
  отсутствие Electron/DOM зависимостей) и renderer-таргет (bundler + DOM),
  плюс negative-проба.
- Тесты обновлены на `.ts`-спецификаторы; extensionless CJS-require из
  `ipcHandlers.js`/`database.js`/`markdownMirror.js`/`diarization.js`
  разрешаются в emitted `.js` как раньше. JS-файлы удалены (второго
  execution path нет).

Проверка: `pnpm run typecheck` 0 ошибок; `pnpm run lint` 0 errors (baseline
42+2); обе armы shared-пробы и entrypoint-проба проходят под CLI-tsc
эквивалентами. Inventory графа Electron: 124 JS, 58 TS, 1 MTS, 25 JSON; срез `src`:
133 JS, 0 JSX, 1 MJS (vite.config), 250 TS, 254 TSX, 1 MTS.

## Этап «download/filesystem и sidecar process primitives»

15 сентября 2026 (issue #37). I/O-примитивы, на которых стоят model
downloads, FFmpeg и native server lifecycle, переведены в strict TS:
`abortError`, `downloadUtils`, `systemTar`, `ffmpegUtils`, `safeTempDir`,
`modelDirUtils`, `binaryResolver`, `sidecarPidFile`, `sidecarReaper`,
`sidecarRegistry`, `utils/process`, `utils/serverUtils` и
`urlAudioDownloader`. Отдельные functions/modules сохранены; общего job
runner нет; resource owner и AbortSignal-протяжка — прежние.

- Download/archive: Range/resume, 200-vs-206, retryable codes, TLS/no-retry,
  stall timer, temp close-before-unlink (cleanup ждёт `close` pending
  open-а), atomic rename c EXDEV-fallback, stale-tmp sweep и disk-space
  reservation без изменений; типизированы `DownloadSignal` (структурный
  сигнал менеджеров, не DOM AbortSignal), `DownloadError` (code/isAbort/
  isHttpError/isTlsError), progress callback и результат попытки. Транспорт
  (Electron net / node https) не менялся.
- `urlAudioDownloader` — та же implementation за типизированным url-download
  IPC: HTTPS-only, запрет YouTube, DNS/private-address/NAT64 проверки,
  redirect-лимиты и private-host re-check, 500MiB cap, connect/stall
  таймауты, temp ownership и close-before-unlink. SSRF policy не смешана с
  provider endpoint policy. Electron net для proxy-пути — по-прежнему
  ленивый require с test seam `_setElectronNetForTests`.
- FFmpeg: типизированы conversion options (`ConvertToWavOptions` с signal из
  #32), split result, WAV format/samples, segment buffers; аргументы
  child-процессов остаются массивами execFile/spawn (никаких shell-строк);
  пути packaged/development без изменений.
- Sidecar: PID-file читается как unknown и валидируется до использования
  (integer > 0); name+command matching перед kill, SIGTERM grace → SIGKILL →
  сохранение surviving PID, shutdown deadline/allSettled, name+command
  фрагменты — прежние. Новой platform abstraction нет.
- Интеграция: extensionless CJS-require менеджеров (`whisper.js`,
  `parakeet.js`, `llamaServer.js`, `modelManagerBridge.js`, `diarization.js`,
  `appleCalendarManager.js`, `cliBridge.js` и др.) разрешаются в emitted
  `.js`; тесты с явными `.js`-спецификаторами переведены на `.ts`
  (downloadUtils/modelDirUtils в 6 файлах + `m1IdentitySourceContract`).
  Второго wrapper-пути нет.

Проверка: `pnpm run typecheck` 0 ошибок; `pnpm run lint` 0 errors (41+2
warnings — на одно ниже прежнего baseline: устранён unused `e` в
`utils/process`); strict compiler probes в
`test/scripts/downloadsTypeProbe.test.js` (негативные call sites + полный
positive graph). Inventory графа Electron: 111 JS, 71 TS, 1 MTS, 25 JSON.

## Этап «SQLite row types и DatabaseManager»

16 сентября 2026 (issue #38). Persistence adapter переведён в strict TS:
`database.js` → `database.ts` (778 строк), `noteSearch.js`, `dbTimestamp.js`.
Один DatabaseManager, те же SQL/транзакции/схема; ORM/repository-слоя нет.

- Инвентаризация SQL shapes зафиксирована в типизированных internal row
  интерфейсах (notes/blank notes, spaces/folders, actions, dictionary/
  snippets, chat conversations/messages (+message_count/preview), calendar
  events с dedupe-колонкой, tokens-строки, contacts, speaker profiles/
  mappings/embeddings, transcriptions): SQLite timestamps остаются строками,
  integer-booleans — числами, `folder_id`/`embedding` nullable,
  `lastInsertRowid` — number|bigint с явным Number() там, где он уже был.
  Internal rows не объявлены публичными DTO: токены и embedding Buffers
  main-only; shared contracts не расширены.
- better-sqlite3 types не поставляются и @types не установлен — описан узкий
  структурный surface (`SqliteDatabase`/`SqliteStatement`/`SqliteRunResult`),
  который реально использует менеджер; statement results кастуются к row
  типам только на SQL boundary. Arbitrary JSON (`agent_messages.metadata`)
  остаётся строкой/null до проверки потребителем.
- `module.exports = DatabaseManager` сохранён CommonJS-контрактом в конце
  файла: все существующие require-сайты (main.js, ipcHandlers.js, тесты)
  продолжают получать класс напрямую и в source (tsx), и в emitted `.js`.
  Поведение use-after-close стало явным throw "Database is closed" вместо
  TypeError от null (прежде тоже падало, теперь с диагностикой).
- Behavior сохранён: миграции/schema/WAL/foreign keys, transaction ordering,
  note/folder relocation, built-in action overrides, calendar dedup
  (NUL-подобная `has_synced` проекция), selection/sync storage; отсутствие
  строки (`null`) и malformed row не смешиваются; пустые no-field обновления
  возвращают ровно `{success:false}`, как раньше.
- Тесты: 21 файл с явным `.js`-спецификатором database/noteSearch переведён
  на `.ts`; strict compiler probes в `test/scripts/databaseTypeProbe.test.js`
  — негативные коды (2554/2345/2322×7) сверены фактическим tsc-прогоном,
  positive graph чист под standalone strict.

Проверка: `pnpm run typecheck` 0 ошибок; `pnpm run lint` 0 errors (40+2
warnings — на 1 ниже прежнего: ушёл unused GENERATE_NOTES_KEY в database);
runtime-shape smoke: `require('./src/helpers/database.ts')` под tsx возвращает
класс (function, без .default), noteSearch/dbTimestamp дают прежние
значения. Inventory графа Electron: 108 JS, 74 TS, 1 MTS, 25 JSON.

## Этап «note files, Granola import, audio storage и CLI bridge»

16 сентября 2026 (issue #39). Локальные file/CLI adapters переведены в
strict TS, file/import-каналы получили общий contract + typed handler +
bundled bridge.

- `audioStorage.js` → `audioStorage.ts`: file naming (wall-clock из
  `parseDbTimestamp`), retention cleanup (`cleanupExpiredAudio` + callers),
  `deleteAllAudio` без изменений; cleanup-колонки/ID-парсинг прежние.
  CommonJS-контракт `module.exports = AudioStorageManager` сохранён.
- `markdownMirror.js` → `markdownMirror.ts` (singleton через
  `module.exports = new MarkdownMirror()`): encode-префикс `__ow-`,
  Windows-reserved, symlink-гварды, frontmatter YAML-экранирование,
  rename/delete propagation, rebuild и note-vs-transcript globbing без
  изменений; типы `MirroredNote`/`MirrorSpeakerMapping`.
- `granolaImport.js` → `granolaImport.ts` (уже ESM): RFC-4180 tokenizer,
  header synonyms, date normalization (UTC/US/month-first), speaker-line
  режим, deterministic UUID и note-key allocator — поведение 1:1; типы
  `GranolaParsedNote`/`CsvWarning`/парсинг-результаты.
- `cliBridge.js` → `cliBridge.ts`: та же route table, discovery file
  (version 1, порты 8200–8219, 127.0.0.1, random token, mode 0600),
  timingSafeEqual bearer, loopback-фильтр, 1MiB body cap, UTF-8 decode
  после concat, error/status/204 shapes, lifecycle. Вместо непроверяемого
  `IPCHandlers` — узкий `CliBridgeOperations` (databaseManager-slice +
  существующие операции и event senders); wiring в main.js явный. Удалён
  мёртвый вызов `_asyncVectorUpsert` (метод исчез из IPCHandlers при
  cleanup векторного стора — CLI create/update ноты падал бы 500).
- Note-files/granola cutover: `src/contracts/noteFiles.ts` (9 каналов,
  аргументы, дискриминированный preview/result, без путей через bridge),
  `src/helpers/noteFilesIpcHandlers.ts` (deps: mirror, dialogs, fs,
  importNotes, granola preview→run state остаётся в main),
  `src/preload/noteFilesBridge.ts`; ручные entries удалены из `preload.js`
  и `src/types/electron.ts`. `importNotes` errors — `{error}` (не
  `{clientNoteId, error}`, как в реальном DB-результате).

Проверка: `pnpm run typecheck` 0 ошибок; `pnpm run lint` 0 errors (39+2
warnings — на 1 ниже прежнего); strict probes
`test/scripts/noteFilesTypeProbe.test.js` (коды 2345×3/2339×2/2353
сверены фактическим tsc-прогоном; positive graph чист). Inventory графа
Electron: 104 JS, 81 TS, 1 MTS, 25 JSON.

## Этап «calendar managers, OAuth transport и reminders»

16 сентября 2026 (issue #40). Реальные implementation за контрактом #34
переведены в strict TS: три managers остаются отдельными, универсального
provider framework нет.

- `oauthLoopbackFlow` → TS: типизированы callback-result/state/PKCE,
  timeout/cancel, первый-terminal-callback claim и server cleanup;
  redirect/scopes/PKCE/multi-account/token persistence — прежние.
  `googleCalendarOAuth`/`microsoftCalendarOAuth` → TS: token responses
  (error/description pair, rotated refresh), email resolution (Google
  id_token, Microsoft preferred_username + Graph /me fallback),
  in-flight refresh dedupe Microsoft, revocation Google. Credentials не
  регистрируются и не менялись.
- `googleCalendarManager` → TS: pagination, sync-token TTL/full-window
  pruning (410 fallback), selected calendars, primary-only, contacts
  upsert; provider payload — unknown → `GoogleEventItem` parser →
  internal rows. `microsoftCalendarManager` → TS: delta links,
  series-master backfill (bare-stub keep-stored-row policy), сокращённый
  TTL при неудачном backfill без потери старого cache, Graph datetime
  normalization (все windows разные, алгоритмы не унифицированы).
- `appleCalendarManager` → TS: newline JSON протокол EventKit child
  описан типами; внешние сообщения валидируются (`isPermissionMessage`/
  `isSnapshotMessage`/`isHelperSnapshotEvent`) до DB mutations; connect
  result — дискриминированное union (unsupported/helper-missing/denied/
  snapshot-failed); first-snapshot promise, restart backoff, stale child
  callbacks не владеют replacement (`_onHelperGone` identity check).
- `calendarReminderScheduler` → TS: dedupe/reschedule/disconnect/reconcile
  semantics прежние; `calendarSyncInterval` → TS (backoff/focus throttle).
  Handler #34 не дублирует manager side effects. CommonJS-контракты всех
  восьми модулей сохранены (`module.exports = Class[+helpers]`), wiring в
  main.js/ipcHandlers.js не менялся.

Проверка: `pnpm run typecheck` 0 ошибок; `pnpm run lint` 0 errors (39+2
warnings — на 1 ниже); runtime-shape smoke под tsx (все 8 модулей:
class/function + helpers на месте); strict probes
`test/scripts/calendarManagersTypeProbe.test.js` — коды 2345×5/2554×3
сверены фактическим tsc-прогоном, positive graph чист. Inventory графа
Electron: 96 JS, 89 TS, 1 MTS, 25 JSON.

## Этап «environment и secret storage implementations»

16 сентября 2026 (issue #41). Main-owned настройки и encrypted secret
persistence переведены в strict TS: `environment.js`(532) → `.ts`,
`secretCrypto.js` → `.ts`, `config/secretKeys.js` → `.ts`. Storage format и
владелец credentials не менялись.

- Storage contract зафиксирован типами: `SecretEnvKey` — literal union из
  `as const`-каталога BYOK + перечисленных enterprise/corti/custom ключей
  (свободного string index нет); PERSISTED_KEYS — упорядоченный список
  записи .env; BackendMode secretCrypto — keychain (32-byte master в
  keychain, AES-256-GCM per secret, safeStorage backup 0600 с atomic
  rename) / safeStorage / unavailable; `DecryptResult.needsReencrypt`
  описывает legacy-blob recovery.
- Behavior сохранён: env precedence (userData `.env` override → fallback
  paths), ленивая инициализация crypto, migration sentinel (`secure-keys/
.migrated` пишется до strip plaintext, failed migration сохраняет .env и
  НЕ пишет sentinel), round-trip verification, atomic tmp+rename записи
  (`.enc` и `.env`, сериализованные общим envWriteQueue), rename fallback
  CUSTOM_REASONING→CUSTOM_CLEANUP, clearAllPersistedData, BYOK accessors,
  генерируемые из каталога на prototype. `.env`-значения секретов не
  логируются (в error-логе только key name + code).
- Catalog: `BYOK_API_KEYS` теперь `as const satisfies readonly
ByokApiKeyEntry[]` — literal имена get/save делают сгенерированную
  поверхность типизированной (`EnvironmentManagerWithByok` для typed
  consumers; runtime-аттачмент на prototype как раньше). Dual-export
  паттерн везде явный: `module.exports = X; module.exports.X = X` —
  проверено на emitted graph: cross-module named import
  (`new environment_js_1.EnvironmentManager()`) + CJS require оба дают
  конструктор (урок #57 применён).
- Callers: ipcHandlers.js/hotkeyManager.js/main.js extensionless requires
  разрешаются в emitted `.js` без изменений; public channels не тронуты.

Проверка: `pnpm run typecheck` 0 ошибок; `pnpm run lint` 0 errors (39+2
warnings); emitted-graph smoke по прод-пути (tsc --outDir + named import
консьюмер под stubbed electron/keyring); targeted behavior tests
`test/helpers/envSecretStorage.test.js` (fake keychain/safeStorage/tmp
userData: backend modes, master-key reuse без перезаписи, legacy
re-encrypt flag, fail-closed, migration sentinel + strip .env, failed
migration preserves plaintext, clearAllPersistedData, секреты не попадают
в логи); strict probes `test/scripts/envSecretTypeProbe.test.js` — коды
(2345/2322/2554×2/2339) сверены фактическим tsc-прогоном, positive graph
чист. Inventory графа Electron: 93 JS, 92 TS, 1 MTS, 25 JSON.

## Этап «provider factories, response adapters и connection checks»

16 сентября 2026 (issue #42). Оставшийся unchecked JS за typed
upload/reasoning boundary переведён в strict TS (14 файлов) и убрано
дублирование endpoint policy.

- Factories/errors: `enterpriseAiProviders.ts` (узкие
  `EnterpriseRuntimeConfig`/credential-chain types, lazy requires прежние),
  `enterpriseProviderErrors.ts` — mapped error union (`MappedEnterpriseError`
  с technicalDetails), Bedrock retry/abort options, SSRF endpoint guard;
  SDK raw errors сужаются через `asErrorRecord` без any. Приоритеты
  retry/failure, messageKey/messageParams и retryable — без изменений.
- Upload adapters: `cortiAuth.ts` (token cache keying по digest секрета,
  timeout/`AbortSignal.any`), `cortiTranscription.ts` (interaction REST flow,
  cleanup на собственном timeout), `tinfoilSecureClient.ts` (attested client
  per session), `tinfoilTranscription.ts`, `geminiTranscription.ts`
  (Interactions API, 400+API_KEY_INVALID fallback), `geminiResponse.ts`,
  `selfHostedTranscription.ts`, `anthropicResponse.ts`, `networkErrors.ts`,
  `bedrockCatalog.ts`, `tinfoilCatalog.ts` — все auth dialects, cancellation,
  malformed-response handling сохранены; contracts #32/#33 deps
  (`transcribeWithCorti/Tinfoil/Gemini` сигнатуры) уже совпадают.
- URL policy dedup: characterization-parity тест
  `test/helpers/providerUrlPolicyParity.test.js` (private-LAN HTTP,
  public HTTP denial, IPv4/IPv6/.local/.ts.net, decorators, suffixes,
  model-list candidates, custom-endpoint private-HTTP rule) — после него
  CJS-зеркала в `providerConnectionTest.ts` удалены; модуль импортирует
  `normalizeBaseUrl`/`getModelListBaseCandidates` из `constants.mts` и
  `isSecureHttpEndpoint` из `urlUtils.ts` (Vite-модуль в main не
  импортируется). Deepgram/AssemblyAI 200-only probe и
  MODEL_LIST_UNVERIFIABLE semantics сохранены.
- Экспорт-модель: все 14 модулей — named ESM exports без `module.exports`
  (consumers деструктурируют именованные функции; класс-паттерн #57 здесь не
  нужен). Emitted-graph prod-path smoke (tsc --outDir + compiled consumer с
  cross-module named imports) — exit 0. `scripts/stt-canary.mjs` переведён на
  `.ts`-спецификатор geminiTranscription (Node 24 type-stripping).
- Connection-check IPC остался в текущих каналах (`test-provider-connection`
  / `test-enterprise-connection`) — их vertical не входит в этот issue;
  типизированные результаты уже описаны в reasoning/upload contracts.

Проверка: `pnpm run typecheck` 0 ошибок; `pnpm run lint` 0 errors (39+2
warnings — baseline, без новых);
strict probes `test/scripts/providerAdaptersTypeProbe.test.js` — коды
(2345×2/2554×4/2322×2/2352/2559) сверены фактическим tsc-прогоном,
positive graph чист. Inventory графа Electron: 80 JS, 105 TS, 1 MTS,
25 JSON.

## Этап «локальные Whisper/Parakeet модели: lifecycle и серверы»

16 сентября 2026 (issue #43). Жизненный цикл локальных моделей
(14 файлов: `whisper`, `whisperServer`, `whisperVadConfig`, `parakeet`,
`parakeetServer`, `parakeetWsServer`, `parakeetWsResult`,
`parakeetCapability`, `parakeetModelInfo`, `localTranscriptionModels`,
`localModelDownloadStatus`, `localModelSelections`, `localServerPolicy`,
`transcriptionTimeout`) переведён в strict TS; менеджеры Whisper и Parakeet
остаются раздельными, метаданные — в существующем JSON-реестре
(`modelRegistryData.json` через `require` + типизированную проекцию
`WhisperModelRegistryEntry`).

- Новый контракт `src/contracts/localModelLifecycle.ts`: 28 каналов
  (`localModelChannels`), `downloadProgressEventSchema`
  (sequence-stamped), `modelNameSchema` и
  результатные интерфейсы (`LocalModelStatusRow`, `LocalModelListResult`,
  `LocalModelActionResult`, `InstallCheckResult`, `ServerLifecycleResult`,
  `ServerStatusResult`, `FfmpegAvailabilityResult`, `VadConfigResult`,
  `DiagnosticsResult`), собранные в `LocalModelLifecycleApi`.
- `whisper.ts`: типизированный `WhisperManager` (download process, ffmpeg
  availability cache, rewarm gating через `shouldRewarmOnWake`), опции
  transcribe `{ signal, vadEnabled, ... }`. `whisperServer.ts`:
  thread resolution (env/auto/manual с clamp), VAD signature, inference
  options (`INFERENCE_DECODER_FIELDS`), `waitForReady`. Аргументы сервера
  собирает `buildWhisperServerArgs`.
- `parakeet*.ts`: manifest fetch через типизированный `fetchJson`,
  extraction retry с кодом ошибки, offline/online пути WS-сервера
  (`parakeetWsServer.ts` с типизированными ws-callbacks),
  streaming finish через `OnlineAccumulator` (`parakeetWsResult.ts`).
- IPC: `registerLocalModelLifecycleHandlers` (28 каналов,
  `src/helpers/localModelLifecycleIpcHandlers.ts`) с узкими
  `WhisperManagerLike`/`ParakeetManagerLike` deps; download-семантика
  сохранена посимвольно (status-tracker sequence, complete на успехе,
  подавление error-события при `DOWNLOAD_IN_PROGRESS`). Parakeet server
  start/stop персистит provider selection только при успехе.
  `whisper-vad-get/set-config` сохранён контракт 1:1: set никогда не
  отвергает — владелец настроек фильтрует allowed keys на записи и
  sanitize/clamp на чтении (схемной валидации на записи нет, как и до cutover).
  Каналы `transcribe-local-whisper`/`transcribe-local-parakeet` остались
  в `preload.js`/`ipcHandlers.js` — они принадлежат vertical #32.
- Bridge: `src/preload/localModelLifecycleBridge.ts` (schema-validated
  `subscribeProgress`, единый boundary-cast `passthroughResult<T>` на
  десериализации). Слушатели прогресса в renderer принимают `(data)` без
  `(_event, ...)` (bridge валидирует и передаёт только payload).
- Экспорт-модель: классы — `export class`, функции — named exports без
  `module.exports`. Emitted-graph prod-path smoke (tsc --outDir + compiled
  consumer) — exit 0. `VAD_LIMITS` экспортирован (единственный новый
  warning устранён).
- Тесты: спецификаторы `.js`→`.ts` в 8 тест-файлах;
  characterization `test/helpers/localModelLifecycleIpc.test.js`
  (sequence/complete/error события, DOWNLOAD_IN_PROGRESS, persist-on-success,
  invalid model name, invalid VAD payload); strict probes
  `test/scripts/localModelLifecycleTypeProbe.test.js` — коды (2740/2322/2339)
  сверены фактическим tsc-прогоном. Fixture `parakeetModelManifest.test.js`
  переведён с vm-исходника (ломается на ESM-синтаксисе TS) на require под
  Module._load хуками с tsx; stub `./parakeetServer` — named-export shape
  (`{ ParakeetServerManager: class ... }`), `AbortSignal.timeout` подменяется
  глобально на время теста.

Проверка: typecheck 0 ошибок (main/renderer/selectors); lint 0 errors
(39+2 warnings — baseline, без новых). Inventory графа Electron: 67 JS,
121 TS, 1 MTS, 25 JSON.

## Этап «local LLM model manager и llama-server»

17 сентября 2026 (issue #44). Local LLM lifecycle (6 файлов:
`modelManagerBridge`, `llamaServer`, `llamaCppInstaller`, `ggufMetadata`,
`llamaContextPolicy`, `llmRequestTimeout`) переведён в strict TS за новый
контракт `localLlmModels`. ModelManagerBridge и LlamaServerManager остаются
действующими owners; registry JSON и GGUF metadata по-прежнему определяют
memory/context constraints.

- `ggufMetadata.ts`: типизированный `HeaderCursor` (bounds checks сохранены),
  `GgufSource`/`GgufMetadata` — absent-метаданные это `undefined`, не
  придуманный default. `llamaContextPolicy.ts`: `GgufArchitectureMetadata`
  (scalars + GGUF per-layer arrays), `scalarValue` сужает не-number поля в
  unknown → тот же fallback, что и до cutover (NaN-путь). Все 15 экспортов
  прежние.
- `llamaServer.ts`: `export class LlamaServerManager` с типизированными
  полями (process/port/contextSize/draft paths/timers), `LlamaServerOptions`,
  `ChatMessage`, `InferenceOptions`, `LlamaResponseError`; typed
  `_requestJson<T>`, `buildResponseError` (CONTEXT_TOO_LARGE с
  neededTokens/maxContextTokens), grow-only restart, idle/health checks
  сохранены. Dual-export: `module.exports = LlamaServerManager` +
  `module.exports.LlamaServerManager` (modelManagerBridge и legacy-тесты
  требуют класс).
- `modelManagerBridge.ts`: типизированный `ModelManager` (download
  reservations, drafter-прогресс с clamp, context ceiling с GGUF-метаданными,
  `_ensurePromptFits` preflight, refuse-ladder при рестартах) +
  `ModelError`/`ModelNotFoundError`. Dual-export `{ default: singleton,
ModelError, ModelNotFoundError }` + ES default того же singleton.
  Интероп-урок: под tsx ESM-граф default-import этого модуля резолвится в
  САМ объект module.exports (обёртку), а не в singleton — поэтому
  `localReasoningBridge.ts` сохраняет pre-cutover double-`.default` доступ;
  инстанс один во всех графах (проверено tsx-ESM/tsx-CJS/tsc-dist).
- `llamaCppInstaller.ts`: dual-export `{ default: singleton, LlamaCppInstaller }`.
- `llmRequestTimeout.js` (уже ESM) → `.ts` с типами; TS-импортёры
  (`ReasoningService`, gemini/openai/tinfoil) не изменились.
- IPC: `registerLocalLlmModelHandlers` (14 каналов,
  `src/helpers/localLlmModelIpcHandlers.ts`) с узким `LlmModelManagerLike`/
  `LlamaCppInstallerLike`; download-семантика 1:1 (tracker sequence на
  progress/complete/error, подавление error-события при
  DOWNLOAD_IN_PROGRESS, raw modelId passthrough — менеджер отвечает типами
  MODEL_NOT_FOUND и т.п., без новой валидации). `llama-cpp-check` сохраняет
  pre-cutover баг 1:1: `getVersion` на инсталлере не существует → installed
  binary проходит через catch в `{ isInstalled: false, error }` (пин в
  тестах; не «чинился» — это изменение поведения, не входящее в issue).
  `llama-server-start` персистит env только при успехе.
- Контракт `src/contracts/localLlmModels.ts`: 14 каналов + event,
  `llmDownloadProgressEventSchema`, результатные интерфейсы
  (`LocalLlmModelStatus` — зеркало registry-полей без импорта renderer-графа,
  `LlmDownloadResult`, `LlamaServerStatusRow` и др.), `LocalLlmModelsApi`.
  Bridge `src/preload/localLlmModelsBridge.ts` (schema-validated
  `onModelDownloadProgress` — слушатели renderer теперь `(data)`).
- Тесты: спецификаторы `.js`→`.ts` в 8 файлах; characterization
  `test/helpers/localLlmModelIpc.test.js` (10 тестов: события sequence,
  DOWNLOAD_IN_PROGRESS оба пути, getVersion-баг, persist-on-success,
  tracker-последовательности);
  `modelManagerBridgeDownloadStatus.test.js` переведён с vm-слайса исходника
  ipcHandlers.js (handler переехал) на прямую регистрацию
  `registerLocalLlmModelHandlers` с реальным трекером; strict probes
  `test/scripts/localLlmModelsTypeProbe.test.js` — коды (2739×2+2740/2322/2322)
  сверены фактическим tsc-прогоном. Emitted-graph smoke: dual-export формы
  (класс / `{default}` / named) под plain node CJS и под tsx — exit 0.

Проверка: typecheck ×3 — 0 ошибок; lint 0 errors (39+2 warnings — baseline,
без новых). Inventory графа Electron: 62 JS, 129 TS, 1 MTS, 25 JSON.

## Этап «diarization, speaker profiles и ONNX worker boundary»

17 сентября 2026 (issue #45). Диаризация/спикерная вертикаль (9 файлов:
`diarization`, `diarizationPolicy`, `speakerEmbeddings`, `onnxWorkerClient`,
`liveSpeakerIdentifier`, `liveSpeakerIdPolicy`, `speakerAssignmentPolicy`,
`speakerMerge`, `src/workers/onnxWorker`) переведена в strict TS за новым
worker-контрактом и speaker-контрактом IPC.

- Worker contract `src/contracts/onnxWorker.ts`: environment-neutral
  discriminated union по method/id (`ping`/`speaker.load`/`speaker.extract`/
  `shutdown`), `parseOnnxWorkerRequest`/`parseOnnxWorkerReply` проверяют
  unknown-сообщения на обеих сторонах ДО model invocation/pending resolution
  (malformed reply не трогает pending; unknown request получает прежний
  `unknown method` error-reply). Error serialization, timeout 30s, queue limit
  1000, respawn backoff/max attempts, shutdown и late-reply-безопасность
  сохранены 1:1.
- `onnxWorker.ts` strict: типизированные fbank/FFT подсчёты, узкий локальный
  слайс onnxruntime (без pull типов пакета в utility process), dispatch через
  контракт. tsconfig.main.json include для worker-entries обновлён
  `src/workers/*.js` → `*.ts`; mainBuild-ассерты (`dist-main/src/workers/
onnxWorker.js`, asarUnpack) остаются валидны; fork остаётся по
  asar-virtual `.js` пути — исходный `.ts` в Electron не запускается.
- `onnxWorkerClient.ts` strict: dual-export singleton (`module.exports =
instance` + `OnnxWorkerClient`/`WorkerCrashedError`/`WorkerOverloadedError`
  re-attach). `speakerEmbeddings.ts` strict: dual-export singleton +
  `MAX_EMBEDDING_SECONDS` static; PCM-буферы клонируются (без transferList),
  как и раньше.
- `diarization.ts` strict: типизированные `DiarizationSegment`/
  `TranscriptSegment`/прогресс, tar-fallback, каскадный shutdown через
  pid-file Set, dual-export класс (main.js требует класс).
  `liveSpeakerIdentifier.ts` strict: typed transient state (embeddings/
  counts/names/profiles/noteIds), VAD-session слайс, recluster-мержи,
  at-cap fold, confirmed-distinct защиты — thresholds/sample rates/
  normalization не изменены. dual-export singleton. Политики и speakerMerge —
  named exports (все прежние имена), `speakerAssignmentPolicy` generic по
  сегменту.
- IPC: контракт `src/contracts/speakerProfiles.ts` (13 каналов + progress
  event со схемой) + `registerSpeakerHandlers`
  (`src/helpers/speakerIpcHandlers.ts`) с узкими database/live/diarization
  deps; 12 хендлеров ушли из ipcHandlers.js (contacts 2, speaker 6,
  diarization models 4). Public DTO без DB Buffer-embedding; retroactive
  mapping/auto-label внедряются deps-ами; download-progress идёт в
  запрашивающее окно с isDestroyed-гейтом 1:1. Bridge
  `src/preload/speakerBridge.ts` (schema-validated
  `onDiarizationDownloadProgress`).
- Тесты: новые `onnxWorkerClient.test.js` (8: malformed replies, foreign/late
  id, crash с pending, stop-during-spawn, queue-limit eviction, shutdown
  rpc с grace period), `onnxWorkerProtocol.test.js` (5: конечная карта
  методов, per-method payload-парсинг, malformed/unknown rejection),
  `speakerIpc.test.js` (12: embedding→profile промоушен note/live, DTO
  projection, destroyed-sender, кодированные ошибки), strict probes
  `speakerOnnxTypeProbe.test.js` (коды 2345/2739+2740×2/2322 сверены tsc).
  Спецификаторы тестов обновлены (.js→.ts, 8 файлов), мок-хуки — dual
  specifiers. Emitted smoke: worker бутится под parentPort-shim и игнорирует
  мусор; dual-export формы под plain node и tsx.

Проверка: typecheck ×3 — 0 ошибок; lint 0 errors (39+2 baseline). Inventory
графа Electron: 53 JS, 142 TS, 1 MTS, 25 JSON. Pack-проверка packaged
utilityProcess ping/load (native runtime) — за оркестратором.

## Этап «realtime provider clients и token routing»

15 сентября 2026 (issue #46). Шесть действующих realtime transport clients
(`openaiRealtimeStreaming`, `assemblyAiStreaming`, `deepgramStreaming`,
`cortiStreaming`, `tinfoilRealtimeStreaming`, `geminiLiveStreaming`) и три
статических routing-модуля (`meetingStreamingProviders`,
`realtimeTokenProviders`, `meetingTranscriptionRouting`) переведены в strict
TS. JS counterparts удалены; токены остались во внутреннем main credential
path, новые IPC channels/bridge не добавлялись.

- Каждый wire protocol сужает распарсенный JSON из `unknown` локально, рядом
  с обработкой provider message. Общая выдуманная union внешних payload не
  вводилась. Endpoint, auth dialect, model/language/environment/tenant,
  keyterms, audio framing, warm/reconnect, commit/flush и disconnect budgets
  сохранены.
- Для `ws` используются минимальные структурные socket interfaces по реально
  вызываемым методам; новая зависимость `@types/ws` не понадобилась, поэтому
  `package.json` и `pnpm-lock.yaml` не менялись.
- `STREAMING_CLIENT_BY_PROVIDER` остаётся конечной typed map из пяти meeting
  transports. `MeetingStreamingProvider` и allow-list выводятся из неё;
  Gemini остаётся dictation-only и не попадает в Note Recording. Lookup
  неизвестного provider fail-closed; string-like ключ приводится один раз и
  тем же значением участвует в lookup и сообщении ошибки.
- Token registry выводит конечный `RealtimeTokenProvider`; overload различает
  одиночный token и tuple двух streams. BYOK-only проверки, AssemblyAI token
  mint per stream, Corti single mint и duplicate raw keys не менялись.
- Реальные meeting callers сведены к `MeetingStreamingClient`; отдельные
  provider option interfaces сохраняют различия transport-параметров.
  `meetingTranscriptionRouting.ts` также включён в strict selector graph, а
  `ModelRegistry` возвращает суженный meeting-provider список.
- Runtime exports следуют фактическим consumers: OpenAI/AssemblyAI/Deepgram/
  Corti имеют `module.exports = Class` + named property (и Deepgram static),
  Gemini/Tinfoil/registry/token сохраняют named-object shape. Существующие
  tsx default-import drills не упрощались. Source fixtures и `stt-canary`
  используют явные `.ts` specifiers; production CJS imports продолжают
  резолвить emitted `.js`.
- Characterization добавляет raw partial/final/malformed fixtures для
  AssemblyAI/Deepgram/Corti, Corti flush и cancel-before-ready, timestamp
  contract для live speaker labels и emitted CommonJS smoke. Strict probe
  фиксирует отсутствие Gemini в meeting registry, tuple-result двух токенов
  и positive full graph. `Module._load` stubs принимают оба варианта локальных
  specifiers; raw `.ts` через `vm.runInNewContext` не исполняется.

Проверка исполнителем: `pnpm run typecheck` — 0 ошибок во всех трёх графах;
`pnpm run lint` — 0 errors, 31+2 baseline warnings. Tests/build/install по
явному ограничению этой сессии не запускались; focused, full test, emitted
build, pack и isolated Electron smoke остаются за оркестратором. Inventory по
фактическому `tsc --listFilesOnly`: 43 JS, 150 TS, 1 MTS, 25 JSON; срез source
`src` без `src/dist`: 51 JS, 0 JSX, 1 MJS, 349 TS, 254 TSX, 1 MTS.

## Этап «native audio capture adapters и PCM policies»

15 сентября 2026 (issue #47). Native tap/AEC wrappers и meeting audio policy
helpers переведены из JavaScript в TypeScript; последовательность meeting
orchestration в `ipcHandlers.js` не менялась.

- `AudioTapManager` получил явные startup/readiness,
  permission/status, warning/error и chunk contracts. Newline JSON с partial
  reads валидируется у stderr boundary; AEC stdout сохраняет split frame
  buffering и проверяет bounded even PCM16 frame lengths. Таймауты, cleanup,
  stale child callbacks, exit/error paths, native ABI, sample rate и platform
  gates сохранены.
- `AudioActivityDetector`, `ActiveMicRecoveryController` и
  `MeetingSystemAudioWatchdog` типизируют clocks, generation/retry state,
  device-change/track callbacks и interruption payloads. Device invalidation,
  default-input recovery, quiet/degraded states и explicit restart semantics
  не получили второго runtime path.
- PCM helpers (`audioUtils`, activity monitor, timeline, echo detector, mic
  gate, holdback и diarization input) сохраняют исходные 24 kHz/PCM16 sample
  math, thresholds, bounded 100 ms silence только после `markRestart()`,
  jitter behavior и source selection. `audioUtils.ts` остаётся browser-shared
  и не импортирует Node/Electron.
- Microphone selection/recovery helpers (`micDeviceSelection`,
  `micSelectionRecovery`, `microphoneSelection`, `systemDefaultMicrophone`)
  используют симметричную string-нормализацию ключей и сохраняют exact,
  remapped, ambiguous, native-default и unavailable статусы.
- Direct CJS consumers сохраняют identity через `module.exports = X` и
  `module.exports.X = X` (AudioActivityDetector, AudioTapManager,
  MeetingEchoLeakDetector, timeline, watchdog); watchdog
  statics и named-object consumers также re-attached. Existing ESM default
  drills не удалялись. Tests use explicit `.ts` source specifiers and every
  touched Module._load hook accepts extensionless and `.js` forms; no raw TS is
  executed through `vm.runInNewContext`.
- `tsconfig.main.json` теперь явно включает native/PCM main modules in the
  strict Node graph. Source inventory after this stage: 35 JS, 365 TS,
  254 TSX, 1 MTS (excluding `src/dist`); the Electron graph is expected to be
  31 JS, 162 TS, 1 MTS and 25 JSON after the 12 main-target renames.

Проверка исполнителем: `pnpm run typecheck` — 0 ошибок во всех трёх графах;
`pnpm run lint` — 0 errors, 31 + 2 baseline warnings. Tests, builds, install,
native rebuild, pack и hardware smoke по ограничению задачи не запускались.
Оркестратору нужно последовательно выполнить focused tests (включая новый
AEC framing и mic-selection recovery coverage), `pnpm run build:main`,
`pnpm run build:renderer`, `pnpm test`, `pnpm run pack` и isolated Electron /
real mic+system recovery smoke на отдельном профиле.

## Этап «desktop windows, hotkeys и app shell adapters»

15 сентября 2026 (issue #48). 23 модуля окон, хоткеев и app-shell адаптеров
переведены в strict TS: `appVersion`, `autoStart`, `autoStartPolicy`,
`debugLogger`, `devServerManager`, `dockManager`, `dockPolicy`, `dragManager`,
`externalUrlOpener`, `globeKeyManager`, `hotkeyList`, `hotkeyManager`,
`hotkeyRepeatGate`, `i18nMain`, `menuManager`, `navigationGuard`,
`notificationTimer`, `onboardingWindowBounds`, `tray`, `windowBroadcast`,
`windowConfig`, `windowManager`, `hooks/useControlPanelWindowDrag`.
Window/hotkey behavior сохранён 1:1; владельцы окон и shortcuts не менялись,
никакого application framework или DI поверх них.

- Экспорт-контракты восстановлены по фактическим require-сайта (self-audit):
  классы-как-модуль — dual export `module.exports = X; module.exports.X = X`
  (HotkeyManager + именованные предикаты, TrayManager, WindowManager,
  GlobeKeyManager, DevServerManager со статиками, MenuManager, DragManager),
  синглтоны — `export default instance; module.exports = instance`
  (debugLogger — 20+ TS-файлов сидят на default-импорте и на CJS-require
  одновременно; dockManager). Форма `export default` + `module.exports =`
  проверена на emitted-графе: CJS require, tsx-ESM default и plain-node ESM
  получают один и тот же экземпляр. Именованные значения — обычные
  `export` (i18nMain, windowBroadcast, navigationGuard, hotkeyList,
  notificationTimer, onboardingWindowBounds, windowConfig, autoStartPolicy,
  appVersion, externalUrlOpener, dockPolicy, hotkeyRepeatGate, autoStart).
- `windowConfig` владеет общим DTO `MeetingNotificationPrompt` (опциональные
  поля: kind/detectionId/sessionId/expiresAt/reason/source/key/variant/
  joinUrl/event — движок строит detection-промпты инкрементально, тесты
  гоняют частичные payload, поэтому union без дискриминанты). Legacy-инертные
  ключи конфигов (`acceptsFirstMouse`, `visibleOnAllWorkspaces`,
  `fullScreenable`) сохранены через intersection с
  `BrowserWindowConstructorOptions` — отгрузка конфигов байт-в-байт прежняя.
- `WindowManager` получил узкий `MeetingDetectionEngineCallbacks`
  (handleNotificationTimeout / handleAutoEndNotificationClosed /
  handleDetectionNotificationClosed) вместо нетипизированного движка;
  payload-очереди note navigation остались `unknown` — их форма принадлежит
  note-вертикали. Tray получает `WindowManager` через type-only import
  (цикла в рантайме нет). Electron-событие `"destroyed"` (window/tray) не
  объявлено в типах Electron — точечный cast на `NodeJS.EventEmitter` с
  комментарием.
- Урок типизации под два компилятора: файлы helpers компилируются и strict
  main-графом, и non-strict renderer-графом (`src/tsconfig.json`,
  `strictNullChecks: false`), где отрицательное сужение размеченных union
  недоступно — `HotkeyRegistrationResult` сделан плоским интерфейсом
  (opциональные поля), а не discriminated union; все ветки читают поля без
  сужения. Behavior не менялся.
- `hotkeyManager` сохранил slot-модель, rollback/partial-registration,
  Fn-гейт и dual-export предикатов; ленивые `require("./environment")`
  типизированы через `new () => EnvironmentManager` ctor-type. i18nMain
  экспортирует синглтон i18next-инстанса как named export; identity — один
  инстанс на граф.
- Тесты: явные `.js`-спецификаторы на мигрированные модули переведены на
  `.ts` (hotkeySlot*, dockPolicy, hotkeyList, windowConfigTypes,
  onboardingWindowBounds, windowManagerNavigation, debugLogger*,
  envSecretStorage, autoStartPolicy, appVersion); мок-хуки Module._load
  принимают оба спецификатора (`./x` и `./x.js`) — в
  windowManagerMeetingNotification и globeKeyManager хуки расширены, фейки
  hotkeyManager/dragManager/menuManager/devServerManager переведены на
  named-export shape под новые import-формы windowManager;
  m1IdentitySourceContract читает `windowConfig.ts`. Синхронизирующие
  комментарии (i18n.ts, utils/hotkeys.ts, index.css) переведены на `.ts`
  имена.

Проверка исполнителем: `pnpm run typecheck` — 0 ошибок во всех трёх графах;
`pnpm run lint` — 0 errors, warnings только прежнего baseline (ни одного в
мигрированных файлах). Tests, builds, install, native rebuild, pack и
isolated smoke по ограничению задачи не запускались. Оркестратору нужно
последовательно выполнить focused tests (windowManagerNavigation/
MeetingNotification, windowConfig*, windowPositionClamp,
onboardingWindowBounds, globeKeyManager, hotkeySlotRollback/Unregister/
FnGuard/Validation, dockPolicy, autoStartPolicy, debugLogger, appVersion,
i18nMain, notificationTimer, hotkeyRepeatGate, m1IdentitySourceContract,
mainBuild), затем `pnpm run build:main`, `pnpm run build:renderer`,
`pnpm test`, `pnpm run pack` и isolated Electron smoke (Notes by default,
onboarding compact/expanded, tray restore, shortcut и notification route) на
отдельном профиле; после pack — восстановить Node ABI better-sqlite3 перед
DB-тестами.

Inventory графа Electron по фактическому `tsc -p tsconfig.main.json
--listFilesOnly` (пересчитано на main `4c4f6faf` после фиксов #61): **12 JS,
184 TS, 1 MTS, 25 JSON**. В граф входят 12 JS, а не 10: root `main.js` и
`preload.js` — такие же entry points компилятора, как ONNX worker, и
считаются вместе с 10 JS-модулями в `src/helpers`. Runtime-inventory
отделяется от tooling: в срезе `src` без `src/dist` — 12 JS, 388 TS, 254 TSX,
1 MTS, 1 MJS (vite.config), из них `src/helpers/whisperCppRelease.js` —
build-tooling (используется только `scripts/download-whisper-cpp.js` перед
pack), а `src/eslint.config.js` — конфигурация lint; исполняемого
приложением JS вне графа не остаётся.

## Этап «non-meeting IPC: transcription execution, data/files, desktop/settings»

15 сентября 2026 (issue #67). Оставшийся non-meeting IPC вынесен из
`src/helpers/ipcHandlers.js` в три typed-вертикали по действующим операциям;
`src/contracts` → typed handler registration → `src/preload` bridge →
`src/types/electron.ts`, как в предыдущих вертикалях. Каналы, аргументы,
результаты, события и ошибки не менялись; недоверенные payloads парсятся на
границе (Zod), дальше в managers идут только проверенные значения. Никакого
общего RPC framework, service container или provider router не появилось.

- `src/contracts/transcriptionExecution.ts` +
  `src/helpers/transcriptionExecutionIpcHandlers.ts` +
  `src/preload/transcriptionExecutionBridge.ts` — `transcribe-local-whisper`,
  `transcribe-local-parakeet`, пять провайдерских прокси
  (`proxy-xai/mistral/corti/tinfoil/gemini-transcription`), `retry-transcription`,
  voice-draft temp audio (`save/delete-temp-audio`), provider connection/model
  discovery (`test-provider-connection`, `test-enterprise-connection`,
  `bedrock-list-models`, `get-tinfoil-chat-models`). Переиспользованы схемы
  ответа из `contracts/localFileTranscription.ts`; тяжелые SDK (`ai`, AWS) и
  Corti-клиент остаются ленивыми фабриками в composition root.
- `src/contracts/transcriptionData.ts` +
  `src/helpers/transcriptionDataIpcHandlers.ts` +
  `src/preload/transcriptionDataBridge.ts` — `db-*-transcription`,
  `get-transcription-by-id`, `update-transcription-text`, аудио-хранилище
  (`save/get/show/delete/merge/delete-all/usage`), `retention-settings-changed`,
  экспорты (`export-note/transcript/dictionary`), выбор/одобрение/размер файлов
  (`select-audio-file`, `approve-audio-path`, `get-file-size`),
  `agent-open-note` и обычная (non-meeting) навигация `get-pending-note-navigation`
  + подписка `note-navigation-pending`. Четыре события
  (`transcription-added/updated/deleted`, `transcriptions-cleared`) валидируются
  на preload-границе и дропают malformed payloads; unsubscribe снимает ровно
  свою подписку. Разрешение/одобрение аудио-путей вынесено в
  `src/helpers/audioPathAllowlist.ts` — общий с JS-rootом allowlist.
- `src/contracts/desktopSettings.ts` +
  `src/helpers/desktopSettingsIpcHandlers.ts` +
  `src/preload/desktopSettingsBridge.ts` — onboarding/window controls
  (`onboarding-*`, `window-*`, `snap/restore-from-meeting-mode`,
  `set-notification-interactivity`), credential-поверхность (BYOK
  `get-/save-<base>-key` из манифеста, Corti client id/secret, custom-endpoint
  ключи, Bedrock/Azure/Vertex ключи, `save-all-keys-to-env`), startup/hotkeys
  (`set-hotkey-listening-mode`, `get-hotkey-mode-info`,
  `register/unregister-cancel-hotkey`, `get-effective-default-hotkey`,
  activation mode, `sync-startup-preferences`, auto-start), drag
  (`start/stop-control-panel-drag`), `open-external`, language
  (`get/save/set-ui-language`), logging/debug (`get-log-level`, `app-log`,
  `get-debug-state`, `set-debug-logging`, `open-logs-folder`),
  permissions/system settings (microphone/system audio/accessibility,
  `open-*-settings`, `show-emoji-panel`, `get-system-default-microphone`),
  clipboard, `cleanup-app`, app/OAuth metadata (`get-app-version`,
  `get-oauth-protocol*`), model folders (`get-model-cache-root`,
  `open-whisper-models-folder`), `get-md5-hash` и
  `sync-notification-preferences`. Ручные `BYOK_KEY_BRIDGES` в preload.js
  заменены мостом, генерируемым из `config/secretKeys.ts`; открытие System
  Settings вынесено в `src/helpers/systemSettingsLauncher.ts` (общий с
  calendar-вертикалью).
- Владелец оставшегося `src/helpers/ipcHandlers.js` — meeting coordinator
  (meeting prepare/start/send/stop/cancel, detection/auto-end/join, session
  speaker config, `mic-warm-hold-changed`, recording locks, все их callbacks
  и state) плюс composition root: регистрации typed-вертикалей с узкими
  callbacks. `set-meeting-mode-active` и notification-detection gate проходят
  через два узких замыкания — lifecycle встречи не переносился.
- Подозрительно неиспользуемые renderer'ом каналы (например `retry-transcription`,
  `db-*`, `cleanup-app`, `agent-open-note` после удаления Home/Insights)
  сохранены: consumer-проверка показала только отсутствие renderer-вызовов,
  динамических регистраций и main-вызовов нет, но удаление поверхности —
  отдельное продуктовое решение, не часть миграции.
- Тесты: `retryTranscriptionHandler.test.js` разбит на два харнесса — typed
  execution-модуль (retry + proxy structured errors; моки инжектируются deps,
  Module._load остаётся для upload-харнесса ipcHandlers.js) и прежний
  fake-this для BYOK upload. `deviceCleanupContract.test.js` читает исходник
  `desktopSettingsIpcHandlers.ts` + проверяет cleanup-seams в composition
  root. `secretKeys.test.js` проверяет manifest-генерацию моста вместо
  инлайн-тюплов preload.js.

Инвентарь графа на этой ветке: JS в графе по-прежнему 12 (root `main.js`,
`preload.js` и 10 JS в `src/helpers` — весь non-meeting IPC из
`ipcHandlers.js` убран, файл остался meeting coordinator + composition root),
TS — +11 модулей к срезу `4c4f6faf` (три contracts/handlers/bridges-тройки,
`audioPathAllowlist`, `systemSettingsLauncher`).

Проверка исполнителем: `pnpm run typecheck` — 0 ошибок во всех трёх графах;
`pnpm run lint` — 0 errors, warnings только прежнего baseline (ни одного в
новых файлах). Tests, builds, install, native rebuild, pack и smoke по
ограничению задачи не запускались. Оркестратору нужно последовательно
выполнить `pnpm run build:main`, `pnpm run build:renderer`, focused tests
(retryTranscriptionHandler, deviceCleanupContract, secretKeys,
bedrockEnterpriseIpc, preloadOnboardingBridge, retentionSettings,
meetingStreamingWiring, macInferenceSourceContract, m1IdentitySourceContract,
granolaImportIpc, mainProcessEsmEntries, mainBuild), затем `pnpm test` и
isolated smoke (Settings: ключи/провайдеры/hotkeys/language/debug;
upload/diarization; onboarding; Notes) на отдельном профиле; после pack —
восстановить Node ABI better-sqlite3 перед DB-тестами.

## Этап «meeting coordinator: session lifecycle, detection, auto-end и diarization publication»

16 сентября 2026 (issue #72). Весь meeting runtime вынесен из `src/helpers/ipcHandlers.js`
(3588 → ~1250 строк; файл остался composition root) в strict TS. Владельцы и
единственный путь исполнения сохранены; политики detection/auto-end остались в
своих модулях, единого state-machine framework нет.

- Девять хелперов переведены в strict TS (JS-версии удалены):
  `meetingTranscriptionLifecycle` (dual-export module-as-factory),
  `meetingAutoEndController` (factory + константы на module.exports),
  `meetingAutoEndLifecycle`, `meetingDetectionEngine` (класс + константы dual),
  `meetingJoinUrl`, `meetingProcessDetector` (класс dual), `processListCache`
  (синглтон), `ownProcessPids`, `electronProcessIds`. Пороги, окно restart
  grace, sleep-reset, исключение собственных PID и все экспорты сохранены.
- `src/helpers/meetingCoordinatorIpcHandlers.ts` — координатор: prepare/connect
  (reuse по connection key, guard «Operation in progress»), local chunks,
  native capture/AEC/watchdog/silence-timer, live speakers, lifecycle-очередь
  start/stop (owner-loss, same-document navigation, идемпотентный stop),
  recording locks, mic-warm-hold, detection prefs, session speaker config,
  notification respond/ready/data, auto-end IPC, join-calendar-meeting,
  pending meeting-note navigation. Зависимости — managers и узкие callbacks
  (fetchRealtimeToken, resolveWhisperVadOptions, speakerEmbeddings loader,
  windowManager surface); `this` целиком не передаётся.
- `src/helpers/meetingDiarizationPublication.ts` — финальная диаризация
  (`_startOrSkipDiarization`), reconcile live-speaker state, speaker
  expectation, roster-проекции; поздний результат уходит исходной
  session/note. `src/helpers/meetingHotkeyIpcHandler.ts` — владелец
  `register-meeting-hotkey`; bootstrap-регистрация и общий callback остались
  в main.js.
- Контракт `src/contracts/meetingCoordinator.ts` (21 канал + 15 событий),
  bridge `src/preload/meetingCoordinatorBridge.ts` (валидация ответов,
  malformed события дропаются, payload-only listeners, idempotent
  unsubscribe), `src/types/electron.ts` — meeting DTO переехал в контракт.
  `mic-warm-hold-changed` и `meeting-system-audio-degraded` не имеют
  renderer-продюсера/producer'а — каналы сохранены как есть.
- Найденный самостоятельный lifecycle дефект prepare/cancel задокументирован
  и зафиксирован characterization-тестом БЕЗ изменения поведения: cancel
  сбрасывает guards, пока connect ещё выполняется, и допускает второй
  параллельный prepare (last-writer-wins на streaming refs/connection key).
  Исправлено последующим lifecycle fix: cancel/timeout сразу завершают IPC-ответ,
  но guard остаётся до завершения подключения и очистки обоих клиентов.
  Поздние клиенты не публикуются; start во время очистки отклоняется.
  Characterization заменён regression-тестами, включая частичный отказ двух
  потоков. Hard abort сетевого подключения по-прежнему не обещается.
- `geminiLiveStreaming.ts` больше не входит в main compiler graph: на main
  файл эмиссился в dist-main только через мёртвый require в старом
  `ipcHandlers.js` (класс не использовался). Это был графовый артефакт, а не
  продуктовая потребность — Gemini в meeting registry не входил (#46);
  runtime-потребители грузят его через Vite (renderer) и tsx (stt-canary),
  emitted .js не нужен. Соответствующая строка убрана из child-probe
  mainBuild.test.js; сверка полного emitted-списка с графом подтвердила,
  что остальные 23 файла `src/helpers` вне main-графа — renderer/canary-only
  (инвентарь #35) и ни один runtime-модуль эмиссию не потерял.

Проверка исполнителем: `pnpm run typecheck` — 0 ошибок в main и
settings-selectors, renderer-entrypoints closure побайтово совпадает с
baseline main (никаких новых strict-ошибок у renderer-потребителей);
`pnpm run lint` — 0 errors, warnings меньше baseline (в ipcHandlers.js
осталось 3 прежних warning'а вместо 20). Tests/builds/install/native rebuild
по ограничению задачи не запускались. Оркестратору нужно последовательно
выполнить `pnpm run build:main`, `pnpm run build:renderer`, focused tests
(meetingCoordinatorIpc, meetingCoordinatorBridge, meetingCoordinatorTypeProbe,
meetingStreamingWiring, meetingSpeakerReconcile, meetingDetectionEngine,
meetingDetectionEngineAutoEnd, meetingAutoEndController/Lifecycle,
meetingTranscriptionLifecycle, meetingJoinUrl, electronProcessIds,
meetingRecordingSession, meetingTranscriptPersistence, meetingStreaming*,
rendererBridgeContract, mainProcessEsmEntries, mainBuild, macInferenceSource,
deviceCleanupContract), затем `pnpm test` и isolated macOS smoke (start/stop,
mic+system, local/realtime, auto-end/restart, notification join, speaker
completion) на отдельном профиле.

## Этап «финальный TS cutover: main, preload, ipcHandlers и strict renderer»

23 сентября 2026 (issue #68, база `7ce24a3a`, merge #74). Последние три
runtime-JS entry/composition файла переведены в strict TS, оба runtime-таргета
закрыты: `allowJs: false`. Поведение продукта не менялось; известная гонка
prepare/cancel не трогалась (отдельный fix).

### Инвентарь на старте

Tracked runtime JS — ровно три файла: `main.js`, `preload.js`,
`src/helpers/ipcHandlers.js` (совпадает с ожиданием issue). Вне графа:
`src/helpers/whisperCppRelease.js` (tooling download script) и
`src/eslint.config.js` (конфиг lint) — сознательно не мигрированы.
Динамических импортов, уводящих модули мимо графа, нет; все require-сиды
lazy-загрузок (ai, AWS SDK, corti/enterprise клиенты, modelManagerBridge,
markdownMirror и др.) аудированы: каждый лениво требуемый локальный модуль
остаётся в программе через `typeof import(...)`-касты, поэтому эмиссия не имеет
дыр (сверка полного `--listFilesOnly`-списка до/после: отличие — ровно три
переименования .js → .ts).

### Переводы

- `main.js` → `main.ts`: типизированы process/electron, менеджеры, app events,
  startup/shutdown. Порядок сохранён: identity/userData до storage/managers,
  затем protocol registration, TLS CA merge, singleton lock, Notes по умолчанию.
  Статические связи графа — только ESM import с `.js`-расширением; тяжёлые SDK
  остаются за ленивыми `require` (типизированы через `typeof import`).
- `preload.js` → `preload.ts`: типизированный `registerListener<T>`, полезные
  нагрузки событий перенесены из деклараций renderer'а; bundle-вход в
  `scripts/build-main.js` обновлён на `preload.ts`, emitted filename прежний
  (`dist-main/preload.js`, sandbox bundle).
- `src/helpers/ipcHandlers.js` → `ipcHandlers.ts`: составной корень (composition
  root) полностью типизирован; владельцы регистрации каналов не менялись —
  таблица ownership прежняя (typed-вертикали владеют своими каналами,
  координатор — meeting-каналами, корень только передаёт зависимости).
  Lazy-require тяжёлых SDK и клиентов сохранён (комментарии на местах).

### Согласование типов (без blanket casts)

- Dual-export re-attach добавлены там, где у модулей появились TS named
  импорты: `database` (DatabaseManager), `cliBridge` (CliBridge),
  `audioStorage` (AudioStorageManager); синглтоны `markdownMirror` и
  `liveSpeakerIdentifier` получили `export default` (паттерн debugLogger);
  `llamaCppInstaller` — единственный синглтон, `export default` вместо
  повторного `new`.
- Небольшие dep-интерфейсы typed-вертикалей переведены с property-fn на
  method-синтаксис (bivariance), где строгая контравариантность не пропускала
  реальные менеджеры: vocabulary, containers, actions, chatPersistence,
  transcriptionData, speaker, localModelLifecycle, localLlmModels,
  desktopSettings, meetingCoordinator. `DiarizationModelsLike.cancelDownload`
  стал `Promise` (менеджер всегда был async; хендлер его await'ит).
- Честные типовые правки: `updateTranscriptionAudio` принимает SQLite 0|1
  `hasAudio`; `SpeakerProfileRow.embedding` обязательный (NOT NULL);
  `clearAudioFlags` принимает и строковые id (аудио-имена файлов);
  `DatabaseManager.db` — публичный геттер с throw после close (семантика
  use-after-close как у всех методов; тесты `db.db.close()` работают как
  раньше).

### Документированные boundary casts

Единичные, с комментариями на местах, там, где менеджеры исторически
типизированы свободнее wire-контрактов: lifecycle-менеджеры
(`WhisperManagerLike`/`ParakeetManagerLike`/`LlmModelManagerLike`/
`LlmDownloadStatusTracker` — payload'ы запинены characterization-тестами #43/#44),
`SpeakerDatabase` (ветка null у upsert недостижима для путей вертикали),
coordinator-менеджеры.

Оба дефекта, зафиксированных после миграции как «исправление вне миграции»,
исправлены в issue #78: ретроактивное сопоставление спикеров использует
`note.id` из `NoteRow[]` без каста, а skip внутри прохода учитывает только
реально назначенные строки (`profile_id !== null`) — placeholder-строки,
по которым заметка попала в unmapped-выборку, теперь заменяются. Delete-all-audio
опирается на реальный `DatabaseManager.getAudioFlaggedIds()` с typed-подключением
менеджера в registration (regression:
`test/helpers/speakerRetroactiveMapping.test.js`,
`test/helpers/transcriptionDataDeleteAllAudio.test.js`).

### Renderer strict

`src/tsconfig.json`: `strict: true`, `allowJs: false`, JS/JSX-паттерны из
include убраны. 48 реальных strict-диагностик исправлены: сужение nullable
состояний (noteStore, meetingRecordingStore), сужение bridge-payload на
границах слушателей (мосты валидируют до доставки), guard'ы дискриминированных
unions через `error !== undefined` (tools), guard'ы optional-членов API.
`actionStore`-хелперы и `resolveExpectedSpeakerCount` расширили параметры до
null-форм wire'а. Casts единичные, целевые, с комментариями; `@ts-nocheck`,
фиктивные declarations и массовые `any`/non-null не использовались. Корневые
lint-предупреждения: 12+2 (ниже baseline 15+2 — main/preload ушли из JS lint
поверхности).

### Итоговый инвентарь (после cutover)

- Tracked runtime JS: **0**. Root: `main.ts`, `preload.ts`;
  `src/helpers/whisperCppRelease.js` (tooling) и `src/eslint.config.js` (lint)
  — не runtime.
- Main compiler graph (`tsc -p tsconfig.main.json --listFilesOnly`, без
  node_modules/dist): **0 JS, 187 TS + 1 MTS + 2 root entries (main.ts,
  preload.ts), 25 JSON**; worker `src/workers/onnxWorker.ts` → emitted
  `dist-main/src/workers/onnxWorker.js` (asarUnpack без изменений).
- Срез `src` (без `src/dist`): 414 TS, 254 TSX, 1 MTS (constants.mts), 2 JS
  (tooling/lint, вне таргетов), 0 JSX.
- Эмиссия: `pnpm run build:main` даёт прежний `dist-main/main.js` +
  bundled `dist-main/preload.js`; `package.json#main` не менялся; packaging
  (`electron-builder.json` files/asarUnpack) и `scripts/run-electron.js` без
  изменений — dev и pack потребляют один и тот же output.

### Команды проверки

```sh
pnpm run typecheck          # main + renderer + settings-selectors, все strict
pnpm run lint               # 0 errors
pnpm test -- \
  test/scripts/mainBuild.test.js test/helpers/mainProcessEsmEntries.test.js \
  test/helpers/retryTranscriptionHandler.test.js \
  test/m1IdentitySourceContract.test.js test/helpers/macInferenceSourceContract.test.js \
  test/helpers/deviceCleanupContract.test.js test/helpers/secretKeys.test.js \
  test/helpers/rendererBridgeContract.test.js
pnpm test                   # полный прогон
pnpm run pack               # macOS arm64 .app; затем isolated Electron smoke
```

Ожидания от mainBuild: emitted graph замкнут (нет runtime-импортов .ts),
preload sandbox-бандл грузится, route + ESM constants грузятся в plain Node,
CJS-формы экспортов сохранены, компилятор отвергает неверные аргументы и
DOM-глобалы в main. `pnpm test` подготавливает SQLite и собирает main, если
выбранные тесты требуют результат сборки (включая mainBuild и полный прогон).
На macOS тесты используют Node-режим Electron и тот же ABI, что приложение;
вручную переключать SQLite на Node ABI не нужно. Выбор проверок описан в
[quality steering](../.memory-bank/steerings/quality.md).
