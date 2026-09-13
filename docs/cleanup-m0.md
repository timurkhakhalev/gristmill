# Cleanup M0: контракт, inventory и делегирование

Дата: 2026-09-14. Исходный код: baseline `49cd2b3`, upstream
`4335972b96a62caab0c822b3b9549a1a4fdbb351`.

Статус: M0 завершён. Контракт и ownership подготовлены. Зависимости
установлены через pnpm; renderer build, typecheck, lint и полный тестовый прогон выполнены.
Решение Home/Insights подтверждено. Удаления и делегирование реализации не начаты.
Функциональный scope — `removal-plan.md`; будущая архитектура — не scope cleanup.

## Решения и границы

- Сохраняем Note как продуктовую сущность: заметки без аудио, папки, редактор,
  шаблоны/AI Actions, экспорт, полную историю и действия embedded chat.
- Сохраняем всех прямых ASR/LLM, Local runtime/downloads и работающий Self-Hosted.
  Не расширяем поддержку режимов/моделей под видом снятия ограничений.
- Сохраняем realtime, mic/system, watchdog/reconnect, диаризацию, контакты,
  ручную правку и межвстречное распознавание спикеров. Не реализуем batch.
- Сохраняем Dictionary/Snippets: данные, chat tools и ручной management UI.
- Удаляем OW backend/account/paywalls, managed policies, sync/sharing/teams,
  hosted integrations, dictation, standalone assistant, web_search, YouTube,
  semantic search/Qdrant и non-mac-arm64. Direct-provider credentials остаются.
- Календари Apple/Google/Microsoft остаются. Собственный OAuth позже; G/M до
  настройки показывают понятную недоступность. Manual recording не блокируется.
- Отдельный чистый профиль OpenHercules; данные/ключи OW не мигрируем.
- Новые модели, durable tracks/queue/revisions/automatic notes — отдельный этап.

## Home/Insights: доказательства и подтверждённое решение

| Экран | Что делает сейчас | Источник | Подтверждённое решение |
| --- | --- | --- | --- |
| Home | История диктовок: copy/delete/retry, сохранённое аудио диктовок | `ControlPanel.tsx` рендерит `HistoryView` для `home` | Удалить вместе с dictation |
| Insights | Words spoken, WPM, число диктовок, streak, heatmap; также leaderboard/cloud sync | `InsightsView.tsx`, `audioManager.saveTranscription → recordAnalyticsEvent`, backfill из transcriptions в database | Удалить локальную и серверную часть статистики диктовок |
| Notes | Библиотека заметок и встреч | `ControlPanel.tsx`: `personal-notes → PersonalNotesView` | Сохранить, сделать стартовым экраном |

Home — не список встреч. Insights не является аналитикой встреч: найденный
producer — сохранение диктовки; исторический backfill также читает transcriptions.
Новый meeting dashboard не добавляем в cleanup. Пользователь подтвердил удаление
Home/Insights и запуск в Notes. Это не основание удалить
capture diagnostics, локальные логи, сам импорт/экспорт или записи notes.

## Матрица задач и владельцев

| ID | Результат | Зависимости | Ownership |
| --- | --- | --- | --- |
| M0 | Согласованные документы, inventories, исходные результаты проверок | — | README, AGENTS, активные docs |
| M1 | Identity/storage/keychain/protocol/session, без OW updater/publish | M0 | Identity в main/build, updater; затем передать общие файлы M7/M8 |
| M2 | Удалён серверный слой OW | M1 | Auth/usage/sync/sharing/workspace/policy/engagement модули и специализированный UI |
| M3 | Все сохранённые inference routes без OW | M1 | Provider registry, fileTranscription, realtime adapters/routing, AI providers; сохранить собственные credentials |
| M4 | Удалены dictation и voice assistant | M1 | audioManager, useAudioRecording, AssistantPanel и dictation-only helpers/overlays |
| M5 | Embedded chat работает, FTS вместо semantic, без web_search | M1 | Весь общий chat runtime/persistence/tools, ChatView entry module, Qdrant/search modules |
| M6 | Файлы/direct URL и календари работают без YouTube/OW callback | M1 | UploadAudioView целиком, import helpers, calendar managers/OAuth и специализированный UI |
| M7 | Собраны общие подключения и настройки | M2–M6 | main.js, ipcHandlers.js, preload, общие types, App.jsx, ControlPanel/nav, onboarding, settings/stores, database/schema |
| M8 | Только arm64, актуальные deps/build/assets | M7 | package.json, pnpm-lock.yaml, build configs, scripts, native artifacts, workflows, branding |
| M9 | Приёмка и итоговая документация | M8 | Итоговые проверки и docs; исправления возвращать владельцам |

