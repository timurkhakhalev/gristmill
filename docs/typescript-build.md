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
`src/preload/notesBridge.ts`, `src/preload/urlDownloadBridge.ts` и
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
а не всеми файлами в каталоге helpers. В нём **133 JS, 12 TS, 1 MTS и 25 JSON**.
Entry points: main, preload и ONNX worker. Тесты и tooling в граф не входят.
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
- `src/config/constants.mts`
- `src/config/secretKeys.js`
- `src/constants/speakerDetection.json`
- `src/constants/whisperVad.json`
- `src/helpers/abortError.js`
- `src/helpers/agentStreamRequestRegistry.js`
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
- `src/helpers/bedrockCatalog.js`
- `src/helpers/binaryResolver.js`
- `src/helpers/builtinActions.js`
- `src/helpers/calendarAvailability.js`
- `src/helpers/calendarAvailabilityService.js`
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
- `src/helpers/downloadUtils.js`
- `src/helpers/dragManager.js`
- `src/helpers/electronProcessIds.js`
- `src/helpers/enterpriseAiProviders.js`
- `src/helpers/enterpriseProviderErrors.js`
- `src/helpers/environment.js`
- `src/helpers/externalUrlOpener.js`
- `src/helpers/ffmpegUtils.js`
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
- `src/helpers/modelDirUtils.js`
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
- `src/helpers/retentionSettings.js`
- `src/helpers/safeTempDir.js`
- `src/helpers/secretCrypto.js`
- `src/helpers/selfHostedTranscription.js`
- `src/helpers/sidecarPidFile.js`
- `src/helpers/sidecarReaper.js`
- `src/helpers/sidecarRegistry.js`
- `src/helpers/speakerAssignmentPolicy.js`
- `src/helpers/speakerCount.ts`
- `src/helpers/speakerEmbeddings.js`
- `src/helpers/speakerMerge.js`
- `src/helpers/stripThinking.js`
- `src/helpers/systemDefaultMicrophone.js`
- `src/helpers/systemTar.js`
- `src/helpers/urlDownloadIpcHandlers.ts`
- `src/helpers/tinfoilCatalog.js`
- `src/helpers/tinfoilRealtimeStreaming.js`
- `src/helpers/tinfoilSecureClient.js`
- `src/helpers/tinfoilTranscription.js`
- `src/helpers/transcriptFormatter.js`
- `src/helpers/transcriptText.js`
- `src/helpers/transcriptionRoute.ts`
- `src/helpers/transcriptionTimeout.js`
- `src/helpers/tray.js`
- `src/helpers/uploadCancelRegistry.js`
- `src/helpers/uploadTimestamps.js`
- `src/helpers/urlAudioDownloader.js`
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
- `src/services/localReasoningBridge.js`
- `src/services/transcriptionBaseUrl.ts`
- `src/utils/audioUtils.js`
- `src/utils/process.js`
- `src/utils/serverUtils.js`
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
Inventory графа Electron: 133 JS, 12 TS, 1 MTS, 25 JSON.
