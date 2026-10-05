import { meetingCoordinatorChannels } from "../contracts/meetingCoordinator.js";
import { companionConfigureActionSchema } from "../contracts/companion.js";
import os from "node:os";
import { isDevelopmentChannel } from "./appChannel.js";
import {
  installCompanionHost,
  uninstallCompanionHost,
  companionHostInstalled,
  refreshCompanionHost,
} from "./installCompanionHost.js";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  shell,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import debugLogger from "./debugLogger.js";
import { getModelType, isSherpaLocalProvider } from "./parakeetModelInfo.js";
import { broadcastToWindows } from "./windowBroadcast.js";
import { extractAnthropicText, describeMissingAnthropicText } from "./anthropicResponse.js";
import {
  isEnterpriseProvider,
  mapEnterpriseError,
  runAbortableOperation,
  runBedrockRequest,
  validateEnterpriseEndpoint,
} from "./enterpriseProviderErrors.js";
// The renderer's ModelRegistry is not main-loadable; the raw registry data is
// packaged, and the route resolver only needs {id, baseUrl} per provider.
import modelRegistryData from "../models/modelRegistryData.json";
import whisperVadDefaults from "../constants/whisperVad.json";
import { MAX_SPEAKER_COUNT } from "../constants/speakerDetection.json";
import { approveAudioPath, resolveAllowedAudioPath } from "./audioPathAllowlist.js";
import { openSystemSettings } from "./systemSettingsLauncher.js";
import { NoteWriteService } from "./noteWriteService.js";
import { registerNotesHandlers } from "./notesIpcHandlers.js";
import { registerUrlDownloadHandlers } from "./urlDownloadIpcHandlers.js";
import { registerMeetingCompanionHandlers } from "./meetingCompanionWindow.js";
import { registerVocabularyHandlers } from "./vocabularyIpcHandlers.js";
import { registerContainerHandlers } from "./containerIpcHandlers.js";
import { registerChatPersistenceHandlers } from "./chatPersistenceIpcHandlers.js";
import { registerActionsHandlers } from "./actionsIpcHandlers.js";
import {
  registerLocalFileTranscriptionHandler,
  type TranscriptionHandlerDeps,
} from "./localFileTranscriptionIpcHandler.js";
import { transcribeLocalFile } from "./localFileTranscription.js";
import {
  applyConfirmedSpeaker,
  canAutoRelabelSpeaker,
  type SpeakerSegment,
} from "./speakerAssignmentPolicy.js";
import { sendNoteUpdated, sendNoteDeleted } from "./notesEvents.js";
import { getCortiToken } from "./cortiAuth.js";
import { transcribeWithTinfoil } from "./tinfoilTranscription.js";
import { probeGeminiAudioDuration, transcribeGeminiFile } from "./geminiFileTranscription.js";
import { AudioStorageManager } from "./audioStorage.js";
import { AgentStreamRequestRegistry } from "./agentStreamRequestRegistry.js";
import { createUploadCancelRegistry } from "./uploadCancelRegistry.js";
import { LocalModelDownloadStatus } from "./localModelDownloadStatus.js";
import {
  DEFAULT_WHISPER_VAD_CONFIG,
  resolveContextSileroEnabled,
  sanitizeWhisperVadConfig,
} from "./whisperVadConfig.js";
import { DEFAULT_RETENTION_SETTINGS, type RetentionSettings } from "./retentionSettings.js";
import { registerCalendarAvailabilityHandler } from "./calendarAvailabilityIpcHandler.js";
import { registerCalendarIntegrationHandlers } from "./calendarIpcHandlers.js";
import { registerNoteFilesHandlers } from "./noteFilesIpcHandlers.js";
import { registerLocalModelLifecycleHandlers } from "./localModelLifecycleIpcHandlers.js";
import { registerLocalLlmModelHandlers } from "./localLlmModelIpcHandlers.js";
import {
  registerMeetingCoordinatorHandlers,
  type MeetingCoordinatorRuntime,
} from "./meetingCoordinatorIpcHandlers.js";
import { registerSpeakerHandlers } from "./speakerIpcHandlers.js";
import {
  registerRemoteTranscriptionHandler,
  transcribeAudioFileByok,
  type RemoteTranscriptionDeps,
} from "./remoteTranscriptionIpcHandler.js";
import { postRawAudioFile } from "./audioFileUpload.js";
import { registerReasoningHandlers, type EnterpriseStreamModel } from "./reasoningIpcHandlers.js";
import { registerBbHandlers } from "./bbIpcHandlers.js";
import { createBbTextConversation, generateBbSummary } from "./bbSummary.js";
import { ensureBbWorkspace } from "./bbWorkspace.js";
import { NoteReadService } from "./noteReadService.js";
import { registerFileDiarizationHandlers } from "./fileDiarizationIpcHandlers.js";
import { registerUploadCancelHandler } from "./uploadCancelIpcHandler.js";
import { registerTranscriptionExecutionHandlers } from "./transcriptionExecutionIpcHandlers.js";
import type { LocalModelDownloadState } from "./localModelDownloadStatus.js";
import type { MergedSpeakerSegment } from "./speakerMerge.js";
import type { ModelManager } from "./modelManagerBridge.js";
import type { DiarizationSegment } from "./diarization.js";
import type { LlmModelManagerLike, LlmDownloadStatusTracker } from "./localLlmModelIpcHandlers.js";
import type { WhisperManagerLike, ParakeetManagerLike } from "./localModelLifecycleIpcHandlers.js";
import { registerTranscriptionDataHandlers } from "./transcriptionDataIpcHandlers.js";
import { MeetingProcessingWorker, registerMeetingProcessingHandlers } from "./meetingProcessing.js";
import {
  meetingProcessingChannels,
  meetingRecordingPlaybackRequestSchema,
  meetingRecordingPlaybackReleaseSchema,
  meetingRecordingExportRequestSchema,
  meetingRecordingAudioRequestSchema,
} from "../contracts/meetingProcessing.js";
import {
  canPlayMeetingRun,
  createMeetingAudioOperationRegistry,
  exportMeetingMixedMp3,
  exportMeetingSourceTrack,
} from "./meetingAudioExport.js";
import { composeMeetingAudioParts, prepareMeetingAudio } from "./meetingAudioMixer.js";
import { recognizeMeetingSpeakers } from "./meetingSpeakerRecognition.js";
import { createMeetingTextConversation, generateMeetingSummary } from "./meetingSummary.js";
import { meetingNamingInstruction, suggestMeetingSpeakerNames } from "./meetingSpeakerNaming.js";
import { BYOK_API_KEYS } from "../config/secretKeys.js";
import { registerDesktopSettingsHandlers } from "./desktopSettingsIpcHandlers.js";
import { listLocalTranscriptionModels } from "./localTranscriptionModels.js";
import { getEnterpriseAIModel } from "./enterpriseAiProviders.js";
import markdownMirror from "./markdownMirror.js";
import modelManagerBundle from "./modelManagerBridge.js";
import localReasoningBridge from "../services/localReasoningBridge.js";
import type { NoteItem } from "../contracts/notes.js";
import type { TranscriptionResponse } from "../contracts/localFileTranscription.js";
import type { EnvironmentManagerWithByok } from "./environment.js";
import type { DatabaseManager, SpeakerProfileWithEmbedding } from "./database.js";
import type { WhisperManager } from "./whisper.js";
import type { ParakeetManager } from "./parakeet.js";
import type { DiarizationManager } from "./diarization.js";
import type { WindowManager } from "./windowManager.js";
import type { GoogleCalendarManager } from "./googleCalendarManager.js";
import type { MicrosoftCalendarManager } from "./microsoftCalendarManager.js";
import type { AppleCalendarManager } from "./appleCalendarManager.js";
import type { MeetingDetectionEngine } from "./meetingDetectionEngine.js";
import type { AudioTapManager } from "./audioTapManager.js";
import type { TrayManager } from "./tray.js";

const transcriptionProviderBaseUrls = () => modelRegistryData.transcriptionProviders;

// The bundle's `default` is the ModelManager singleton under every loader; the
// default import resolves to the module.exports wrapper, so drill in once
// (same interop note as localReasoningBridge.ts). Eager is fine: the llm
// lifecycle deps already materialized the manager during setupHandlers.
const modelManager = (modelManagerBundle as unknown as { default: ModelManager }).default;

interface IPCHandlersManagerOptions {
  environmentManager: EnvironmentManagerWithByok;
  databaseManager: DatabaseManager;
  whisperManager: WhisperManager;
  parakeetManager: ParakeetManager;
  diarizationManager: DiarizationManager;
  windowManager: WindowManager;
  googleCalendarManager: GoogleCalendarManager;
  microsoftCalendarManager: MicrosoftCalendarManager;
  appleCalendarManager: AppleCalendarManager;
  meetingDetectionEngine: MeetingDetectionEngine;
  audioTapManager: AudioTapManager;
  getTrayManager: () => TrayManager | null;
  oauthProtocolRegistered: boolean;
  oauthProtocol: string;
}

// The multipart transport behind the remote transcription handler. Kept here
// (not in the typed module) because it owns the Electron net session; the
// handler receives it as a narrow dependency.
async function postMultipart(
  url: URL,
  body: Buffer,
  boundary: string,
  headers: Record<string, string> = {},
  { signal }: { signal?: AbortSignal } = {}
): Promise<{ statusCode: number; data: unknown }> {
  // Electron's RequestInit typing predates useSessionCookies; the runtime
  // honors it, and a typed variable carries the extra flag past excess-property
  // checks without a cast.
  const fetchInit: RequestInit & { useSessionCookies?: boolean } = {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      ...headers,
    },
    body: body as unknown as NonNullable<RequestInit["body"]>,
    useSessionCookies: false,
    signal,
  };

  const response = await net.fetch(url.toString(), fetchInit);
  const text = await response.text();

  try {
    return { statusCode: response.status, data: JSON.parse(text) };
  } catch {
    // Vercel platform errors (413 payload cap, 504 timeout) return non-JSON bodies.
    throw Object.assign(new Error(`Server error ${response.status}: ${text.slice(0, 120)}`), {
      code: "SERVER_ERROR",
      statusCode: response.status,
    });
  }
}

function runGeminiFile(request: Parameters<typeof transcribeGeminiFile>[0]) {
  return transcribeGeminiFile(request, {
    fetch: (url, init) => {
      const fetchInit: RequestInit & { useSessionCookies?: boolean } = {
        ...init,
        useSessionCookies: false,
      };

      return net.fetch(url, fetchInit);
    },
    probeDuration: probeGeminiAudioDuration,
  });
}

