# План сокращения OpenWhispr до OpenHercules

Статус: план для реализации. Исходный код пока не изменён.
Основание: обсуждение OpenHercules и импорт OpenWhispr
`4335972b96a62caab0c822b3b9549a1a4fdbb351`.

## Граница продукта

OpenHercules — самостоятельное macOS-приложение для встреч без собственного
backend и без зависимости от backend OpenWhispr. Записи, транскрипты,
заметки, настройки и история обработки хранятся локально.

В этом плане удаление Cloud означает удаление OpenWhispr Cloud и серверных
функций продукта. Прямые запросы к ASR/LLM по пользовательским API-ключам
сохраняются согласно прежнему обсуждению. Если требуется полностью offline
обработка, это отдельное изменение: тогда локальные ASR/LLM становятся
обязательными и пункт об удалении этих runtime неприменим.

Сохраняем meeting library/detail, ручные заметки, шаблоны, участников,
исправление speaker labels, теги/категории, локальный импорт записей встреч,
экспорт, запись mic/system, capture health, календари, batch processing,
автоматический summary и chat по одной встрече.

Будущий backend остаётся возможностью, а не частью текущего runtime.
Удалённые реализации сохраняются в истории Git. Не оставляем закомментированные
модули, скрытые экраны, флаги premium=true или заглушки авторизации.

## 0. Зафиксировать исходную точку

- До удаления создать отдельный baseline commit текущего импорта и постоянный
  tag `openwhispr-baseline`. Сейчас `main` не содержит коммитов; одного
  перемещаемого `upstream/main` недостаточно как ссылки на локальную baseline.
- Проверить состав коммита: исходники, lockfile, LICENSE, документация;
  исключить секреты, runtime-данные и скачанные build artifacts.
- Сохранить upstream SHA и особенности импорта из `openwhispr-upstream/IMPORT.md`.
- Проверить исходную сборку и зафиксировать имеющиеся ошибки. Smoke-проверку
  приложения проводить только после изоляции его identity/storage на этапе 1.
- Дальнейшие удаления разбивать на осмысленные коммиты по этапам ниже.
  Для возврата функции использовать историю; копия `legacy-cloud/` не нужна.

Это план будущих коммитов, а не утверждение, что они уже созданы.

## 1. Отделить приложение от инфраструктуры OpenWhispr

- Изменить app identity, product name, userData, keychain service names,
  protocol handlers и Electron session partitions на OpenHercules.
- Удалить автоматическое обнаружение/перенос данных OpenWhispr и account-bound
  очистку данных. Создавать собственную локальную базу без миграции чужого профиля.
- Удалить upstream auto-update feed, загрузку и установку обновлений OpenWhispr.
  Пока собственного release channel нет, оставить ручное распространение сборки.
- Пересобрать onboarding: разрешения mic/system, выбор провайдеров, опциональный
  календарь. Без регистрации, trial, dictation demo и экранов покупки.
- Убрать upstream publish/release destinations из сборки и workflows.

Точки входа: `main.js`, `electron-builder.json`, `src/updater.js`,
`src/lib/authAccountScope.ts`, `src/components/OnboardingFlow.tsx`.

Готово: запуск использует только профиль OpenHercules и не обращается за
авторизацией или обновлениями к OpenWhispr.

## 2. Удалить серверный слой продукта

