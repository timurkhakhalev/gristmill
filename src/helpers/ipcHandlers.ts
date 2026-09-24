import { app, BrowserWindow, dialog, ipcMain, net, shell, type IpcMainInvokeEvent } from "electron";
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
import { registerNotesHandlers } from "./notesIpcHandlers.js";
import { registerUrlDownloadHandlers } from "./urlDownloadIpcHandlers.js";
import { registerVocabularyHandlers } from "./vocabularyIpcHandlers.js";
import { registerContainerHandlers } from "./containerIpcHandlers.js";
import { registerChatPersistenceHandlers } from "./chatPersistenceIpcHandlers.js";
import { registerActionsHandlers } from "./actionsIpcHandlers.js";
import { registerLocalFileTranscriptionHandler } from "./localFileTranscriptionIpcHandler.js";
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
import liveSpeakerIdentifier from "./liveSpeakerIdentifier.js";
import {
  DEFAULT_WHISPER_VAD_CONFIG,
  resolveContextSileroEnabled,
  sanitizeWhisperVadConfig,
} from "./whisperVadConfig.js";
import { DEFAULT_RETENTION_SETTINGS, type RetentionSettings } from "./retentionSettings.js";
import { fetchRealtimeTokenForProvider } from "./realtimeTokenProviders.js";
import { registerCalendarAvailabilityHandler } from "./calendarAvailabilityIpcHandler.js";
import { registerCalendarIntegrationHandlers } from "./calendarIpcHandlers.js";
import { registerNoteFilesHandlers } from "./noteFilesIpcHandlers.js";
import { registerLocalModelLifecycleHandlers } from "./localModelLifecycleIpcHandlers.js";
import { registerLocalLlmModelHandlers } from "./localLlmModelIpcHandlers.js";
import {
  registerMeetingCoordinatorHandlers,
  type CoordinatorLiveSpeakerIdentifier,
  type MeetingCoordinatorRuntime,
} from "./meetingCoordinatorIpcHandlers.js";
import type { DiarizationPublicationDatabase } from "./meetingDiarizationPublication.js";
import { registerSpeakerHandlers, type SpeakerDatabase } from "./speakerIpcHandlers.js";
import { registerRemoteTranscriptionHandler } from "./remoteTranscriptionIpcHandler.js";
import { registerReasoningHandlers, type EnterpriseStreamModel } from "./reasoningIpcHandlers.js";
import { registerFileDiarizationHandlers } from "./fileDiarizationIpcHandlers.js";
import { registerUploadCancelHandler } from "./uploadCancelIpcHandler.js";
import { registerTranscriptionExecutionHandlers } from "./transcriptionExecutionIpcHandlers.js";
import type { MeetingStreamingProvider } from "./meetingStreamingProviders.js";
import type { LocalModelDownloadState } from "./localModelDownloadStatus.js";
import type { MergedSpeakerSegment } from "./speakerMerge.js";
import type { ModelManager } from "./modelManagerBridge.js";
import type { DiarizationSegment } from "./diarization.js";
import type { LlmModelManagerLike, LlmDownloadStatusTracker } from "./localLlmModelIpcHandlers.js";
import type { WhisperManagerLike, ParakeetManagerLike } from "./localModelLifecycleIpcHandlers.js";
import type { DiarizationPublicationDiarizationManager } from "./meetingDiarizationPublication.js";
import { registerTranscriptionDataHandlers } from "./transcriptionDataIpcHandlers.js";
import { registerDesktopSettingsHandlers } from "./desktopSettingsIpcHandlers.js";
import { listLocalTranscriptionModels } from "./localTranscriptionModels.js";
import markdownMirror from "./markdownMirror.js";
import modelManagerBundle from "./modelManagerBridge.js";
import type { NoteItem } from "../contracts/notes.js";
import type { TranscriptionResponse } from "../contracts/localFileTranscription.js";
import type { EnvironmentManagerWithByok } from "./environment.js";
import type { DatabaseManager, SpeakerProfileRow } from "./database.js";
import type { WhisperManager } from "./whisper.js";
import type { ParakeetManager } from "./parakeet.js";
import type { DiarizationManager } from "./diarization.js";
import type { WindowManager } from "./windowManager.js";
import type { GoogleCalendarManager } from "./googleCalendarManager.js";
import type { MicrosoftCalendarManager } from "./microsoftCalendarManager.js";
import type { AppleCalendarManager } from "./appleCalendarManager.js";
import type { MeetingDetectionEngine } from "./meetingDetectionEngine.js";
import type { AudioTapManager } from "./audioTapManager.js";
import type { MeetingAecManager } from "./meetingAecManager.js";
import type { TrayManager } from "./tray.js";