Порядок: M0 → M1 → параллельно M2/M3/M4/M5/M6 → M7 → M8 → M9.
Тесты своих модулей принадлежат исполнителю соответствующего M, не откладываются
на M9. M6 можно разделить на импорт и календари с непересекающимся ownership.

Правила передачи:

1. До запуска назначить точный список файлов каждого исполнителя. Таблица выше
   задаёт ответственность, но не разрешает редактировать чужой shared файл.
2. M2/M3 передают требования к UploadAudioView владельцу M6, не редактируют его.
   M4 не удаляет общие chat-модули; ChatView удаляет M5, навигацию меняет M7.
3. Каждый исполнитель передаёт M7 manifest: imports/call sites/IPC channels,
   типы, поля settings/schema и проверки, которые нужно удалить/сохранить.
   Manifest содержит точные символы, а не «почистить связанные зависимости».
4. Новые shared-файлы добавляются к ownership только через интегратора.
   Пересекающиеся переводы редактирует M7 по списку ключей от исполнителей.
5. До M7 частичные ветки могут не собираться целиком; это не законченные релизы.
   Не добавлять временные auth stubs или compatibility shims ради промежуточной сборки.
6. Только M8 удаляет пакеты в рамках cleanup. По отдельному запросу пользователя
   установка переведена на pnpm 10.19.0; canonical lockfile — pnpm-lock.yaml.
7. Отчёт исполнителя: изменённые файлы, сохранённые функции, команды/результаты,
   shared manifest, непроверенное и новые вопросы. Нельзя самовольно сокращать scope.

## Provider × lane inventory

Это snapshot импортированного кода, не проверка доступности внешних API.
Точные model IDs/defaults остаются в baseline `src/models/modelRegistryData.json`;
M3 сравнивает сохранённые entries с `49cd2b3`, не заменяет каталог новыми моделями.

| Провайдер/режим | Note Recording (realtime) | Audio Upload | Notes/chat LLM |
| --- | --- | --- | --- |
| OpenAI | Да: mini/4o transcribe | Да; включая текущую diarize ветку | Да |
| Groq | Нет | Да | Да |
| xAI | Нет | Да | Нет отдельного registry adapter |
| Mistral | Нет | Да; текущая diarize ветка | Через существующие Local/custom, не новый direct adapter |
| Gemini | Нет в meeting router | Да | Да |
| Corti | Да | Да | Да |
| Tinfoil | Да | Да, batchModel mapping | Да |
| Deepgram | Да | Нет в текущем upload | Нет |
| AssemblyAI | Да | Нет в текущем upload | Нет |
| Anthropic / OpenRouter | Нет | Нет | Да |
| Custom | Нет | Да | Да |
| Local | Да | Да | Да |
| Self-Hosted | Не поддерживается; не снимать disabled | Сохранить существующий путь | Да, lan |
| Bedrock / Azure / Vertex | Не добавлять | Не добавлять | Сохранить direct credentials и существующие модели |
| OpenWhispr Cloud | Удалить | Удалить | Удалить |

Источники: `ModelRegistry.ts`, `modelRegistryData.json`,
`meetingTranscriptionRouting.js`, `fileTranscription.ts`,
`services/ai/inferenceProviders/index.ts`. Streaming-модель в общем каталоге не
означает поддержку Note Recording: Gemini live не входит в meeting allowlist.
Dictation lane удаляется; его провайдеры не должны исчезнуть из сохранённых lanes.
Local: сохранить whisper/parakeet/diarization catalogs и GGUF families
qwen/mistral/llama/openai-oss/gemma/liquidai, их download/runtime dependencies.

M3 acceptance: для каждой сохранённой строки registry/settings/dispatch тест
с fake transport, без платных API вызовов; неподдерживаемые сочетания остаются
явно неподдерживаемыми. Сохранить существующие технические лимиты запросов.

