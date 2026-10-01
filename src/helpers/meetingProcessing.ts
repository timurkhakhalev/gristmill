import { isRegenerableNoteTitle } from "./regenerableNoteTitle.js";
import { TRANSLATIONS_BY_LOCALE } from "../locales/translations.js";
import { formatMeetingMaterial } from "./meetingPromptMaterial.js";
import fs from "fs";
import debugLogger from "./debugLogger.js";
import { createHash } from "crypto";
import { z } from "zod";
import {
  meetingProcessingConfigSchema,
  meetingProcessingResultDtoSchema,
  type MeetingProcessingConfig,
  type MeetingProcessingResultDto,
  type MeetingProcessingRunDto,
  type MeetingRecordingDto,
  type MeetingRecordingEpochDto,
  type MeetingIntentionalInterval,
  type MeetingSource,
  type MeetingSummaryArtifact,
  type MeetingSpeakerCorrection,
  type MeetingTranscriptArtifact,
  MEETING_ASR_GATE_MS,
} from "../contracts/meetingRecording.js";
import {
  meetingProcessingChannels,
  meetingProcessingCreateRunRequestSchema,
  meetingProcessingListRequestSchema,
  meetingProcessingListResponseSchema,
  meetingProcessingRetryRequestSchema,
  meetingProcessingCancelRequestSchema,
  meetingProcessingSummaryActionRequestSchema,
  meetingProcessingSpeakerCorrectionRequestSchema,
  meetingProcessingUpdateBlockedRunConfigRequestSchema,
  meetingProcessingRunResponseSchema,
  type MeetingProcessingRecordingResult,
} from "../contracts/meetingProcessing.js";
import type { RemoteTranscriptionRequest, RemoteTranscriptionResult } from "../contracts/uploadTranscription.js";
import { parseDeepgramFileResponse } from "./deepgramFileTranscription.js";
import { parseElevenLabsFileResponse } from "./elevenLabsFileTranscription.js";
import { parseGeminiFileResponse } from "./geminiFileTranscription.js";
import { parseOpenAIFileResponse } from "./remoteTranscriptionIpcHandler.js";
import { meetingTranscriptArtifactSchema, meetingSummaryArtifactSchema } from "../contracts/meetingRecording.js";
import type { MeetingRecordingStorage } from "./meetingRecordingStorage.js";
import { matchZoomSpeakers } from "./zoomSpeakerMatcher.js";
import { composeMeetingAudioParts, meetingTimelineFrameCount, meetingSourceIntentionallyEmpty, prepareMeetingAudio, type MeetingAudioMixerDeps, type PreparedMeetingAudio, type MeetingAudioLayout } from "./meetingAudioMixer.js";
import { formatSpeakerTranscript, mergeSpeakersWithText } from "./speakerMerge.js";
import { byokFileSizeLimit } from "./transcriptionRoute.js";
import { supportedMeetingFileProvider } from "./meetingFileTranscription.js";
import { RECAP_KEY } from "./builtinActions.js";
import { requestMeetingJson, looksLikeRefusal } from "./meetingJsonRepair.js";
import {
  MEETING_TASKS_INSTRUCTION,
  readMeetingSummarySection,
  replaceMeetingRecap,
  replaceMeetingTasks,
  validateMeetingRecap,
  validateMeetingTasks,
  type MeetingRecap,
} from "./meetingSummarySections.js";

const AUTO_RETRY_LIMIT = 3;
const RETRY_BASE_SECONDS = 5;
const RETRY_MAX_SECONDS = 300;
const GEMINI_MAX_SECONDS = 30 * 60;

export interface MeetingProcessingDatabase {
  listAllMeetingRecordings(): MeetingRecordingDto[];
  listMeetingRecordingsForNote(noteId: number): MeetingRecordingDto[];
  listMeetingProcessingRuns(recordingId: string): MeetingProcessingRunDto[];
  listAllMeetingProcessingRuns(): MeetingProcessingRunDto[];
  getMeetingProcessingRun(id: string): MeetingProcessingRunDto | null;
  getMeetingRecording(id: string): MeetingRecordingDto | null;
  listMeetingRecordingEpochs(id: string): MeetingRecordingEpochDto[];
  listMeetingIntentionalIntervals(id: string): MeetingIntentionalInterval[];
  getNote(id: number): {
    title: string;
    content: string;
    transcript?: string | null;
    enhanced_content?: string | null;
    participants: string | null;
    expected_speaker_count?: number | null;
  } | null;
  createMeetingProcessingRun(recordingId: string, input: {
    kind: "reprocess" | "summary";
    sourceRecordingIds?: string[];
    config: MeetingProcessingConfig | null;
    configError?: { code: string; messageKey?: string } | null;
    sourceRunId?: string | null;
    retryAt?: string | null;
  }): MeetingProcessingRunDto;
  claimMeetingProcessingRun(id: string, now?: string): boolean;
  setMeetingProcessingRunState(id: string, update: {
    stage: "prepare" | "asr" | "normalize" | "summary";
    status: "pending" | "running" | "blocked" | "failed" | "cancelled" | "complete";
    errorCode?: string | null;
    retryAt?: string | null;
    retryCount?: number;
  }): { success: boolean };
  setMeetingRunArtifact(id: string, artifact: "provider-response" | "transcript" | "summary"): { success: boolean };
  retryMeetingProcessingRun(id: string): MeetingProcessingRunDto | null;
  updateBlockedMeetingRunConfig(
    id: string,
    config: MeetingProcessingConfig | null,
    error?: { code: string; messageKey?: string } | null
  ): MeetingProcessingRunDto | null;
  recoverRunningMeetingProcessingRuns(): number;
  getMeetingRunSpeakerCorrections(runId: string): MeetingSpeakerCorrection[];
  getMeetingRunSpeakerCorrectionRevision(runId: string): number;
  listMeetingZoomObservations: import("./database.js").DatabaseManager["listMeetingZoomObservations"];
  listMeetingAudioClockAnchors: import("./database.js").DatabaseManager["listMeetingAudioClockAnchors"];
  getMeetingPlatformCoverage: import("./database.js").DatabaseManager["getMeetingPlatformCoverage"];
  applyMeetingPlatformDecisions: import("./database.js").DatabaseManager["applyMeetingPlatformDecisions"];
  setMeetingRunSpeakerCorrection(runId: string, speakerId: string, profileId: number | null, displayName: string, source?: "voice" | "platform" | "model" | "user", participantEmail?: string): { success: boolean };
  getContactProfiles(emails: string[]): Array<{ email: string; display_name: string | null }>;
  rememberContactName(email: string, name: string): void;
  applyAutomaticMeetingSpeakerCorrections(runId: string, expectedCurrentRunId: string, expectedRevision: number, corrections: Array<{ speakerId: string; profileId: number | null; displayName: string }>, source: "voice" | "platform" | "model", rejectedModelSpeakerIds?: string[]): boolean;
  getMeetingRunLlmSourceSnapshot(runId: string): string | null;
  setMeetingRunLlmSourceSnapshot(runId: string, snapshotJson: string): boolean;
  applyMeetingGeneratedTitle(runId: string, noteId: number, expectedTitle: string | null, title: string, expectedSnapshotJson: string): boolean;
  updateMeetingRunLlmSourceSnapshot(runId: string, snapshotJson: string, expectedSnapshotJson: string): boolean;
  updateMeetingSummaryIfCurrent(input: {
    recordingId: string;
    runId: string;
    sourceRunId: string;
    expectedSnapshotJson: string;
    expectedSpeakerCorrectionRevision: number;
    expectedTitle: string | null;
    expectedManualNotes: string;
    expectedTranscript: string | null;
    expectedProjection: string | null;
    summary: string;
  }): boolean;
  setMeetingSpeakerNamingError(runId: string, errorCode: string | null): boolean;
  selectMeetingProcessingRun(
    recordingId: string,
    runId: string,
    projection: { transcript: string; summary: string | null; summaryPrompt: string | null } | null
  ): { success: boolean; noteId?: number };
}

export interface MeetingProcessingWorkerDeps {
  database: MeetingProcessingDatabase;
  storage: MeetingRecordingStorage;
  isCaptureActive: () => boolean;
  transcribeRemote: (
    request: RemoteTranscriptionRequest,
    onRawProviderResponse: (response: unknown) => Promise<void>,
    signal: AbortSignal
  ) => Promise<RemoteTranscriptionResult>;
  transcribeLocal: (path: string, options: {
    provider: string;
    model: string;
    language: string;
    requestId: string;
    signal: AbortSignal;
  }) => Promise<{ success: boolean; text?: string; error?: string; message?: string; code?: string }>;
  diarizeLocal: (path: string, options: {
    durationSeconds: number;
    expectedSpeakerCount: number | null;
    signal: AbortSignal;
  }) => Promise<Array<{ speaker: string; start: number; end: number }>>;
  summarize: (input: string, config: NonNullable<MeetingProcessingConfig["summary"]>, signal: AbortSignal) => Promise<string>;
  summarizeAgent?: (input: string, config: NonNullable<MeetingProcessingConfig["summary"]>, run: MeetingProcessingRunDto, signal: AbortSignal) => Promise<string>;
  getCredential: (reference: string | undefined, provider: string) => string;
  mixAudio?: (
    recording: MeetingRecordingDto,
    runId: string,
    epochs: MeetingRecordingEpochDto[],
    signal: AbortSignal,
    layout?: MeetingAudioLayout,
    intentionalEmptySources?: MeetingSource[]
  ) => Promise<PreparedMeetingAudio>;
  fileSize?: (path: string) => number;
  now?: () => Date;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  onChanged?: (recordingId: string, runId: string) => void;
  onNoteProjectionChanged?: (noteId: number) => void;
  recognizeSpeakers?: (
    recording: MeetingRecordingDto,
    run: MeetingProcessingRunDto,
    transcript: MeetingTranscriptArtifact,
    audioPath: string,
    signal: AbortSignal
  ) => Promise<Array<{ speakerId: string; profileId: number | null; displayName: string }>>;
  nameSpeakers?: (
    input: unknown,
    config: NonNullable<MeetingProcessingConfig["summary"]>,
    run: MeetingProcessingRunDto,
    signal: AbortSignal
  ) => Promise<{ speakers: Array<{ speakerId: string; name: string }>; title?: string | null }>;
  createActionConversation?: (
    config: NonNullable<MeetingProcessingConfig["summary"]>,
    instruction: string,
    run: MeetingProcessingRunDto,
    signal: AbortSignal
  ) => Promise<import("./meetingSummary.js").MeetingTextConversation>;
  getActionPrompt?: (translationKey: string) => string | null;
  mixerDeps?: MeetingAudioMixerDeps;
}

interface MeetingLlmSourceSnapshot {
  version: 1;
  sourceRunId: string;
  sourceRecordingIds: string[];
  meetingTitle: string | null;
  participants: Array<{ name: string | null; email: string | null }> | null;
  manualNotes: string;
  manualNoteRevision: string;
  speakerCorrectionRevision: number;
  transcriptSegments: Array<{ id: string; speakerId: string | null; speakerName: string | null; speakerNameSource?: "user" | "model" | "voice" | "platform" | null; text: string }>;
  promptModel: NonNullable<MeetingProcessingConfig["summary"]>;
}

const meetingLlmSourceSnapshotSchema = z.object({
  version: z.literal(1),
  sourceRunId: z.string().uuid(),
  sourceRecordingIds: z.array(z.string().uuid()).min(1),
  meetingTitle: z.string().nullable(),
  participants: z.array(z.object({ name: z.string().nullable(), email: z.string().nullable() }).strict()).nullable(),
  manualNotes: z.string(),
  manualNoteRevision: z.string().regex(/^[a-f0-9]{64}$/),
  speakerCorrectionRevision: z.number().int().nonnegative(),
  transcriptSegments: z.array(z.object({
    id: z.string().min(1),
    speakerId: z.string().nullable(),
    speakerName: z.string().nullable(),
    speakerNameSource: z.enum(["user", "model", "voice", "platform"]).nullable().optional(),
    text: z.string(),
  }).strict()).min(1),
  promptModel: meetingProcessingConfigSchema.shape.summary.unwrap().unwrap(),
}).strict();

