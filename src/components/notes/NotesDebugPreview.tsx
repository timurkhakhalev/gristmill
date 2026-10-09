import { useMemo, useState } from "react";
import type { NoteItem } from "../../contracts/notes";
import type { MeetingProcessingRecordingResult } from "../../contracts/meetingProcessing";
import type {
  MeetingProcessingConfig,
  MeetingProcessingRunDto,
} from "../../contracts/meetingRecording";
import { serializeTranscriptSegments } from "../../utils/transcriptSpeakerState";
import EmptyStateCard from "../ui/EmptyStateCard";
import { FileText } from "../icons";
import { Button } from "../ui/button";
import NoteEditor from "./NoteEditor";
import NotesOnboarding from "./NotesOnboarding";
import type { NotesDebugScenario } from "./NotesDebugControls";
import { MOCK_GATE_SECONDS, type MockPipeline } from "./meetingMock";

const NOW = "2026-09-25T12:00:00.000Z";

const SECOND_RECORDING_ID = "00000000-0000-4000-8000-000000000101";

const RECORDING_ID = "00000000-0000-4000-8000-000000000001";

const RUN_ID = "00000000-0000-4000-8000-000000000002";

const transcriptSegments = [
  {
    id: "s1",
    speaker: "speaker-1",
    text: "Привет, давай начнём с плана релиза на следующую неделю.",
    timestamp: 0,
    endTimestamp: 6,
  },
  {
    id: "s2",
    speaker: "speaker-2",
    text: "Да, у нас готова фича для биллинга, осталось закрыть регрессию.",
    timestamp: 6,
    endTimestamp: 13,
  },
  {
    id: "s3",
    speaker: "speaker-1",
    text: "Кто возьмёт регрессию по Stripe?",
    timestamp: 14,
    endTimestamp: 17,
  },
  {
    id: "s4",
    speaker: "speaker-2",
    text: "Я могу, но нужно согласовать сроки с Лерой.",
    timestamp: 17,
    endTimestamp: 22,
  },
  {
    id: "s5",
    speaker: "speaker-1",
    text: "Хорошо, договорись до завтра. Что ещё блокирует релиз?",
    timestamp: 23,
    endTimestamp: 28,
  },
  {
    id: "s6",
    speaker: "speaker-2",
    text: "Метрики на дашборде всё ещё падают — есть подозрение на утечку в meeting processing.",
    timestamp: 29,
    endTimestamp: 38,
  },
  {
    id: "s7",
    speaker: "speaker-1",
    text: "Окей, посмотрим логи сегодня вечером.",
    timestamp: 39,
    endTimestamp: 43,
  },
  {
    id: "s8",
    speaker: "speaker-2",
    text: "И ещё: деплой в пятницу или понедельник?",
    timestamp: 44,
    endTimestamp: 48,
  },
  {
    id: "s9",
    speaker: "speaker-1",
    text: "Перенесём на понедельник, чтобы не рисковать перед выходными.",
    timestamp: 49,
    endTimestamp: 56,
  },
  {
    id: "s10",
    speaker: "speaker-2",
    text: "Принято, тогда фикс дашборда дебажим в субботу.",
    timestamp: 57,
    endTimestamp: 63,
  },
  {
    id: "s11",
    speaker: "speaker-1",
    text: "Хорошо, спасибо. Давай синхронизируемся завтра в 11.",
    timestamp: 64,
    endTimestamp: 70,
  },
];

const part2Segments = [
  {
    id: "p1",
    speaker: "speaker-2",
    text: "Привет, Лера подтвердила — берёт регрессию по Stripe до среды.",
    timestamp: 1820,
    endTimestamp: 1827,
  },
  {
    id: "p2",
    speaker: "speaker-1",
    text: "Отлично, тогда оставляем пятницу для смок-тестов.",
    timestamp: 1828,
    endTimestamp: 1834,
  },
  {
    id: "p3",
    speaker: "speaker-2",
    text: "По дашборду я нашёл утечку — это был неиспользуемый MediaRecorder.",
    timestamp: 1835,
    endTimestamp: 1843,
  },
  { id: "p4", speaker: "speaker-1", text: "Фикс уже в репо?", timestamp: 1844, endTimestamp: 1846 },
  {
    id: "p5",
    speaker: "speaker-2",
    text: "Да, PR готов, ревью нужно от тебя.",
    timestamp: 1847,
    endTimestamp: 1851,
  },
];

const fullSegments = [...transcriptSegments, ...part2Segments];

const transcript = serializeTranscriptSegments(fullSegments);

