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
  `config/transcriptionCapabilities.ts`, `helpers/reasoningRouting.ts`.
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

`pnpm test` сначала собирает main. Для отдельного прогона:

```sh
pnpm run build:main
pnpm exec node --import tsx --test --test-concurrency=1 --test-timeout=30000 test/scripts/mainBuild.test.js
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
- `node scripts/smoke-electron.js` — запуск, Notes, blank note, folder/edit,
  поиск, chat persistence, Dictionary/Snippets, AI Actions, onboarding и Settings
  прошли на отдельном временном профиле.
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
а не всеми файлами в каталоге helpers. В нём **111 JS, 71 TS, 1 MTS и 25 JSON**
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
- `src/config/secretKeys.js`
- `src/constants/speakerDetection.json`
- `src/constants/whisperVad.json`
- `src/helpers/abortError.ts`
- `src/helpers/agentStreamRequestRegistry.ts`
- `src/helpers/anthropicResponse.js`
- `src/helpers/appleCalendarManager.js`
- `src/helpers/assemblyAiStreaming.js`
- `src/helpers/audioActivityDetector.js`
- `src/helpers/audioStorage.js`
- `src/helpers/audioTapManager.js`
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
- `src/helpers/bedrockCatalog.js`
- `src/helpers/binaryResolver.ts`
- `src/helpers/builtinActions.ts`
- `src/helpers/calendarReminderScheduler.js`
- `src/helpers/calendarSyncInterval.js`
- `src/helpers/cliBridge.js`
- `src/helpers/cortiAuth.js`
- `src/helpers/cortiStreaming.js`
- `src/helpers/cortiTranscription.js`
- `src/helpers/database.js`
- `src/helpers/dbTimestamp.js`
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
- `src/helpers/enterpriseAiProviders.js`
- `src/helpers/enterpriseProviderErrors.js`
- `src/helpers/environment.js`
- `src/helpers/externalUrlOpener.js`
- `src/helpers/ffmpegUtils.ts`
- `src/helpers/geminiLiveStreaming.js`
- `src/helpers/geminiTranscription.js`
- `src/helpers/ggufMetadata.js`
- `src/helpers/globeKeyManager.js`
- `src/helpers/googleCalendarManager.js`
- `src/helpers/googleCalendarOAuth.js`
- `src/helpers/granolaImport.js`
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
- `src/helpers/markdownMirror.js`
- `src/helpers/meetingAecManager.js`
- `src/helpers/meetingAudioActivityMonitor.js`
- `src/helpers/meetingAudioTimeline.js`
- `src/helpers/meetingAutoEndController.js`
- `src/helpers/meetingAutoEndLifecycle.js`
- `src/helpers/meetingDetectionEngine.js`
- `src/helpers/meetingDiarizationInput.js`
- `src/helpers/meetingEchoLeakDetector.js`
- `src/helpers/meetingJoinUrl.js`
- `src/helpers/meetingMicGate.js`
- `src/helpers/meetingMicHoldback.js`
- `src/helpers/meetingProcessDetector.js`
- `src/helpers/meetingStreamingProviders.js`
- `src/helpers/meetingSystemAudioWatchdog.js`
- `src/helpers/meetingTranscriptionLifecycle.js`
- `src/helpers/menuManager.js`
- `src/helpers/microsoftCalendarManager.js`
- `src/helpers/microsoftCalendarOAuth.js`
- `src/helpers/modelDirUtils.ts`
- `src/helpers/modelManagerBridge.js`
- `src/helpers/navigationGuard.js`
- `src/helpers/networkErrors.js`
- `src/helpers/noteSearch.js`
- `src/helpers/notificationTimer.js`
- `src/helpers/oauthLoopbackFlow.js`
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
- `src/helpers/providerConnectionTest.js`
- `src/helpers/realtimeTokenProviders.js`
- `src/helpers/retentionSettings.ts`
- `src/helpers/safeTempDir.ts`
- `src/helpers/secretCrypto.js`
- `src/helpers/selfHostedTranscription.js`
- `src/helpers/sidecarPidFile.ts`
- `src/helpers/sidecarReaper.ts`
- `src/helpers/sidecarRegistry.ts`
- `src/helpers/speakerAssignmentPolicy.js`
- `src/helpers/speakerCount.ts`
- `src/helpers/speakerEmbeddings.js`
- `src/helpers/speakerMerge.js`
- `src/helpers/stripThinking.js`
- `src/helpers/systemDefaultMicrophone.js`
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
- `src/helpers/tinfoilCatalog.js`
- `src/helpers/tinfoilRealtimeStreaming.js`
- `src/helpers/tinfoilSecureClient.js`
- `src/helpers/tinfoilTranscription.js`
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
- `src/utils/audioUtils.js`
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
восстановлен; `node scripts/smoke-electron.js` на изолированном профиле.
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