const transcriptionProviderBaseUrls = () => modelRegistryData.transcriptionProviders;

// The bundle's `default` is the ModelManager singleton under every loader; the
// default import resolves to the module.exports wrapper, so drill in once
// (same interop note as localReasoningBridge.ts). Eager is fine: the llm
// lifecycle deps already materialized the manager during setupHandlers.
const modelManager = (modelManagerBundle as unknown as { default: ModelManager }).default;

// Meeting capture runs at 24 kHz (see meetingRecordingStore AudioContext); realtime
// streaming providers must be told the true PCM rate or they misread the audio.
const MEETING_STREAM_SAMPLE_RATE = 24000;
const MEETING_RECONNECT_BUFFER_MAX_BYTES = MEETING_STREAM_SAMPLE_RATE * 2 * 30;
// The realtime clients default to a 0.6 server-VAD threshold, raised in #630 to
// keep mic ambient noise from opening turns. The direct system-audio channel
// uses a lower threshold so quiet remote speech still opens a turn.
const MEETING_SYSTEM_VAD_THRESHOLD = 0.3;

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
  meetingAecManager: MeetingAecManager;
  getTrayManager: () => TrayManager | null;
  oauthProtocolRegistered: boolean;
  oauthProtocol: string;
}

// The WindowManager class has no mainWindow property; the main-window seams
// below read it as an absent optional, exactly like the untyped JS did.
type IpcWindowManager = WindowManager & { mainWindow?: BrowserWindow | null };

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

