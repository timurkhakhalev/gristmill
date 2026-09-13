# План сокращения OpenWhispr до OpenHercules

Статус: план cleanup для реализации. Код cleanup пока не изменён.
Основание: обсуждение OpenHercules и импорт OpenWhispr
`4335972b96a62caab0c822b3b9549a1a4fdbb351`.

## Граница продукта

OpenHercules — самостоятельное macOS-приложение для встреч без собственного
backend и без зависимости от backend OpenWhispr. Записи, транскрипты,
заметки, настройки и история обработки хранятся локально.

В этом плане удаление Cloud означает удаление OpenWhispr Cloud и серверных
функций продукта. Прямые запросы к ASR/LLM по пользовательским API-ключам
сохраняются. Сохраняем всех существующих прямых ASR/LLM-провайдеров,
их модели, настройки ключей и custom endpoints; не сужаем список до одного.
Целевая платформа подтверждена: только macOS Apple Silicon.

Сохраняются все три режима: Cloud Providers (BYOK), Local и Self-Hosted.
Удаляется только OpenWhispr Cloud. Local runtime, загрузка моделей и их
настройки остаются. Существующая продуктовая модель notes, включая заметки
без аудио, редактор и папки, сохраняется и не требует будущей замены на Meeting.
Batch processing можно добавить к существующей модели заметок.

Активные product/architecture/cutover docs синхронизированы с этим scope.
Матрица делегирования, inventory и результаты baseline: `cleanup-m0.md`.

Сохраняем meeting library/detail, ручные заметки, шаблоны, участников,
исправление speaker labels, теги/категории, локальный импорт записей встреч,
экспорт, текущую realtime-запись mic/system, существующую диаризацию,
capture health, календари, существующий Audio Upload, генерацию notes
и полноценный встроенный chat, включая локальные cross-note tools.
Возможности сохраняются в текущем объёме.

Cleanup не реализует новую архитектуру записи и обработки. Durable audio,
переход meeting flow с realtime на batch, очередь, revisions, автоматический
summary и новые модели относятся к следующему этапу. Требования из
`architecture.md` и `product.md` остаются целевыми, но не являются критериями
готовности этого cleanup. До следующего этапа сохраняются известные ограничения
upstream, включая зависимость realtime от сети и временное хранение аудио.

Будущий backend остаётся возможностью, а не частью текущего runtime.
Удалённые реализации сохраняются в истории Git. Не оставляем закомментированные
модули, скрытые экраны, флаги premium=true или заглушки авторизации.

## 0. Зафиксировать исходную точку

- Baseline уже сохранена: commit `49cd2b3` содержит импорт и документы.
  Для возврата удалённых функций использовать этот commit; дополнительный
  архив в рабочем дереве не нужен.
- Сохранить upstream SHA и особенности импорта из `openwhispr-upstream/IMPORT.md`.
- Проверить исходную сборку и зафиксировать имеющиеся ошибки. Smoke-проверку
  приложения проводить только после изоляции его identity/storage на этапе 1.
- Дальнейшие удаления разбивать на осмысленные коммиты по этапам ниже.
  Для возврата функции использовать историю; копия `legacy-cloud/` не нужна.

Коммит baseline создан; коммиты cleanup ещё не созданы.

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

## 3. Сохранить meeting-пути при удалении общих зависимостей

- Сохранить существующие start/stop, realtime transports, mic/system capture,
  reconnect/watchdog и текущую диаризацию в `meetingRecordingStore.ts` и meeting IPC.
  Удалить только OW Cloud route и его token/config bootstrap.
- Сохранить прямые адаптеры в `src/services/fileTranscription.ts`,
  `src/services/ai/inferenceProviders/` и realtime provider modules.
  Списки для Note Recording и Audio Upload остаются разными по фактическим
  возможностям; новые batch-адаптеры сейчас не добавлять.
- Удалить тарифные проверки и предложения перейти в OW Cloud из Audio Upload.
  Сохранить технические ограничения существующих direct-provider запросов.
  Универсальный chunking длинных файлов относится к следующему этапу.
- Сохранить существующую генерацию notes и шаблоны, без добавления автоматической
  стадии после stop и без нового формата revisions.
- Сохранить полноценный встроенный chat и его существующие действия, включая
  изменение заметок; не превращать его в read-only Q&A. Общие streaming,
  persistence и tool modules сохранять, пока они нужны встроенному chat.
  Отдельный общий ассистент означает самостоятельный экран ChatView и голосовой
  assistant вне заметки. Не переносить его удаление автоматически на инструменты
  встроенного чата. Если инструмент требует OW backend, явно перечислить его
  и согласовать замену/исключение до удаления; скрыто урезать chat нельзя.