## Chat tools inventory

Источник: `src/services/tools/index.ts`, вызывается из `useChatStreaming.ts`.

| Tool | После cleanup |
| --- | --- |
| search_notes | Сохранить только FTS; убрать cloud/semantic ветки, обновить описание и тесты |
| get_note / create_note / update_note / list_folders | Сохранить локальные действия без нового ограничения текущей заметкой |
| copy_to_clipboard | Сохранить; это не paste-at-cursor |
| get_snippet | Сохранить текущую регистрацию при наличии snippets |
| update_snippets / update_dictionary | Сохранить вместе с данными и management UI |
| get_calendar_events / get_calendar_availability | Сохранить; доступны при подключённом календаре |
| web_search | Удалить tool, IPC/preload/types/settings и backend вызов; без замены |

Ограничения tool support выбранной модели сохраняются. Screen/selection
параметры AssistantPanel не используются `useEmbeddedChat`: оставить noteContext,
транскрипт, обычное выделение/редактирование текста; удалить assistant-only context.

## Сетевая политика после cleanup

Это критерии наблюдения, не новая firewall-инфраструктура.

| Сценарий | Допустимо | Недопустимо |
| --- | --- | --- |
| Чистый startup/idle без настроенных интеграций | Локальные операции | OW auth/API/MCP/update/usage/sync/analytics |
| BYOK inference, connection test, model list | Выбранный provider endpoint, его текущие SDK/attestation endpoints | OW token/config bootstrap или proxy |
| Local | Loopback runtime; загрузки нужных моделей/бинарников по существующему действию | Qdrant/search-index downloads, OW application updates |
| Self-Hosted/custom | URL пользователя согласно текущим проверкам | OW fallback |
| Calendar | Apple local; после настройки собственный Google/Microsoft OAuth и API | upstream credentials, openwhispr.com/auth/desktop-callback |
| URL import | Прямой media URL, текущие проверки схемы/адреса/redirect | YouTube/yt-dlp-only пути |

Provider hosts включают api.openai.com, api.groq.com, api.x.ai,
api.mistral.ai, generativelanguage.googleapis.com, api.anthropic.com,
api.deepgram.com, streaming.assemblyai.com/api.assemblyai.com, openrouter.ai,
существующие Corti и Tinfoil endpoints (включая динамический enclave/attestation),
настроенные AWS/Azure/Vertex endpoints. Не ограничивать custom произвольным
списком доменов и не удалять рабочий provider из-за имени enterprise.
Источники адресов: constants.ts, provider modules и upstream network-allowlist.md;
upstream allowlist сам по себе не разрешает OW обращения после cleanup.

GitHub/Hugging Face/CDN нужны сохранённым model/runtime downloads; запрет updater
не означает запрет всего github.com. Проверять назначение URL, включая redirects.
При smoke наблюдать renderer И main/native/SDK соединения: одного DevTools мало.
Логи проверки не должны содержать ключи, cookies, содержимое записей или заметок.

## Baseline проверок: фактический результат

Среда: Node v24.12.0, pnpm 10.19.0; npm отключён локальной политикой.
Первый прогон выполнялся без node_modules. Затем по запросу пользователя:
`pnpm import`, `pnpm install --frozen-lockfile`, разрешение build scripts для
electron/esbuild/ffmpeg-static/onnxruntime-node/better-sqlite3 и их установка.
package-lock.json заменён на pnpm-lock.yaml, scripts используют pnpm.
Добавлен прямой devDependency app-builder-lib 26.15.3: scripts/afterPack.js
импортирует его напрямую, а pnpm не открывает транзитивные зависимости root.
Три afterPackWindowsOnnxRuntime теста после этого проходят.
Импорт разрешил версии в рамках package.json; не утверждаем побайтовое совпадение
всего dependency tree с исходным npm lock. Новая база фиксируется pnpm lockfile.
Приложение не запускалось, пользовательский профиль не использовался.