| Область | Что удалить | Основные точки входа |
| --- | --- | --- |
| Аккаунт | Sign-in/out, session refresh, auth cookies, reauthentication, auth callbacks | `src/lib/auth.ts`, `src/hooks/useAuth.ts`, auth UI, `main.js` |
| Подписка | Plans, Stripe checkout/portal, trial, usage polling, quotas, upsell | `src/hooks/useUsage.ts`, `src/lib/usageStore.ts`, `src/lib/subscriptionFlag.ts`, `src/components/UpgradePrompt.tsx` |
| Managed inference | OpenWhispr ASR/LLM proxy, выдача realtime tokens/config, отправка usage | `src/services/ai/inferenceProviders/openwhispr.ts`, cloud IPC в `src/helpers/ipcHandlers.js` |
| Sync/backup | Background sync, cloud IDs, tombstones, cloud conflict resolution, backup settings | `src/services/SyncService.ts`, `src/services/syncPassPolicy.ts`, `src/helpers/cloudSyncGuards.js` |
| Sharing/teams | Public links, invitations, ACL, shared spaces, workspace roles | `src/services/NoteSharingService.ts`, `src/services/WorkspacesService.ts`, share/team UI |
| Enterprise | SSO/SCIM client paths, policies, managed credentials, enterprise routing | `src/stores/policyStore.ts`, `src/stores/policyRules.ts`, `src/helpers/enterpriseIdentityManager.js`, `src/helpers/workspacePolicyManager.js` |
| Hosted integrations | Personal/workspace API keys, hosted MCP, cloud CLI cards | `src/components/IntegrationsView.tsx`, `src/components/McpIntegrationCard.tsx`, `src/components/CliIntegrationCard.tsx` |
| Engagement | Leaderboard, workspace nudges, Insights upload, promotional UI | `src/services/LeaderboardService.ts`, `src/services/AnalyticsService.ts`, соответствующие hooks/UI |

В каждой области удалить UI, вызовы, IPC/preload/type declarations, store state,
таймеры, env/config, переводы и тесты исключительно удалённого поведения.
Общие модули удалять только после переноса оставшихся пользователей.

Не удалять по одному слову `cloud`, `auth` или `policy`: авторизация API-провайдера,
calendar OAuth, сетевые ошибки и правила audio capture нужны самостоятельно.
Локальные диагностические логи и capture events сохраняются.

Готово: чтение, редактирование и запись встреч не зависят от аккаунта,
подписки, workspace или ответа удалённой policy-службы.

## 3. Заменить зависимые meeting-пути до удаления общего кода

- Выделить capture из `src/stores/meetingRecordingStore.ts` и meeting IPC.
  Start должен работать без API-ключей и сети; stop сначала финализирует
  локальные mic/system tracks и manifest, затем ставит обработку в очередь.
- Заменить временные diarization PCM и их удаление на durable chunks.
  Сбой renderer/app оставляет завершённые чанки и явное состояние gaps.
- Ввести SQLite processing runs и сохраняемые revisions. ASR каждого трека,
  optional diarization, merge и summary имеют отдельный retry; пропуск
  diarization должен быть явным допустимым состоянием.
- Перенести полезные direct-provider adapters из `src/services/fileTranscription.ts`
  и `src/services/ai/inferenceProviders/` за stage contracts.
- Удалить тарифные ограничения из `UploadAudioView.tsx`. Технические лимиты
  запроса провайдера обрабатывать chunking и проверкой полноты результата.
- Сделать summary автоматическим после готовой transcript revision; сохранять
  историю и помечать notes stale после изменения исходного transcript/speakers.
- Отделить `useEmbeddedChat` от глобального agent runtime: оставить контекст
  одной встречи, локальную историю и timestamp citations. Исключить инструменты
  поиска чужих встреч, web search, screen context и компьютерные действия.
- После переключения удалить старую обязательную realtime-цепочку,
  managed streaming config и `Coming soon` self-hosted meeting mode.
  Новый batch provider не должен зависеть от старого списка streaming providers.

Завершённый этап не содержит двух meeting pipelines. Выделение общих частей
и переключение пользователей входят в один законченный срез изменения.

Готово: capture переживает отключённую сеть; обработка ждёт провайдера;
повторный запуск стадии сохраняет исходное аудио и предыдущие результаты.

## 4. Удалить остальные продукты и лишнюю модельную инфраструктуру

- Dictation, paste-at-cursor, translation, snippets, wake words, global voice
  assistant, screen capture context, selection editing и их overlays/hotkeys.
- Глобальный chat, cross-note semantic search, Qdrant и embedding index.
- Самостоятельную общую библиотеку notes свести к meeting library;
  сохранить note editor и шаблоны внутри встречи.
- Voice fingerprinting между встречами и live speaker recognition удалить;
  ручные контакты/участники и исправления speakers сохранить.
- Bundled Whisper/Parakeet/Cohere ASR и llama runtime, UI загрузки моделей,
  GPU-рекламу и авто-download scripts убрать из первой версии с direct API.
- Локальную diarization не удалять вместе с ASR/LLM автоматически: сначала
  выбрать рабочую diarization стадию. Если она остаётся ONNX-based, сохранить
  требуемые ONNX runtime/models. AEC/VAD оценивать по потребителям capture.