const summary =
  "## TLDR\nКоманда обсудила готовность релиза: главный блокер — регрессия по Stripe, деплой перенесён на понедельник. Договорились проверить логи meeting processing и синхронизироваться завтра.\n\n## Готовность релиза\n**Speaker 2** сообщил, что фича для биллинга готова, но регрессию по Stripe нужно закрыть. Регрессию берёт Лера, срок согласуется.\n\n## Дашборд и утечка\n**Speaker 2** заметил падение метрик и заподозрил утечку в meeting processing; **Speaker 1** предложил посмотреть логи вечером. Позже утечку нашли: неиспользуемый MediaRecorder.";

const config: MeetingProcessingConfig = {
  transcription: { mode: "providers", provider: "deepgram", model: "nova-3", language: "ru" },
  summary: {
    instruction: "Подведи итоги встречи",
    reasoningMode: "providers",
    provider: "openai",
    model: "gpt-4o",
  },
};

const TASK2_SUMMARY_SCENARIOS: NotesDebugScenario[] = [
  "summary-tasks-loading",
  "summary-tasks-ok",
  "summary-tasks-zero",
  "summary-tasks-error",
  "summary-tasks-format",
  "summary-tasks-conflict",
  "summary-recap-running",
  "summary-recap",
];

const TASK2_TRANSCRIPT_SCENARIOS: NotesDebugScenario[] = [
  ...TASK2_SUMMARY_SCENARIOS,
  "naming",
  "audio-playing",
  "audio-paused",
  "short-meeting",
  "speakers-auto",
  "chat-follow-up",
];

function makeMockPipeline(scenario: NotesDebugScenario): MockPipeline | undefined {
  switch (scenario) {
    case "gate-waiting":
      return { waitingSeconds: MOCK_GATE_SECONDS };
    case "naming":
      return { namingRunning: true };
    case "audio-playing":
      return { audioPlayback: { currentTime: 312, playing: true } };
    case "audio-paused":
      return { audioPlayback: { currentTime: 312, playing: false } };
    case "short-meeting":
      return { autoSummarySkipped: { seconds: 130, chars: 1340 } };
    case "speakers-auto":
      return { modelSpeakerIds: ["speaker-2"], tasks: "ok", recap: "none" };
    case "summary-tasks-loading":
      return { tasks: "loading", recap: "none" };
    case "summary-tasks-ok":
      return { tasks: "ok", recap: "none" };
    case "summary-tasks-zero":
      return { tasks: "zero", recap: "none" };
    case "summary-tasks-error":
      return { tasks: "error", recap: "none" };
    case "summary-tasks-format":
      return { tasks: "format", recap: "none" };
    case "summary-tasks-conflict":
      return { tasks: "conflict", recap: "none" };
    case "summary-recap-running":
      return { tasks: "ok", recap: "running" };
    case "summary-recap":
      return { tasks: "ok", recap: "ok" };
    case "chat-follow-up":
      return {};
    default:
      return undefined;
  }
}