- Сохранить custom/self-hosted пути там, где они уже работают. Не открывать
  неподдерживаемый realtime self-hosted mode простым снятием disabled.
- В общих файлах выполнять только выделение кода, необходимое для удаления
  зависимостей. Полный перенос на stage contracts отложить.

Готово: существующие direct-provider meeting, upload, notes и chat работают
без аккаунта OpenWhispr; cleanup не подменяет realtime новым pipeline.

## 4. Удалить остальные продукты и лишнюю модельную инфраструктуру

- Dictation, paste-at-cursor, dictation translation, dictation-specific применение snippets,
  wake words, global voice assistant, screen capture context, selection editing
  вне заметок и их overlays/hotkeys. Данные snippets/dictionary и их локальные
  инструменты встроенного chat и экран ручного управления Dictionary/Snippets
  сохранить — решение подтверждено пользователем.
  Обычное выделение текста и редактирование в NoteEditor не удалять.
- Глобальный chat, cross-note semantic search, Qdrant и embedding index.
- Сохранить библиотеку notes без изменения её продуктовой модели: заметки
  без записи, папки, редактор, prompts и AI Actions над заметками.
- Сохранить распознавание спикеров полностью: live speaker recognition,
  voice fingerprinting между встречами, контакты и ручные исправления.
- Сохранить bundled local ASR/LLM runtime, UI и загрузку моделей для arm64.
- Существующую локальную диаризацию meeting flow и её ONNX runtime/models
  сохранить. Встроенную OpenAI/Mistral диаризацию Audio Upload также сохранить.
  Выбор и сравнение новых способов diarization не блокируют cleanup.
  AEC/VAD и speaker embeddings удалять только при отсутствии оставшихся
  потребителей; межвстречное распознавание и внутривстречная кластеризация различны.
- Сохранить импорт локальных audio/video файлов, прямых media URL и FFmpeg.
  Удалить только YouTube import и его UI/обработчики; yt-dlp удалить после
  проверки, что сохранённый импорт прямых URL не зависит от него.
- Сохранить Note Recording, Audio Upload, LLM settings для notes/chat,
  meeting hotkey, recording pill, tray и уведомления.
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
- OAuth registrations добавляются позже и не входят в cleanup.
- До настройки OAuth явным образом показывать недоступность конкретного
  подключения; ручная запись и Apple Calendar работают независимо.
- Сохранить call detection, reminders, calendar vocabulary и участников.
  Calendar attendee остаётся подсказкой, а не доказательством speaker identity.

## 6. Сократить сборку, зависимости и документацию

- Удалить Windows/Linux и macOS Intel targets, native artifacts и CI jobs, Nix.
  Сохранить macOS audio tap, mic/call detection, calendar helper и нужный AEC.
- Пересобрать `compile:native`, prestart/predev/prebuild/pack: сейчас они
  скачивают компоненты нескольких продуктов. Удалить Qdrant, search embeddings,
  YouTube-only dependencies и ненужные platform artifacts. Local ASR/LLM,
  diarization и speaker recognition dependencies для arm64 сохранить.
- Удалить зависимости после проверки оставшихся imports: Better Auth/SSO,
  Qdrant client, Linux DBus и прочие ставшие неиспользуемыми пакеты.
  Enterprise policies/managed routing удалить, но прямые провайдеры с собственными
  credentials сохранить, включая AWS/Azure/Vertex, если у них есть такой путь.
  Их SDK удалять только при отсутствии сохранённых потребителей.
  Сохранить keychain, SQLite, FFmpeg и нужные AI SDK.
- Убрать загрузку брендовых шрифтов OpenWhispr; использовать имеющийся свободный
  шрифт. Заменить брендовые assets, сохранив MIT license и attribution.
- Обновить lockfile штатным package manager; не менять его параллельно с cutover.
- Удалить старые workflows, troubleshooting/setup docs и agent instructions,
  относящиеся к вырезанным продуктам; архив доступен из baseline commit.
- Актуализировать README и ссылки на планы. Разделить завершённый cleanup
  и будущий переход обработки: новая архитектура не считается реализованной
  после удаления серверных функций.

## Проверка результата

- Сборка и запуск macOS arm64 на чистом профиле OpenHercules без auth/backend env.
- Startup и idle не обращаются к OpenWhispr API/auth/MCP/update endpoints;
  это проверяется наблюдением сетевых запросов, дополнительно к поиску строк.