interface ActiveRun {
  runId: string;
  stage: MeetingProcessingRunDto["stage"];
  mode: MeetingProcessingConfig["transcription"]["mode"] | "summary-local" | "summary-remote";
  controller: AbortController;
}

interface MeetingSummaryActionContext {
  run: MeetingProcessingRunDto;
  recording: MeetingRecordingDto;
  note: NonNullable<ReturnType<MeetingProcessingDatabase["getNote"]>>;
  sourceRunId: string;
  snapshotJson: string;
  snapshot: MeetingLlmSourceSnapshot;
  transcript: MeetingTranscriptArtifact;
  artifact: MeetingSummaryArtifact;
  markdown: string;
  actionItemsSection: string | null;
  recapSection: string | null;
}

export class MeetingProcessingWorker {
  private retentionReady = false;
  private captureActive = false;
  private active: ActiveRun | null = null;
  private work: Promise<void> | null = null;
  private workRequested = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly activeSummaryActions = new Map<string, Set<AbortController>>();
  private readonly activeTaskRuns = new Set<string>();
  private readonly backgroundSummaryActions = new Set<Promise<unknown>>();
  private readonly agentThreadActionTails = new Map<string, Promise<void>>();
  private readonly summaryMutationTails = new Map<number, Promise<void>>();
  private readonly now: () => Date;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;

  constructor(private readonly deps: MeetingProcessingWorkerDeps) {
    deps.database.recoverRunningMeetingProcessingRuns();
    this.now = deps.now ?? (() => new Date());
    this.setTimer = deps.setTimeout ?? setTimeout;
    this.clearTimer = deps.clearTimeout ?? clearTimeout;
    this.recoverInterruptedSummaryTasks();
  }

  onRetentionReady(): void {
    this.retentionReady = true;
    this.processPending();
  }

  captureStarted(noteId?: number): void {
    this.captureActive = true;
    if (noteId !== undefined) {
      for (const run of this.deps.database.listAllMeetingProcessingRuns()) {
        const recording = this.deps.database.getMeetingRecording(run.recordingId);
        if (
          recording?.noteId === noteId &&
          run.kind !== "summary" &&
          (run.status === "pending" || run.status === "running") &&
          (run.stage === "prepare" || run.stage === "asr") &&
          !run.hasRawProviderResponse
        ) {
          this.cancelRun(run.id, "meeting-resumed");
        }
      }
    }
    if (
      this.active?.stage === "prepare" ||
      (this.active?.stage === "asr" && this.active.mode === "local") ||
      this.active?.stage === "normalize" ||
      (this.active?.stage === "summary" && this.active.mode === "summary-local")
    ) {
      this.active.controller.abort();
    }
    this.clearRetryTimer();
  }

  captureStopped(): void {
    this.captureActive = false;
    this.processPending();
  }

  stop(): void {
    this.stopped = true;
    this.clearRetryTimer();
    this.active?.controller.abort();
    for (const controllers of this.activeSummaryActions.values()) {
      for (const controller of controllers) controller.abort();
    }
  }

  cancelRun(runId: string, errorCode = "processing-cancelled"): boolean {
    const run = this.deps.database.getMeetingProcessingRun(runId);
    if (!run || (run.status !== "pending" && run.status !== "running")) return false;
    if (this.active?.runId === runId) this.active.controller.abort();
    return this.deps.database.setMeetingProcessingRunState(runId, {
      stage: this.active?.runId === runId ? this.active.stage : "prepare",
      status: "cancelled",
      errorCode,
      retryAt: null,
    }).success;
  }

  async cancelRecordingForDeletion(recordingId: string, includeNonAudio = false): Promise<void> {
    for (const run of this.deps.database.listAllMeetingProcessingRuns().filter((item) => item.sourceRecordingIds.includes(recordingId))) {
      const needsAudio = run.stage === "prepare" || run.stage === "asr" ||
        (run.stage === "normalize" && run.config?.transcription.mode === "local");
      const mustCancel = includeNonAudio || needsAudio;
      if (this.active?.runId === run.id && mustCancel) this.active.controller.abort();
      if ((run.status === "pending" || run.status === "running") && mustCancel) {
        this.deps.database.setMeetingProcessingRunState(run.id, {
          stage: run.stage,
          status: "cancelled",
          errorCode: includeNonAudio ? "note-deletion-requested" : "audio-deletion-requested",
          retryAt: null,
        });
      }
    }
    await this.work;
  }

  setSpeakerCorrection(input: z.infer<typeof meetingProcessingSpeakerCorrectionRequestSchema>): boolean {
    const run = this.deps.database.getMeetingProcessingRun(input.runId);
    if (!run) return false;
    const transcriptRunId = run.kind === "summary" ? run.sourceRunId : run.id;
    if (!transcriptRunId) return false;
    const transcript = this.readTranscript(transcriptRunId);
    if (!transcript?.segments?.some((segment) => segment.speaker === input.speakerId)) return false;
    if (input.participantEmail) {
      const recording = this.deps.database.getMeetingRecording(run.recordingId);
      const note = recording && this.deps.database.getNote(recording.noteId);
      if (!note || !participantCandidates(note.participants).some((person) => person.email?.toLowerCase() === input.participantEmail?.toLowerCase())) return false;
    }
    const updated = this.deps.database.setMeetingRunSpeakerCorrection(
      transcriptRunId,
      input.speakerId,
      input.profileId,
      input.displayName,
      "user",
      input.participantEmail
    );
    if (!updated.success) return false;
    const recording = this.deps.database.getMeetingRecording(run.recordingId);
    if (recording?.currentRunId === run.id || recording?.currentRunId === transcriptRunId) {
      const currentRunId = recording.currentRunId;
      if (currentRunId) this.publishCurrentSelection(currentRunId);
      this.deps.onNoteProjectionChanged?.(recording.noteId);
    }
    this.notify(run);
    return true;
  }

  async runSummaryAction(input: { runId: string; action: "tasks" | "recap" }): Promise<{ success: boolean; error?: string }> {
    const operation = () => input.action === "tasks"
      ? this.runPrioritizedTasks(input.runId)
      : this.runRecap(input.runId);
    const run = this.deps.database.getMeetingProcessingRun(input.runId);
    const threadKey = run?.config?.summary?.reasoningMode === "agent" ? run.id : null;
    return threadKey ? this.withAgentThreadAction(threadKey, operation) : operation();
  }

  retry(runId: string): MeetingProcessingResultDto | null {
    const run = this.deps.database.retryMeetingProcessingRun(runId);
    if (!run) return null;
    const result = this.getResult(run);
    this.notify(run);
    this.processPending();
    return result;
  }

  updateBlockedRunConfig(input: unknown): MeetingProcessingResultDto | null {
    const parsed = meetingProcessingUpdateBlockedRunConfigRequestSchema.parse(input);
    const current = this.deps.database.getMeetingProcessingRun(parsed.runId);
    const noArtifacts = current &&
      !current.hasRawProviderResponse &&
      !current.hasTranscript &&
      !current.hasSummary &&
      !this.deps.storage.hasRunArtifact(current.id, "provider-response") &&
      !this.deps.storage.hasRunArtifact(current.id, "provider-response-mic") &&
      !this.deps.storage.hasRunArtifact(current.id, "provider-response-system") &&
      !this.deps.storage.hasRunArtifact(current.id, "transcript") &&
      !this.deps.storage.hasRunArtifact(current.id, "summary");
    const summaryOnlyCorrection = current &&
      current.stage === "summary" &&
      current.errorCode === "missing-summary-config" &&
      current.hasRawProviderResponse &&
      current.hasTranscript &&
      !current.hasSummary &&
      this.deps.storage.hasRunArtifact(current.id, "provider-response") &&
      this.deps.storage.hasRunArtifact(current.id, "transcript");
    if (
      !current ||
      current.status !== "blocked" ||
      current.kind === "summary" ||
      (!noArtifacts && !summaryOnlyCorrection)
    ) return null;
    const run = this.deps.database.updateBlockedMeetingRunConfig(
      parsed.runId,
      parsed.config,
      parsed.configError
    );
    if (!run) return null;
    const result = this.getResult(run);
    this.notify(run);
    this.processPending();
    return result;
  }