| Проверка | Результат 2026-09-14 |
| --- | --- |
| pnpm run build:renderer | PASS после установки; предупреждения о крупных chunks/dynamic imports |
| pnpm run lint | PASS: 0 errors, 6 warnings |
| pnpm run typecheck | PASS после установки |
| Node tests: пять файлов ниже | 77 passed, 0 failed |
| Полный финальный Node/tsx прогон после pnpm настройки | 4444 tests: 4437 pass, 0 fail, 6 skipped, 1 todo; 51.6 s |
| meetingStreamingProviders.test.js | ws установлен; входит в полный повторный прогон |
| Native package / arm64 smoke / network | Не запускались; runtime smoke только после M1 |

Выполненная dependency-free проверка:

```sh
node --test --test-timeout=10000 \
  test/helpers/meetingTranscriptionRouting.test.js \
  test/helpers/meetingSystemAudioWatchdog.test.js \
  test/helpers/meetingRecordingSession.test.js \
  test/helpers/meetingTranscriptionLifecycle.test.js \
  test/helpers/meetingStreamingWiring.test.js
```

Это unit/source-level проверки, не доказательство работы audio hardware.
Не менять package type ради предупреждения Node MODULE_TYPELESS_PACKAGE_JSON.
Для повторения проверок: renderer build, typecheck, lint,
`node --import tsx --test --test-timeout=30000 "test/**/*.test.js"` и сохранить
реальные исходные ошибки. Не запускать prestart/prebuild автоматически:
они компилируют native компоненты и скачивают модели нескольких продуктов.
Native SQLite ABI различается для Node и Electron. Для Node-тестов выполнен
`pnpm --dir node_modules/better-sqlite3 exec prebuild-install`; in-memory SQLite
проверен успешно. Перед Electron smoke восстановить Electron ABI командой
`pnpm exec electron-builder install-app-deps`. Не запускать rebuild одновременно
с тестами. Первый полный прогон до завершения Electron install невалиден как
чистый baseline; результаты повторного прогона фиксируются отдельно.

## Characterization и приёмка по этапам

| Сценарий | Имеющаяся проверка / действие | Когда |
| --- | --- | --- |
| Start/stop, отмена старта, повторный stop | meetingRecordingSession, meetingTranscriptionLifecycle tests | Пройдён unit baseline; повторить M3/M7 |
| System audio stall/restart | meetingSystemAudioWatchdog tests | Пройдён unit baseline; hardware после M1 и M9 |
| Interruption/device change | meetingRecordingStoreSystemAudioInterrupted/Degraded, audioTapManagerWarnings tests | После deps; hardware после M1 и M9 |
| Renderer loss | Проверить cleanup/restart, transcript и состояние записи на отдельном профиле | Baseline после M1, затем M9; сейчас не проверено |
| Realtime + speakers | Mic/system, local diarization, live recognition, contacts/corrections | После M1 baseline и M9, с разрешённой тестовой записью |
| Notes/chat/search | Blank note, folders, AI Actions, все сохранённые tools/history, FTS | M5/M7 tests и M9 smoke |
| Imports | Локальный файл/direct URL; явный отказ YouTube после удаления | M6 tests и M9 smoke |
| Calendar | Apple; G/M «не настроено» без OAuth, ручная запись доступна | M6/M9 |
| Identity/network | Отдельный userData/keychain/session, нет OW startup/idle requests | M1, затем M9 |

Не улучшать заранее неизвестное поведение baseline под видом characterization.
Для crash/device/network сценариев зафиксировать фактические данные до/после,
включая существующие ограничения временного аудио и realtime. Не требовать
offline durability/recovery до batch. Не трогать пользовательские записи OW.

## Закрытие M0

- [x] Принятые решения, включая Home/Insights, записаны.
- [x] README, AGENTS, product/architecture/cutover/delivery согласованы.
- [x] Provider/tools inventory и сетевые критерии записаны.
- [x] Матрица ownership и порядок передачи определены.
- [x] Доступные baseline команды выполнены, ограничения не скрыты.
- [x] Решение Home/Insights и стартового экрана подтверждено.
- [x] Dependencies установлены; по запросу пользователя используется pnpm lockfile;
  renderer build/typecheck/lint повторены успешно.
- [x] Полный финальный прогон тестов: 0 failures; skips/todo не считаются проверенными сценариями.

M1 не означает разрешение начинать все удаления без отдельного поручения.
Runtime characterization переносится после изоляции M1 намеренно, не считается
выполненным в M0. Коммиты/публикация не выполняются без отдельного запроса.