function makePreview(scenario: NotesDebugScenario) {
  const hasTranscript =
    TASK2_TRANSCRIPT_SCENARIOS.includes(scenario) ||
    [
      "transcript",
      "ready",
      "audio-deleted",
      "enhanced-stale",
      "summary-failed",
      "summary-generating",
    ].includes(scenario);

  const hasSummary =
    TASK2_SUMMARY_SCENARIOS.includes(scenario) ||
    scenario === "speakers-auto" ||
    ["ready", "audio-deleted", "enhanced-stale"].includes(scenario);

  const isRecording =
    scenario === "recording" || scenario === "reconnecting" || scenario === "system-unavailable";

  const note: NoteItem = {
    id: 0,
    title: scenario === "blank" ? "" : "Тестовая встреча",
    content: ["manual", "transcript", "ready", "audio-deleted", "enhanced-stale"].includes(scenario)
      ? "Вручную записал важный вопрос о сроках."
      : "",
    note_type: "meeting",
    source_file: null,
    audio_duration_seconds: null,
    created_at: NOW,
    updated_at: NOW,
    enhanced_content: hasSummary ? summary : null,
    enhancement_prompt: null,
    enhanced_at_content_hash: null,
    folder_id: null,
    folder_ids: [],
    transcript: hasTranscript ? transcript : null,
    calendar_event_id: null,
    participants: null,
    diarization_enabled: null,
    expected_speaker_count: null,
  };

  const runStatus: MeetingProcessingRunDto["status"] =
    scenario === "queued"
      ? "pending"
      : scenario === "processing" ||
          scenario === "summary-generating" ||
          scenario === "processing-elapsed-short" ||
          scenario === "processing-elapsed-long"
        ? "running"
        : scenario === "blocked" || scenario === "transcript"
          ? "blocked"
          : scenario === "failed" || scenario === "summary-failed"
            ? "failed"
            : "complete";

  const isElapsedShort = scenario === "processing-elapsed-short";
  const isElapsedLong = scenario === "processing-elapsed-long";

  const runCreatedAt = isElapsedShort
    ? new Date(Date.now() - 12_000).toISOString()
    : isElapsedLong
      ? new Date(Date.now() - 125_000).toISOString()
      : NOW;

  const run: MeetingProcessingRunDto = {
    id: RUN_ID,
    recordingId: RECORDING_ID,
    sourceRecordingIds: [RECORDING_ID, SECOND_RECORDING_ID],
    hasExplicitAudioParts: true,
    kind: "initial",
    sourceRunId: null,
    bbThreadId: null,
    provider: "deepgram",
    model: "nova-3",
    config:
      scenario === "blocked"
        ? null
        : scenario === "transcript"
          ? { ...config, summary: null }
          : config,
    configError: scenario === "blocked" ? { code: "missing-transcription-config" } : null,
    stage: scenario === "queued" ? "prepare" : hasTranscript ? "summary" : "asr",
    status: runStatus,
    errorCode:
      scenario === "blocked"
        ? "missing-transcription-config"
        : scenario === "transcript"
          ? "missing-summary-config"
          : scenario === "failed" || scenario === "summary-failed"
            ? "provider-timeout"
            : null,
    speakerNamingErrorCode: null,
    retryAt: null,
    retryCount: 0,
    hasRawProviderResponse: hasTranscript,
    hasTranscript,
    hasSummary,
    createdAt: runCreatedAt,
    updatedAt: runCreatedAt,
  };

  const hasRecording =
    scenario === "gate-waiting" ||
    TASK2_TRANSCRIPT_SCENARIOS.includes(scenario) ||
    [
      "queued",
      "processing",
      "processing-elapsed-short",
      "processing-elapsed-long",
      "blocked",
      "failed",
      "summary-failed",
      "summary-generating",
      "incomplete",
      "transcript",
      "ready",
      "audio-deleted",
      "enhanced-stale",
    ].includes(scenario);

  const isMultiPartTranscript =
    scenario === "transcript" ||
    scenario === "ready" ||
    scenario === "audio-deleted" ||
    scenario === "enhanced-stale" ||
    scenario === "summary-failed" ||
    scenario === "summary-generating";

  const recordings: MeetingProcessingRecordingResult[] = hasRecording
    ? [
        {
          recording: {
            id: RECORDING_ID,
            groupId: RECORDING_ID,
            captureState: scenario === "incomplete" ? "incomplete" : "ready",
            captureErrorCode: scenario === "incomplete" ? "system-audio-unavailable" : null,
            audioState: scenario === "audio-deleted" ? "deleted" : "available",
            audioErrorCode: null,
            audioPreparationErrorCode: null,
            currentRunId: scenario === "incomplete" ? null : RUN_ID,
            startedAt: NOW,
            endedAt: NOW,
            durationSeconds: 1820,
          },
          runs:
            scenario === "incomplete"
              ? []
              : [
                  {
                    run,
                    transcript: hasTranscript
                      ? {
                          text: fullSegments.map((segment) => segment.text).join(" "),
                          segments: fullSegments.map((segment) => ({
                            speaker: segment.speaker,
                            text: segment.text,
                            start: segment.timestamp,
                            end: segment.endTimestamp,
                          })),
                          diarized: true,
                        }
                      : null,
                    summary: hasSummary ? { text: summary } : null,
                    speakerCorrections: [],
                    speakerCorrectionRevision: 0,
                  },
                ],
        },
        ...(isMultiPartTranscript
          ? [
              {
                recording: {
                  id: SECOND_RECORDING_ID,
                  groupId: RECORDING_ID,
                  captureState: "ready" as const,
                  captureErrorCode: null,
                  audioState: "available" as const,
                  audioErrorCode: null,
                  audioPreparationErrorCode: null,
                  currentRunId: RUN_ID,
                  startedAt: "2026-09-25T12:32:40.000Z",
                  endedAt: "2026-09-25T12:36:55.000Z",
                  durationSeconds: 255,
                },
                runs: [],
              },
            ]
          : []),
      ]
    : [];

  return { note, recordings, isRecording };
}

