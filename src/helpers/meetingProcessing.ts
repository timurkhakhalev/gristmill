import fs from "fs";
import {
  meetingProcessingConfigSchema,
  meetingProcessingResultDtoSchema,
  type MeetingProcessingConfig,
  type MeetingProcessingResultDto,
  type MeetingProcessingRunDto,
  type MeetingRecordingDto,
  type MeetingRecordingEpochDto,
  type MeetingSpeakerCorrection,
  type MeetingTranscriptArtifact,
} from "../contracts/meetingRecording.js";
import {
  meetingProcessingChannels,
  meetingProcessingCreateRunRequestSchema,
  meetingProcessingListRequestSchema,
  meetingProcessingListResponseSchema,
  meetingProcessingRetryRequestSchema,
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
import { prepareMeetingAudio, type MeetingAudioMixerDeps, type PreparedMeetingAudio } from "./meetingAudioMixer.js";
import { formatSpeakerTranscript, mergeSpeakersWithText } from "./speakerMerge.js";
import { byokFileSizeLimit } from "./transcriptionRoute.js";

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
  getNote(id: number): { content?: string | null; expected_speaker_count?: number | null } | null;
  createMeetingProcessingRun(recordingId: string, input: {
    kind: "reprocess" | "summary";
    config: MeetingProcessingConfig | null;
    configError?: { code: string; messageKey?: string } | null;
    sourceRunId?: string | null;
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
  setMeetingRunSpeakerCorrection(runId: string, speakerId: string, profileId: number | null, displayName: string): { success: boolean };
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
  getCredential: (reference: string | undefined, provider: string) => string;
  mixAudio?: (
    recording: MeetingRecordingDto,
    runId: string,
    epochs: MeetingRecordingEpochDto[],
    signal: AbortSignal
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
  ) => Promise<MeetingSpeakerCorrection[]>;
  mixerDeps?: MeetingAudioMixerDeps;
}

interface ActiveRun {
  runId: string;
  stage: MeetingProcessingRunDto["stage"];
  mode: MeetingProcessingConfig["transcription"]["mode"] | "summary-local" | "summary-remote";
  controller: AbortController;
}

export class MeetingProcessingWorker {
  private retentionReady = false;
  private captureActive = false;
  private active: ActiveRun | null = null;
  private work: Promise<void> | null = null;
  private workRequested = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly now: () => Date;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;

  constructor(private readonly deps: MeetingProcessingWorkerDeps) {
    deps.database.recoverRunningMeetingProcessingRuns();
    this.now = deps.now ?? (() => new Date());
    this.setTimer = deps.setTimeout ?? setTimeout;
    this.clearTimer = deps.clearTimeout ?? clearTimeout;
  }

  onRetentionReady(): void {
    this.retentionReady = true;
    this.processPending();
  }

  captureStarted(): void {
    this.captureActive = true;
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
  }

  cancelRun(runId: string): boolean {
    const run = this.deps.database.getMeetingProcessingRun(runId);
    if (!run || (run.status !== "pending" && run.status !== "running")) return false;
    if (this.active?.runId === runId) this.active.controller.abort();
    return this.deps.database.setMeetingProcessingRunState(runId, {
      stage: this.active?.runId === runId ? this.active.stage : "prepare",
      status: "cancelled",
      errorCode: "processing-cancelled",
      retryAt: null,
    }).success;
  }

  async cancelRecordingForDeletion(recordingId: string, includeNonAudio = false): Promise<void> {
    for (const run of this.deps.database.listMeetingProcessingRuns(recordingId)) {
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

  async selectRun(recordingId: string, runId: string): Promise<{ success: boolean; noteId?: number }> {
    const recording = this.deps.database.getMeetingRecording(recordingId);
    const run = this.deps.database.getMeetingProcessingRun(runId);
    if (!recording || !run || run.recordingId !== recordingId) return { success: false };
    const result = this.getResult(run);
    if (!result.transcript) return { success: false };
    const projection = result.transcript
      ? {
          transcript: serializeTranscriptProjection(result.transcript, result.speakerCorrections),
          summary: result.summary?.text ?? null,
          summaryPrompt: run.config?.summary?.instruction ?? null,
        }
      : null;
    const selected = this.deps.database.selectMeetingProcessingRun(recordingId, runId, projection);
    if (selected.success && selected.noteId !== undefined && projection) {
      this.deps.onNoteProjectionChanged?.(selected.noteId);
    }
    this.notify(run);
    return selected;
  }

  setSpeakerCorrection(input: { runId: string; speakerId: string; profileId: number | null; displayName: string }): boolean {
    const run = this.deps.database.getMeetingProcessingRun(input.runId);
    if (!run) return false;
    const transcriptRunId = run.kind === "summary" ? run.sourceRunId : run.id;
    if (!transcriptRunId) return false;
    const updated = this.deps.database.setMeetingRunSpeakerCorrection(
      transcriptRunId,
      input.speakerId,
      input.profileId,
      input.displayName
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
    const run = this.deps.database.createMeetingProcessingRun(parsed.recordingId, {
      kind: parsed.kind,
      config: parsed.config,
      configError: parsed.configError ?? null,
      sourceRunId: parsed.sourceRunId ?? null,
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
          captureState: recording.captureState,
          captureErrorCode: recording.captureErrorCode,
          audioState: recording.audioState,
          audioErrorCode: recording.audioErrorCode,
          currentRunId: recording.currentRunId,
          startedAt: recording.startedAt,
          endedAt: recording.endedAt,
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
    await this.work;
  }

  private async drainQueue(): Promise<void> {
    while (!this.stopped && this.retentionReady && !this.isCapturing()) {
      const now = this.now().toISOString();
      const pending = this.deps.database.listAllMeetingProcessingRuns()
        .filter((run) => run.status === "pending" && (!run.retryAt || Date.parse(run.retryAt) <= Date.parse(now)))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const run = pending.find((candidate) => this.deps.database.claimMeetingProcessingRun(candidate.id, now));
      if (!run) return;
      await this.processClaimedRun(run.id);
    }
  }

  private async processClaimedRun(runId: string): Promise<void> {
    const run = this.deps.database.getMeetingProcessingRun(runId);
    if (!run || run.status !== "running") return;
    const recording = this.deps.database.getMeetingRecording(run.recordingId);
    if (!recording) return;
    const config = run.config;
    const mode = run.stage === "summary"
      ? config?.summary?.reasoningMode === "local" ? "summary-local" : "summary-remote"
      : config?.transcription.mode ?? "providers";
    const active: ActiveRun = { runId, stage: run.stage, mode, controller: new AbortController() };
    this.active = active;
    try {
      if (run.stage === "prepare") {
        await this.prepare(run, recording, active.controller.signal);
      } else if (run.stage === "asr") {
        await this.transcribe(run, recording, active.controller.signal);
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
      if (current) this.notify(current);
    }
  }

  private async prepare(run: MeetingProcessingRunDto, recording: MeetingRecordingDto, signal: AbortSignal): Promise<void> {
    if (this.isCapturing()) return this.pause(run, "prepare");
    const config = this.requireConfig(run);
    const provider = config.transcription.mode === "local" ? null : supportedProvider(config.transcription.provider, config.transcription.model);
    if (config.transcription.mode === "providers" && !provider) {
      throw new MeetingProcessingFailure("unsupported-provider", "blocked");
    }
    const epochs = this.deps.database.listMeetingRecordingEpochs(recording.id);
    const mixer = this.deps.mixAudio ?? ((recordingValue, runId, epochValues, abortSignal) =>
      prepareMeetingAudio(this.deps.storage, recordingValue, runId, epochValues, {
        signal: abortSignal,
        deps: this.deps.mixerDeps,
      })
    );
    const audio = await mixer(recording, run.id, epochs, signal);
    signal.throwIfAborted();
    if (this.isCapturing()) return this.pause(run, "asr");
    if (provider && audio.sizeBytes > byokFileSizeLimit(provider)) {
      throw new MeetingProcessingFailure("provider-limit", "blocked");
    }
    if (provider === "gemini" && audio.durationSeconds > GEMINI_MAX_SECONDS) {
      throw new MeetingProcessingFailure("gemini-duration-limit", "blocked");
    }
    this.setState(run.id, "asr", "pending", null, null);
  }

  private async transcribe(run: MeetingProcessingRunDto, recording: MeetingRecordingDto, signal: AbortSignal): Promise<void> {
    const current = this.requireCurrentRun(run.id);
    if (current.hasRawProviderResponse) return this.setState(run.id, "normalize", "pending", null, null);
    if (this.isCapturing()) return this.pause(run, "asr");
    if (current.retryCount > AUTO_RETRY_LIMIT) {
      this.setState(run.id, "asr", "failed", current.errorCode ?? "asr-outcome-unknown", null);
      return;
    }
    if (recording.audioState !== "available") throw new MeetingProcessingFailure("audio-unavailable", "blocked");
    const config = this.requireConfig(run).transcription;
    const audioPath = this.deps.storage.getDerivedAudioPath(recording.id, run.id);
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
    const provider = supportedProvider(config.provider, config.model);
    if (!provider) throw new MeetingProcessingFailure("unsupported-provider", "blocked");
    if (fileSize > byokFileSizeLimit(provider)) throw new MeetingProcessingFailure("provider-limit", "blocked");
    if (provider === "gemini" && (recording.endedAt && recording.startedAt && (Date.parse(recording.endedAt) - Date.parse(recording.startedAt)) / 1000 > GEMINI_MAX_SECONDS)) {
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
      transcriptionMode: "providers",
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      requestId,
    };
    const result = await this.deps.transcribeRemote(request, async (response) => this.saveRawResponse(run.id, response), signal);
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
      if (transcript?.text.trim()) this.setState(run.id, "summary", "pending", null, null);
      else this.setState(run.id, "summary", "complete", null, null);
      return;
    }
    if (this.isCapturing()) return this.pause(run, "normalize");
    const config = this.requireConfig(run).transcription;
    const raw = this.deps.storage.readRunArtifact(run.id, "provider-response");
    if (raw === null) throw new MeetingProcessingFailure("provider-response-missing", "failed");
    const recordingDuration = timelineDuration(recording, this.deps.database.listMeetingRecordingEpochs(recording.id));
    let result: RemoteTranscriptionResult;
    if (config.mode === "local") {
      result = normalizeLocalResponse(raw);
      if (result.success && result.text?.trim() && config.local?.options?.diarize !== false) {
        if (this.isCapturing()) return this.pause(run, "normalize");
        const audioPath = this.deps.storage.getDerivedAudioPath(recording.id, run.id);
        if (!(this.deps.fileSize ?? ((filePath) => fs.statSync(filePath).size))(audioPath)) {
          const mixer = this.deps.mixAudio ?? ((recordingValue, runId, epochValues, abortSignal) =>
            prepareMeetingAudio(this.deps.storage, recordingValue, runId, epochValues, {
              signal: abortSignal,
              deps: this.deps.mixerDeps,
            })
          );
          await mixer(recording, run.id, this.deps.database.listMeetingRecordingEpochs(recording.id), signal);
        }
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
      const provider = supportedProvider(config.provider, config.model);
      if (!provider) throw new MeetingProcessingFailure("unsupported-provider", "blocked");
      result = normalizeProviderResponse(provider, raw);
    }
    if (!result.success || typeof result.text !== "string") {
      throw new MeetingProcessingFailure(result.code || "provider-response-invalid", "failed", result.error);
    }
    const transcript = validateTranscript(result, recordingDuration, config.mode === "providers" && !!result.text.trim());
    this.deps.storage.writeRunArtifact(run.id, "transcript", transcript);
    if (!this.deps.database.setMeetingRunArtifact(run.id, "transcript").success) {
      this.deps.storage.removeRunArtifact(run.id, "transcript");
      throw new MeetingProcessingFailure("transcript-state-not-saved", "failed");
    }
    if (this.deps.recognizeSpeakers && recording.audioState === "available" && transcript.segments?.length) {
      const audioPath = this.deps.storage.getDerivedAudioPath(recording.id, run.id);
      const corrections = await this.deps.recognizeSpeakers(recording, run, transcript, audioPath, signal);
      signal.throwIfAborted();
      for (const correction of corrections) {
        if (this.deps.database.getMeetingRunSpeakerCorrections(run.id).some((existing) => existing.speakerId === correction.speakerId)) {
          continue;
        }
        this.deps.database.setMeetingRunSpeakerCorrection(
          run.id,
          correction.speakerId,
          correction.profileId,
          correction.displayName
        );
      }
      if (corrections.length) this.deps.onNoteProjectionChanged?.(recording.noteId);
    }
    this.publishCurrentSelection(run.id);
    if (!transcript.text.trim()) this.setState(run.id, "summary", "complete", null, null);
    else if (this.requireConfig(run).summary) this.setState(run.id, "summary", "pending", null, null);
    else this.setState(run.id, "summary", "blocked", "missing-summary-config", null);
  }

  private async summarize(run: MeetingProcessingRunDto, recording: MeetingRecordingDto, signal: AbortSignal): Promise<void> {
    const current = this.requireCurrentRun(run.id);
    if (current.hasSummary) return this.setState(run.id, "summary", "complete", null, null);
    if (this.isCapturing()) return this.pause(run, "summary");
    const config = this.requireConfig(run);
    const transcriptRun = run.kind === "summary" ? run.sourceRunId : run.id;
    if (!transcriptRun) throw new MeetingProcessingFailure("summary-transcript-missing", "blocked");
    const transcript = this.readTranscript(transcriptRun);
    if (!transcript) throw new MeetingProcessingFailure("summary-transcript-missing", "blocked");
    if (!transcript.text.trim()) return this.setState(run.id, "summary", "complete", null, null);
    const summaryConfig = config.summary;
    if (!summaryConfig) throw new MeetingProcessingFailure("missing-summary-config", "blocked");
    const note = this.deps.database.getNote(recording.noteId);
    const manual = note?.content ?? "";
    const input = [manual.trim() ? `## Manual Notes\n${manual}` : "", `## Transcript\n${transcript.text}`]
      .filter(Boolean).join("\n\n");
    const generated = await this.deps.summarize(input, summaryConfig, signal);
    signal.throwIfAborted();
    if (!generated.trim()) throw new MeetingProcessingFailure("summary-empty-output", "failed");
    const summary = meetingSummaryArtifactSchema.parse({ text: generated.trim() });
    this.deps.storage.writeRunArtifact(run.id, "summary", summary);
    if (!this.deps.database.setMeetingRunArtifact(run.id, "summary").success) {
      this.deps.storage.removeRunArtifact(run.id, "summary");
      throw new MeetingProcessingFailure("summary-state-not-saved", "failed");
    }
    this.publishCurrentSelection(run.id);
    this.setState(run.id, "summary", "complete", null, null);
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
    const summaryValue = run.hasSummary ? this.deps.storage.readRunArtifact(run.id, "summary") : null;
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
      summaryPrompt: run.config?.summary?.instruction ?? null,
    });
    if (projection.success && projection.noteId !== undefined) {
      this.deps.onNoteProjectionChanged?.(projection.noteId);
    }
  }

  private notify(run: MeetingProcessingRunDto): void {
    this.deps.onChanged?.(run.recordingId, run.id);
  }

  private isCapturing(): boolean {
    return this.captureActive || this.deps.isCaptureActive();
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
}

export function normalizeProviderResponse(provider: "deepgram" | "elevenlabs" | "gemini" | "openai", raw: unknown): RemoteTranscriptionResult {
  if (provider === "deepgram") return parseDeepgramFileResponse(raw, true);
  if (provider === "elevenlabs") return parseElevenLabsFileResponse(raw, true);
  if (provider === "openai") return parseOpenAIFileResponse(raw, true);
  return parseGeminiFileResponse(raw, true);
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

function supportedProvider(provider: string | undefined, model: string | undefined): "deepgram" | "elevenlabs" | "gemini" | "openai" | null {
  if (provider === "deepgram" && (!model || model.startsWith("nova-"))) return "deepgram";
  if (provider === "elevenlabs" && (!model || model === "scribe_v2")) return "elevenlabs";
  if (provider === "gemini" && (!model || model === "gemini-3.5-transcribe")) return "gemini";
  if (provider === "openai" && (!model || ["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "gpt-4o-transcribe-diarize"].includes(model))) return "openai";
  return null;
}

function providerModel(model: string | undefined, provider: "deepgram" | "elevenlabs" | "gemini" | "openai"): string {
  return model || (provider === "deepgram" ? "nova-3" : provider === "elevenlabs" ? "scribe_v2" : provider === "gemini" ? "gemini-3.5-transcribe" : "gpt-4o-transcribe-diarize");
}

function serializeTranscriptProjection(
  transcript: MeetingTranscriptArtifact,
  corrections: MeetingSpeakerCorrection[]
): string {
  if (!transcript.segments?.length) {
    return JSON.stringify(transcript.text ? [{ text: transcript.text, timestamp: 0 }] : []);
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
        speakerLockSource: "user",
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
  const frames = Math.max(
    ...epochs.map((epoch) => epoch.startFrame + epoch.frameCount),
    recording.endedAt ? Math.round((Date.parse(recording.endedAt) - Date.parse(recording.startedAt)) * 24) : 0
  );
  return frames / 24_000;
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
  if (["api-key-missing", "invalid-key", "INVALID_KEY", "API_KEY_MISSING", "reasoning-model-missing", "reasoning-endpoint-missing", "reasoning-endpoint-invalid", "reasoning-provider-missing", "unsupported-reasoning-provider", "unsupported-enterprise-reasoning-route", "enterprise-reasoning-unavailable", "SELF_HOSTED_ENDPOINT_INVALID", "DIARIZATION_MODEL_MISSING", "MODEL_NOT_DOWNLOADED", "MODEL_NOT_FOUND", "LLAMASERVER_NOT_FOUND", "LOCAL_SERVER_UNAVAILABLE"].includes(code)) {
    return new MeetingProcessingFailure(code, "blocked", error.message);
  }
  return new MeetingProcessingFailure(code, "failed", error.message);
}