  createRun(input: unknown): MeetingProcessingResultDto {
    const parsed = meetingProcessingCreateRunRequestSchema.parse(input);
    if (parsed.gateAfterStop && parsed.kind !== "reprocess") {
      throw new Error("Only end-of-meeting transcription can use the processing gate");
    }
    const recording = this.deps.database.getMeetingRecording(parsed.recordingId);
    if (!recording) throw new Error("Meeting recording not found");
    const sourceRecordingIds = parsed.gateAfterStop
      ? this.deps.database.listMeetingRecordingsForNote(recording.noteId)
        .filter((part) => part.audioState === "available" && ["ready", "incomplete"].includes(part.captureState) && part.captureErrorCode !== "recording-audio-unavailable")
        .map((part) => part.id)
      : parsed.sourceRecordingIds ?? [parsed.recordingId];
    const orderedSourceIds = sourceRecordingIds.map((id) => {
      const source = this.deps.database.getMeetingRecording(id);
      if (!source || source.noteId !== recording.noteId) throw new Error("Meeting audio is unavailable for a selected part");
      return source;
    }).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id)).map((part) => part.id);
    if (parsed.kind === "reprocess" && !parsed.gateAfterStop && this.isCapturing()) {
      throw new Error("Transcription starts after the end-of-meeting wait");
    }
    const sameSources = (run: MeetingProcessingRunDto) =>
      run.sourceRecordingIds.length === sourceRecordingIds.length &&
      run.sourceRecordingIds.every((id, index) => id === orderedSourceIds[index]);
    const activeGate = this.deps.database.listAllMeetingProcessingRuns().find((run) =>
      this.isEndOfMeetingGate(run) &&
      (run.status === "pending" || run.status === "running" || run.status === "blocked") &&
      run.sourceRecordingIds.some((id) => sourceRecordingIds.includes(id))
    );
    if (activeGate && sameSources(activeGate) && (parsed.gateAfterStop || Date.parse(activeGate.retryAt as string) > this.now().getTime())) {
      const result = this.getResult(activeGate);
      this.notify(activeGate);
      return result;
    }
    if (activeGate && Date.parse(activeGate.retryAt as string) > this.now().getTime() && !parsed.gateAfterStop) {
      throw new Error("Transcription starts after the end-of-meeting wait");
    }
    if (parsed.kind === "reprocess" && !parsed.gateAfterStop) {
      const latestStop = sourceRecordingIds
        .map((id) => this.deps.database.getMeetingRecording(id)?.endedAt)
        .filter((value): value is string => value !== null && value !== undefined)
        .map(Date.parse)
        .filter(Number.isFinite)
        .reduce((latest, value) => Math.max(latest, value), 0);
      if (latestStop > 0 && this.now().getTime() < latestStop + MEETING_ASR_GATE_MS) {
        throw new Error("Transcription starts after the end-of-meeting wait");
      }
    }
    if (parsed.gateAfterStop) {
      const existing = this.deps.database.listMeetingProcessingRuns(parsed.recordingId).find((run) =>
        run.kind === "reprocess" &&
        run.status !== "cancelled" &&
        sameSources(run)
      );
      if (existing) {
        const result = this.getResult(existing);
        this.notify(existing);
        return result;
      }
    }
    if (parsed.kind === "summary" && parsed.sourceRunId) {
      const autoSummary = this.deps.database.listAllMeetingProcessingRuns().find((run) =>
        run.recordingId === parsed.recordingId &&
        run.id === parsed.sourceRunId &&
        run.kind !== "summary" && run.stage === "summary" &&
        (run.status === "pending" || run.status === "running")
      );
      if (autoSummary) this.cancelRun(autoSummary.id, "manual-summary-requested");
      const activeSummary = this.deps.database.listAllMeetingProcessingRuns().find((run) =>
        run.recordingId === parsed.recordingId &&
        run.kind === "summary" && run.sourceRunId === parsed.sourceRunId &&
        (run.status === "pending" || run.status === "running")
      );
      if (activeSummary) {
        const result = this.getResult(activeSummary);
        this.notify(activeSummary);
        return result;
      }
    }
    const run = this.deps.database.createMeetingProcessingRun(parsed.kind === "reprocess" ? orderedSourceIds[0] : parsed.recordingId, {
      kind: parsed.kind,
      sourceRecordingIds: orderedSourceIds,
      config: parsed.config,
      configError: parsed.configError ?? null,
      sourceRunId: parsed.sourceRunId ?? null,
      retryAt: parsed.gateAfterStop ? new Date(this.now().getTime() + MEETING_ASR_GATE_MS).toISOString() : null,
    });
    const result = this.getResult(run);
    this.notify(run);
    this.processPending();
    return result;
  }

  listForNote(noteId: number): MeetingProcessingRecordingResult[] {
    const request = meetingProcessingListRequestSchema.parse({ noteId });
    return this.deps.database.listMeetingRecordingsForNote(request.noteId).map((recording) => {
      const runs = this.deps.database.listMeetingProcessingRuns(recording.id).map((run) => this.getResult(run));
      return {
        recording: {
          id: recording.id,
          groupId: recording.groupId,
          captureState: recording.captureState,
          captureErrorCode: recording.captureErrorCode,
          platformCoverage: this.deps.database.getMeetingPlatformCoverage(recording.id) ?? null,
          audioState: recording.audioState,
          audioErrorCode: recording.audioErrorCode,
          currentRunId: recording.currentRunId,
          startedAt: recording.startedAt,
          endedAt: recording.endedAt,
          durationSeconds: recording.endedAt ? meetingTimelineFrameCount(recording, this.deps.database.listMeetingRecordingEpochs(recording.id)) / 24_000 : null,
        },
        runs,
      };
    });
  }

  processPending(): void {
    if (this.stopped || !this.retentionReady) return;
    if (this.work) {
      this.workRequested = true;
      return;
    }
    this.clearRetryTimer();
    this.work = this.drainQueue().finally(() => {
      this.work = null;
      if (this.workRequested) {
        this.workRequested = false;
        this.processPending();
      } else {
        this.scheduleRetryTimer();
      }
    });
  }

  async waitForIdle(): Promise<void> {
    while (this.work || this.backgroundSummaryActions.size > 0) {
      const pending = [this.work, ...this.backgroundSummaryActions].filter(
        (work): work is Promise<unknown> => work !== null
      );
      await Promise.all(pending);
    }
  }

  private async drainQueue(): Promise<void> {
    while (!this.stopped && this.retentionReady && !this.isCapturing()) {
      const now = this.now().toISOString();
      const pending = this.deps.database.listAllMeetingProcessingRuns()
        .filter((run) => run.status === "pending" && (!run.retryAt || Date.parse(run.retryAt) <= Date.parse(now)))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      let claimed: { id: string; endOfMeetingGate: boolean } | null = null;
      for (const candidate of pending) {
        const endOfMeetingGate = this.isEndOfMeetingGate(candidate);
        if (endOfMeetingGate && !this.isCurrentNoteAudioVersion(candidate)) {
          this.cancelRun(candidate.id, "meeting-audio-changed");
          continue;
        }
        if (this.deps.database.claimMeetingProcessingRun(candidate.id, now)) {
          claimed = { id: candidate.id, endOfMeetingGate };
          break;
        }
      }
      if (!claimed) return;
      await this.processClaimedRun(claimed.id, claimed.endOfMeetingGate);
    }
  }

  private async processClaimedRun(runId: string, endOfMeetingGate: boolean): Promise<void> {
    const run = this.deps.database.getMeetingProcessingRun(runId);
    if (!run || run.status !== "running") return;
    const recording = this.deps.database.getMeetingRecording(run.recordingId);
    if (!recording) return;
    if (endOfMeetingGate && (!this.isCurrentNoteAudioVersion(run) || this.isCapturing())) {
      this.cancelRun(runId, "meeting-audio-changed");
      return;
    }
    const config = run.config;
    const mode = run.stage === "summary"
      ? config?.summary?.reasoningMode === "local" ? "summary-local" : "summary-remote"
      : config?.transcription.mode ?? "providers";
    const active: ActiveRun = { runId, stage: run.stage, mode, controller: new AbortController() };
    this.active = active;
    try {
      if (run.stage === "prepare") {
        await this.prepare(run, recording, active.controller.signal, endOfMeetingGate);
      } else if (run.stage === "asr") {
        await this.transcribe(run, recording, active.controller.signal, endOfMeetingGate);
      } else if (run.stage === "normalize") {
        await this.normalize(run, recording, active.controller.signal);
      } else {
        await this.summarize(run, recording, active.controller.signal);
      }
    } catch (error) {
      this.handleFailure(runId, run.stage, error);
    } finally {
      if (this.active === active) this.active = null;
      const current = this.deps.database.getMeetingProcessingRun(runId);
      if (current && (run.stage === "normalize" || run.stage === "summary" || current.status !== "pending" || this.isCapturing())) {
        try { this.deps.storage.removeDerivedAudio(recording.id, run.id); }
        catch (error) { this.handleFailure(runId, run.stage, error); }
      }
      if (current) this.notify(current);
    }
  }

  private async prepare(run: MeetingProcessingRunDto, recording: MeetingRecordingDto, signal: AbortSignal, endOfMeetingGate: boolean): Promise<void> {
    if (endOfMeetingGate && !this.isCurrentNoteAudioVersion(run)) {
      this.cancelRun(run.id, "meeting-audio-changed");
      return;
    }
    if (this.isCapturing()) return this.pause(run, "prepare");
    const config = this.requireConfig(run);
    const provider = config.transcription.mode === "local" ? null : supportedMeetingFileProvider(config.transcription.provider, config.transcription.model);
    if (config.transcription.mode === "providers" && !provider) {
      throw new MeetingProcessingFailure("unsupported-provider", "blocked");
    }
    const { timeline, epochs, intentionalIntervals } = this.sourceTimeline(run, recording, true);
    const intentionalEmptySources = this.intentionalEmptySources(timeline, epochs, intentionalIntervals);
    const layouts: MeetingAudioLayout[] = provider === "deepgram" ? ["stereo"] : provider ? ["mic", "system"] : ["mono"];
    const audios: PreparedMeetingAudio[] = [];
    for (const layout of layouts) {
      audios.push(await (this.deps.mixAudio
        ? this.deps.mixAudio(timeline, run.id, epochs, signal, layout, intentionalEmptySources)
        : prepareMeetingAudio(this.deps.storage, timeline, run.id, epochs, { signal, deps: this.deps.mixerDeps, layout, intentionalEmptySources })));
    }
    const audio = audios[0];
    signal.throwIfAborted();
    if (endOfMeetingGate && !this.isCurrentNoteAudioVersion(run)) {
      this.cancelRun(run.id, "meeting-audio-changed");
      return;
    }
    if (this.isCapturing()) return this.pause(run, "asr");
    if (provider && audios.some((value) => value.sizeBytes > byokFileSizeLimit(provider))) {
      throw new MeetingProcessingFailure("provider-limit", "blocked");
    }
    if (provider === "gemini" && audio.durationSeconds > GEMINI_MAX_SECONDS) {
      throw new MeetingProcessingFailure("gemini-duration-limit", "blocked");
    }
    this.setState(run.id, "asr", "pending", null, endOfMeetingGate ? run.retryAt : null);
  }

  private async ensureAudio(run: MeetingProcessingRunDto, recording: MeetingRecordingDto, layout: MeetingAudioLayout, signal: AbortSignal): Promise<void> {
    const filePath = this.deps.storage.getDerivedAudioPath(recording.id, run.id, layout);
    try {
      if ((this.deps.fileSize ?? ((p) => fs.statSync(p).size))(filePath) > 0) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const { timeline, epochs, intentionalIntervals } = this.sourceTimeline(run, recording);
    const intentionalEmptySources = this.intentionalEmptySources(timeline, epochs, intentionalIntervals);
    await (this.deps.mixAudio
      ? this.deps.mixAudio(timeline, run.id, epochs, signal, layout, intentionalEmptySources)
      : prepareMeetingAudio(this.deps.storage, timeline, run.id, epochs, { signal, deps: this.deps.mixerDeps, layout, intentionalEmptySources }));
  }

  private async transcribe(run: MeetingProcessingRunDto, recording: MeetingRecordingDto, signal: AbortSignal, endOfMeetingGate: boolean): Promise<void> {
    const current = this.requireCurrentRun(run.id);
    if (current.hasRawProviderResponse) return this.setState(run.id, "normalize", "pending", null, null);
    if (endOfMeetingGate && !this.isCurrentNoteAudioVersion(current)) {
      this.cancelRun(run.id, "meeting-audio-changed");
      return;
    }
    if (this.isCapturing()) return this.pause(run, "asr");
    if (current.retryCount > AUTO_RETRY_LIMIT) {
      this.setState(run.id, "asr", "failed", current.errorCode ?? "asr-outcome-unknown", null);
      return;
    }
    if (recording.audioState !== "available") throw new MeetingProcessingFailure("audio-unavailable", "blocked");
    const config = this.requireConfig(run).transcription;
    const { timeline, epochs, intentionalIntervals } = this.sourceTimeline(run, recording);
    const intentionalEmptySources = this.intentionalEmptySources(timeline, epochs, intentionalIntervals);
    const layouts: MeetingAudioLayout[] = config.mode === "local" ? ["mono"] : config.provider === "deepgram" ? ["stereo"] : ["mic", "system"];
    for (const layout of layouts) await this.ensureAudio(run, recording, layout, signal);
    const audioPath = this.deps.storage.getDerivedAudioPath(recording.id, run.id, layouts[layouts.length - 1]);
    const fileSize = (this.deps.fileSize ?? ((filePath) => fs.statSync(filePath).size))(audioPath);
    const requestId = `meeting-${run.id}`;
    if (config.mode === "local") {
      const local = config.local;
      if (!local) throw new MeetingProcessingFailure("local-route-unsupported", "blocked");
      const result = await this.deps.transcribeLocal(audioPath, {
        provider: local.provider,
        model: local.model,
        language: config.language,
        requestId,
        signal,
      });
      if (!result.success) {
        const cancelled = result.code === "UPLOAD_CANCELLED";
        throw new MeetingProcessingFailure(
          result.code || "local-transcription-failed",
          cancelled ? "cancelled" : "failed",
          result.error || result.message
        );
      }
      this.saveRawResponse(run.id, result);
      this.setState(run.id, "normalize", "pending", null, null);
      return;
    }
    const provider = supportedMeetingFileProvider(config.provider, config.model);
    if (!provider) throw new MeetingProcessingFailure("unsupported-provider", "blocked");
    if (fileSize > byokFileSizeLimit(provider)) throw new MeetingProcessingFailure("provider-limit", "blocked");
    if (provider === "gemini" && timelineDuration(timeline, epochs) > GEMINI_MAX_SECONDS) {
      throw new MeetingProcessingFailure("gemini-duration-limit", "blocked");
    }
    const apiKey = this.deps.getCredential(config.credentialRef, provider);
    if (!apiKey) throw new MeetingProcessingFailure("api-key-missing", "blocked");
    const request: RemoteTranscriptionRequest = {
      filePath: audioPath,
      apiKey,
      provider,
      model: providerModel(config.model, provider),
      language: config.language === "auto" ? undefined : config.language,
      diarize: true,
      ...(provider === "deepgram" ? { multichannel: true } : {}),
      transcriptionMode: "providers",
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      requestId,
    };
    if (endOfMeetingGate && (!this.isCurrentNoteAudioVersion(current) || this.isCapturing())) {
      this.cancelRun(run.id, "meeting-audio-changed");
      return;
    }
    let result: RemoteTranscriptionResult;
    if (provider === "deepgram") {
      result = await this.deps.transcribeRemote(request, async (response) => this.saveRawResponse(run.id, response), signal);
    } else {
      // Each completed source is durable before normalization; retries only pay for the missing source.
      const outcomes = await Promise.allSettled((["mic", "system"] as const).map(async (source) => {
        if (source === "mic" && intentionalEmptySources.includes("mic")) return;
        const artifact = source === "mic" ? "provider-response-mic" : "provider-response-system";
        if (this.deps.storage.hasRunArtifact(run.id, artifact)) return;
        const filePath = this.deps.storage.getDerivedAudioPath(recording.id, run.id, source);
        if ((this.deps.fileSize ?? ((p) => fs.statSync(p).size))(filePath) > byokFileSizeLimit(provider)) {
          throw new MeetingProcessingFailure("provider-limit", "blocked");
        }
        const response = await this.deps.transcribeRemote({
          ...request, filePath, requestId: `${requestId}-${source}`,
          diarize: source === "system", timestamps: true,
          // Whisper supplies segment timestamps without diarization; GPT-4o plain ASR does not.
          model: provider === "openai" && source === "mic" ? "whisper-1" : request.model,
        }, async (raw) => {
          signal.throwIfAborted();
          const current = this.deps.database.getMeetingProcessingRun(run.id);
          if (current?.status !== "running" || current.stage !== "asr" || this.deps.database.getMeetingRecording(recording.id)?.audioState !== "available") {
            throw new MeetingProcessingFailure("stale-provider-response", "cancelled");
          }
          this.deps.storage.writeRunArtifact(run.id, artifact, raw);
        }, signal);
        if (!this.deps.storage.hasRunArtifact(run.id, artifact)) throw providerFailure(response);
      }));
      signal.throwIfAborted();
      const failed = outcomes.find((outcome) => outcome.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      const micResponse = intentionalEmptySources.includes("mic")
        ? { type: "intentional-empty", source: "mic" }
        : this.deps.storage.readRunArtifact(run.id, "provider-response-mic");
      this.saveRawResponse(run.id, {
        mic: micResponse,
        system: this.deps.storage.readRunArtifact(run.id, "provider-response-system"),
      });
      result = { success: true };
    }
    const after = this.deps.database.getMeetingProcessingRun(run.id);
    if (!after || after.status !== "running") return;
    if (after.hasRawProviderResponse) {
      this.setState(run.id, "normalize", "pending", null, null);
      return;
    }
    throw providerFailure(result);
  }

  private async normalize(run: MeetingProcessingRunDto, recording: MeetingRecordingDto, signal: AbortSignal): Promise<void> {
    const current = this.requireCurrentRun(run.id);
    if (current.hasTranscript) {
      const transcript = this.readTranscript(run.id);
      if (transcript?.text.trim()) await this.continueReadyTranscript(run, recording, transcript, signal);
      else this.setState(run.id, "summary", "complete", null, null);
      return;
    }
    if (this.isCapturing()) return this.pause(run, "normalize");
    const config = this.requireConfig(run).transcription;
    const raw = this.deps.storage.readRunArtifact(run.id, "provider-response");
    if (raw === null) throw new MeetingProcessingFailure("provider-response-missing", "failed");
    const { timeline, epochs } = this.sourceTimeline(run, recording);
    const recordingDuration = timelineDuration(timeline, epochs);
    let result: RemoteTranscriptionResult;
    if (config.mode === "local") {
      result = normalizeLocalResponse(raw);
      if (result.success && result.text?.trim() && config.local?.options?.diarize !== false) {
        if (this.isCapturing()) return this.pause(run, "normalize");
        const audioPath = this.deps.storage.getDerivedAudioPath(recording.id, run.id);
        await this.ensureAudio(run, recording, "mono", signal);
        const note = this.deps.database.getNote(recording.noteId);
        const diarization = await this.deps.diarizeLocal(audioPath, {
          durationSeconds: recordingDuration,
          expectedSpeakerCount: note?.expected_speaker_count ?? null,
          signal,
        });
        signal.throwIfAborted();
        if (!diarization.length) throw new MeetingProcessingFailure("local-diarization-unavailable", "blocked");
        const segments = mergeSpeakersWithText(diarization, result.text || "", recordingDuration);
        result = { ...result, text: formatSpeakerTranscript(segments), diarized: true, segments };
      }
    } else {
      const provider = supportedMeetingFileProvider(config.provider, config.model);
      if (!provider) throw new MeetingProcessingFailure("unsupported-provider", "blocked");
      if (provider === "deepgram") {
        result = parseDeepgramFileResponse(raw, true, true, recordingDuration);
      } else {
        const sources = z.object({ mic: z.unknown(), system: z.unknown() }).parse(raw);
        const intentionalEmptyMic = z.object({
          type: z.literal("intentional-empty"),
          source: z.literal("mic"),
        }).safeParse(sources.mic).success;
        const mic = intentionalEmptyMic
          ? { success: true as const, text: "", segments: [] }
          : normalizeProviderResponse(provider, sources.mic, false);
        const system = normalizeProviderResponse(provider, sources.system, true);
        for (const source of [mic, system]) {
          if (!source.success || typeof source.text !== "string" || (source.text.trim() && !source.segments?.length)) {
            throw new MeetingProcessingFailure(source.code || "provider-timestamps-missing", "failed");
          }
        }
        const segments = [
          ...(mic.segments ?? []).map((segment) => ({ ...segment, speaker: "mic" })),
          ...(system.segments ?? []).map((segment) => ({ ...segment, speaker: `system:${segment.speaker}` })),
        ].sort((a, b) => a.start - b.start);
        result = { success: true, text: formatSpeakerTranscript(segments), segments, diarized: true };
      }
    }
    if (!result.success || typeof result.text !== "string") {
      throw new MeetingProcessingFailure(result.code || "provider-response-invalid", "failed", result.error);
    }
    const transcript = validateTranscript(result, recordingDuration, config.mode === "providers" && !!result.text.trim());
    if (transcript.segments?.some((segment) => segment.speaker === "mic") &&
        !this.deps.database.getMeetingRunSpeakerCorrections(run.id).some((item) => item.speakerId === "mic")) {
      const saved = this.deps.database.setMeetingRunSpeakerCorrection(run.id, "mic", null, run.config?.selfDisplayName?.trim() || "You", "user");
      if (!saved.success) throw new MeetingProcessingFailure("self-name-not-saved", "failed");
    }
    this.deps.storage.writeRunArtifact(run.id, "transcript", transcript);
    if (!this.deps.database.setMeetingRunArtifact(run.id, "transcript").success) {
      this.deps.storage.removeRunArtifact(run.id, "transcript");
      throw new MeetingProcessingFailure("transcript-state-not-saved", "failed");
    }
    if (this.deps.recognizeSpeakers && recording.audioState === "available" && transcript.segments?.length) {
      const layout = config.mode === "local" ? "mono" : "system";
      const audioPath = this.deps.storage.getDerivedAudioPath(recording.id, run.id, layout);
      await this.ensureAudio(run, recording, layout, signal);
      const recognitionTranscript = { ...transcript, segments: transcript.segments.filter((segment) => segment.speaker !== "mic") };
      const recognized = await this.deps.recognizeSpeakers(recording, run, recognitionTranscript, audioPath, signal);
      signal.throwIfAborted();
      const assigned = new Set(this.deps.database.getMeetingRunSpeakerCorrections(run.id).map((item) => item.speakerId));
      const candidates = recognized.filter((item) => {
        if (assigned.has(item.speakerId)) return false;
        assigned.add(item.speakerId);
        return true;
      });
      if (candidates.length) {
        const revision = this.deps.database.getMeetingRunSpeakerCorrectionRevision(run.id);
        if (this.deps.database.applyAutomaticMeetingSpeakerCorrections(
          run.id,
          run.id,
          revision,
          candidates.map(({ speakerId, profileId, displayName }) => ({ speakerId, profileId, displayName })),
          "voice"
        )) this.publishCurrentSelection(run.id);
      }
    }
    this.publishCurrentSelection(run.id);
    if (!transcript.text.trim()) this.setState(run.id, "summary", "complete", null, null);
    else await this.continueReadyTranscript(run, recording, transcript, signal);
  }

  private applyPlatformNames(run: MeetingProcessingRunDto, recording: MeetingRecordingDto, transcript: MeetingTranscriptArtifact): void {
    const database = this.deps.database;
    try {
      const parts = run.sourceRecordingIds.map((id) => database.getMeetingRecording(id)).filter((part): part is MeetingRecordingDto => !!part);
      if (parts.length !== run.sourceRecordingIds.length) return;
      const { partOffsets, epochs } = composeMeetingAudioParts(parts, (id) => database.listMeetingRecordingEpochs(id));
      const observations = run.sourceRecordingIds.flatMap((id) => database.listMeetingZoomObservations(id));
      if (!observations.length) return;
      const anchors = run.sourceRecordingIds.flatMap((id) => database.listMeetingAudioClockAnchors(id));
      const decisions = matchZoomSpeakers({ transcript, observations, anchors, epochs, partOffsets });
      const revision = database.getMeetingRunSpeakerCorrectionRevision(run.id);
      if (database.applyMeetingPlatformDecisions(run.id, revision, decisions)) this.publishCurrentSelection(run.id);
    } catch {
      // Evidence is optional. Its failure cannot discard a saved transcript or
      // block voice recognition/model naming/Summary; never log names here.
      debugLogger.warn("Meeting platform evidence unavailable", { recordingId: recording.id }, "meeting");
    }
  }

  private async continueReadyTranscript(
    run: MeetingProcessingRunDto,
    recording: MeetingRecordingDto,
    transcript: MeetingTranscriptArtifact,
    signal: AbortSignal
  ): Promise<void> {
    const current = this.requireCurrentRun(run.id);
    if (current.hasSummary) return this.setState(run.id, "summary", "complete", null, null);
    if (this.isCapturing()) return this.pause(run, "normalize");
    const config = this.requireConfig(run);
    const sourceRunId = run.kind === "summary" ? run.sourceRunId : run.id;
    if (!sourceRunId) throw new MeetingProcessingFailure("summary-transcript-missing", "blocked");
    if (!this.isSelectedRun(run)) {
      this.cancelRun(run.id, "processing-run-stale");
      return;
    }
    if (run.kind === "initial" && !this.isCurrentNoteAudioVersion(run)) {
      this.cancelRun(run.id, "meeting-audio-changed");
      return;
    }
    if (run.kind !== "summary") this.applyPlatformNames(run, recording, transcript);
    if (config.summary) {
      const snapshot = this.getOrCreateLlmSourceSnapshot(run, recording, sourceRunId, transcript);
      await this.nameUnknownSpeakers(run, recording, sourceRunId, transcript, snapshot, signal);
    }
    if (signal.aborted || this.isCapturing()) return this.pause(run, "normalize");
    if (!this.isSelectedRun(run) || (run.kind === "initial" && !this.isCurrentNoteAudioVersion(run))) {
      this.cancelRun(run.id, "processing-run-stale");
      return;
    }
    if (config.generateSummary === false) return this.setState(run.id, "summary", "complete", null, null);
    if (!config.summary) return this.setState(run.id, "summary", "blocked", "missing-summary-config", null);
    this.setState(run.id, "summary", "pending", null, null);
  }

  private async summarize(run: MeetingProcessingRunDto, recording: MeetingRecordingDto, signal: AbortSignal): Promise<void> {
    const current = this.requireCurrentRun(run.id);
    if (current.hasSummary) return this.setState(run.id, "summary", "complete", null, null);
    if (this.isCapturing()) return this.pause(run, "summary");
    const config = this.requireConfig(run);
    const sourceRunId = run.kind === "summary" ? run.sourceRunId : run.id;
    if (!sourceRunId) throw new MeetingProcessingFailure("summary-transcript-missing", "blocked");
    const transcript = this.readTranscript(sourceRunId);
    if (!transcript) throw new MeetingProcessingFailure("summary-transcript-missing", "blocked");
    if (!transcript.text.trim()) return this.setState(run.id, "summary", "complete", null, null);
    if (config.generateSummary === false && run.kind !== "summary") return this.setState(run.id, "summary", "complete", null, null);
    if (!config.summary) throw new MeetingProcessingFailure("missing-summary-config", "blocked");
    if (!this.isSelectedRun(run)) {
      this.cancelRun(run.id, "processing-run-stale");
      return;
    }
    if (run.kind === "initial" && !this.isCurrentNoteAudioVersion(run)) {
      this.cancelRun(run.id, "meeting-audio-changed");
      return;
    }

    const snapshot = this.refreshLlmSnapshotSpeakerState(
      run.id,
      sourceRunId,
      transcript,
      this.getOrCreateLlmSourceSnapshot(run, recording, sourceRunId, transcript)
    );
    const note = this.deps.database.getNote(recording.noteId);
    if (!note || hashText(note.content) !== snapshot.manualNoteRevision || note.title !== snapshot.meetingTitle) {
      throw new MeetingProcessingFailure("summary-source-changed", "failed");
    }

    if (run.kind !== "summary") {
      const sourceIds = [...run.sourceRecordingIds].sort();
      const previousRuns = this.deps.database.listAllMeetingProcessingRuns().filter((candidate) =>
        candidate.id !== run.id && candidate.sourceRecordingIds.length === sourceIds.length &&
        [...candidate.sourceRecordingIds].sort().every((id, index) => id === sourceIds[index])
      );
      // Stop also creates a reprocess run for grouped audio. Only an actual retranscription bypasses the first-Summary threshold.
      const retranscription = run.kind === "reprocess" && previousRuns.some((candidate) => candidate.hasTranscript);
      if (config.generateSummary !== true && !retranscription && !this.isAutoSummaryEligible(run, recording, transcript)) {
        this.setState(run.id, "summary", "complete", null, null);
        return;
      }
      if (run.kind === "initial" && previousRuns.some((candidate) => candidate.hasSummary ||
        (candidate.kind === "summary" && (candidate.status === "pending" || candidate.status === "running")))) {
        this.setState(run.id, "summary", "complete", null, null);
        return;
      }
    }

    const input = formatMeetingMaterial({
      meetingTitle: snapshot.meetingTitle,
      manualNotes: snapshot.manualNotes,
      transcriptSegments: this.promptSegments(snapshot, transcript),
      transcriptSourceId: snapshot.sourceRunId,
    });
    const summaryConfig = snapshot.promptModel;
    const currentRun = this.deps.database.getMeetingProcessingRun(run.id) ?? run;
    const generated = summaryConfig.reasoningMode === "agent"
      ? await this.deps.summarizeAgent?.(input, summaryConfig, currentRun, signal)
      : await this.deps.summarize(input, summaryConfig, signal);
    if (generated === undefined) throw new MeetingProcessingFailure("bb-unavailable", "blocked");
    signal.throwIfAborted();
    if (!generated.trim()) throw new MeetingProcessingFailure("summary-empty-output", "failed");
    if (this.isCapturing()) return this.pause(run, "summary");
    if (!this.isSelectedRun(run) || (run.kind === "initial" && !this.isCurrentNoteAudioVersion(run))) {
      this.cancelRun(run.id, run.kind === "summary" ? "processing-run-stale" : "meeting-audio-changed");
      return;
    }
    const latestNote = this.deps.database.getNote(recording.noteId);
    if (
      !latestNote || hashText(latestNote.content) !== snapshot.manualNoteRevision || latestNote.title !== snapshot.meetingTitle ||
      this.deps.database.getMeetingRunSpeakerCorrectionRevision(sourceRunId) !== snapshot.speakerCorrectionRevision
    ) throw new MeetingProcessingFailure("summary-source-changed", "failed");

    const summary = meetingSummaryArtifactSchema.parse({
      text: generated.trim(),
      speakerCorrectionRevision: snapshot.speakerCorrectionRevision,
      manualNoteRevision: snapshot.manualNoteRevision,
    });
    this.deps.storage.writeRunArtifact(run.id, "summary", summary);
    if (!this.deps.database.setMeetingRunArtifact(run.id, "summary").success) {
      this.deps.storage.removeRunArtifact(run.id, "summary");
      throw new MeetingProcessingFailure("summary-state-not-saved", "failed");
    }
    this.publishCurrentSelection(run.id);
    this.setState(run.id, "summary", "complete", null, null);
    if (this.deps.createActionConversation) {
      const work = this.runSummaryAction({ runId: run.id, action: "tasks" });
      this.backgroundSummaryActions.add(work);
      void work.finally(() => this.backgroundSummaryActions.delete(work));
    }
  }

  private getOrCreateLlmSourceSnapshot(
    run: MeetingProcessingRunDto,
    recording: MeetingRecordingDto,
    sourceRunId: string,
    transcript: MeetingTranscriptArtifact
  ): MeetingLlmSourceSnapshot {
    const saved = this.deps.database.getMeetingRunLlmSourceSnapshot(run.id);
    if (saved !== null) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(saved);
      } catch {
        throw new MeetingProcessingFailure("llm-source-snapshot-invalid", "failed");
      }
      const parsed = meetingLlmSourceSnapshotSchema.safeParse(decoded);
      if (!parsed.success || parsed.data.sourceRunId !== sourceRunId) {
        throw new MeetingProcessingFailure("llm-source-snapshot-invalid", "failed");
      }
      return parsed.data as MeetingLlmSourceSnapshot;
    }

    const note = this.deps.database.getNote(recording.noteId);
    const promptModel = run.config?.summary;
    if (!note || !promptModel) throw new MeetingProcessingFailure("summary-source-missing", "blocked");
    let participants: MeetingLlmSourceSnapshot["participants"];
    try {
      participants = participantCandidates(note.participants);
    } catch (error) {
      if (!(error instanceof MeetingProcessingFailure) || error.code !== "calendar-participants-invalid") throw error;
      participants = null;
      this.deps.database.setMeetingSpeakerNamingError(run.id, "calendar-participants-invalid");
    }
    const snapshot: MeetingLlmSourceSnapshot = {
      version: 1,
      sourceRunId,
      sourceRecordingIds: [...run.sourceRecordingIds],
      meetingTitle: note.title,
      participants,
      manualNotes: note.content,
      manualNoteRevision: hashText(note.content),
      speakerCorrectionRevision: this.deps.database.getMeetingRunSpeakerCorrectionRevision(sourceRunId),
      transcriptSegments: buildLlmTranscriptSegments(sourceRunId, transcript, this.deps.database.getMeetingRunSpeakerCorrections(sourceRunId)),
      promptModel,
    };
    if (!this.deps.database.setMeetingRunLlmSourceSnapshot(run.id, JSON.stringify(snapshot))) {
      throw new MeetingProcessingFailure("llm-source-snapshot-not-saved", "failed");
    }
    return snapshot;
  }

  private refreshLlmSnapshotSpeakerState(
    runId: string,
    sourceRunId: string,
    transcript: MeetingTranscriptArtifact,
    snapshot: MeetingLlmSourceSnapshot
  ): MeetingLlmSourceSnapshot {
    const oldJson = this.deps.database.getMeetingRunLlmSourceSnapshot(runId);
    if (oldJson === null) throw new MeetingProcessingFailure("llm-source-snapshot-missing", "failed");
    const revision = this.deps.database.getMeetingRunSpeakerCorrectionRevision(sourceRunId);
    const segments = buildLlmTranscriptSegments(sourceRunId, transcript, this.deps.database.getMeetingRunSpeakerCorrections(sourceRunId));
    if (revision === snapshot.speakerCorrectionRevision && JSON.stringify(segments) === JSON.stringify(snapshot.transcriptSegments)) {
      return snapshot;
    }
    const updated = { ...snapshot, speakerCorrectionRevision: revision, transcriptSegments: segments };
    if (!this.deps.database.updateMeetingRunLlmSourceSnapshot(runId, JSON.stringify(updated), oldJson)) {
      throw new MeetingProcessingFailure("llm-source-snapshot-stale", "cancelled");
    }
    return updated;
  }

  private async nameUnknownSpeakers(
    run: MeetingProcessingRunDto,
    recording: MeetingRecordingDto,
    sourceRunId: string,
    transcript: MeetingTranscriptArtifact,
    currentSnapshot: MeetingLlmSourceSnapshot,
    signal: AbortSignal
  ): Promise<void> {
    if (!this.deps.nameSpeakers) return;
    let snapshot = this.refreshLlmSnapshotSpeakerState(run.id, sourceRunId, transcript, currentSnapshot);
    const unknownIds = [...new Set(snapshot.transcriptSegments
      .filter((segment) => segment.speakerId && (!segment.speakerName || segment.speakerNameSource === "model"))
      .map((segment) => segment.speakerId as string))];
    const generateTitle = run.config?.generateTitle === true && isRegenerableNoteTitle(snapshot.meetingTitle, Object.values(TRANSLATIONS_BY_LOCALE).map((locale) => locale.notes.list.untitledNote));
    if (!unknownIds.length && !generateTitle) {
      this.deps.database.setMeetingSpeakerNamingError(
        run.id,
        snapshot.participants === null ? "calendar-participants-invalid" : null
      );
      return;
    }
    if (!this.isSelectedRun(run) || (run.kind === "initial" && !this.isCurrentNoteAudioVersion(run))) return;
    if (snapshot.participants === null) {
      this.deps.database.setMeetingSpeakerNamingError(run.id, "calendar-participants-invalid");
      return;
    }
    try {
      const noteBeforeNaming = this.deps.database.getNote(recording.noteId);
      if (!noteBeforeNaming) return;
      const participantsBeforeNaming = participantCandidates(noteBeforeNaming.participants);
      if (
        noteBeforeNaming.title !== snapshot.meetingTitle ||
        JSON.stringify(participantsBeforeNaming) !== JSON.stringify(snapshot.participants)
      ) {
        this.refreshLlmSnapshotSpeakerState(run.id, sourceRunId, transcript, snapshot);
        return;
      }
      const result = await this.deps.nameSpeakers({
        generateTitle,
        meetingTitle: snapshot.meetingTitle,
        transcriptSourceId: snapshot.sourceRunId,
        participants: this.enrichedParticipants(participantsBeforeNaming),
        segments: this.promptSegments(snapshot, transcript),
      }, snapshot.promptModel, run, signal);
      signal.throwIfAborted();
      if (this.isCapturing()) return;
      if (!this.isSelectedRun(run) || (run.kind === "initial" && !this.isCurrentNoteAudioVersion(run))) return;
      const note = this.deps.database.getNote(recording.noteId);
      const nowParticipants = note ? participantCandidates(note.participants) : [];
      if (
        !note || note.title !== snapshot.meetingTitle || JSON.stringify(nowParticipants) !== JSON.stringify(snapshot.participants) ||
        this.deps.database.getMeetingRunSpeakerCorrectionRevision(sourceRunId) !== snapshot.speakerCorrectionRevision
      ) {
        snapshot = this.refreshLlmSnapshotSpeakerState(run.id, sourceRunId, transcript, snapshot);
        return;
      }
      const suggestions = result.speakers;
      validateSpeakerSuggestions(suggestions, unknownIds);
      const suggestedIds = new Set(suggestions.map((suggestion) => suggestion.speakerId));
      const rejectedModelIds = [...new Set(snapshot.transcriptSegments
        .filter((segment) => segment.speakerId && segment.speakerNameSource === "model" && !suggestedIds.has(segment.speakerId))
        .map((segment) => segment.speakerId!))];
      if ((suggestions.length || rejectedModelIds.length) && this.deps.database.applyAutomaticMeetingSpeakerCorrections(
        sourceRunId,
        run.id,
        snapshot.speakerCorrectionRevision,
        suggestions.map(({ speakerId, name }) => ({ speakerId, profileId: null, displayName: name })),
        "model",
        rejectedModelIds
      )) {
        const candidates = this.enrichedParticipants(participantsBeforeNaming);
        for (const suggestion of suggestions) {
          const matches = candidates.filter((person) => person.email && person.name?.normalize("NFC").toLowerCase() === suggestion.name.trim().normalize("NFC").toLowerCase());
          const emails = [...new Set(matches.map((person) => person.email!))];
          if (emails.length === 1 && suggestions.filter((item) => item.name.trim().toLowerCase() === suggestion.name.trim().toLowerCase()).length === 1) {
            this.deps.database.rememberContactName(emails[0], suggestion.name);
          }
        }
        snapshot = this.refreshLlmSnapshotSpeakerState(run.id, sourceRunId, transcript, snapshot);
        this.publishCurrentSelection(run.id);
      }
      if (generateTitle && result.title?.trim()) {
        const expectedJson = this.deps.database.getMeetingRunLlmSourceSnapshot(run.id);
        if (expectedJson && this.deps.database.applyMeetingGeneratedTitle(run.id, recording.noteId, snapshot.meetingTitle, result.title.trim(), expectedJson)) {
          this.deps.onNoteProjectionChanged?.(recording.noteId);
        }
      }
      this.deps.database.setMeetingSpeakerNamingError(run.id, null);
    } catch (error) {
      if (signal.aborted || this.isCapturing()) return;
      this.deps.database.setMeetingSpeakerNamingError(run.id, errorCodeOf(error));
    }
  }

  private enrichedParticipants(participants: Array<{ name: string | null; email: string | null }>) {
    const profiles = new Map(this.deps.database.getContactProfiles(participants.flatMap((person) => person.email ? [person.email] : []))
      .map((profile) => [profile.email.toLowerCase(), profile.display_name]));
    return participants.map((person) => ({ ...person, name: (person.email && profiles.get(person.email.toLowerCase())) || person.name }));
  }

  private isAutoSummaryEligible(
    run: MeetingProcessingRunDto,
    recording: MeetingRecordingDto,
    transcript: MeetingTranscriptArtifact
  ): boolean {
    const { timeline, epochs } = this.sourceTimeline(run, recording);
    const transcriptCharacters = transcript.segments?.length
      ? transcript.segments.reduce((length, segment) => length + segment.text.length, 0)
      : transcript.text.length;
    return timelineDuration(timeline, epochs) >= 180 && transcriptCharacters >= 2500;
  }

  private isSelectedRun(run: MeetingProcessingRunDto): boolean {
    return this.deps.database.getMeetingRecording(run.recordingId)?.currentRunId === run.id;
  }

  private saveRawResponse(runId: string, response: unknown): void {
    const current = this.deps.database.getMeetingProcessingRun(runId);
    const recording = current ? this.deps.database.getMeetingRecording(current.recordingId) : null;
    if (!current || current.status !== "running" || current.stage !== "asr" || current.hasRawProviderResponse || recording?.audioState !== "available") {
      throw new MeetingProcessingFailure("stale-provider-response", "cancelled");
    }
    this.deps.storage.writeRunArtifact(runId, "provider-response", response);
    if (!this.deps.database.setMeetingRunArtifact(runId, "provider-response").success) {
      this.deps.storage.removeRunArtifact(runId, "provider-response");
      throw new MeetingProcessingFailure("provider-response-state-not-saved", "cancelled");
    }
    this.notify(current);
  }

  private handleFailure(runId: string, stage: MeetingProcessingRunDto["stage"], error: unknown): void {
    const run = this.deps.database.getMeetingProcessingRun(runId);
    if (!run || run.status !== "running") return;
    const failure = error instanceof MeetingProcessingFailure
      ? error
      : failureFromUnknown(error);
    if (failure.status === "cancelled" || ((error as Error)?.name === "AbortError" && this.isCapturing())) {
      this.pause(run, stage);
      return;
    }
    if (failure.status === "blocked") {
      this.setState(run.id, stage, "blocked", failure.code, null);
      return;
    }
    if (isTransientFailure(failure)) {
      const retryCount = run.retryCount + 1;
      if (retryCount <= AUTO_RETRY_LIMIT) {
        const delaySeconds = Math.min(RETRY_MAX_SECONDS, RETRY_BASE_SECONDS * 2 ** run.retryCount);
        const retryAt = new Date(this.now().getTime() + delaySeconds * 1000).toISOString();
        this.setState(run.id, stage, "pending", failure.code, retryAt, retryCount);
        return;
      }
    }
    this.setState(run.id, stage, "failed", failure.code, null, run.retryCount);
  }

  private pause(run: MeetingProcessingRunDto, stage: MeetingProcessingRunDto["stage"]): void {
    this.setState(run.id, stage, "pending", null, null, run.retryCount);
  }

  private setState(
    runId: string,
    stage: MeetingProcessingRunDto["stage"],
    status: MeetingProcessingRunDto["status"],
    errorCode: string | null,
    retryAt: string | null,
    retryCount?: number
  ): void {
    const updated = this.deps.database.setMeetingProcessingRunState(runId, { stage, status, errorCode, retryAt, retryCount });
    if (!updated.success) return;
    const current = this.deps.database.getMeetingProcessingRun(runId);
    if (current) this.notify(current);
  }

  private requireConfig(run: MeetingProcessingRunDto): MeetingProcessingConfig {
    const parsed = meetingProcessingConfigSchema.safeParse(run.config);
    if (!parsed.success) throw new MeetingProcessingFailure("processing-config-missing", "blocked");
    return parsed.data;
  }

  private sourceTimeline(run: MeetingProcessingRunDto, recording: MeetingRecordingDto, requireAudio = false): {
    timeline: MeetingRecordingDto;
    epochs: MeetingRecordingEpochDto[];
    intentionalIntervals: MeetingIntentionalInterval[];
  } {
    const sources = run.sourceRecordingIds.map((id) => this.deps.database.getMeetingRecording(id));
    if (sources.some((source) => !source || (requireAudio && source.audioState !== "available") || source.noteId !== recording.noteId)) {
      throw new MeetingProcessingFailure("audio-part-unavailable", "blocked");
    }
    const parts = sources as MeetingRecordingDto[];
    if (requireAudio) {
      for (const part of parts) {
        this.intentionalEmptySources(part, this.deps.database.listMeetingRecordingEpochs(part.id), this.deps.database.listMeetingIntentionalIntervals(part.id));
      }
    }
    const combined = composeMeetingAudioParts(parts, (id) => this.deps.database.listMeetingRecordingEpochs(id));
    for (const source of ["mic", "system"] as const) {
      const metadata = combined.recording.sourceMetadata[source];
      combined.recording.sourceMetadata[source] = {
        ...(metadata && typeof metadata === "object" ? metadata : {}),
        intentionallyEmpty: parts.every((part) => meetingSourceIntentionallyEmpty(part,
          this.deps.database.listMeetingRecordingEpochs(part.id), this.deps.database.listMeetingIntentionalIntervals(part.id), source)),
      };
    }
    const offsets = new Map(combined.partOffsets.map((part) => [part.recordingId, part.startFrame]));
    const intentionalIntervals = (sources as MeetingRecordingDto[]).flatMap((part) => {
      const offset = offsets.get(part.id) ?? 0;
      return this.deps.database.listMeetingIntentionalIntervals(part.id).map((interval) => ({
        ...interval,
        timelineStartFrame: interval.timelineStartFrame === null ? null : interval.timelineStartFrame + offset,
        timelineEndFrame: interval.timelineEndFrame === null ? null : interval.timelineEndFrame + offset,
      }));
    });
    return {
      timeline: {
        ...recording,
        startedAt: combined.recording.startedAt,
        endedAt: combined.recording.endedAt,
        sourceMetadata: combined.recording.sourceMetadata,
      },
      epochs: combined.epochs,
      intentionalIntervals,
    };
  }

  private intentionalEmptySources(
    timeline: MeetingRecordingDto,
    epochs: MeetingRecordingEpochDto[],
    intervals: MeetingIntentionalInterval[]
  ): MeetingSource[] {
    const empty: MeetingSource[] = [];
    for (const source of ["mic", "system"] as const) {
      if (epochs.some((epoch) => epoch.source === source && epoch.frameCount > 0)) continue;
      if (!meetingSourceIntentionallyEmpty(timeline, epochs, intervals, source)) {
        throw new MeetingProcessingFailure(`${source}-source-unavailable`, "blocked");
      }
      empty.push(source);
    }
    return empty;
  }

  private requireCurrentRun(runId: string): MeetingProcessingRunDto {
    const run = this.deps.database.getMeetingProcessingRun(runId);
    if (!run || run.status !== "running") throw new MeetingProcessingFailure("processing-run-stale", "cancelled");
    return run;
  }

  private readTranscript(runId: string): MeetingTranscriptArtifact | null {
    const value = this.deps.storage.readRunArtifact(runId, "transcript");
    if (value === null) return null;
    const parsed = meetingTranscriptArtifactSchema.safeParse(value);
    if (!parsed.success) throw new MeetingProcessingFailure("transcript-artifact-invalid", "failed");
    return parsed.data;
  }

  private getResult(run: MeetingProcessingRunDto): MeetingProcessingResultDto {
    const transcriptRunId = run.kind === "summary" ? run.sourceRunId : run.id;
    const rawTranscript = transcriptRunId ? this.readTranscript(transcriptRunId) : null;
    const speakerCorrections = transcriptRunId
      ? this.deps.database.getMeetingRunSpeakerCorrections(transcriptRunId)
      : [];
    const transcript = rawTranscript;
    const summaryRun = run.hasSummary
      ? run
      : run.kind === "summary" && run.sourceRunId
        ? this.deps.database.getMeetingProcessingRun(run.sourceRunId)
        : null;
    const summaryValue = summaryRun?.hasSummary
      ? this.deps.storage.readRunArtifact(summaryRun.id, "summary")
      : null;
    const summary = summaryValue === null ? null : meetingSummaryArtifactSchema.parse(summaryValue);
    return meetingProcessingResultDtoSchema.parse({ run, transcript, summary, speakerCorrections });
  }

  private publishCurrentSelection(runId: string): void {
    const run = this.deps.database.getMeetingProcessingRun(runId);
    const recording = run ? this.deps.database.getMeetingRecording(run.recordingId) : null;
    if (!run || !recording || recording.currentRunId !== runId) return;
    const result = this.getResult(run);
    if (!result.transcript) return;
    const projection = this.deps.database.selectMeetingProcessingRun(recording.id, run.id, {
      transcript: serializeTranscriptProjection(result.transcript, result.speakerCorrections),
      summary: result.summary?.text ?? null,
      summaryPrompt: this.summaryPromptForResult(run),
    });
    if (projection.success && projection.noteId !== undefined) {
      this.deps.onNoteProjectionChanged?.(projection.noteId);
    }
  }

  private summaryPromptForResult(run: MeetingProcessingRunDto): string | null {
    if (run.hasSummary || run.kind !== "summary" || !run.sourceRunId) return run.config?.summary?.instruction ?? null;
    return this.deps.database.getMeetingProcessingRun(run.sourceRunId)?.config?.summary?.instruction ?? null;
  }

  private async runPrioritizedTasks(runId: string): Promise<{ success: boolean; error?: string }> {
    if (this.activeTaskRuns.has(runId)) return { success: true };
    this.activeTaskRuns.add(runId);
    let context: MeetingSummaryActionContext | null = null;
    try {
      context = this.getSummaryActionContext(runId);
      if (["complete", "zero"].includes(context.artifact.taskStatus ?? "")) return { success: true };
      await this.writeTaskStatus(context, "running", undefined);
      context = this.getSummaryActionContext(runId);

      const controller = this.beginSummaryAction(runId);
      try {
        const input = formatMeetingMaterial({
          meetingTitle: context.snapshot.meetingTitle,
          manualNotes: context.snapshot.manualNotes,
          summary: context.markdown,
          transcriptSegments: this.promptSegments(context.snapshot, context.transcript),
          transcriptSourceId: context.snapshot.sourceRunId,
        });
        const conversation = await this.createActionConversation(context, MEETING_TASKS_INSTRUCTION, controller.signal);
        const response = await conversation.send(input);
        if (response.refusal || looksLikeRefusal(response.text)) throw new MeetingProcessingFailure("meeting-task-refused", "failed");
        const validated = validateMeetingTasks(response.text);
        if (!validated.success) throw new MeetingProcessingFailure("meeting-task-markdown-invalid", "failed");
        const tasks = validated.value;
        const isEmpty = tasks.length === 0;
        await this.applySummarySection(
          context,
          "Action Items",
          (markdown) => replaceMeetingTasks(markdown, tasks),
          isEmpty ? "zero" : "complete"
        );
        return { success: true };
      } finally {
        this.endSummaryAction(runId, controller);
      }
    } catch (error) {
      const code = actionErrorCode(error);
      if (context) {
        const status = code === "meeting-summary-section-invalid"
          ? "section-error"
          : code === "meeting-summary-edit-conflict" || code === "meeting-summary-source-changed"
            ? "conflict"
            : code === "meeting-task-markdown-invalid"
              ? "format-error"
              : "provider-error";
        await this.writeTaskStatus(context, status, code).catch(() => {});
      }
      return { success: false, error: code };
    } finally {
      this.activeTaskRuns.delete(runId);
    }
  }

  private async runRecap(runId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const context = this.getSummaryActionContext(runId);
      const prompt = this.deps.getActionPrompt?.(RECAP_KEY);
      if (!prompt) throw new MeetingProcessingFailure("meeting-recap-action-missing", "blocked");
      const controller = this.beginSummaryAction(runId);
      try {
        const input = formatMeetingMaterial({
          meetingTitle: context.snapshot.meetingTitle,
          manualNotes: context.snapshot.manualNotes,
          summary: context.markdown,
          transcriptSegments: this.promptSegments(context.snapshot, context.transcript),
          transcriptSourceId: context.snapshot.sourceRunId,
        });
        const conversation = await this.createActionConversation(context, prompt, controller.signal);
        const recap = await requestMeetingJson<MeetingRecap>({
          conversation,
          prompt: input,
          refusalCode: "meeting-recap-refused",
          invalidCode: "meeting-recap-json-invalid",
          validate: validateMeetingRecap,
        });
        await this.applySummarySection(context, "Recap", (markdown) => replaceMeetingRecap(markdown, recap));
        return { success: true };
      } finally {
        this.endSummaryAction(runId, controller);
      }
    } catch (error) {
      return { success: false, error: actionErrorCode(error) };
    }
  }

  private getSummaryActionContext(runId: string): MeetingSummaryActionContext {
    const run = this.deps.database.getMeetingProcessingRun(runId);
    const recording = run ? this.deps.database.getMeetingRecording(run.recordingId) : null;
    if (!run || !recording || recording.currentRunId !== run.id || run.status !== "complete" || !run.hasSummary) {
      throw new MeetingProcessingFailure("meeting-summary-not-selected", "blocked");
    }
    const sourceRunId = run.kind === "summary" ? run.sourceRunId : run.id;
    if (!sourceRunId) throw new MeetingProcessingFailure("meeting-summary-source-missing", "blocked");
    const snapshotJson = this.deps.database.getMeetingRunLlmSourceSnapshot(run.id);
    if (!snapshotJson) throw new MeetingProcessingFailure("meeting-summary-source-missing", "blocked");
    let decoded: unknown;
    try {
      decoded = JSON.parse(snapshotJson);
    } catch {
      throw new MeetingProcessingFailure("meeting-summary-source-invalid", "failed");
    }
    const parsedSnapshot = meetingLlmSourceSnapshotSchema.safeParse(decoded);
    if (!parsedSnapshot.success || parsedSnapshot.data.sourceRunId !== sourceRunId) {
      throw new MeetingProcessingFailure("meeting-summary-source-invalid", "failed");
    }
    const snapshot = parsedSnapshot.data as MeetingLlmSourceSnapshot;
    const note = this.deps.database.getNote(recording.noteId);
    const transcript = this.readTranscript(sourceRunId);
    const artifactValue = this.deps.storage.readRunArtifact(run.id, "summary");
    if (!note || !transcript || artifactValue === null) {
      throw new MeetingProcessingFailure("meeting-summary-source-missing", "blocked");
    }
    const artifact = meetingSummaryArtifactSchema.parse(artifactValue);
    if (
      hashText(note.content) !== snapshot.manualNoteRevision ||
      this.deps.database.getMeetingRunSpeakerCorrectionRevision(sourceRunId) !== snapshot.speakerCorrectionRevision ||
      (artifact.manualNoteRevision !== undefined && artifact.manualNoteRevision !== snapshot.manualNoteRevision)
    ) throw new MeetingProcessingFailure("meeting-summary-source-changed", "failed");
    const markdown = note.enhanced_content ?? artifact.text;
    return {
      run,
      recording,
      note,
      sourceRunId,
      snapshotJson,
      snapshot,
      transcript,
      artifact,
      markdown,
      actionItemsSection: readMeetingSummarySection(markdown, "Action Items"),
      recapSection: readMeetingSummarySection(markdown, "Recap"),
    };
  }

  private promptSegments(snapshot: MeetingLlmSourceSnapshot, transcript: MeetingTranscriptArtifact) {
    const sourceSegments = transcript.segments;
    if (sourceSegments?.length && sourceSegments.length !== snapshot.transcriptSegments.length) {
      throw new MeetingProcessingFailure("meeting-summary-source-invalid", "failed");
    }
    return snapshot.transcriptSegments.map((segment, index) => {
      const source = sourceSegments?.[index];
      return { ...segment, ...(source ? { start: source.start, end: source.end } : {}) };
    });
  }

  private async createActionConversation(
    context: MeetingSummaryActionContext,
    instruction: string,
    signal: AbortSignal
  ): Promise<import("./meetingSummary.js").MeetingTextConversation> {
    if (!this.deps.createActionConversation) {
      throw new MeetingProcessingFailure("meeting-summary-action-unavailable", "blocked");
    }
    return this.deps.createActionConversation(
      { ...context.snapshot.promptModel, instruction },
      instruction,
      context.run,
      signal
    );
  }

  private async applySummarySection(
    context: MeetingSummaryActionContext,
    heading: "Action Items" | "Recap",
    mutate: (markdown: string) => { success: true; markdown: string } | { success: false; error: string },
    taskStatus?: "complete" | "zero"
  ): Promise<void> {
    await this.withSummaryMutation(context.recording.noteId, () => {
      const latest = this.getSummaryActionContext(context.run.id);
      const expectedSection = heading === "Action Items" ? context.actionItemsSection : context.recapSection;
      const latestSection = heading === "Action Items" ? latest.actionItemsSection : latest.recapSection;
      if (latest.snapshotJson !== context.snapshotJson || latestSection !== expectedSection) {
        throw new MeetingProcessingFailure("meeting-summary-edit-conflict", "failed");
      }
      const expected = mutate(context.markdown);
      if (!expected.success) throw new MeetingProcessingFailure(expected.error, "failed");
      const result = mutate(latest.markdown);
      if (!result.success) throw new MeetingProcessingFailure("meeting-summary-edit-conflict", "failed");
      const updatedArtifact = meetingSummaryArtifactSchema.parse({
        ...latest.artifact,
        text: result.markdown,
        ...(taskStatus ? { taskStatus, taskErrorCode: null } : {}),
      });
      this.deps.storage.writeRunArtifact(latest.run.id, "summary", updatedArtifact);
      const projected = this.deps.database.updateMeetingSummaryIfCurrent({
        recordingId: latest.recording.id,
        runId: latest.run.id,
        sourceRunId: latest.sourceRunId,
        expectedSnapshotJson: latest.snapshotJson,
        expectedSpeakerCorrectionRevision: latest.snapshot.speakerCorrectionRevision,
        expectedTitle: latest.note.title,
        expectedManualNotes: latest.note.content,
        expectedTranscript: latest.note.transcript ?? null,
        expectedProjection: latest.note.enhanced_content ?? null,
        summary: result.markdown,
      });
      if (!projected) {
        this.deps.storage.writeRunArtifact(latest.run.id, "summary", latest.artifact);
        throw new MeetingProcessingFailure("meeting-summary-edit-conflict", "failed");
      }
      this.deps.onNoteProjectionChanged?.(latest.recording.noteId);
      this.notify(latest.run);
    });
  }

  private async writeTaskStatus(
    context: MeetingSummaryActionContext,
    status: NonNullable<MeetingSummaryArtifact["taskStatus"]>,
    errorCode: string | undefined
  ): Promise<void> {
    await this.withSummaryMutation(context.recording.noteId, () => {
      const latestRun = this.deps.database.getMeetingProcessingRun(context.run.id);
      const recording = latestRun
        ? this.deps.database.getMeetingRecording(latestRun.recordingId)
        : null;
      if (!latestRun || !recording || recording.currentRunId !== latestRun.id || !latestRun.hasSummary) return;
      const currentValue = this.deps.storage.readRunArtifact(latestRun.id, "summary");
      if (currentValue === null) return;
      const current = meetingSummaryArtifactSchema.parse(currentValue);
      const artifact = meetingSummaryArtifactSchema.parse({
        ...current,
        taskStatus: status,
        taskErrorCode: errorCode ?? null,
      });
      this.deps.storage.writeRunArtifact(latestRun.id, "summary", artifact);
      this.notify(latestRun);
    });
  }

  private withSummaryMutation<T>(noteId: number, operation: () => T): Promise<T> {
    const previous = this.summaryMutationTails.get(noteId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.summaryMutationTails.set(noteId, current);
    return previous.catch(() => {}).then(operation).finally(() => {
      release();
      if (this.summaryMutationTails.get(noteId) === current) this.summaryMutationTails.delete(noteId);
    });
  }

  private withAgentThreadAction<T>(threadKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.agentThreadActionTails.get(threadKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.agentThreadActionTails.set(threadKey, current);
    return previous.catch(() => {}).then(operation).finally(() => {
      release();
      if (this.agentThreadActionTails.get(threadKey) === current) this.agentThreadActionTails.delete(threadKey);
    });
  }

  private beginSummaryAction(runId: string): AbortController {
    const controller = new AbortController();
    const controllers = this.activeSummaryActions.get(runId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.activeSummaryActions.set(runId, controllers);
    return controller;
  }

  private endSummaryAction(runId: string, controller: AbortController): void {
    const controllers = this.activeSummaryActions.get(runId);
    controllers?.delete(controller);
    if (controllers?.size === 0) this.activeSummaryActions.delete(runId);
  }

  private recoverInterruptedSummaryTasks(): void {
    for (const run of this.deps.database.listAllMeetingProcessingRuns()) {
      if (!run.hasSummary) continue;
      const value = this.deps.storage.readRunArtifact(run.id, "summary");
      const parsed = meetingSummaryArtifactSchema.safeParse(value);
      if (!parsed.success || parsed.data.taskStatus !== "running") continue;
      this.deps.storage.writeRunArtifact(run.id, "summary", {
        ...parsed.data,
        taskStatus: "provider-error",
        taskErrorCode: "meeting-summary-task-interrupted",
      });
    }
  }

  private notify(run: MeetingProcessingRunDto): void {
    this.deps.onChanged?.(run.recordingId, run.id);
  }

  private isCapturing(): boolean {
    return this.captureActive || this.deps.isCaptureActive();
  }

  private isEndOfMeetingGate(run: MeetingProcessingRunDto): boolean {
    return run.kind !== "summary" &&
      (run.stage === "prepare" || run.stage === "asr") &&
      run.retryAt !== null &&
      run.retryCount === 0 &&
      !run.hasRawProviderResponse;
  }

  private isCurrentNoteAudioVersion(run: MeetingProcessingRunDto): boolean {
    const recording = this.deps.database.getMeetingRecording(run.recordingId);
    if (!recording || run.kind === "summary") return false;
    const parts = this.deps.database.listMeetingRecordingsForNote(recording.noteId)
      .filter((part) => part.audioState === "available" && part.captureErrorCode !== "recording-audio-unavailable")
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
    if (parts.some((part) =>
      (part.captureState !== "ready" && part.captureState !== "incomplete") || part.audioState !== "available"
    )) return false;
    const currentIds = parts.map((part) => part.id).sort();
    const sourceIds = [...run.sourceRecordingIds].sort();
    return currentIds.length === sourceIds.length && currentIds.every((id, index) => id === sourceIds[index]);
  }

  private scheduleRetryTimer(): void {
    if (this.stopped || !this.retentionReady || this.isCapturing()) return;
    const future = this.deps.database.listAllMeetingProcessingRuns()
      .filter((run) => run.status === "pending" && run.retryAt && Date.parse(run.retryAt) > this.now().getTime())
      .map((run) => Date.parse(run.retryAt as string));
    if (!future.length) return;
    const delay = Math.max(0, Math.min(...future) - this.now().getTime());
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      this.processPending();
    }, delay);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) this.clearTimer(this.retryTimer);
    this.retryTimer = null;
  }
}

