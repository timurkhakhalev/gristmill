# Structured output: Dayproof и маршруты OpenHercules

Проверено по текущему коду обоих проектов и публичной документации 2026-09-28; реальные запросы к платным моделям не выполнялись.

В Dayproof всего два analysis backend, а не набор прямых BYOK adapters:

- `src-tauri/src/analysis/codex_backend.rs:45`: `codex exec --output-schema <file> --output-last-message <file>`; затем JSON parse.
- `src-tauri/src/analysis/opencode_backend.rs:218`: `format: {type: "json_schema", schema, retryCount: 2}`; результат берётся из `info.structured`, не из текста сообщения.
- `session_analyzer.rs:31` и `day_analyzer.rs:35`: десериализация в тип и отдельная доменная validation перед использованием. Заимствуем именно сочетание transport schema + validation.

В OpenHercules `src/services/ai/inferenceProviders/index.ts` перечисляет маршруты ниже. Таблица показывает возможности и ограничения, которые нужно проверить для выбранного маршрута; она не требует реализовать native JSON Schema на всех маршрутах в этой задаче. Базовый контракт задачи — получить текст выбранным маршрутом, разобрать и проверить полный JSON, а при ошибке вернуть её в ту же conversation. Если native schema добавляется для конкретного подтверждённого маршрута, её передают от потребителя до транспорта, а не только в system prompt.

| Маршрут | Способ передачи схемы | Ограничение / решение |
| --- | --- | --- |
| OpenAI | Chat Completions `response_format: {type:"json_schema", json_schema:{name,strict:true,schema}}` | Проверять поддержку выбранной модели. [Документация](https://developers.openai.com/api/docs/guides/structured-outputs). |
| OpenRouter | Тот же `response_format` + `provider.require_parameters: true` | Не направлять запрос на endpoint, который проигнорирует schema. [Документация](https://openrouter.ai/docs/guides/features/structured-outputs). |
| Groq | `response_format.json_schema`, `strict:true` | Strict доступен только поддерживаемым моделям; best effort не равен strict. [Документация](https://console.groq.com/docs/structured-outputs). |
| Anthropic | `output_config.format: {type:"json_schema",schema}` | Для поддерживаемой модели/API; отказ и обрезание не считать JSON-успехом. [Документация](https://platform.claude.com/docs/en/build-with-claude/structured-outputs). |
| Gemini | В текущем `generateContent`: `generationConfig.responseMimeType="application/json"` и `responseJsonSchema` | Не смешивать контракт generateContent с новым Interactions API; поддерживается подмножество schema. [API](https://ai.google.dev/api/generate-content). |
| Tinfoil | `response_format: {type:"json_schema",json_schema:{name,schema}}` | Через существующий защищённый клиент; проверить конкретную модель и endpoint. [Документация](https://docs.tinfoil.sh/guides/structured-outputs). |
| Local llama.cpp | Schema-constrained `response_format` в `/chat/completions` | Проверить bundled binary; поддерживаемый диалект отличается от OpenAI. [Сервер](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md). |
| Self-hosted LAN / custom | Параметр соответствует фактическому серверу: llama.cpp, OpenAI-compatible и т. п. | Наличие `/chat/completions` само по себе не доказывает поддержку schema. Не удалять её автоматически при HTTP 400. Не менять endpoint/model скрыто. |
| Corti | Требует проверки именно Models API выбранной модели | Текущий adapter — обычный chat completions; подтверждения constrained schema для этого endpoint не получено. Не заявлять native guarantee. |
| Azure | Native structured output поддерживаемого deployment | Согласовать API version и текущий adapter. [Документация](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/structured-outputs). |
| Vertex | Нативный response schema выбранной модели/API | Gemini и partner models не имеют одного универсального wire-контракта. [Документация](https://cloud.google.com/vertex-ai/generative-ai/docs/reference/rest/v1beta1/GenerationConfig). |
| Bedrock | Нативный structured output выбранного API/model | Converse/InvokeModel и совместимые endpoints различаются; проверять реальный route. [Документация](https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html). |
| BB agent | В текущем `spawnBbThread` schema не передаётся; live `bb thread spawn --help` не показывает schema flag | `bb --json` относится к оболочке CLI, не ответу модели. Native Codex/OpenCode из Dayproof нельзя автоматически считать доступным через BB. Сквозной native schema в BB остаётся отдельной точкой интеграции; без него используем явно описанный ниже validated-text режим, не называя его constrained decoding. |


Это исследование возможностей, а не объём изменений в каждом провайдере. Текущий контракт задачи описан в [draft.md](draft.md), раздел 12.4.