export class IPCHandlers {
  environmentManager: EnvironmentManagerWithByok;
  databaseManager: DatabaseManager;
  readonly noteWrites: NoteWriteService;
  whisperManager: WhisperManager;
  parakeetManager: ParakeetManager;
  diarizationManager: DiarizationManager;
  windowManager: WindowManager;
  getTrayManager: () => TrayManager | null;
  googleCalendarManager: GoogleCalendarManager;
  microsoftCalendarManager: MicrosoftCalendarManager;
  appleCalendarManager: AppleCalendarManager;
  meetingDetectionEngine: MeetingDetectionEngine;
  audioTapManager: AudioTapManager;
  oauthProtocolRegistered: boolean;
  oauthProtocol: string;
  sessionId: string;
  // requestId -> AbortControllers for in-flight audio-upload work, so a
  // cancel can abort the exact job.
  _uploadCancelRegistry: ReturnType<typeof createUploadCancelRegistry>;
  _enterpriseReasoningRequests: AgentStreamRequestRegistry;
  // Enterprise streams get their own registry so cancelling a Bedrock
  // one-shot cleanup never aborts a live chat stream or vice versa.
  _enterpriseStreams: AgentStreamRequestRegistry;
  // webContents id -> its release listener, for renderers holding the mic open.
  _hotkeyCaptureMode: boolean;
  audioStorageManager: AudioStorageManager;
  localModelDownloadStatus: LocalModelDownloadStatus;
  _retentionCleanupInterval: NodeJS.Timeout | null;
  _retentionSettings: RetentionSettings; // Synced from renderer
  _retentionSettingsSynced: boolean;
  _noteFilesEnabled: boolean;
  _granolaImportPending: import("./noteFilesIpcHandlers.js").GranolaImportState | null;
  whisperVadSettings: Record<string, unknown>;
  _meetingCoordinator: MeetingCoordinatorRuntime | null = null;
  _meetingProcessing: MeetingProcessingWorker | null = null;
  _meetingAudioOperations: ReturnType<typeof createMeetingAudioOperationRegistry>;
  _meetingRecoveryReady = false;

  constructor(managers: IPCHandlersManagerOptions) {
    this.environmentManager = managers.environmentManager;
    this.databaseManager = managers.databaseManager;
    this.whisperManager = managers.whisperManager;
    this.parakeetManager = managers.parakeetManager;
    this.diarizationManager = managers.diarizationManager;
    this.windowManager = managers.windowManager;
    this.getTrayManager = managers.getTrayManager;
    this.googleCalendarManager = managers.googleCalendarManager;
    this.microsoftCalendarManager = managers.microsoftCalendarManager;
    this.appleCalendarManager = managers.appleCalendarManager;
    this.meetingDetectionEngine = managers.meetingDetectionEngine;
    this.audioTapManager = managers.audioTapManager;
    this.oauthProtocolRegistered = managers.oauthProtocolRegistered === true;
    this.oauthProtocol = managers.oauthProtocol || "gristmill";
    this.sessionId = crypto.randomUUID();
    this._uploadCancelRegistry = createUploadCancelRegistry();
    this._enterpriseReasoningRequests = new AgentStreamRequestRegistry();
    this._enterpriseStreams = new AgentStreamRequestRegistry();
    this._meetingAudioOperations = createMeetingAudioOperationRegistry();
    this._hotkeyCaptureMode = false;
    this.audioStorageManager = new AudioStorageManager();
    this.localModelDownloadStatus = new LocalModelDownloadStatus();
    this._retentionCleanupInterval = null;
    this._retentionSettings = { ...DEFAULT_RETENTION_SETTINGS };
    this._retentionSettingsSynced = false;
    this._noteFilesEnabled = false;
    this._granolaImportPending = null;
    this.whisperVadSettings = {
      noteRecordingSileroEnabled: true,
      meetingSileroEnabled: true,
      ...DEFAULT_WHISPER_VAD_CONFIG,
    };

    try {
      this.audioStorageManager.meetingRecordings.recover(this.databaseManager);
      this._meetingRecoveryReady = true;
    } catch (error) {
      debugLogger.error(
        "Meeting recording recovery failed; background processing is paused",
        {
          error: error instanceof Error ? error.message : String(error),
        },
        "meeting"
      );
    }

    this.noteWrites = new NoteWriteService({
      database: this.databaseManager,
      mirrorWrite: (note) => this._asyncMirrorWrite(note),
      refreshMeetingSpeakerConfigFromNote: (noteId, note) =>
        this._meetingCoordinator?.refreshMeetingSpeakerConfigFromNote(noteId, note),
    });
    this.meetingDetectionEngine.onNoteSaved = (noteId) => this._asyncMirrorWrite({ id: noteId });
    this._setupRetentionCleanup();
    this.setupHandlers();
  }

  // The dictation slot reports its own changes from the renderer. Slots
  // registered through IPC have to announce theirs here so macOS can re-derive
  // which keys the native Globe listener owns.
  _notifyHotkeyChanged(hotkey: string): void {
    ipcMain.emit("hotkey-changed", null, hotkey);
  }

  _getWhisperVadSettings(): Record<string, unknown> {
    const current = this.whisperVadSettings || {};

    return {
      noteRecordingSileroEnabled: current.noteRecordingSileroEnabled !== false,
      meetingSileroEnabled: current.meetingSileroEnabled !== false,
      ...sanitizeWhisperVadConfig(current as Record<string, unknown>),
    };
  }

  _updateNativeModelDownloadStatus(
    modelType: string,
    modelId: string,
    progressData: {
      type?: string;
      percentage?: number | null;
      downloaded_bytes?: number | null;
      total_bytes?: number | null;
    }
  ): LocalModelDownloadState | null {
    if (progressData.type === "complete") {
      return this.localModelDownloadStatus.finish(modelType, modelId);
    }

    if (progressData.type === "installing") {
      return this.localModelDownloadStatus.update(modelType, modelId, {
        phase: "installing",
        progress: progressData.percentage || 100,
      });
    }

    return this.localModelDownloadStatus.update(modelType, modelId, {
      phase: "downloading",
      progress: progressData.percentage || 0,
      downloadedBytes: progressData.downloaded_bytes || 0,
      totalBytes: progressData.total_bytes || 0,
    });
  }

  _setWhisperVadSettings(update: Record<string, unknown> = {}): Record<string, unknown> {
    const ALLOWED_KEYS = new Set([
      "noteRecordingSileroEnabled",
      "meetingSileroEnabled",
      ...Object.keys(whisperVadDefaults.DEFAULTS),
    ]);

    const filtered: Record<string, unknown> = {};

    for (const [k, v] of Object.entries(update)) {
      if (ALLOWED_KEYS.has(k)) filtered[k] = v;
    }

    this.whisperVadSettings = { ...this._getWhisperVadSettings(), ...filtered };

    return this._getWhisperVadSettings();
  }

  // Shared by the upload IPC handler and the CLI bridge. `filePath` must
  // already have passed resolveAllowedAudioPath (or approveAudioPath).
  // Delegates to the shared module; the IPC handler passes the same deps.
  async transcribeLocalFile(
    filePath: string,
    options: Record<string, unknown> = {}
  ): Promise<TranscriptionResponse> {
    const { transcribeLocalFile: execute } =
      require("./localFileTranscription") as typeof import("./localFileTranscription.js");

    return execute(
      {
        readFile: (p: string) => fs.readFileSync(p),
        isSherpaLocalProvider: (provider: unknown) => isSherpaLocalProvider(provider),
        transcribeLocalWhisper: (audioBuffer: Buffer, opts: unknown) =>
          this._transcribeLocalWhisper(audioBuffer, opts),
        transcribeLocalParakeet: (audioBuffer: Buffer, opts: unknown) =>
          this._transcribeLocalParakeet(audioBuffer, opts),
        resolveWhisperVadOptions: (context: string) => this._resolveWhisperVadOptions(context),
      },
      filePath,
      options
    );
  }

  approveAudioPath(filePath: string): void {
    approveAudioPath(filePath);
  }

  listLocalTranscriptionModels() {
    return listLocalTranscriptionModels({
      whisperManager: this.whisperManager,
      parakeetManager: this.parakeetManager,
    });
  }

  _resolveWhisperVadOptions(context: string) {
    const settings = this._getWhisperVadSettings();

    const {
      noteRecordingSileroEnabled: _noteRecordingSilero,
      meetingSileroEnabled: _meetingSilero,
      ...vadConfig
    } = settings;

    return {
      vadEnabled: resolveContextSileroEnabled(settings as Record<string, unknown>, context),
      vadConfig,
    };
  }

  // Narrow adapters for the typed verticals: they treat payloads as unknown,
  // the managers own their own narrowing at the boundary.
  _transcribeLocalWhisper(audioBuffer: unknown, options: unknown): Promise<unknown> {
    return this.whisperManager.transcribeLocalWhisper(
      audioBuffer as Buffer,
      options as Record<string, unknown> | undefined
    );
  }

  _transcribeLocalParakeet(audioBuffer: unknown, options: unknown): Promise<unknown> {
    return this.parakeetManager.transcribeLocalParakeet(
      audioBuffer as Buffer,
      options as Record<string, unknown> | undefined
    );
  }

  _mirrorDeleteFolderIfUnshared(folderName: string, relocatedNoteIds: number[]): void {
    if (!this._noteFilesEnabled) return;

    // Folder rows are hard-deleted (no deleted_at column): a live same-named
    // folder in another space shares the mirror directory, so leave it on disk.
    const stillLive = this.databaseManager.db
      .prepare("SELECT 1 FROM folders WHERE name = ?")
      .get(folderName);

    // Notes whose primary folder was the deleted one survive with a moved
    // folder_id (next extra folder) or NULL (falls back to the Personal
    // directory). Queue reprojection at the surviving location. Personal is
    // always shared with root notes and must never be removed as a directory.
    // The ids are per-call (closed over in the handler), not instance state.
    for (const noteId of relocatedNoteIds) {
      const note = this.databaseManager.getNote(noteId);

      if (note) this._asyncMirrorWrite(note as unknown as NoteItem);
    }

    if (!stillLive && folderName !== "Personal") markdownMirror.deleteFolder(folderName);
  }

  _mirrorRenameFolder(oldName: string, newName: string): void {
    if (!this._noteFilesEnabled) return;

    try {
      // A directory can contain root notes or notes from same-named folders.
      // Reproject only notes assigned to the new name; never move it wholesale.
      const ids = this.databaseManager.db
        .prepare(
          "SELECT notes.id FROM notes JOIN folders ON folders.id = notes.folder_id WHERE folders.name = ?"
        )
        .all(newName) as Array<{ id: number }>;

      for (const { id } of ids) {
        const note = this.databaseManager.getNote(id);

        if (!note) continue;
        markdownMirror.writeNote(note, newName);

        if (note.transcript)
          markdownMirror.writeTranscript(note, newName, this._buildSpeakerMappings(id));
      }

      const shared = this.databaseManager.db
        .prepare("SELECT 1 FROM folders WHERE name = ?")
        .get(oldName);

      if (!shared && oldName !== "Personal") markdownMirror.deleteFolder(oldName);
    } catch (error) {
      debugLogger.error(
        "Note mirror rename failed after commit",
        { error: String(error) },
        "note-files"
      );
    }
  }