export function registerMeetingProcessingHandlers(
  ipcMain: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void },
  worker: MeetingProcessingWorker
): void {
  ipcMain.handle(meetingProcessingChannels.listForNote, (_event, ...args) => {
    const parsed = meetingProcessingListRequestSchema.safeParse(args[0]);
    if (!parsed.success) return { success: false, error: "Invalid meeting processing list request" };
    try {
      return meetingProcessingListResponseSchema.parse({ success: true, recordings: worker.listForNote(parsed.data.noteId) });
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle(meetingProcessingChannels.createRun, (_event, ...args) => {
    try {
      const parsed = meetingProcessingCreateRunRequestSchema.parse(args[0]);
      return meetingProcessingRunResponseSchema.parse({ success: true, result: worker.createRun(parsed) });
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle(meetingProcessingChannels.retryRun, (_event, ...args) => {
    const parsed = meetingProcessingRetryRequestSchema.safeParse(args[0]);
    if (!parsed.success) return { success: false, error: "Invalid meeting processing retry request" };
    try {
      const result = worker.retry(parsed.data.runId);
      return result
        ? meetingProcessingRunResponseSchema.parse({ success: true, result })
        : { success: false, error: "Meeting processing run cannot be retried" };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle(meetingProcessingChannels.cancelRun, (_event, ...args) => {
    const parsed = meetingProcessingCancelRequestSchema.safeParse(args[0]);
    if (!parsed.success) return { success: false, error: "Invalid meeting processing cancellation request" };
    try {
      return worker.cancelRun(parsed.data.runId)
        ? { success: true }
        : { success: false, error: "Meeting processing run cannot be cancelled" };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle(meetingProcessingChannels.updateBlockedRunConfig, (_event, ...args) => {
    const parsed = meetingProcessingUpdateBlockedRunConfigRequestSchema.safeParse(args[0]);
    if (!parsed.success) return { success: false, error: "Invalid blocked meeting run config update request" };
    try {
      const result = worker.updateBlockedRunConfig(parsed.data);
      return result
        ? meetingProcessingRunResponseSchema.parse({ success: true, result })
        : { success: false, error: "Meeting processing run cannot be updated" };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle(meetingProcessingChannels.setSpeakerCorrection, (_event, ...args) => {
    const parsed = meetingProcessingSpeakerCorrectionRequestSchema.safeParse(args[0]);
    if (!parsed.success) return { success: false, error: "Invalid speaker correction" };
    try {
      const success = worker.setSpeakerCorrection(parsed.data);
      return success ? { success: true } : { success: false, error: "Speaker or calendar participant is no longer available" };
    } catch {
      return { success: false, error: "Could not save speaker identity" };
    }
  });
  ipcMain.handle(meetingProcessingChannels.runSummaryAction, async (_event, ...args) => {
    const parsed = meetingProcessingSummaryActionRequestSchema.safeParse(args[0]);
    if (!parsed.success) return { success: false, error: "Invalid meeting summary action request" };
    return worker.runSummaryAction(parsed.data);
  });
}

export function normalizeProviderResponse(provider: "deepgram" | "elevenlabs" | "gemini" | "openai", raw: unknown, diarize = true): RemoteTranscriptionResult {
  if (provider === "deepgram") return parseDeepgramFileResponse(raw, diarize);
  if (provider === "elevenlabs") return parseElevenLabsFileResponse(raw, diarize);
  if (provider === "openai") return parseOpenAIFileResponse(raw, diarize, !diarize);
  return parseGeminiFileResponse(raw, diarize);
}

class MeetingProcessingFailure extends Error {
  constructor(
    readonly code: string,
    readonly status: "blocked" | "failed" | "cancelled",
    message?: string
  ) {
    super(message ?? code);
  }
}

function providerModel(model: string | undefined, provider: "deepgram" | "elevenlabs" | "gemini" | "openai"): string {
  return model || (provider === "deepgram" ? "nova-3" : provider === "elevenlabs" ? "scribe_v2" : provider === "gemini" ? "gemini-3.5-transcribe" : "gpt-4o-transcribe-diarize");
}

function serializeTranscriptProjection(
  transcript: MeetingTranscriptArtifact,
  corrections: MeetingSpeakerCorrection[]
): string {
  if (!transcript.segments?.length) {
    return JSON.stringify(transcript.text ? [{ text: transcript.text }] : []);
  }
  const correctionsBySpeaker = new Map(corrections.map((correction) => [correction.speakerId, correction]));
    return JSON.stringify(transcript.segments.map((segment) => {
      const correction = segment.speaker ? correctionsBySpeaker.get(segment.speaker) : undefined;
    return {
      text: segment.text,
      timestamp: segment.start,
      endTimestamp: segment.end,
      ...(segment.speaker ? { speaker: segment.speaker } : {}),
      ...(correction ? {
        speakerName: correction.displayName,
        speakerIsPlaceholder: false,
        speakerStatus: "locked",
        speakerLocked: true,
        speakerLockSource: correction.source,
      } : segment.speaker ? {
        speakerIsPlaceholder: true,
        speakerStatus: "provisional",
      } : {}),
    };
  }));
}

function providerFailure(result: RemoteTranscriptionResult): MeetingProcessingFailure {
  const code = result.code || "transcription-error";
  if (code === "UPLOAD_CANCELLED") return new MeetingProcessingFailure(code, "cancelled", result.error);
  if (["PROVIDER_LIMIT", "API_KEY_MISSING", "INVALID_KEY", "GEMINI_MODEL_UNSUPPORTED", "DEEPGRAM_MODEL_UNSUPPORTED", "GEMINI_DURATION_LIMIT", "GEMINI_DURATION_UNKNOWN", "STREAMING_ONLY_PROVIDER", "CUSTOM_ENDPOINT_INVALID"].includes(code)) {
    return new MeetingProcessingFailure(code.toLowerCase().replaceAll("_", "-"), "blocked", result.error);
  }
  if (code === "PROVIDER_RATE_LIMITED" || code === "TRANSCRIPTION_TRANSPORT_ERROR" || /Gemini API error 5\d\d/.test(result.error || "")) {
    return new MeetingProcessingFailure(code, "failed", result.error);
  }
  return new MeetingProcessingFailure(code, "failed", result.error);
}

function normalizeLocalResponse(raw: unknown): RemoteTranscriptionResult {
  if (!raw || typeof raw !== "object") return { success: false, error: "Local transcription response is invalid", code: "LOCAL_INVALID_RESPONSE" };
  const value = raw as Record<string, unknown>;
  if (value.success !== true || typeof value.text !== "string") {
    return { success: false, error: typeof value.error === "string" ? value.error : typeof value.message === "string" ? value.message : "Local transcription failed", code: typeof value.code === "string" ? value.code : "LOCAL_TRANSCRIPTION_FAILED" };
  }
  return { success: true, text: value.text };
}

function validateTranscript(result: RemoteTranscriptionResult, duration: number, requireSpeaker: boolean): MeetingTranscriptArtifact {
  const text = result.text ?? "";
  const segments = result.segments ?? [];
  if (text.trim() && requireSpeaker && (!result.diarized || !segments.length)) {
    throw new MeetingProcessingFailure("provider-diarization-missing", "failed");
  }
  let lastStart = -1;
  for (const segment of segments) {
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 || segment.end < segment.start || segment.end > duration + 1 / 24_000 || segment.start < lastStart) {
      throw new MeetingProcessingFailure("transcript-timing-invalid", "failed");
    }
    if (requireSpeaker && !segment.speaker?.trim()) throw new MeetingProcessingFailure("transcript-speaker-missing", "failed");
    lastStart = segment.start;
  }
  return meetingTranscriptArtifactSchema.parse({
    text,
    segments,
    ...(result.diarized !== undefined ? { diarized: result.diarized } : {}),
  });
}

function timelineDuration(recording: MeetingRecordingDto, epochs: ReturnType<MeetingProcessingDatabase["listMeetingRecordingEpochs"]>): number {
  return meetingTimelineFrameCount(recording, epochs) / 24_000;
}

function isTransientFailure(error: MeetingProcessingFailure): boolean {
  return error.code === "PROVIDER_RATE_LIMITED" ||
    error.code === "TRANSCRIPTION_TRANSPORT_ERROR" ||
    error.code === "TRANSIENT_NETWORK_ERROR" ||
    /Gemini API error 5\d\d/.test(error.message);
}

function failureFromUnknown(value: unknown): MeetingProcessingFailure {
  const error = value instanceof Error ? value : new Error(String(value));
  const detail = error as Error & { code?: string; status?: number; statusCode?: number };
  if (error.name === "AbortError") {
    return new MeetingProcessingFailure("processing-cancelled", "cancelled", error.message);
  }
  const status = detail.status ?? detail.statusCode;
  if (status === 429) return new MeetingProcessingFailure("PROVIDER_RATE_LIMITED", "failed", error.message);
  if ((typeof status === "number" && status >= 500) || error instanceof TypeError) {
    return new MeetingProcessingFailure("TRANSIENT_NETWORK_ERROR", "failed", error.message);
  }
  const code = detail.code || "processing-error";
  if (["api-key-missing", "invalid-key", "INVALID_KEY", "API_KEY_MISSING", "reasoning-model-missing", "reasoning-endpoint-missing", "reasoning-endpoint-invalid", "reasoning-provider-missing", "unsupported-reasoning-provider", "unsupported-enterprise-reasoning-route", "enterprise-reasoning-unavailable", "SELF_HOSTED_ENDPOINT_INVALID", "DIARIZATION_MODEL_MISSING", "MODEL_NOT_DOWNLOADED", "MODEL_NOT_FOUND", "LLAMASERVER_NOT_FOUND", "LOCAL_SERVER_UNAVAILABLE", "bb-not-installed", "bb-version-unsupported", "bb-project-mismatch"].includes(code)) {
    return new MeetingProcessingFailure(code, "blocked", error.message);
  }
  return new MeetingProcessingFailure(code, "failed", error.message);
}

function participantCandidates(value: string | null): Array<{ name: string | null; email: string | null }> {
  if (!value) return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new MeetingProcessingFailure("calendar-participants-invalid", "failed");
  }
  if (!Array.isArray(decoded)) throw new MeetingProcessingFailure("calendar-participants-invalid", "failed");
  return decoded.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new MeetingProcessingFailure("calendar-participants-invalid", "failed");
    }
    const attendee = item as Record<string, unknown>;
    const email = typeof attendee.email === "string" && attendee.email.trim() ? attendee.email.trim() : null;
    const displayName = typeof attendee.displayName === "string" && attendee.displayName.trim()
      ? attendee.displayName.trim()
      : null;
    return {
      name: displayName && !/^[^\s@]+@[^\s@]+$/.test(displayName) && displayName.toLowerCase() !== email?.toLowerCase()
        ? displayName
        : null,
      email,
    };
  });
}

function buildLlmTranscriptSegments(
  sourceRunId: string,
  transcript: MeetingTranscriptArtifact,
  corrections: MeetingSpeakerCorrection[]
): MeetingLlmSourceSnapshot["transcriptSegments"] {
  const sourceSegments = transcript.segments?.length
    ? transcript.segments
    : transcript.text ? [{ text: transcript.text, start: 0, end: 0 }] : [];
  const correctionsBySpeaker = new Map(corrections.map((correction) => [correction.speakerId, correction]));
  return sourceSegments.map((segment, index) => {
    const speakerId = segment.speaker?.trim() || null;
    const correction = speakerId ? correctionsBySpeaker.get(speakerId) : undefined;
    return {
      id: `${sourceRunId}:${index}`,
      speakerId,
      speakerName: correction?.displayName ?? null,
      speakerNameSource: correction?.source ?? null,
      text: segment.text,
    };
  });
}

function validateSpeakerSuggestions(
  suggestions: Array<{ speakerId: string; name: string }>,
  unknownIds: string[]
): void {
  if (!Array.isArray(suggestions)) throw new MeetingProcessingFailure("speaker-name-json-invalid", "failed");
  const allowed = new Set(unknownIds);
  const seen = new Set<string>();
  for (const suggestion of suggestions) {
    if (
      !suggestion || typeof suggestion.speakerId !== "string" || !allowed.has(suggestion.speakerId) ||
      seen.has(suggestion.speakerId) || typeof suggestion.name !== "string" || !suggestion.name.trim()
    ) throw new MeetingProcessingFailure("speaker-name-json-invalid", "failed");
    seen.add(suggestion.speakerId);
  }
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function errorCodeOf(value: unknown): string {
  const code = value && typeof value === "object" && "code" in value && typeof value.code === "string"
    ? value.code
    : "speaker-name-failed";
  return code.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 128);
}

function actionErrorCode(value: unknown): string {
  const code = value && typeof value === "object" && "code" in value && typeof value.code === "string"
    ? value.code
    : "meeting-summary-action-failed";
  return code.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 128);
}
