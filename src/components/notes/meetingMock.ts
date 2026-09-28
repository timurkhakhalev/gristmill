// In-memory mock of the task-002 meeting pipeline (delayed ASR, speaker naming,
// prioritized tasks, Recap). Only the debug preview uses it; no real work runs.

export type MockTasksState = "loading" | "ok" | "zero" | "error" | "format" | "conflict";
export type MockRecapState = "none" | "running" | "ok";

export interface MockPipeline {
  /** Seconds left in the 15 s end-of-meeting gate before ASR starts. */
  waitingSeconds?: number;
  /** Extra pipeline stage shown while the run is otherwise running. */
  namingRunning?: boolean;
  tasks?: MockTasksState;
  recap?: MockRecapState;
  /** Auto Summary was skipped because the meeting is short. */
  autoSummarySkipped?: { seconds: number; chars: number };
  /** Speaker ids whose names were assigned by the model, not by a person. */
  modelSpeakerIds?: string[];
  /** Speaker names changed after the Summary was written. */
  summaryStale?: boolean;
}

export const MOCK_GATE_SECONDS = 15;

const TASKS_OK = `## Action Items

### HIGH
- Лера: закрыть регрессию по Stripe до среды

### MEDIUM
- Проверить логи meeting processing сегодня вечером
- Синхронизироваться завтра в 11

### LOW
- Вернуться к вопросу об автоматических откатах после релиза`;

const TASKS_PLAIN = `## Action Items
- Закрыть регрессию по Stripe
- Проверить логи meeting processing`;

const RECAP_OK = `## Recap

**Релиз перенесён на понедельник**

- Регрессия по Stripe блокирует релиз, берёт Лера
- Утечка в meeting processing найдена, фикс ждёт ревью`;

const RECAP_RUNNING = `## Recap

_Готовим recap…_`;

export function composeMockSummary(base: string, tasks: MockTasksState | undefined, recap: MockRecapState | undefined): string {
  const parts = [base];
  if (tasks === "ok") parts.push(TASKS_OK);
  else if (tasks === "loading" || tasks === "error" || tasks === "conflict") parts.push(TASKS_PLAIN);
  if (recap === "ok") parts.push(RECAP_OK);
  else if (recap === "running") parts.push(RECAP_RUNNING);
  return parts.join("\n\n");
}

export const MOCK_FOLLOW_UP_REPLY = `Вы с Лерой договорились о переносе релиза, и письменное подтверждение сроков снимет риск недопонимания. [0:49]

Привет! Итоги синка: релиз переносим на понедельник, чтобы не рисковать перед выходными. Лера берёт регрессию по Stripe до среды, фикс по утечке уже в PR и ждёт ревью. Предложение: смок-тесты оставить на пятницу. Дайте знать, если что-то из этого не подходит.`;