- Библиотека и локальные заметки открываются без сети и аккаунта.
- С настроенным direct realtime provider запись стартует/останавливается,
  mic/system и существующая диаризация работают как до cleanup.
- Проверены повторный stop, interruption/device change и renderer loss:
  регрессий относительно baseline нет; исходные ограничения задокументированы.
- Direct Audio Upload, notes generation, правка speakers, существующий экспорт
  и meeting chat работают без OW Cloud. Лимиты провайдеров отображаются честно.
- Каждый сохранённый провайдер остаётся в registry/settings и имеет рабочий
  dispatch; целевые тесты проверяют routing без реальных платных запросов.
- Встроенный chat сохраняет существующие действия и локальную историю;
  инструменты не теряются из-за удаления отдельного assistant UI или backend.
- Создание заметок без аудио, папки и AI Actions работают как прежде.
- Local, BYOK и поддерживаемые Self-Hosted пути сохранены.
- Импорт файла и прямого media URL работает; YouTube import удалён.
- Обычный локальный поиск по заголовкам и тексту работает без Qdrant.
- Live и межвстречное распознавание спикеров не урезаны.
- Typecheck, lint, renderer build и целевые тесты сохранённых путей проходят;
  финальная macOS arm64 smoke-проверка подтверждает permissions и текущий capture.

## Что требуется определить перед соответствующим этапом

- Удаление самостоятельного ChatView и голосового ассистента вне заметок
  подтверждено пользователем. Общие модули встроенного chat сохранить.
- Проверка `src/services/tools/index.ts` показала: чтение/создание/изменение
  notes, папки, clipboard и vocabulary tools работают локально; calendar tools
  используют существующие календарные интеграции. `search_notes` содержит
  cloud/semantic/FTS пути: оставить FTS согласно принятому решению о поиске.
- Удаление `web_search` подтверждено пользователем: убрать инструмент из
  registry, его реализацию, IPC/preload/type declarations и связанные UI/settings.
  Удалить вызов `/api/agent/web-search`; замену или BYOK web-search provider
  сейчас не добавлять. Остальные инструменты встроенного chat сохранить.
- Snippet/dictionary: подтверждено сохранение данных, инструментов встроенного
  chat и экрана ручного управления; удаляется только dictation-specific применение.
- Home/Insights: подтверждено удаление истории диктовок и их статистики целиком.
  Открывать Notes по умолчанию; новый dashboard в cleanup не добавлять.
- Screen/selection context проверен по цепочке вызовов: `useEmbeddedChat`
  передаёт `noteContext` и вызывает `sendMessageWithResult(text)` без
  `attachment`/`selectedContext`. Эти параметры общего `useChatStreaming`
  используются голосовым AssistantPanel и onboarding assistant demo, а не
  встроенным chat заметки. Их удаление вместе с отдельным ассистентом не
  сокращает текущие возможности embedded chat. Контекст заметки/транскрипта,
  обычное выделение и редактирование текста сохранить.

- Собственные Google/Microsoft OAuth registrations — перед включением этих
  интеграций; они не блокируют остальной cutover.
- Перед удалением native dependencies проверить потребителей оставшейся
  realtime-записи и диаризации. Новую ASR-модель для cleanup выбирать не требуется.

## Следующий этап: batch processing и эксперименты (вне cleanup)

После cleanup отдельно планируются durable раздельные записи, restart recovery,
переход meeting flow на batch, processing runs/revisions, автоматические notes,
timestamp citations и обработка длинных файлов. ASR и diarization могут
возвращаться одним вызовом провайдера; отдельный запрос diarization не обязателен.

Список пользователя для будущего сравнения, перенесённый со скриншота:

- Groq Whisper Large v3 Turbo.
- ElevenLabs Scribe v2.
- Deepgram Nova-2 batch.
- Deepgram Nova-3, один язык.
- OpenAI `gpt-transcribe` (название со скриншота; точный API model ID уточнить).
- Deepgram Nova-3 Multilingual.
- OpenAI `gpt-4o-transcribe`.

Также ранее обсуждалась `gpt-4o-transcribe-diarize`, уже используемая OW
в Audio Upload. Список кандидатов не означает, что все они поддерживают
диаризацию или уже имеют batch-адаптер в импортированном коде. Цены и доступность
из скриншота здесь не подтверждаются; проверяются перед экспериментами.
Добавление адаптеров, выбор победителей и запуск сравнений в cleanup не входят.

Наличие будущего backend не требует сейчас auth, sync schema, billing framework
или plugin SDK. Для возвращения возможностей достаточно baseline истории,
явных требований будущей версии. Stage contracts относятся к будущему batch-этапу.