async function postRawAudioFile(
  url: URL,
  filePath: string,
  contentType: string,
  apiKey: string,
  {
    signal,
    multipart,
  }: {
    signal?: AbortSignal;
    multipart?: { fileName: string; fields: Record<string, string> };
  } = {}
): Promise<{ statusCode: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const boundary = multipart ? `----OpenHercules${crypto.randomUUID()}` : null;
    const header = boundary
      ? Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${multipart!.fileName.replace(/[\r\n"]/g, "_")}"\r\nContent-Type: ${contentType}\r\n\r\n`
        )
      : null;
    const footer = boundary
      ? Buffer.from(
          `\r\n${Object.entries(multipart!.fields)
            .map(
              ([name, value]) =>
                `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
            )
            .join("")}--${boundary}--\r\n`
        )
      : null;
    const request = net.request({
      method: "POST",
      url: url.toString(),
      headers: boundary
        ? { "xi-api-key": apiKey, "Content-Type": `multipart/form-data; boundary=${boundary}` }
        : { Authorization: `Token ${apiKey}`, "Content-Type": contentType },
    });
    request.chunkedEncoding = true;
    const source = fs.createReadStream(filePath);
    let settled = false;
    const finish = (error?: Error, result?: { statusCode: number; data: unknown }) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      source.destroy();
      if (error) {
        request.abort();
        reject(error);
      } else if (result) resolve(result);
    };
    const abort = () => finish(new DOMException("Cancelled", "AbortError"));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    source.on("error", finish);
    request.on("error", finish);
    request.on("close", () => {
      if (!settled) finish(new Error("Audio upload closed before a response"));
    });
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", finish);
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        try {
          finish(undefined, { statusCode: response.statusCode, data: JSON.parse(body) });
        } catch {
          finish(undefined, { statusCode: response.statusCode, data: body });
        }
      });
    });
    void (async () => {
      if (header) await new Promise<void>((written) => request.write(header, undefined, written));
      for await (const chunk of source) {
        if (signal?.aborted) return;
        await new Promise<void>((written) => request.write(chunk, undefined, written));
      }
      if (!signal?.aborted) {
        if (footer) await new Promise<void>((written) => request.write(footer, undefined, written));
        request.end();
      }
    })().catch(finish);
  });
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
  whisperManager: WhisperManager;
  parakeetManager: ParakeetManager;
  diarizationManager: DiarizationManager;
  windowManager: IpcWindowManager;
  getTrayManager: () => TrayManager | null;
  googleCalendarManager: GoogleCalendarManager;
  microsoftCalendarManager: MicrosoftCalendarManager;
  appleCalendarManager: AppleCalendarManager;
  meetingDetectionEngine: MeetingDetectionEngine;
  audioTapManager: AudioTapManager;
  meetingAecManager: MeetingAecManager;
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
    this.meetingAecManager = managers.meetingAecManager;
    this.oauthProtocolRegistered = managers.oauthProtocolRegistered === true;
    this.oauthProtocol = managers.oauthProtocol || "openhercules";
    this.sessionId = crypto.randomUUID();
    this._uploadCancelRegistry = createUploadCancelRegistry();
    this._enterpriseReasoningRequests = new AgentStreamRequestRegistry();
    this._enterpriseStreams = new AgentStreamRequestRegistry();
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
    liveSpeakerIdentifier.setDiarizationManager(this.diarizationManager);
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

  _mirrorDeleteFolderIfUnshared(folderName: string): void {
    if (!this._noteFilesEnabled) return;
    // Folder names are only unique per space — a live same-named folder in
    // another space shares the mirror directory, so leave it on disk.
    const stillLive = this.databaseManager.db
      .prepare("SELECT 1 FROM folders WHERE name = ? AND deleted_at IS NULL")
      .get(folderName);
    if (stillLive) return;
    markdownMirror.deleteFolder(folderName);
  }

  _asyncMirrorWrite(note: NoteItem): void {
    if (!this._noteFilesEnabled) {
      debugLogger.debug(
        "Mirror write skipped: note files disabled",
        { noteId: note.id },
        "note-files"
      );
      return;
    }
    setImmediate(() => {
      const folderName = this._getFolderName(note.folder_id);
      markdownMirror.writeNote(note, folderName);
      if (note.transcript) {
        markdownMirror.writeTranscript(note, folderName, this._buildSpeakerMappings(note.id));
      }
    });
  }

  _asyncMirrorDelete(noteId: number): void {
    if (!this._noteFilesEnabled) {
      debugLogger.debug("Mirror delete skipped: note files disabled", { noteId }, "note-files");
      return;
    }
    setImmediate(() => {
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
    // No sweep at startup: _retentionSettings still holds the 30-day default
    // until the renderer syncs, so sweeping here deletes audio a user set to
    // keep for 60/90 days or forever (#1370). The first sync runs the first
    // sweep instead.
    this._retentionCleanupInterval = setInterval(() => {
      if (this._retentionSettingsSynced) this._runRetentionCleanup();
    }, SIX_HOURS_MS);
  }

  _runRetentionCleanup(): void {
    const { audioRetentionDays, transcriptRetentionDays } = this._retentionSettings;
    try {
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
      }
    } catch (error) {
      debugLogger.error(
        "Retention cleanup failed",
        { error: (error as Error).message },
        "audio-storage"
      );
    }
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
        (
          require("./enterpriseAiProviders") as typeof import("./enterpriseAiProviders.js")
        ).getEnterpriseAIModel(
          provider,
          model,
          apiKey,
          enterprise
        ) as Promise<EnterpriseStreamModel>,
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
      deleteTranscriptionInternal: (id) => this.deleteTranscriptionInternal(id),
      buildSpeakerMappings: (noteId) => this._buildSpeakerMappings(noteId),
      queueNoteNavigation: (payload) => this.windowManager.queueNoteNavigation(payload),
      consumePendingNoteNavigation: () => this.windowManager.consumePendingNoteNavigation(),
      retention: {
        getCurrentSettings: () => this._retentionSettings,
        getOwner: () => this.windowManager.mainWindow?.webContents,
        hasSynced: () => this._retentionSettingsSynced,
        onSettingsChanged: (settings) => {
          this._retentionSettings = settings;
          this._retentionSettingsSynced = true;
          this._runRetentionCleanup();
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
        getPermissionStatus: () => this.audioTapManager.getPermissionStatus(),
      },
      oauthProtocolRegistered: this.oauthProtocolRegistered,
      oauthProtocol: this.oauthProtocol,
      getTrayManager: () => this.getTrayManager(),
      sendToMainWindow: (channel) => this.windowManager.mainWindow?.webContents?.send(channel),
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
        deleteAllAudio: () => this.audioStorageManager.deleteAllAudio(),
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
    registerNotesHandlers(ipcMain, {
      saveNote: (title, content, noteType, sourceFile, audioDuration, folderId, spaceId) =>
        this.databaseManager.saveNote(
          title,
          content,
          noteType,
          sourceFile,
          audioDuration,
          folderId,
          spaceId
        ),
      getNote: (id) => this.databaseManager.getNote(id),
      getNotes: (noteType, limit, folderId, spaceId) =>
        this.databaseManager.getNotes(noteType, limit, folderId, spaceId),
      getNotesForSpace: (spaceId, limit) => this.databaseManager.getNotesForSpace(spaceId, limit),
      updateNote: (id, updates) => this.databaseManager.updateNote(id, updates),
      deleteNoteInternal: (id) => this.deleteNoteInternal(id),
      searchNotes: (query, limit, spaceId, folderId) =>
        this.databaseManager.searchNotes(query, limit, spaceId, folderId),
      asyncMirrorWrite: (note) => this._asyncMirrorWrite(note),
      tryAutoLabelOneOnOne: (noteId) => this._tryAutoLabelOneOnOne(noteId),
      refreshMeetingSpeakerConfigFromNote: (noteId, note) =>
        this._meetingCoordinator?.refreshMeetingSpeakerConfigFromNote(noteId, note),
    });

    // Container (folders/spaces) channels live in the typed module.
    registerContainerHandlers(ipcMain, {
      database: this.databaseManager,
      noteFilesEnabled: () => this._noteFilesEnabled,
      getFolderName: (folderId) => this._getFolderName(folderId),
      mirrorWriteNote: (note) => this._asyncMirrorWrite(note),
      mirrorEnsureFolder: (name) => markdownMirror.ensureFolder(name),
      mirrorRenameFolder: (oldName, newName) => markdownMirror.renameFolder(oldName, newName),
      mirrorDeleteFolderIfUnshared: (name) => this._mirrorDeleteFolderIfUnshared(name),
    });

    // AI Actions catalog channels live in the typed module.
    registerActionsHandlers(ipcMain, {
      database: this.databaseManager,
    });

    // Agent conversation (chat persistence) channels live in the typed module.
    registerChatPersistenceHandlers(ipcMain, {
      database: this.databaseManager,
    });

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
    registerLocalFileTranscriptionHandler(ipcMain, {
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
    });

    // Remote (BYOK/self-hosted) transcription lives in the typed module; the
    // route resolver is re-run there as the trust boundary, and every active
    // transport receives the cancel registry's AbortSignal.
    registerRemoteTranscriptionHandler(ipcMain, {
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
    });

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
      localService: (
        require("../services/localReasoningBridge") as typeof import("../services/localReasoningBridge.js")
      ).default,
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
        (
          require("./enterpriseAiProviders") as typeof import("./enterpriseAiProviders.js")
        ).getEnterpriseAIModel(
          provider,
          model,
          apiKey,
          enterprise
        ) as Promise<EnterpriseStreamModel>,
      bedrockCleanupRequests: this._enterpriseReasoningRequests,
      enterpriseStreams: this._enterpriseStreams,
      logError: (message, data) => debugLogger.error(message, data),
    });

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
    this._meetingCoordinator = registerMeetingCoordinatorHandlers(ipcMain, {
      databaseManager: this.databaseManager as unknown as DiarizationPublicationDatabase & import("./meetingCaptureSession.js").MeetingCaptureDatabase,
      meetingRecordingStorage: this.audioStorageManager.meetingRecordings,
      diarizationManager: this
        .diarizationManager as unknown as DiarizationPublicationDiarizationManager,
      meetingDetectionEngine: this.meetingDetectionEngine,
      audioTapManager: this.audioTapManager,
      meetingAecManager: this.meetingAecManager,
      whisperManager: {
        transcribeLocalWhisper: (audio, options) =>
          this._transcribeLocalWhisper(audio, options) as Promise<
            | {
                success?: boolean;
                text?: string | null;
              }
            | null
            | undefined
          >,
      },
      parakeetManager: {
        transcribeLocalParakeet: (audio, options) =>
          this._transcribeLocalParakeet(audio, options) as Promise<
            | {
                success?: boolean;
                text?: string | null;
              }
            | null
            | undefined
          >,
      },
      liveSpeakerIdentifier: liveSpeakerIdentifier as CoordinatorLiveSpeakerIdentifier,
      fetchRealtimeToken: ((event, options, extra) =>
        fetchRealtimeTokenForProvider(
          options.provider as MeetingStreamingProvider,
          {
            environmentManager: this.environmentManager,
            proxyFetch,
            mintCortiToken: (tokenOptions) => this._mintStoredCortiToken(tokenOptions),
          },
          options,
          extra
        )) as Parameters<typeof registerMeetingCoordinatorHandlers>[1]["fetchRealtimeToken"],
      resolveWhisperVadOptions: (context) => this._resolveWhisperVadOptions(context),
      speakerEmbeddings: () =>
        require("./speakerEmbeddings") as import("./speakerEmbeddings.js").SpeakerEmbeddings,
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
    });
    this.windowManager.setMeetingCaptureQuitGuard({
      isRecording: () => this._meetingCoordinator?.isRecording() === true,
      stop: async () => {
        const result = await this._meetingCoordinator?.requestSafeStop();
        return { success: result?.success === true };
      },
    });

    registerSpeakerHandlers(ipcMain, {
      // SpeakerDatabase narrows the manager surface; upsert's null branch is
      // not reachable for the promotion paths this vertical drives.
      databaseManager: this.databaseManager as unknown as SpeakerDatabase,
      liveSpeakerIdentifier,
      diarizationManager: this.diarizationManager,
      retroactiveMapping: (profile) =>
        this._retroactiveMapping(
          profile as { id: number; display_name: string; embedding: Buffer }
        ),
      tryAutoLabelOneOnOne: (noteId) => this._tryAutoLabelOneOnOne(noteId),
      logError: (message, data) => debugLogger.error(message, data, "speaker"),
    });
  }

  _retroactiveMapping(profile: { id: number; display_name: string; embedding: Buffer }): void {
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

        let profile: SpeakerProfileRow | null = null;
        for (const emb of unmapped) {
          profile = this.databaseManager.upsertSpeakerProfile(
            displayName,
            email,
            emb.embedding,
            profile?.id ?? null
          );
          if (!profile) continue;
          this.databaseManager.setSpeakerMapping(noteId, emb.speaker_id, profile.id, displayName);
          liveSpeakerIdentifier.mapSpeaker(emb.speaker_id, profile.id, displayName, noteId);
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
          this._retroactiveMapping(profile as SpeakerProfileRow & { embedding: Buffer });
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

  deleteNoteInternal(id: number) {
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