export default function NotesDebugPreview({
  scenario,
  onSelectScenario,
}: {
  scenario: NotesDebugScenario;
  onSelectScenario: (scenario: NotesDebugScenario) => void;
}) {
  const [preview, setPreview] = useState(() => makePreview(scenario));
  const [isRecording, setIsRecording] = useState(preview.isRecording);

  const [capturePhase, setCapturePhase] = useState<
    "idle" | "preparing" | "recording" | "paused" | "saving" | "saved" | "incomplete" | "failed"
  >(
    preview.isRecording
      ? "recording"
      : scenario === "paused"
        ? "paused"
        : scenario === "incomplete"
          ? "incomplete"
          : scenario === "capture-preparing"
            ? "preparing"
            : scenario === "capture-saving"
              ? "saving"
              : scenario === "capture-failed"
                ? "failed"
                : "idle"
  );

  const [captureStartedAt, setCaptureStartedAt] = useState<number | undefined>(
    preview.isRecording || scenario === "capture-saving" || scenario === "paused"
      ? Date.now() - 75_000
      : undefined
  );

  const [systemStatus, setSystemStatus] = useState<
    "inactive" | "active" | "reconnecting" | "unavailable"
  >(
    scenario === "reconnecting"
      ? "reconnecting"
      : scenario === "system-unavailable"
        ? "unavailable"
        : preview.isRecording
          ? "active"
          : "inactive"
  );

  const startRecording = () => {
    setCaptureStartedAt(Date.now());
    setCapturePhase("recording");
    setIsRecording(true);
    setSystemStatus("active");
  };

  const pauseRecording = () => {
    setCapturePhase("paused");
    setIsRecording(false);
  };

  const resumeRecording = () => {
    setCapturePhase("recording");
    setIsRecording(true);
  };

  const stopRecording = () => {
    setCapturePhase("saved");
    setIsRecording(false);
    setSystemStatus("inactive");
  };

  const { note, recordings } = preview;
  const mockPipeline = useMemo(() => makeMockPipeline(scenario), [scenario]);

  return (
    <div className="flex h-full flex-col" data-notes-debug-scenario={scenario}>
      <div className="shrink-0 border-b border-orange-500/20 bg-orange-500/10 px-4 py-2 text-xs leading-snug text-orange-700 dark:text-orange-300">
        Debug preview: {scenario}. In memory only; no database, audio, or provider calls.
      </div>
      {scenario === "onboarding" ? (
        <div className="min-h-0 flex-1">
          <NotesOnboarding preview onComplete={() => onSelectScenario("empty")} />
        </div>
      ) : scenario === "empty" ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyStateCard
            icon={FileText}
            title="No notes yet"
            description="Create a note to start writing or recording."
          >
            <Button size="sm" onClick={() => onSelectScenario("blank")}>
              Create note
            </Button>
          </EmptyStateCard>
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <NoteEditor
            note={note}
            onTitleChange={(_id, title) =>
              setPreview((current) => ({
                ...current,
                note: { ...current.note, title },
              }))
            }
            onContentChange={(_id, content) =>
              setPreview((current) => ({
                ...current,
                note: { ...current.note, content },
              }))
            }
            isSaving={false}
            isRecording={isRecording}
            isProcessing={false}
            onStartRecording={startRecording}
            onStopRecording={stopRecording}
            onPauseRecording={pauseRecording}
            onResumeRecording={resumeRecording}
            onGenerateSummary={() =>
              setPreview((current) => ({
                ...current,
                note: { ...current.note, enhanced_content: summary },
              }))
            }
            enhancement={
              note.enhanced_content
                ? {
                    content: note.enhanced_content,
                    isStale: scenario === "enhanced-stale",
                    onChange: (_id, content) =>
                      setPreview((current) => ({
                        ...current,
                        note: { ...current.note, enhanced_content: content },
                      })),
                  }
                : undefined
            }
            debugPreview={{
              recordings,
              capturePhase,
              captureStartedAt,
              captureErrorCode:
                scenario === "incomplete" || scenario === "capture-failed"
                  ? "system-audio-unavailable"
                  : undefined,
              micStatus: isRecording ? "active" : "inactive",
              systemStatus,
              viewMode:
                scenario === "ready" ||
                scenario === "enhanced-stale" ||
                scenario === "summary-generating" ||
                scenario === "short-meeting" ||
                TASK2_SUMMARY_SCENARIOS.includes(scenario)
                  ? "enhanced"
                  : "raw",
              mockPipeline,
              chatMode: scenario === "chat-follow-up" ? "floating" : undefined,
            }}
          />
        </div>
      )}
    </div>
  );
}