  _asyncMirrorWrite(note: Pick<NoteItem, "id">): void {
    if (!this._noteFilesEnabled) {
      debugLogger.debug(
        "Mirror write skipped: note files disabled",
        { noteId: note.id },
        "note-files"
      );

      return;
    }

    setImmediate(() => {
      if (!this._noteFilesEnabled) return;

      try {
        const current = this.databaseManager.getNote(note.id);

        if (!current) return;
        const folderName = this._getFolderName(current.folder_id);
        markdownMirror.writeNote(current, folderName);
        markdownMirror.writeTranscript(current, folderName, this._buildSpeakerMappings(note.id));
      } catch (error) {
        debugLogger.error(
          "Note mirror failed after commit",
          {
            noteId: note.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "note-files"
        );
      }
    });
  }

  _publishMeetingNoteProjection(noteId: number): void {
    const note = this.databaseManager.getNote(noteId);

    if (!note) return;
    sendNoteUpdated(note);
    this._asyncMirrorWrite(note);
  }

  _asyncMirrorDelete(noteId: number): void {
    if (!this._noteFilesEnabled) {
      debugLogger.debug("Mirror delete skipped: note files disabled", { noteId }, "note-files");

      return;
    }

    setImmediate(() => {
      if (!this._noteFilesEnabled) return;
      markdownMirror.deleteNote(noteId);
    });
  }

  _buildFolderMap(): Record<number, string> {
    const folders = this.databaseManager.getFolders();
    const map: Record<number, string> = {};

    for (const f of folders) {
      map[f.id] = f.name;
    }

    return map;
  }

  _buildSpeakerMappings(noteId: number): Record<string, string> {
    const arr = this.databaseManager.getSpeakerMappings(noteId);
    const map: Record<string, string> = {};

    for (const m of arr) {
      map[m.speaker_id] = m.display_name;
    }

    return map;
  }

  _resolveOneOnOneOtherParticipant(participantsJson: string | null | undefined) {
    return this._meetingCoordinator?.resolveOneOnOneOtherParticipant(participantsJson) ?? null;
  }

  _rebuildMirror(basePath: string | undefined): void {
    if (basePath) markdownMirror.init(basePath);
    const notes = this.databaseManager.getNotes(null, 99999);
    const speakerMappingsMap: Record<string, Record<string, string>> = {};

    for (const note of notes) {
      if (note.transcript) {
        speakerMappingsMap[note.id] = this._buildSpeakerMappings(note.id);
      }
    }

    markdownMirror.rebuildAll(notes, this._buildFolderMap(), speakerMappingsMap);
  }

  _getFolderName(folderId: number | null | undefined): string {
    if (!folderId) return "Personal";

    const folder = this.databaseManager.db
      .prepare("SELECT name FROM folders WHERE id = ?")
      .get(folderId) as { name?: string } | undefined;

    return folder?.name || "Personal";
  }

  _getDictionarySafe(): unknown[] {
    try {
      return this.databaseManager.getDictionary();
    } catch {
      return [];
    }
  }

  _setupRetentionCleanup(): void {
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
    // No sweep at startup: _retentionSettings still holds an unverified default
    // until the renderer syncs, so sweeping here deletes audio a user set to
    // keep for 60/90 days or forever (#1370). The first sync runs the first
    // sweep instead.
    this._retentionCleanupInterval = setInterval(() => {
      if (this._retentionSettingsSynced) {
        void this._runRetentionCleanup().then((ready) => {
          if (ready) this._meetingProcessing?.onRetentionReady();
        });
      }
    }, SIX_HOURS_MS);
  }

  async _runRetentionCleanup(): Promise<boolean> {
    const { audioRetentionDays, transcriptRetentionDays } = this._retentionSettings;

    try {
      // Durable deletion intents from a previous process must settle before the
      // worker can read any recording or result belonging to them.
      let ready = await this._processMeetingDeletionIntents();

      if (transcriptRetentionDays > 0) {
        const { ids } =
          this.databaseManager.deleteTranscriptionsExpiredBefore(transcriptRetentionDays);

        for (const id of ids) {
          this.audioStorageManager.deleteAudio(id);
          broadcastToWindows("transcription-deleted", { id });
        }
      }

      if (audioRetentionDays > 0) {
        this.audioStorageManager.cleanupExpiredAudio(audioRetentionDays, this.databaseManager);
        const cutoff = Date.now() - audioRetentionDays * 86_400_000;

        for (const recording of this.databaseManager.listAllMeetingRecordings()) {
          if (
            recording.audioState !== "available" ||
            recording.captureState === "recording" ||
            recording.captureState === "finalizing"
          )
            continue;
          const endedAt = recording.endedAt ? Date.parse(recording.endedAt) : NaN;

          if (!Number.isFinite(endedAt) || endedAt >= cutoff) continue;
          const intent = this.databaseManager.beginMeetingAudioDeletion(recording.id);

          if (intent && !(await this._finishMeetingDeletion(intent))) ready = false;
        }
      }

      return ready;
    } catch (error) {
      debugLogger.error(
        "Retention cleanup failed",
        { error: (error as Error).message },
        "audio-storage"
      );

      return false;
    }
  }

  async shutdownMeetingWork(): Promise<void> {
    // Each owner closes admission synchronously before its first await.
    const results = await Promise.allSettled([
      this._meetingProcessing?.stop(),
      this._meetingAudioOperations.stop(),
      this._meetingCoordinator?.shutdown(),
    ]);

    for (const result of results) if (result.status === "rejected") throw result.reason;
  }

  async _finishMeetingDeletion(
    intent: import("../contracts/meetingRecording.js").MeetingDeletionIntentDto
  ): Promise<boolean> {
    try {
      if (intent.kind === "audio") {
        if (!intent.recordingId) throw new Error("Invalid meeting audio deletion intent");

        const dependentAnchors = new Set(
          this.databaseManager
            .listAllMeetingProcessingRuns()
            .filter((run) => run.sourceRecordingIds.includes(intent.recordingId as string))
            .map((run) => run.recordingId)
        );

        dependentAnchors.add(intent.recordingId);
        await Promise.all(
          [...dependentAnchors].map((id) => this._meetingAudioOperations.cancelAndWait(id))
        );
        await this._meetingProcessing?.cancelRecordingForDeletion(intent.recordingId);
        this.audioStorageManager.meetingRecordings.removeRecordingAudio(intent.recordingId);

        if (!this.databaseManager.completeMeetingAudioDeletion(intent.id).success) {
          throw new Error("Meeting audio deletion state was not completed");
        }

        for (const run of this.databaseManager.listMeetingProcessingRuns(intent.recordingId)) {
          broadcastToWindows("meeting-processing-updated", {
            recordingId: intent.recordingId,
            runId: run.id,
          });
        }

        return true;
      }

      const { recordingIds, runIds } = this.databaseManager.getMeetingNoteStorageIds(intent.noteId);
      await Promise.all(
        recordingIds.map((recordingId) => this._meetingAudioOperations.cancelAndWait(recordingId))
      );
      await this._meetingProcessing?.cancelNoteForDeletion(intent.noteId);
      this.audioStorageManager.meetingRecordings.removeNoteFiles(recordingIds, runIds);

      if (!this.databaseManager.completeMeetingNoteDeletion(intent.id).success) {
        throw new Error("Meeting note deletion state was not completed");
      }

      setImmediate(() => sendNoteDeleted({ id: intent.noteId }));
      this._asyncMirrorDelete(intent.noteId);

      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      const safeCode =
        typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : "file-operation-failed";

      this.databaseManager.failMeetingDeletion(intent.id, safeCode);
      debugLogger.error(
        "Meeting recording deletion failed",
        {
          intentId: intent.id,
          kind: intent.kind,
          error: error instanceof Error ? error.message : String(error),
        },
        "audio-storage"
      );

      return false;
    }
  }

  async _processMeetingDeletionIntents(): Promise<boolean> {
    let success = true;

    for (const intent of this.databaseManager.listMeetingDeletionIntents()) {
      if (!(await this._finishMeetingDeletion(intent))) success = false;
    }

    return success;
  }

  async _deleteAllAudio(): Promise<{ deleted: number; failed: number }> {
    const expected = this._meetingCoordinator?.currentRecordingScope();

    if (expected) {
      const stopped = await this._meetingCoordinator!.requestSafeStop({
        expected,
        reason: "delete-audio",
        suppressProcessing: true,
      });

      if (!stopped.success) throw new Error("Active meeting recording could not be stopped safely");
    }

    const legacy = this.audioStorageManager.deleteAllAudio();
    let deleted = legacy.deleted;
    let failed = legacy.failed;

    for (const recording of this.databaseManager.listAllMeetingRecordings()) {
      if (recording.audioState === "deleted") continue;

      try {
        const intent = this.databaseManager.beginMeetingAudioDeletion(recording.id);

        if (!intent || !(await this._finishMeetingDeletion(intent))) failed += 1;
        else deleted += 1;
      } catch (error) {
        failed += 1;
        debugLogger.error(
          "Failed to delete meeting audio",
          {
            recordingId: recording.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "audio-storage"
        );
      }
    }

    return { deleted, failed };
  }

  _registerMeetingRecordingAssetHandlers(): void {
    const storage = this.audioStorageManager.meetingRecordings;
    const database = this.databaseManager;

    const leases = new Map<
      string,
      { recordingId: string; sender: WebContents; cleanup: () => void }
    >();

    const release = (id: string): boolean => {
      const lease = leases.get(id);

      if (!lease) return true;
      let success = true;

      try {
        storage.removeDerivedAudio(lease.recordingId, id);
      } catch {
        success = false;
        debugLogger.warn("Temporary meeting playback cleanup failed", {
          code: "meeting-playback-cleanup-failed",
        });
      }

      lease.sender.removeListener("destroyed", lease.cleanup);
      lease.sender.removeListener("render-process-gone", lease.cleanup);
      leases.delete(id);

      return success;
    };

    ipcMain.handle(meetingProcessingChannels.releasePlayback, (event, payload: unknown) => {
      const { leaseId } = meetingRecordingPlaybackReleaseSchema.parse(payload);
      const success = leases.get(leaseId)?.sender.id !== event.sender.id || release(leaseId);

      return { success, ...(success ? {} : { error: "meeting-playback-cleanup-failed" }) };
    });
    ipcMain.handle(meetingProcessingChannels.getPlaybackPath, async (event, payload: unknown) => {
      try {
        const parsed = meetingRecordingPlaybackRequestSchema.parse(payload);
        const recording = database.getMeetingRecording(parsed.recordingId);
        const run = parsed.runId ? database.getMeetingProcessingRun(parsed.runId) : null;

        if (
          !recording ||
          recording.audioState !== "available" ||
          (parsed.runId && (!run || run.recordingId !== recording.id))
        ) {
          return { success: false, error: "meeting-audio-unavailable" };
        }

        if (run && !canPlayMeetingRun(recording, run)) {
          return { success: false, error: "meeting-result-not-selected" };
        }

        return await this._meetingAudioOperations.run(recording.id, async (signal) => {
          if (signal.aborted) throw new Error("Meeting audio operation cancelled");
          const currentRecording = database.getMeetingRecording(recording.id);
          const currentRun = run ? database.getMeetingProcessingRun(run.id) : null;

          if (
            !currentRecording ||
            currentRecording.audioState !== "available" ||
            (run && (!currentRun || currentRun.recordingId !== currentRecording.id))
          ) {
            return { success: false, error: "meeting-audio-unavailable" };
          }

          if (currentRun && !canPlayMeetingRun(currentRecording, currentRun)) {
            return { success: false, error: "meeting-result-not-selected" };
          }

          const playbackId = crypto.randomUUID();
          let leased = false;

          try {
            const sources = currentRun?.sourceRecordingIds.map((id) =>
              database.getMeetingRecording(id)
            ) ?? [currentRecording];

            if (sources.some((source) => !source || source.audioState !== "available"))
              throw new Error("meeting-audio-part-unavailable");

            const combined = composeMeetingAudioParts(
              sources as NonNullable<typeof currentRecording>[],
              (id) => database.listMeetingRecordingEpochs(id)
            );

            const { path: audioPath } = await prepareMeetingAudio(
              storage,
              combined.recording,
              playbackId,
              combined.epochs,
              { signal }
            );

            signal.throwIfAborted();

            if (event.sender.isDestroyed()) throw new Error("Meeting player was closed");
            approveAudioPath(audioPath);
            const cleanup = () => release(playbackId);
            leases.set(playbackId, { recordingId: recording.id, sender: event.sender, cleanup });
            event.sender.once("destroyed", cleanup);
            event.sender.once("render-process-gone", cleanup);
            leased = true;

            return { success: true, path: audioPath, leaseId: playbackId };
          } finally {
            if (!leased) storage.removeDerivedAudio(recording.id, playbackId);
          }
        });
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

    ipcMain.handle(meetingProcessingChannels.exportAudio, async (_event, payload: unknown) => {
      try {
        const parsed = meetingRecordingExportRequestSchema.parse(payload);
        const recording = database.getMeetingRecording(parsed.recordingId);

        if (!recording || recording.audioState !== "available") {
          return { success: false, error: "meeting-audio-unavailable" };
        }

        const isMixed = parsed.source === "mixed";

        const result = await dialog.showSaveDialog({
          defaultPath: `Gristmill-meeting-${parsed.source}.${isMixed ? "mp3" : "wav"}`,
          filters: isMixed
            ? [{ name: "MP3 audio", extensions: ["mp3"] }]
            : [{ name: "WAV audio", extensions: ["wav"] }],
        });

        if (result.canceled || !result.filePath) return { success: false };
        const destination = path.resolve(result.filePath);

        if (!(await fs.promises.stat(path.dirname(destination))).isDirectory()) {
          throw new Error("Selected export folder is unavailable");
        }

        const currentRecording = database.getMeetingRecording(parsed.recordingId);

        if (!currentRecording || currentRecording.audioState !== "available") {
          return { success: false, error: "meeting-audio-unavailable" };
        }

        const runId = isMixed ? parsed.runId : null;
        const run = runId ? database.getMeetingProcessingRun(runId) : null;

        if (runId && (!run || run.recordingId !== currentRecording.id || !run.hasTranscript)) {
          return { success: false, error: "meeting-result-not-selected" };
        }

        return await this._meetingAudioOperations.run(currentRecording.id, async (signal) => {
          if (signal.aborted) throw new Error("Meeting audio operation cancelled");
          const latestRecording = database.getMeetingRecording(currentRecording.id);

          if (!latestRecording || latestRecording.audioState !== "available") {
            return { success: false, error: "meeting-audio-unavailable" };
          }

          if (parsed.source === "mic" || parsed.source === "system") {
            await exportMeetingSourceTrack(
              storage,
              latestRecording,
              parsed.source,
              database.listMeetingRecordingEpochs(latestRecording.id),
              destination,
              signal
            );

            return { success: true };
          }

          const latestRun = runId ? database.getMeetingProcessingRun(runId) : null;

          if (
            runId &&
            (!latestRun || latestRun.recordingId !== latestRecording.id || !latestRun.hasTranscript)
          ) {
            return { success: false, error: "meeting-result-not-selected" };
          }

          const mixId = crypto.randomUUID();
          const sourcePath = storage.getDerivedAudioPath(latestRecording.id, mixId);

          try {
            if (!fs.existsSync(sourcePath)) {
              const sources = latestRun
                ? latestRun.sourceRecordingIds.map((id) => database.getMeetingRecording(id))
                : [latestRecording];

              if (sources.some((source) => !source || source.audioState !== "available"))
                throw new Error("meeting-audio-part-unavailable");

              const combined = composeMeetingAudioParts(
                sources as NonNullable<typeof latestRecording>[],
                (id) => database.listMeetingRecordingEpochs(id)
              );

              await prepareMeetingAudio(storage, combined.recording, mixId, combined.epochs, {
                signal,
              });
            }

            await exportMeetingMixedMp3(sourcePath, destination, signal);

            return { success: true };
          } finally {
            storage.removeDerivedAudio(latestRecording.id, mixId);
          }
        });
      } catch (error) {
        debugLogger.error(
          "Meeting audio export failed",
          {
            error: error instanceof Error ? error.message : String(error),
          },
          "audio-storage"
        );

        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

    const deleteAudio = async (payload: unknown) => {
      const parsed = meetingRecordingAudioRequestSchema.parse(payload);
      const intent = database.beginMeetingAudioDeletion(parsed.recordingId);

      if (!intent) return { success: false, error: "meeting-audio-unavailable" };
      const success = await this._finishMeetingDeletion(intent);

      return { success, ...(success ? {} : { error: "meeting-audio-delete-failed" }) };
    };

    ipcMain.handle(meetingProcessingChannels.deleteAudio, (_event, payload: unknown) =>
      deleteAudio(payload)
    );
    ipcMain.handle(meetingProcessingChannels.retryAudioDeletion, (_event, payload: unknown) =>
      deleteAudio(payload)
    );
  }

  _syncStartupEnv(setVars: Record<string, string>, clearVars: string[] = []): void {
    let changed = false;

    for (const [key, value] of Object.entries(setVars)) {
      if (process.env[key] !== value) {
        process.env[key] = value;
        changed = true;
      }
    }

    for (const key of clearVars) {
      if (process.env[key]) {
        delete process.env[key];
        changed = true;
      }
    }

    if (changed) {
      debugLogger.debug("Synced startup env vars", {
        set: Object.keys(setVars),
        cleared: clearVars.filter((k) => !process.env[k]),
      });
      // Log persistence failures with the exact keys that were requested.
      this.environmentManager.saveAllKeysToEnvFile().catch((err: Error) => {
        debugLogger.error("Failed to persist startup env vars to .env", {
          set: Object.keys(setVars),
          clearRequested: clearVars,
          error: err.message,
        });
      });
    }
  }

  // Mints a Corti access token from stored BYOK credentials. Shared by the
  // dictation streaming handlers and the meeting realtime-token resolver.
  async _mintStoredCortiToken(options: { environment?: string; tenant?: string } = {}) {
    const clientId = this.environmentManager.getCortiClientId();
    const clientSecret = this.environmentManager.getCortiClientSecret();

    if (!clientId || !clientSecret) {
      const err = new Error("No Corti credentials configured. Add them in Settings.");
      (err as NodeJS.ErrnoException).code = "NO_API";
      throw err;
    }

    const environment = options.environment || "us";
    const tenant = (options.tenant || "").trim() || "base";
    const token = await getCortiToken({ environment, tenant, clientId, clientSecret });

    return { token, environment, tenant };
  }

  setupHandlers(): void {
    const proxyFetch = (url: string | URL, init: RequestInit = {}) => {
      const fetchInit: RequestInit & { useSessionCookies?: boolean } = {
        ...init,
        useSessionCookies: false,
      };

      return net.fetch(url.toString(), fetchInit);
    };

    // Local/remote transcription execution, temp audio, retry and provider
    // connection/model discovery live in the typed module. Heavy SDKs and the
    // Corti client stay lazy behind these factories.
    registerTranscriptionExecutionHandlers(ipcMain, {
      whisperManager: {
        transcribeLocalWhisper: (audioBuffer, options) =>
          this._transcribeLocalWhisper(audioBuffer, options),
      },
      parakeetManager: {
        transcribeLocalParakeet: (audioBuffer, options) =>
          this._transcribeLocalParakeet(audioBuffer, options),
      },
      resolveWhisperVadOptions: (context) => this._resolveWhisperVadOptions(context),
      environmentManager: this.environmentManager,
      proxyFetch: (url, init) => proxyFetch(url, init as RequestInit),
      transcribeGeminiFile: runGeminiFile,
      transcribeWithCorti: async (args) => {
        const { transcribeAudio } =
          require("./cortiTranscription") as typeof import("./cortiTranscription.js");

        return transcribeAudio(args as Parameters<typeof transcribeAudio>[0]);
      },
      mintStoredCortiToken: (tokenOptions) => this._mintStoredCortiToken(tokenOptions),
      generateText: (options) => require("ai").generateText(options),
      getEnterpriseAIModel: (provider, model, apiKey, enterprise) =>
        getEnterpriseAIModel(provider, model, apiKey, enterprise) as Promise<EnterpriseStreamModel>,
      bedrockSdk: async () => require("@aws-sdk/client-bedrock"),
      bedrockProfileCredentials: (profile) =>
        require("@aws-sdk/credential-providers").fromNodeProviderChain({ profile }),
      providerBaseUrls: transcriptionProviderBaseUrls,
      audioStorage: this.audioStorageManager,
      database: this.databaseManager,
      broadcast: broadcastToWindows,
      logger: {
        log: (message, data) => debugLogger.log(message, data),
        debug: (message, data) => debugLogger.debug(message, data),
        warn: (message, data) => debugLogger.warn(message, data),
        error: (message, data, tag) => debugLogger.error(message, data, tag),
      },
    });

    // Transcription records, audio storage, exports, file selection and the
    // pending (non-meeting) note navigation live in the typed module.
    registerTranscriptionDataHandlers(ipcMain, {
      database: this.databaseManager,
      audioStorage: this.audioStorageManager,
      deleteAllAudio: () => this._deleteAllAudio(),
      deleteTranscriptionInternal: (id) => this.deleteTranscriptionInternal(id),
      buildSpeakerMappings: (noteId) => this._buildSpeakerMappings(noteId),
      queueNoteNavigation: (payload) => this.windowManager.queueNoteNavigation(payload),
      consumePendingNoteNavigation: () => this.windowManager.consumePendingNoteNavigation(),
      retention: {
        getCurrentSettings: () => this._retentionSettings,
        getOwner: () => this.windowManager.controlPanelWindow?.webContents,
        hasSynced: () => this._retentionSettingsSynced,
        onSettingsChanged: (settings) => {
          this._retentionSettings = settings;
          this._retentionSettingsSynced = true;
          void this._runRetentionCleanup().then((ready) => {
            if (ready) this._meetingProcessing?.onRetentionReady();
          });
          // First point at which the local-history switch is known to be real.
          // After the sweep, so expired transcripts are gone before they can be
          // reconstructed into counters the sweep would only have to purge.
        },
      },
      broadcast: broadcastToWindows,
      logger: {
        log: (message, data) => debugLogger.log(message, data),
        debug: (message, data) => debugLogger.debug(message, data),
        warn: (message, data) => debugLogger.warn(message, data),
        error: (message, data, tag) => debugLogger.error(message, data, tag),
      },
    });

    // Onboarding/window controls, credentials, hotkeys, language, debug,
    // permissions, cleanup and app metadata live in the typed module; meeting
    // coordinator seams stay behind the two narrow gates below.
    registerDesktopSettingsHandlers(ipcMain, {
      windowManager: this.windowManager,
      setMeetingModeActive: (active) => this.meetingDetectionEngine?.setMeetingModeActive(active),
      setDetectionGateForNotifications: (enabled) =>
        this.meetingDetectionEngine?.setPreferences({ audioDetection: enabled }),
      environment: {
        byokGet: (name) => this.environmentManager[name](),
        byokSave: (name, key) => this.environmentManager[name](key),
        getCortiClientId: () => this.environmentManager.getCortiClientId(),
        saveCortiClientId: (key) => this.environmentManager.saveCortiClientId(key),
        getCortiClientSecret: () => this.environmentManager.getCortiClientSecret(),
        saveCortiClientSecret: (key) => this.environmentManager.saveCortiClientSecret(key),
        getCustomTranscriptionKey: () => this.environmentManager.getCustomTranscriptionKey(),
        saveCustomTranscriptionKey: (key) =>
          this.environmentManager.saveCustomTranscriptionKey(key),
        getCleanupCustomKey: () => this.environmentManager.getCleanupCustomKey(),
        saveCleanupCustomKey: (key) => this.environmentManager.saveCleanupCustomKey(key),
        getBedrockRegion: () => this.environmentManager.getBedrockRegion(),
        saveBedrockRegion: (value) => this.environmentManager.saveBedrockRegion(value),
        getBedrockProfile: () => this.environmentManager.getBedrockProfile(),
        saveBedrockProfile: (value) => this.environmentManager.saveBedrockProfile(value),
        getBedrockAccessKeyId: () => this.environmentManager.getBedrockAccessKeyId(),
        saveBedrockAccessKeyId: (key) => this.environmentManager.saveBedrockAccessKeyId(key),
        getBedrockSecretAccessKey: () => this.environmentManager.getBedrockSecretAccessKey(),
        saveBedrockSecretAccessKey: (key) =>
          this.environmentManager.saveBedrockSecretAccessKey(key),
        getBedrockSessionToken: () => this.environmentManager.getBedrockSessionToken(),
        saveBedrockSessionToken: (key) => this.environmentManager.saveBedrockSessionToken(key),
        getAzureEndpoint: () => this.environmentManager.getAzureEndpoint(),
        saveAzureEndpoint: (value) => this.environmentManager.saveAzureEndpoint(value),
        getAzureApiKey: () => this.environmentManager.getAzureApiKey(),
        saveAzureApiKey: (key) => this.environmentManager.saveAzureApiKey(key),
        getAzureDeployment: () => this.environmentManager.getAzureDeployment(),
        saveAzureDeployment: (value) => this.environmentManager.saveAzureDeployment(value),
        getAzureApiVersion: () => this.environmentManager.getAzureApiVersion(),
        saveAzureApiVersion: (value) => this.environmentManager.saveAzureApiVersion(value),
        getVertexProject: () => this.environmentManager.getVertexProject(),
        saveVertexProject: (value) => this.environmentManager.saveVertexProject(value),
        getVertexLocation: () => this.environmentManager.getVertexLocation(),
        saveVertexLocation: (value) => this.environmentManager.saveVertexLocation(value),
        getVertexApiKey: () => this.environmentManager.getVertexApiKey(),
        saveVertexApiKey: (key) => this.environmentManager.saveVertexApiKey(key),
        getActivationMode: () => this.environmentManager.getActivationMode(),
        saveActivationMode: (mode) => this.environmentManager.saveActivationMode(mode),
        getUiLanguage: () => this.environmentManager.getUiLanguage(),
        saveUiLanguage: (language) => this.environmentManager.saveUiLanguage(language),
        saveAllKeysToEnvFile: () => this.environmentManager.saveAllKeysToEnvFile(),
        clearAllPersistedData: async () => {
          await this.environmentManager.clearAllPersistedData();
        },
      },
      audioTap: {
        isSupported: () => this.audioTapManager?.isSupported(),
        checkAccess: () => this.audioTapManager.checkAccess(),
        requestAccess: () => this.audioTapManager.requestAccess(),
      },
      oauthProtocolRegistered: this.oauthProtocolRegistered,
      oauthProtocol: this.oauthProtocol,
      getTrayManager: () => this.getTrayManager(),
      sendToMainWindow: (channel) =>
        this.windowManager.controlPanelWindow?.webContents?.send(channel),
      stopWhisperServer: () => this.whisperManager.stopServer(),
      stopParakeetServer: () => this.parakeetManager.stopServer(),
      stopLlamaServer: () => modelManager.stopServer(),
      cleanup: {
        stopParakeetServer: () => this.parakeetManager.stopServer(),
        stopWhisperServer: () => this.whisperManager.stopServer(),
        stopGoogleCalendar: () => this.googleCalendarManager.stop(),
        stopMicrosoftCalendar: () => this.microsoftCalendarManager.stop(),
        stopAppleCalendar: () => this.appleCalendarManager.stop(),
        shutdownDiarization: () => this.diarizationManager.shutdown(),
        revokeGoogleTokens: () => this.googleCalendarManager.revokeAllTokens(),
        closeDatabase: () => this.databaseManager.db.close(),
        deleteAllAudio: () => this._deleteAllAudio(),
        deleteWhisperModels: () => {
          const { getModelsDirForService } =
            require("./modelDirUtils") as typeof import("./modelDirUtils.js");

          const whisperDir = getModelsDirForService("whisper");

          if (fs.existsSync(whisperDir)) fs.rmSync(whisperDir, { recursive: true, force: true });
        },
        deleteParakeetModels: async () => {
          await this.parakeetManager.deleteAllParakeetModels();
        },
        deleteDiarizationModels: async () => {
          await this.diarizationManager.deleteModels();
        },
        deleteLlmModels: () => modelManager.deleteAllModels(),
      },
      logger: {
        log: (message, data) => debugLogger.log(message, data),
        debug: (message, data) => debugLogger.debug(message, data),
        warn: (message, data) => debugLogger.warn(message, data),
        error: (message, data, tag) => debugLogger.error(message, data, tag),
      },
    });

    // Vocabulary (dictionary/snippets) channels live in the typed module.
    registerVocabularyHandlers(ipcMain, {
      database: this.databaseManager,
      debugLogger,
    });

    // Notes DB channels live in the typed module; pass only what they need.
    const noteReader = new NoteReadService(
      this.databaseManager,
      this.audioStorageManager.meetingRecordings
    );

    registerNotesHandlers(ipcMain, {
      noteWrites: this.noteWrites,
      getNote: (id) => this.databaseManager.getNote(id),
      getNotes: (noteType, limit, folderId, spaceId) =>
        this.databaseManager.getNotes(noteType, limit, folderId, spaceId),
      getNotesForSpace: (spaceId, limit) => this.databaseManager.getNotesForSpace(spaceId, limit),
      deleteNoteInternal: (id) => this.deleteNoteInternal(id),
      searchNotes: (query, limit, spaceId, folderId) =>
        this.databaseManager.searchNotes(query, limit, spaceId, folderId),
      searchNoteContent: (query, spaceId) =>
        noteReader.searchNotes(query).flatMap((hit) => {
          const note = this.databaseManager.getNote(hit.note_id);

          return note && (spaceId === null || note.space_id === spaceId)
            ? [{ note, matches: hit.matches }]
            : [];
        }),
      searchNoteTranscripts: (query, spaceId) =>
        noteReader.searchTranscripts(query).flatMap((hit) => {
          const note = this.databaseManager.getNote(hit.note_id);

          return note && (spaceId === null || note.space_id === spaceId)
            ? [{ note, matches: hit.matches }]
            : [];
        }),
      getNoteTranscript: (noteId) => noteReader.transcript(noteId),
      getNoteOutput: (request) => noteReader.readOutput(request),
    });

    // Container (folders/spaces) channels live in the typed module.
    registerContainerHandlers(ipcMain, {
      database: this.databaseManager,
      noteFilesEnabled: () => this._noteFilesEnabled,
      getFolderName: (folderId) => this._getFolderName(folderId),
      mirrorWriteNote: (note) => this._asyncMirrorWrite(note),
      mirrorEnsureFolder: (name) => markdownMirror.ensureFolder(name),
      mirrorRenameFolder: (oldName, newName) => this._mirrorRenameFolder(oldName, newName),
      mirrorDeleteFolderIfUnshared: (name, relocatedNoteIds) =>
        this._mirrorDeleteFolderIfUnshared(name, relocatedNoteIds),
    });

    // AI Actions catalog channels live in the typed module.
    registerActionsHandlers(ipcMain, {
      database: this.databaseManager,
    });

    // Agent conversation (chat persistence) channels live in the typed module.
    registerChatPersistenceHandlers(ipcMain, {
      database: this.databaseManager,
    });

    registerMeetingCompanionHandlers(ipcMain, this.windowManager.meetingCompanion);

    // URL download channels live in the typed module, per-registration state
    // included. Only the downloader and logging are shared.
    const urlDownloader =
      require("./urlAudioDownloader") as typeof import("./urlAudioDownloader.js");

    registerUrlDownloadHandlers(ipcMain, {
      download: urlDownloader.download,
      sweepStaleTempArtifacts: urlDownloader.sweepStaleTempArtifacts,
      getSafeTempDir: require("./safeTempDir").getSafeTempDir,
      debugLogger,
    });

    // Local file transcription lives in the typed module; the shared
    // execution below it also serves the CLI bridge.
    const localFileTranscriptionDeps: TranscriptionHandlerDeps = {
      readFile: (filePath) => fs.readFileSync(filePath),
      resolveAllowedAudioPath: (filePath) => resolveAllowedAudioPath(filePath),
      isSherpaLocalProvider: (provider) => isSherpaLocalProvider(provider),
      transcribeLocalWhisper: (audioBuffer, options) =>
        this._transcribeLocalWhisper(audioBuffer, options),
      transcribeLocalParakeet: (audioBuffer, options) =>
        this._transcribeLocalParakeet(audioBuffer, options),
      resolveWhisperVadOptions: (context) => this._resolveWhisperVadOptions(context),
      uploadCancelRegistry: this._uploadCancelRegistry,
      logDebug: (message, data) => debugLogger.debug(message, data),
      logError: (message, data) => debugLogger.error(message, data),
    };

    registerLocalFileTranscriptionHandler(ipcMain, localFileTranscriptionDeps);

    // Remote (BYOK/self-hosted) transcription lives in the typed module; the
    // route resolver is re-run there as the trust boundary, and every active
    // transport receives the cancel registry's AbortSignal.
    const remoteTranscriptionDeps: RemoteTranscriptionDeps = {
      resolveAllowedAudioPath: (filePath) => resolveAllowedAudioPath(filePath),
      readFile: (filePath) => fs.readFileSync(filePath),
      fileSize: (filePath) => fs.statSync(filePath).size,
      providerBaseUrls: transcriptionProviderBaseUrls,
      postMultipart: (url, body, boundary, headers, options) =>
        postMultipart(url, body, boundary, headers, options),
      postRawAudioFile,
      transcribeWithTinfoil: (args) => transcribeWithTinfoil(args),
      transcribeGeminiFile: runGeminiFile,
      // Lazy like the pre-cutover handler: the Corti client is only loaded
      // when its route actually runs.
      transcribeWithCorti: async (args) => {
        const { transcribeAudio } =
          require("./cortiTranscription") as typeof import("./cortiTranscription.js");

        return transcribeAudio(args as Parameters<typeof transcribeAudio>[0]);
      },
      getCortiClientId: () => this.environmentManager.getCortiClientId(),
      getCortiClientSecret: () => this.environmentManager.getCortiClientSecret(),
      getTinfoilKey: () => this.environmentManager.getTinfoilKey(),
      getGeminiKey: () => this.environmentManager.getGeminiKey(),
      uploadCancelRegistry: this._uploadCancelRegistry,
      logDebug: (message, data) => debugLogger.debug(message, data),
      logWarn: (message, data) => debugLogger.warn(message, data),
      logError: (message, data) => debugLogger.error(message, data),
    };

    registerRemoteTranscriptionHandler(ipcMain, remoteTranscriptionDeps);

    const getMeetingCredential = (reference: string | undefined, provider: string): string => {
      if (reference === "CUSTOM_TRANSCRIPTION_API_KEY")
        return this.environmentManager.getCustomTranscriptionKey();

      if (reference === "CUSTOM_CLEANUP_API_KEY")
        return this.environmentManager.getCleanupCustomKey();

      if (reference === "BEDROCK_ACCESS_KEY_ID")
        return this.environmentManager.getBedrockAccessKeyId();

      if (reference === "BEDROCK_SECRET_ACCESS_KEY")
        return this.environmentManager.getBedrockSecretAccessKey();

      if (reference === "BEDROCK_SESSION_TOKEN")
        return this.environmentManager.getBedrockSessionToken();

      if (reference === "AZURE_OPENAI_API_KEY") return this.environmentManager.getAzureApiKey();

      if (reference === "VERTEX_API_KEY") return this.environmentManager.getVertexApiKey();

      const key =
        BYOK_API_KEYS.find((entry) => entry.env === reference) ??
        BYOK_API_KEYS.find((entry) => entry.base === provider);

      return key ? this.environmentManager[key.get]() : "";
    };

    const meetingWorker = new MeetingProcessingWorker({
      database: this.databaseManager,
      storage: this.audioStorageManager.meetingRecordings,
      isCaptureActive: () => this._meetingCoordinator?.isRecording() === true,
      transcribeRemote: (request, onRawProviderResponse, signal) =>
        transcribeAudioFileByok(remoteTranscriptionDeps, request, {
          onRawProviderResponse,
          signal,
        }),
      transcribeLocal: (audioPath, options) => {
        const approvedPath = resolveAllowedAudioPath(audioPath);

        if (!approvedPath) {
          return Promise.resolve({
            success: false,
            error: "File path not allowed",
            code: "AUDIO_PATH_NOT_ALLOWED",
          });
        }

        return transcribeLocalFile(localFileTranscriptionDeps, approvedPath, options);
      },
      diarizeLocal: async (audioPath, options) => {
        if (!this.diarizationManager.isModelDownloaded()) {
          throw Object.assign(new Error("Local diarization models are not installed"), {
            code: "DIARIZATION_MODEL_MISSING",
          });
        }

        const resolveThreshold = (
          require("./diarizationPolicy") as typeof import("./diarizationPolicy.js")
        ).resolveClusterThreshold;

        const dropNegligible = (
          require("./diarizationPolicy") as typeof import("./diarizationPolicy.js")
        ).dropNegligibleClusters;

        const expected = options.expectedSpeakerCount;

        const diarized = await this.diarizationManager.diarize(audioPath, {
          numSpeakers: expected && expected > 0 ? expected : -1,
          threshold: resolveThreshold(options.durationSeconds, undefined),
          signal: options.signal,
        });

        options.signal.throwIfAborted();
        const meaningful = dropNegligible(diarized) ?? [];

        return this.diarizationManager
          .capSpeakerClusters(meaningful, expected && expected > 0 ? expected : MAX_SPEAKER_COUNT)
          .map(({ speaker, start, end }) => ({ speaker, start, end }));
      },
      summarize: async (input, summaryConfig, signal) => {
        const providers = await import("./meetingAiProviders.js");

        return generateMeetingSummary(
          input,
          summaryConfig,
          {
            getAIModel: (provider, model, apiKey, baseUrl, options) =>
              providers.getMeetingAIModel(provider, model, apiKey, baseUrl, options),
            generateText: (options) => require("ai").generateText(options),
            processLocalText: (text, model, options, abortSignal) =>
              localReasoningBridge.processText(text, model, options, abortSignal),
            getCredential: getMeetingCredential,
            getEnterpriseAIModel: (provider, model, apiKey, enterprise) =>
              getEnterpriseAIModel(provider, model, apiKey, enterprise),
            validateEnterpriseEndpoint,
            runBedrockRequest: (operation, options) => runBedrockRequest(operation, options),
          },
          signal
        );
      },
      summarizeAgent: async (input, summaryConfig, run, signal) => {
        if (
          !summaryConfig.agentProvider ||
          !summaryConfig.model ||
          !summaryConfig.agentReasoningLevel
        ) {
          throw new Error("bb summary settings are incomplete");
        }

        return generateBbSummary({
          prompt: `${summaryConfig.instruction}\n\n${input}`,
          selection: {
            provider: summaryConfig.agentProvider,
            model: summaryConfig.model,
            reasoningLevel: summaryConfig.agentReasoningLevel,
          },
          environment: ensureBbWorkspace(app.getPath("userData")),
          threadId: run.bbThreadId,
          saveThreadId: (id) => this.databaseManager.setMeetingRunBbThreadId(run.id, id),
          signal,
        });
      },
      createActionConversation: async (summaryConfig, instruction, run, signal) => {
        if (summaryConfig.reasoningMode === "agent") {
          if (
            !summaryConfig.agentProvider ||
            !summaryConfig.model ||
            !summaryConfig.agentReasoningLevel
          ) {
            throw Object.assign(new Error("bb summary settings are incomplete"), {
              code: "meeting-summary-action-config-invalid",
            });
          }

          return createBbTextConversation({
            selection: {
              provider: summaryConfig.agentProvider,
              model: summaryConfig.model,
              reasoningLevel: summaryConfig.agentReasoningLevel,
            },
            environment: ensureBbWorkspace(app.getPath("userData")),
            threadId: run.bbThreadId,
            promptPrefix: instruction,
            saveThreadId: (id) => this.databaseManager.setMeetingRunBbThreadId(run.id, id),
            signal,
          });
        }

        const providers = await import("./meetingAiProviders.js");

        return createMeetingTextConversation(
          summaryConfig,
          {
            getAIModel: (provider, model, apiKey, baseUrl, options) =>
              providers.getMeetingAIModel(provider, model, apiKey, baseUrl, options),
            generateText: (options) => require("ai").generateText(options),
            processLocalText: (text, model, options, abortSignal) =>
              localReasoningBridge.processText(text, model, options, abortSignal),
            getCredential: getMeetingCredential,
            getEnterpriseAIModel: (provider, model, apiKey, enterprise) =>
              getEnterpriseAIModel(provider, model, apiKey, enterprise),
            validateEnterpriseEndpoint,
            runBedrockRequest: (operation, options) => runBedrockRequest(operation, options),
          },
          signal
        );
      },
      getActionPrompt: (translationKey) =>
        this.databaseManager
          .getActions()
          .find((action) => action.is_builtin === 1 && action.translation_key === translationKey)
          ?.prompt ?? null,
      nameSpeakers: async (input, summaryConfig, run, signal) => {
        const instruction = meetingNamingInstruction(input);
        const namingConfig = { ...summaryConfig, instruction };

        if (summaryConfig.reasoningMode === "agent") {
          if (
            !summaryConfig.agentProvider ||
            !summaryConfig.model ||
            !summaryConfig.agentReasoningLevel
          ) {
            throw new Error("bb speaker naming settings are incomplete");
          }

          const conversation = await createBbTextConversation({
            selection: {
              provider: summaryConfig.agentProvider,
              model: summaryConfig.model,
              reasoningLevel: summaryConfig.agentReasoningLevel,
            },
            environment: ensureBbWorkspace(app.getPath("userData")),
            threadId: run.bbThreadId,
            promptPrefix: instruction,
            saveThreadId: (id) => this.databaseManager.setMeetingRunBbThreadId(run.id, id),
            signal,
          });

          return suggestMeetingSpeakerNames(input, conversation);
        }

        const providers = await import("./meetingAiProviders.js");

        const conversation = await createMeetingTextConversation(
          namingConfig,
          {
            getAIModel: (provider, model, apiKey, baseUrl, options) =>
              providers.getMeetingAIModel(provider, model, apiKey, baseUrl, options),
            generateText: (options) => require("ai").generateText(options),
            processLocalText: (text, model, options, abortSignal) =>
              localReasoningBridge.processText(text, model, options, abortSignal),
            getCredential: getMeetingCredential,
            getEnterpriseAIModel: (provider, model, apiKey, enterprise) =>
              getEnterpriseAIModel(provider, model, apiKey, enterprise),
            validateEnterpriseEndpoint,
            runBedrockRequest: (operation, options) => runBedrockRequest(operation, options),
          },
          signal
        );

        return suggestMeetingSpeakerNames(input, conversation);
      },
      recognizeSpeakers: async (recording, run, transcript, audioPath, signal) => {
        const approvedAudioPath = resolveAllowedAudioPath(audioPath);

        if (!approvedAudioPath) return [];

        const tempDir = (
          require("./safeTempDir") as typeof import("./safeTempDir.js")
        ).getSafeTempDir();

        const speakerEmbeddings =
          require("./speakerEmbeddings") as import("./speakerEmbeddings.js").SpeakerEmbeddings;

        const ffmpeg = require("./ffmpegUtils") as typeof import("./ffmpegUtils.js");

        const corrections = await recognizeMeetingSpeakers(transcript, approvedAudioPath, signal, {
          speakerEmbeddings,
          getProfiles: () => this.databaseManager.getSpeakerProfiles(true),
          convertToWav: (inputPath, outputPath, options) =>
            ffmpeg.convertToWav(inputPath, outputPath, options),
          createTempPath: () => path.join(tempDir, `meeting-speakers-${crypto.randomUUID()}.wav`),
          removeFile: (filePath) => fs.rmSync(filePath, { force: true }),
          logSkipped: (error) =>
            debugLogger.debug(
              "Post-stop speaker recognition skipped",
              {
                recordingId: recording.id,
                runId: run.id,
                error: error instanceof Error ? error.message : String(error),
              },
              "speaker"
            ),
        });

        debugLogger.debug(
          "Post-stop speaker recognition finished",
          {
            recordingId: recording.id,
            runId: run.id,
            recognizedCount: corrections.length,
          },
          "speaker"
        );

        return corrections;
      },
      getCredential: getMeetingCredential,
      onNoteProjectionChanged: (noteId) => this._publishMeetingNoteProjection(noteId),
      onChanged: (recordingId, runId) =>
        broadcastToWindows("meeting-processing-updated", { recordingId, runId }),
    });

    this._meetingProcessing = meetingWorker;
    registerMeetingProcessingHandlers(ipcMain, meetingWorker);
    this._registerMeetingRecordingAssetHandlers();

    // The explicit hard cancel of one managed upload execution: aborts the
    // transcription, diarization and transport registered under the id.
    registerUploadCancelHandler(ipcMain, { uploadCancelRegistry: this._uploadCancelRegistry });

    // File diarization + speaker-text merge live in the typed module; the
    // shared cancel registry is the same instance transcription uses.
    registerFileDiarizationHandlers(ipcMain, {
      diarizationManager: this.diarizationManager,
      resolveAllowedAudioPath: (filePath) => resolveAllowedAudioPath(filePath),
      convertToWav: (inputPath, outputPath, options) =>
        (require("./ffmpegUtils") as typeof import("./ffmpegUtils.js")).convertToWav(
          inputPath,
          outputPath,
          options
        ),
      createTempWavPath: () =>
        path.join(
          (require("./safeTempDir") as typeof import("./safeTempDir.js")).getSafeTempDir(),
          `ow-diarize-${Date.now()}.wav`
        ),
      fileSize: (filePath) => fs.statSync(filePath).size,
      resolveClusterThreshold: (durationSeconds, requestedThreshold) =>
        (
          require("./diarizationPolicy") as typeof import("./diarizationPolicy.js")
        ).resolveClusterThreshold(durationSeconds, requestedThreshold),
      dropNegligibleClusters: (segments) =>
        (
          require("./diarizationPolicy") as typeof import("./diarizationPolicy.js")
        ).dropNegligibleClusters(segments) as DiarizationSegment[],
      pcm16Mono16kBytesPerSecond: (
        require("./transcriptionTimeout") as typeof import("./transcriptionTimeout.js")
      ).PCM16_MONO_16K_BYTES_PER_SECOND,
      maxSpeakerCount: MAX_SPEAKER_COUNT,
      removeFile: (filePath) => fs.unlinkSync(filePath),
      mergeSpeakersWithText: (segments, text, duration) =>
        (require("./speakerMerge") as typeof import("./speakerMerge.js")).mergeSpeakersWithText(
          segments,
          text,
          duration
        ),
      formatSpeakerTranscript: (merged) =>
        (require("./speakerMerge") as typeof import("./speakerMerge.js")).formatSpeakerTranscript(
          merged as MergedSpeakerSegment[]
        ),
      uploadCancelRegistry: this._uploadCancelRegistry,
      logDebug: (message, data) => debugLogger.debug(message, data),
      logError: (message, data) => debugLogger.error(message, data),
    });

    // Main-owned reasoning lives in the typed module: local/Anthropic/
    // enterprise one-shots plus the sender-scoped enterprise stream
    // lifecycle. Provider factories stay lazy and injected so startup never
    // eager-loads the enterprise SDKs.
    registerReasoningHandlers(ipcMain, {
      localService: localReasoningBridge,
      getAnthropicKey: () => this.environmentManager.getAnthropicKey(),
      proxyFetch: (url, init) => proxyFetch(url, init as RequestInit),
      extractAnthropicText,
      describeMissingAnthropicText,
      isEnterpriseProvider,
      mapEnterpriseError,
      runAbortableOperation,
      runBedrockRequest,
      validateEnterpriseEndpoint,
      generateText: (options) => require("ai").generateText(options),
      getEnterpriseAIModel: (provider, model, apiKey, enterprise) =>
        getEnterpriseAIModel(provider, model, apiKey, enterprise) as Promise<EnterpriseStreamModel>,
      bedrockCleanupRequests: this._enterpriseReasoningRequests,
      enterpriseStreams: this._enterpriseStreams,
      logError: (message, data) => debugLogger.error(message, data),
    });
    registerBbHandlers(ipcMain, app.getPath("userData"), this.databaseManager);

    // Provider-neutral availability over the shared calendar cache, in the
    // typed module (validation, computation and wire projection included).
    registerCalendarAvailabilityHandler(ipcMain, {
      databaseManager: this.databaseManager,
      calendarProviders: [
        { provider: "google", manager: this.googleCalendarManager },
        { provider: "microsoft", manager: this.microsoftCalendarManager },
        { provider: "apple", manager: this.appleCalendarManager },
      ],
      logWarn: (message, data, tag) => debugLogger.warn(message, data, tag),
    });

    // Note files (markdown mirror), reveal and Granola import live in the
    // typed module; the mirror stays a projection of SQLite-owned content.
    const ipcInstance = this;
    registerNoteFilesHandlers(ipcMain, {
      mirror: markdownMirror,
      getDefaultNotesPath: () => path.join(app.getPath("userData"), "notes"),
      setNoteFilesEnabled: (enabled) => {
        this._noteFilesEnabled = !!enabled;
      },
      isNoteFilesEnabled: () => this._noteFilesEnabled,
      rebuildMirror: (basePath) => this._rebuildMirror(basePath),
      showItemInFolder: (filePath) => shell.showItemInFolder(filePath),
      openPath: (dirPath) => shell.openPath(dirPath),
      pickFolder: async () => {
        const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });

        if (result.canceled || !result.filePaths.length) return { canceled: true };

        return { canceled: false, path: result.filePaths[0] };
      },
      pickGranolaCsvFiles: async (event) => {
        // Parent the dialog so it opens as a sheet on the settings window —
        // a parentless panel can land invisible on another display/Space.
        const parentWindow = BrowserWindow.fromWebContents((event as IpcMainInvokeEvent)?.sender);

        const dialogOptions: Electron.OpenDialogOptions = {
          properties: ["openFile", "multiSelections"],
          filters: [{ name: "CSV", extensions: ["csv"] }],
        };

        const result = parentWindow
          ? await dialog.showOpenDialog(parentWindow, dialogOptions)
          : await dialog.showOpenDialog(dialogOptions);

        if (result.canceled || !result.filePaths.length) return { canceled: true, filePaths: [] };

        return { canceled: false, filePaths: result.filePaths };
      },
      readFileUtf8: (filePath) => fs.readFileSync(filePath, "utf8"),
      fileSize: (filePath) => fs.statSync(filePath).size,
      importNotes: (notes) => this.databaseManager.importNotes(notes),
      granolaState: {
        get pending() {
          return ipcInstance._granolaImportPending;
        },
        set pending(value) {
          ipcInstance._granolaImportPending = value;
        },
      },
      logError: (message, data, tag) => debugLogger.error(message, data, tag),
    });

    // Local Whisper/Parakeet model lifecycle lives in the typed module;
    // downloads stay sequence-stamped through the shared status tracker.
    registerLocalModelLifecycleHandlers(ipcMain, {
      // Loose manager payloads are pinned by the localModelLifecycle
      // characterization suite; bridge them at this boundary.
      whisperManager: this.whisperManager as unknown as WhisperManagerLike,
      parakeetManager: this.parakeetManager as unknown as ParakeetManagerLike,
      downloadStatus: this.localModelDownloadStatus,
      progressSender: {
        sendToControlPanel: (channel, payload) =>
          this.windowManager.sendToControlPanel(channel, payload),
      },
      updateDownloadStatus: (modelType, modelId, progressData) =>
        this._updateNativeModelDownloadStatus(modelType, modelId, progressData),
      getWhisperVadSettings: () => this._getWhisperVadSettings(),
      setWhisperVadSettings: (payload) => this._setWhisperVadSettings(payload),
      persistParakeetProviderSelection: async (modelName) => {
        process.env.LOCAL_TRANSCRIPTION_PROVIDER =
          getModelType(modelName) === "cohere-transcribe" ? "cohere" : "nvidia";
        process.env.PARAKEET_MODEL = modelName;
        await this.environmentManager.saveAllKeysToEnvFile();
      },
      clearParakeetProviderSelection: async () => {
        delete process.env.LOCAL_TRANSCRIPTION_PROVIDER;
        delete process.env.PARAKEET_MODEL;
        await this.environmentManager.saveAllKeysToEnvFile();
      },
      resolveParakeetProviderName: (modelName) =>
        getModelType(modelName) === "cohere-transcribe" ? "cohere" : "nvidia",
      logError: (message, data) => debugLogger.error(message, data),
    });

    registerLocalLlmModelHandlers(ipcMain, {
      modelManager: modelManager as unknown as LlmModelManagerLike,
      llamaCppInstaller: (require("./llamaCppInstaller") as typeof import("./llamaCppInstaller.js"))
        .default,
      // Loose tracker typing pinned by the localLlmModels characterization suite.
      downloadStatus: this.localModelDownloadStatus as unknown as LlmDownloadStatusTracker,
      progressSender: {
        sendToControlPanel: (channel, payload) =>
          this.windowManager.sendToControlPanel(channel, payload),
      },
      joinPath: (...segments) => path.join(...segments),
      persistEnvAfterServerStart: () => {
        this.environmentManager.saveAllKeysToEnvFile().catch(() => {});
      },
      logError: (message, data) => debugLogger.error(message, data),
    });

    // The calendar integration boundary (connections, sync, selection,
    // provider-neutral reads and Calendar privacy settings) lives in the
    // typed module; OAuth/sync/reminders stay inside the managers.
    registerCalendarIntegrationHandlers(ipcMain, {
      googleManager: this.googleCalendarManager,
      microsoftManager: this.microsoftCalendarManager,
      appleManager: this.appleCalendarManager,
      getUpcomingEvents: (windowMinutes) =>
        this.googleCalendarManager.getUpcomingEvents(windowMinutes),
      getCalendarEventById: (eventId) => this.databaseManager.getCalendarEventById(eventId),
      openCalendarPrivacySettings: () => openSystemSettings("calendars"),
      logError: (message, data, tag) => debugLogger.error(message, data, tag),
    });

    // The meeting coordinator (prepare/start/send/stop/cancel, detection,
    // auto-end, session speaker config, recording locks, mic warm hold and
    // final diarization publication) lives in the typed module; the JS root
    // only wires its dependencies. The meeting-state callbacks the notes and
    // speaker verticals need come from its runtime handle.
    const companionPreference = path.join(app.getPath("userData"), "companion-enabled");
    let companionEnabled = fs.existsSync(companionPreference);
    const companionIsolated = app.commandLine?.hasSwitch("user-data-dir") === true;

    const companionInstallation = {
      channel: isDevelopmentChannel() ? ("development" as const) : ("production" as const),
      chromeRoot: companionIsolated
        ? path.join(app.getPath("userData"), "chrome-test")
        : path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome"),
      profilePath: app.getPath("userData"),
      runtimePath: process.execPath,
      hostScriptPath: path.join(__dirname, "companionNativeHost.js"),
    };

    if (companionEnabled && !companionIsolated) {
      try {
        refreshCompanionHost(companionInstallation);
      } catch (error) {
        debugLogger.warn(
          "Meet host registration could not be refreshed",
          { error: String(error) },
          "meeting"
        );
      }
    }

    const companionFolder =
      companionInstallation.channel === "development" ? "companion-dev" : "companion";

    const companionExtensionPath = app.isPackaged
      ? path.join(process.resourcesPath, companionFolder)
      : path.join(app.getAppPath(), "build", companionFolder);

    ipcMain.handle(meetingCoordinatorChannels.getMeetIntegrationSetup, () => ({
      enabled: companionEnabled,
      installed: companionHostInstalled(companionInstallation),
      extensionPath: companionExtensionPath,
      channel: companionInstallation.channel,
    }));
    ipcMain.handle(
      meetingCoordinatorChannels.configureMeetIntegration,
      async (event, action: unknown) => {
        if (event.sender !== this.windowManager.controlPanelWindow?.webContents)
          return { success: false, error: "Unauthorized window" };
        const parsed = companionConfigureActionSchema.safeParse(action);

        if (!parsed.success) return { success: false, error: "Invalid action" };

        try {
          if (parsed.data === "reveal") {
            const error = await shell.openPath(companionExtensionPath);

            return error ? { success: false, error } : { success: true };
          }

          if (parsed.data === "enable") {
            installCompanionHost(companionInstallation);
            fs.writeFileSync(companionPreference, "enabled\n", { mode: 0o600 });
          } else {
            if (companionHostInstalled(companionInstallation))
              uninstallCompanionHost(companionInstallation);
            fs.rmSync(companionPreference, { force: true });
          }

          companionEnabled = parsed.data === "enable";
          this._meetingCoordinator?.setCompanionEnabled(companionEnabled);

          return { success: true };
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
    );
    this._meetingCoordinator = registerMeetingCoordinatorHandlers(ipcMain, {
      companionProfilePath: app.getPath("userData"),
      companionEnabled,
      showCompanionReminder: (scope) => {
        void this.windowManager.showMeetingNotification(
          { kind: "meet-context-lost", ...scope },
          { autoDismiss: false }
        );
      },
      dismissCompanionReminder: (scope, sender) => {
        const current = this.windowManager._pendingNotificationData;

        if (
          current?.kind !== "meet-context-lost" ||
          current.recordingId !== scope.recordingId ||
          current.sessionId !== scope.sessionId ||
          (sender && sender !== this.windowManager.notificationWindow?.webContents)
        )
          return false;
        this.windowManager.dismissMeetingNotification();

        return true;
      },
      preparePlatformLeave: (sessionId) =>
        this.meetingDetectionEngine?.preparePlatformLeave(sessionId) === true,
      suppressPlatformAutoEnd: (sessionId) =>
        this.meetingDetectionEngine?.suppressAutoEndForPlatform(sessionId),
      databaseManager: this.databaseManager,
      meetingRecordingStorage: this.audioStorageManager.meetingRecordings,
      cancelInitialProcessingRun: (runId) => this._meetingProcessing?.cancelRun(runId) ?? false,
      meetingDetectionEngine: this.meetingDetectionEngine,
      audioTapManager: this.audioTapManager,
      getControlPanelWindow: () => this.windowManager.controlPanelWindow,
      getMeetingNotificationData: () => this.windowManager._pendingNotificationData ?? null,
      consumePendingMeetingNoteNavigation: () =>
        this.windowManager.consumePendingMeetingNoteNavigation() ?? null,
      showNotificationWindow: (sender) => this.windowManager.showNotificationWindow(sender),
      setMeetingCaptureState: (active) =>
        this.getTrayManager()?.setMeetingCaptureStatus(
          active,
          active ? () => this.windowManager.stopMeetingCaptureFromMenu() : undefined
        ),
      onCaptureStarted: (noteId) => this._meetingProcessing?.captureStarted(noteId),
      onCaptureStopped: () => this._meetingProcessing?.captureStopped(),
    });
    this.windowManager.setMeetingCaptureQuitGuard({
      isRecording: () => this._meetingCoordinator?.isRecording() === true,
      stop: async () => {
        const expected = this._meetingCoordinator?.currentRecordingScope();

        if (!expected) return { success: true };

        const result = await this._meetingCoordinator!.requestSafeStop({
          expected,
          reason: "quit",
        });

        return { success: result?.success === true };
      },
    });

    registerSpeakerHandlers(ipcMain, {
      databaseManager: this.databaseManager,
      diarizationManager: this.diarizationManager,
      retroactiveMapping: (profile) => this._retroactiveMapping(profile),
      tryAutoLabelOneOnOne: (noteId) => this._tryAutoLabelOneOnOne(noteId),
      logError: (message, data) => debugLogger.error(message, data, "speaker"),
    });
  }

  _retroactiveMapping(profile: SpeakerProfileWithEmbedding): void {
    setImmediate(async () => {
      try {
        const speakerEmbeddings =
          require("./speakerEmbeddings") as import("./speakerEmbeddings.js").SpeakerEmbeddings;

        const unmappedNotes = this.databaseManager.getNotesWithUnmappedSpeakers();

        const profileEmb = new Float32Array(
          profile.embedding.buffer,
          profile.embedding.byteOffset,
          profile.embedding.byteLength / 4
        );

        for (const unmappedNote of unmappedNotes) {
          const noteId = unmappedNote.id;
          const embeddings = this.databaseManager.getNoteSpeakerEmbeddings(noteId);
          const existing = this.databaseManager.getSpeakerMappings(noteId);

          // Only genuinely assigned rows block a rewrite: the placeholder
          // rows (profile_id IS NULL) that brought this note into the
          // unmapped query are exactly what this pass fills in.
          const assignedSpeakers = new Set(
            existing.filter((m) => m.profile_id !== null).map((m) => m.speaker_id)
          );

          for (const emb of embeddings) {
            if (assignedSpeakers.has(emb.speaker_id)) continue;

            const speakerEmb = new Float32Array(
              emb.embedding.buffer,
              emb.embedding.byteOffset,
              emb.embedding.byteLength / 4
            );

            const similarity = speakerEmbeddings.cosineSimilarity(profileEmb, speakerEmb);

            if (similarity > 0.6) {
              this.databaseManager.setSpeakerMapping(
                noteId,
                emb.speaker_id,
                profile.id,
                profile.display_name
              );

              const note = this.databaseManager.getNote(noteId);

              if (note?.transcript) {
                try {
                  const segments = JSON.parse(note.transcript);
                  let changed = false;

                  for (const seg of segments) {
                    if (seg.speaker === emb.speaker_id && !seg.speakerName) {
                      if (canAutoRelabelSpeaker(seg)) {
                        applyConfirmedSpeaker(seg, {
                          speakerName: profile.display_name,
                          speakerIsPlaceholder: false,
                        });
                      } else {
                        seg.speakerName = profile.display_name;
                        seg.speakerIsPlaceholder = false;
                      }

                      changed = true;
                    }
                  }

                  if (changed) {
                    this.databaseManager.updateNote(noteId, {
                      transcript: JSON.stringify(segments),
                    });
                  }
                } catch (_error) {}
              }
            }
          }
        }
      } catch (err) {
        debugLogger.warn("Retroactive speaker mapping failed", { error: (err as Error).message });
      }
    });
  }

  _tryAutoLabelOneOnOne(noteId: number): void {
    setImmediate(async () => {
      try {
        const note = this.databaseManager.getNote(noteId);
        const other = this._resolveOneOnOneOtherParticipant(note?.participants);

        if (!other || !note) return;
        const { displayName, email } = other;

        const embeddings = this.databaseManager.getNoteSpeakerEmbeddings(noteId);

        if (!embeddings.length) return;

        const existingMappings = this.databaseManager.getSpeakerMappings(noteId);
        const mappedSpeakers = new Set(existingMappings.map((m) => m.speaker_id));

        const transcript: SpeakerSegment[] = note.transcript ? JSON.parse(note.transcript) : [];

        const systemSpeakers = new Set(
          transcript
            .filter((s) => (s as { source?: string }).source !== "mic" && s.speaker)
            .map((s) => s.speaker)
        );

        const unmapped = embeddings.filter(
          (e) => !mappedSpeakers.has(e.speaker_id) && systemSpeakers.has(e.speaker_id)
        );

        if (!unmapped.length) return;

        let profile: SpeakerProfileWithEmbedding | null = null;

        for (const emb of unmapped) {
          profile = this.databaseManager.upsertSpeakerProfile(
            displayName,
            email,
            emb.embedding,
            profile?.id ?? null
          );

          if (!profile) continue;
          this.databaseManager.setSpeakerMapping(noteId, emb.speaker_id, profile.id, displayName);
        }

        const unmappedSystemSpeakers = new Set<string | null | undefined>(
          unmapped.map((e) => e.speaker_id)
        );

        let changed = false;

        for (const seg of transcript) {
          if (!unmappedSystemSpeakers.has(seg.speaker)) continue;

          if (seg.speakerName && !seg.speakerIsPlaceholder) continue;

          if (canAutoRelabelSpeaker(seg)) {
            applyConfirmedSpeaker(seg, { speakerName: displayName, speakerIsPlaceholder: false });
          } else {
            seg.speakerName = displayName;
            seg.speakerIsPlaceholder = false;
          }

          changed = true;
        }

        if (changed) {
          this.databaseManager.updateNote(noteId, { transcript: JSON.stringify(transcript) });
          const updated = this.databaseManager.getNote(noteId);

          if (updated) sendNoteUpdated(updated);
        }

        if (profile) {
          this._retroactiveMapping(profile);
        }

        debugLogger.info(
          "Auto-labeled 1-on-1 meeting speakers",
          { noteId, displayName, speakerCount: unmapped.length },
          "speaker"
        );
      } catch (err) {
        debugLogger.warn(
          "Auto-label 1-on-1 failed",
          { noteId, error: (err as Error).message },
          "speaker"
        );
      }
    });
  }

  deleteTranscriptionInternal(id: number) {
    this.audioStorageManager.deleteAudio(id);
    const result = this.databaseManager.deleteTranscription(id);

    if (result?.success) {
      setImmediate(() => {
        broadcastToWindows("transcription-deleted", { id });
      });
    }

    return result;
  }

  async deleteNoteInternal(id: number): Promise<{ success: boolean }> {
    if (!this.databaseManager.getNote(id)) return { success: false };
    const recordings = this.databaseManager.listMeetingRecordingsForNote(id);

    if (recordings.length > 0) {
      const intent = this.databaseManager.beginMeetingNoteDeletion(id);

      if (!intent) return { success: false };
      const success = await this._finishMeetingDeletion(intent);

      return { success };
    }

    const result = this.databaseManager.deleteNote(id);

    if (result?.success) {
      setImmediate(() => sendNoteDeleted({ id }));
      this._asyncMirrorDelete(id);
    }

    return result;
  }
}

// CommonJS contract: main composition and the test harnesses require the
// class directly; the TS graph imports the named export.
module.exports = IPCHandlers;

module.exports.IPCHandlers = IPCHandlers;
