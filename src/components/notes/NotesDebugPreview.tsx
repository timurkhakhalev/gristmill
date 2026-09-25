import { useState } from "react";
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
import type { NotesDebugScenario } from "./NotesDebugControls";

const NOW = "2026-09-25T12:00:00.000Z";
const RECORDING_ID = "00000000-0000-4000-8000-000000000001";
const RUN_ID = "00000000-0000-4000-8000-000000000002";
const transcriptSegments = [
  { id: "one", speaker: "speaker-1", text: "Обсудили план релиза.", timestamp: 1, endTimestamp: 4 },
  {
    id: "two",
    speaker: "speaker-2",
    text: "Проверим запись на тестовом созвоне.",
    timestamp: 5,
    endTimestamp: 9,
  },
];
const transcript = serializeTranscriptSegments(transcriptSegments);
const summary =
  "## Решение\nПровести тестовый созвон и проверить сохранность обеих дорожек.\n\n## Следующий шаг\nПроверить результат транскрипции.";
const config: MeetingProcessingConfig = {
  transcription: { mode: "providers", provider: "deepgram", model: "nova-3", language: "ru" },
  summary: {
    instruction: "Подведи итоги встречи",
    reasoningMode: "providers",
    provider: "openai",
    model: "gpt-4o",
  },
};

function makePreview(scenario: NotesDebugScenario) {
  const hasTranscript = ["transcript", "ready", "audio-deleted", "enhanced-stale"].includes(
    scenario
  );
  const hasSummary = ["ready", "audio-deleted", "enhanced-stale"].includes(scenario);
  const isRecording = scenario === "recording" || scenario === "reconnecting";
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
    space_id: 0,
    transcript: hasTranscript ? transcript : null,
    calendar_event_id: null,
    participants: null,
    diarization_enabled: null,
    expected_speaker_count: null,
  };

  const runStatus: MeetingProcessingRunDto["status"] =
    scenario === "queued"
      ? "pending"
      : scenario === "processing"
        ? "running"
        : scenario === "blocked" || scenario === "transcript"
          ? "blocked"
          : scenario === "failed"
            ? "failed"
            : "complete";
  const run: MeetingProcessingRunDto = {
    id: RUN_ID,
    recordingId: RECORDING_ID,
    kind: "initial",
    sourceRunId: null,
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
          : scenario === "failed"
            ? "provider-timeout"
            : null,
    retryAt: null,
    retryCount: 0,
    hasRawProviderResponse: hasTranscript,
    hasTranscript,
    hasSummary,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const hasRecording = [
    "queued",
    "processing",
    "blocked",
    "failed",
    "incomplete",
    "transcript",
    "ready",
    "audio-deleted",
    "enhanced-stale",
  ].includes(scenario);
  const recordings: MeetingProcessingRecordingResult[] = hasRecording
    ? [
        {
          recording: {
            id: RECORDING_ID,
            captureState: scenario === "incomplete" ? "incomplete" : "ready",
            captureErrorCode: scenario === "incomplete" ? "system-audio-unavailable" : null,
            audioState: scenario === "audio-deleted" ? "deleted" : "available",
            audioErrorCode: null,
            currentRunId: hasTranscript ? RUN_ID : null,
            startedAt: NOW,
            endedAt: NOW,
          },
          runs:
            scenario === "incomplete"
              ? []
              : [
                  {
                    run,
                    transcript: hasTranscript
                      ? {
                          text: transcriptSegments.map((segment) => segment.text).join(" "),
                          segments: transcriptSegments.map((segment) => ({
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
                  },
                ],
        },
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
    "idle" | "preparing" | "recording" | "saving" | "saved" | "incomplete" | "failed"
  >(
    preview.isRecording
      ? "recording"
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
    preview.isRecording || scenario === "capture-saving" ? Date.now() - 75_000 : undefined
  );
  const [systemStatus, setSystemStatus] = useState<"inactive" | "active" | "reconnecting">(
    scenario === "reconnecting" ? "reconnecting" : preview.isRecording ? "active" : "inactive"
  );

  const startRecording = () => {
    setCaptureStartedAt(Date.now());
    setCapturePhase("recording");
    setIsRecording(true);
    setSystemStatus("active");
  };
  const stopRecording = () => {
    setCapturePhase("saved");
    setIsRecording(false);
    setSystemStatus("inactive");
  };

  const { note, recordings } = preview;
  return (
    <div className="flex h-full flex-col" data-notes-debug-scenario={scenario}>
      <div className="shrink-0 border-b border-orange-500/20 bg-orange-500/10 px-4 py-2 text-xs text-orange-700 dark:text-orange-300">
        Debug preview: {scenario}. In memory only; no database, audio, or provider calls.
      </div>
      {scenario === "empty" ? (
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
                scenario === "ready" || scenario === "enhanced-stale"
                  ? "enhanced"
                  : hasTranscriptScenario(scenario)
                    ? "transcript"
                    : "raw",
            }}
          />
        </div>
      )}
    </div>
  );
}

function hasTranscriptScenario(scenario: NotesDebugScenario): boolean {
  return scenario === "transcript" || scenario === "ready" || scenario === "audio-deleted";
}