- Локальный импорт audio/video встреч и FFmpeg сохранить. URL/YouTube downloader
  и yt-dlp предлагается удалить как расширение за пределами meeting-only среза.
- Hosted API/MCP убрать; новый локальный API сейчас не реализовывать.

Точки входа: `src/helpers/audioManager.js`, `src/hooks/useAudioRecording.js`,
`src/helpers/qdrantManager.js`, `src/components/chat/`, `src/services/tools/`,
`src/components/ControlPanel.tsx`, `package.json`, `scripts/`.

## 5. Сохранить календари без продуктового backend

- Apple Calendar сохранить через EventKit helper.
- Google/Microsoft сохранить через прямой OAuth и API: текущие реализации
  находятся в `googleCalendarOAuth.js`, `microsoftCalendarOAuth.js` и managers.
- Для OpenHercules нужны собственные OAuth app registrations и проверенные callback
  settings. Не опираться на upstream credentials или hosted callback.
- До настройки OAuth явным образом показывать недоступность конкретного
  подключения; ручная запись и Apple Calendar работают независимо.
- Сохранить call detection, reminders, calendar vocabulary и участников.
  Calendar attendee остаётся подсказкой, а не доказательством speaker identity.

## 6. Сократить сборку, зависимости и документацию

- Удалить Windows/Linux native helpers, Nix, platform installers и CI jobs.
  Сохранить macOS audio tap, mic/call detection, calendar helper и нужный AEC.
- Пересобрать `compile:native`, prestart/predev/prebuild/pack: сейчас они
  скачивают Qdrant, local ASR/LLM, embeddings, yt-dlp и другие ненужные компоненты.
- Удалить зависимости после проверки оставшихся imports: Better Auth/SSO,
  Qdrant client, enterprise AWS/Azure/Vertex SDK, Linux DBus и прочие ставшие
  неиспользуемыми пакеты. Сохранить keychain, SQLite, FFmpeg и нужные AI SDK.
- Убрать загрузку брендовых шрифтов OpenWhispr; использовать имеющийся свободный
  шрифт. Заменить брендовые assets, сохранив MIT license и attribution.
- Обновить lockfile штатным package manager; не менять его параллельно с cutover.
- Удалить старые workflows, troubleshooting/setup docs и agent instructions,
  относящиеся к вырезанным продуктам; архив доступен из baseline Git tag.
- Актуализировать README (сейчас ошибочно говорит, что импорта ещё нет),
  product/architecture/cutover/delivery docs. Этот порядок заменяет позднюю
  очистку из прежнего Phase 4: backend удаляется в начале перехода.

## Проверка результата

- Сборка и запуск macOS на чистом профиле OpenHercules без auth/backend env.
- Startup и idle не обращаются к OpenWhispr API/auth/MCP/update endpoints;
  это проверяется наблюдением сетевых запросов, дополнительно к поиску строк.
- Без сети и без провайдера можно начать/остановить запись и открыть библиотеку.
- Mic/system сохраняются раздельно; пропажа трека видна после перезапуска.
- Crash, повторный stop и retry не удаляют аудио и предыдущие артефакты.
- Direct ASR → diarization/skip → merge → summary → meeting chat работает
  без OpenWhispr account; длинная запись обрабатывается полностью.
- Экспорт аудио/транскрипта/notes и правка speakers работают локально.
- Chat не извлекает данные другой встречи. Ошибка ASR/summary не блокирует capture.
- Typecheck, lint, renderer build и целевые тесты сохранённых путей проходят;
  финальная macOS smoke-проверка подтверждает permissions, capture и recovery.

## Что требуется определить перед соответствующим этапом

- Первые direct ASR/summary/chat providers и способ diarization — перед этапом 3.
- Собственные Google/Microsoft OAuth registrations — перед включением этих
  интеграций; они не блокируют остальной cutover.
- Поддержка Intel Macs и конкретные native dependencies — перед финальной упаковкой.

Наличие будущего backend не требует сейчас auth, sync schema, billing framework
или plugin SDK. Для возвращения возможностей достаточно baseline истории,
локальных stage contracts и явных требований будущей версии.
