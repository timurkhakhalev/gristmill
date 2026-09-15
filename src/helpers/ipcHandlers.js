const { ipcMain, app, shell, BrowserWindow, net } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const debugLogger = require("./debugLogger");
const { getModelType, isSherpaLocalProvider } = require("./parakeetModelInfo");
const { broadcastToWindows } = require("./windowBroadcast");
const { extractAnthropicText, describeMissingAnthropicText } = require("./anthropicResponse");
const {
  isEnterpriseProvider,
  mapEnterpriseError,
  runAbortableOperation,
  runBedrockRequest,
  validateEnterpriseEndpoint,
} = require("./enterpriseProviderErrors");
// The renderer's ModelRegistry is not main-loadable; the raw registry data is
// packaged, and the route resolver only needs {id, baseUrl} per provider.
const transcriptionProviderBaseUrls = () =>
  require("../models/modelRegistryData.json").transcriptionProviders;
const { approveAudioPath, resolveAllowedAudioPath } = require("./audioPathAllowlist");
const { openSystemSettings } = require("./systemSettingsLauncher");
const { registerNotesHandlers } = require("./notesIpcHandlers");
const { registerUrlDownloadHandlers } = require("./urlDownloadIpcHandlers");
const { registerVocabularyHandlers } = require("./vocabularyIpcHandlers");
const { registerContainerHandlers } = require("./containerIpcHandlers");
const { registerChatPersistenceHandlers } = require("./chatPersistenceIpcHandlers");
const { registerActionsHandlers } = require("./actionsIpcHandlers");
const { registerLocalFileTranscriptionHandler } = require("./localFileTranscriptionIpcHandler");
const { applyConfirmedSpeaker, canAutoRelabelSpeaker } = require("./speakerAssignmentPolicy");
const { sendNoteUpdated, sendNoteDeleted } = require("./notesEvents");
const { getCortiToken } = require("./cortiAuth");
const { transcribeWithTinfoil } = require("./tinfoilTranscription");
const { transcribeWithGemini } = require("./geminiTranscription");
const AudioStorageManager = require("./audioStorage");
const { AgentStreamRequestRegistry } = require("./agentStreamRequestRegistry");
const { createUploadCancelRegistry } = require("./uploadCancelRegistry");
const LocalModelDownloadStatus = require("./localModelDownloadStatus");
const liveSpeakerIdentifier = require("./liveSpeakerIdentifier");
const {
  DEFAULT_EXPECTED_SPEAKER_COUNT,
  MAX_SPEAKER_COUNT,
} = require("../constants/speakerDetection.json");
const {
  DEFAULT_WHISPER_VAD_CONFIG,
  sanitizeWhisperVadConfig,
  resolveContextSileroEnabled,
} = require("./whisperVadConfig");

const {
  DEFAULT_RETENTION_SETTINGS,
} = require("./retentionSettings");
const { fetchRealtimeTokenForProvider } = require("./realtimeTokenProviders");
const { registerCalendarAvailabilityHandler } = require("./calendarAvailabilityIpcHandler");
const { registerCalendarIntegrationHandlers } = require("./calendarIpcHandlers");
const { registerNoteFilesHandlers } = require("./noteFilesIpcHandlers");
const { registerLocalModelLifecycleHandlers } = require("./localModelLifecycleIpcHandlers");
const { registerLocalLlmModelHandlers } = require("./localLlmModelIpcHandlers");
const { registerMeetingCoordinatorHandlers } = require("./meetingCoordinatorIpcHandlers");
const { registerSpeakerHandlers } = require("./speakerIpcHandlers");
const { registerRemoteTranscriptionHandler } = require("./remoteTranscriptionIpcHandler");
const { registerReasoningHandlers } = require("./reasoningIpcHandlers");
const { registerFileDiarizationHandlers } = require("./fileDiarizationIpcHandlers");
const { registerUploadCancelHandler } = require("./uploadCancelIpcHandler");
const { registerTranscriptionExecutionHandlers } = require("./transcriptionExecutionIpcHandlers");
const { registerTranscriptionDataHandlers } = require("./transcriptionDataIpcHandlers");
const { registerDesktopSettingsHandlers } = require("./desktopSettingsIpcHandlers");

// Meeting capture runs at 24 kHz (see meetingRecordingStore AudioContext); realtime
// streaming providers must be told the true PCM rate or they misread the audio.
const MEETING_STREAM_SAMPLE_RATE = 24000;
const MEETING_RECONNECT_BUFFER_MAX_BYTES = MEETING_STREAM_SAMPLE_RATE * 2 * 30;
// The realtime clients default to a 0.6 server-VAD threshold, raised in #630 to
// keep mic ambient noise from opening turns. The direct system-audio channel
// uses a lower threshold so quiet remote speech still opens a turn.
const MEETING_SYSTEM_VAD_THRESHOLD = 0.3;

const { listLocalTranscriptionModels } = require("./localTranscriptionModels");

// The multipart transport behind the remote transcription handler. Kept here
// (not in the typed module) because it owns the Electron net session; the
// handler receives it as a narrow dependency.
async function postMultipart(url, body, boundary, headers = {}, { signal } = {}) {
  const response = await net.fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      ...headers,
    },
    body,
    useSessionCookies: false,
    signal,
  });
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

class IPCHandlers {
  constructor(managers) {
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
    // requestId -> AbortControllers for in-flight audio-upload work, so a
    // cancel can abort the exact job.
    this._uploadCancelRegistry = createUploadCancelRegistry();
    this._enterpriseReasoningRequests = new AgentStreamRequestRegistry();
    // Enterprise streams get their own registry so cancelling a Bedrock
    // one-shot cleanup never aborts a live chat stream or vice versa.
    this._enterpriseStreams = new AgentStreamRequestRegistry();
    // webContents id -> its release listener, for renderers holding the mic open.
    this._hotkeyCaptureMode = false;
    this.audioStorageManager = new AudioStorageManager();
    this.localModelDownloadStatus = new LocalModelDownloadStatus();
    this._retentionCleanupInterval = null;
    this._retentionSettings = { ...DEFAULT_RETENTION_SETTINGS }; // Synced from renderer
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
  _notifyHotkeyChanged(hotkey) {
    ipcMain.emit("hotkey-changed", null, hotkey);
  }

  _getWhisperVadSettings() {
    const current = this.whisperVadSettings || {};
    return {
      noteRecordingSileroEnabled: current.noteRecordingSileroEnabled !== false,
      meetingSileroEnabled: current.meetingSileroEnabled !== false,
      ...sanitizeWhisperVadConfig(current),
    };
  }

  _updateNativeModelDownloadStatus(modelType, modelId, progressData) {
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

  _setWhisperVadSettings(update = {}) {
    const ALLOWED_KEYS = new Set([
      "noteRecordingSileroEnabled",
      "meetingSileroEnabled",
      ...Object.keys(require("../constants/whisperVad.json").DEFAULTS),
    ]);
    const filtered = {};
    for (const [k, v] of Object.entries(update)) {
      if (ALLOWED_KEYS.has(k)) filtered[k] = v;
    }
    this.whisperVadSettings = { ...this._getWhisperVadSettings(), ...filtered };
    return this._getWhisperVadSettings();
  }

  // Shared by the upload IPC handler and the CLI bridge. `filePath` must
  // already have passed resolveAllowedAudioPath (or approveAudioPath).
  // Delegates to the shared module; the IPC handler passes the same deps.
  async transcribeLocalFile(filePath, options = {}) {
    const { transcribeLocalFile: execute } = require("./localFileTranscription");
    return execute(
      {
        readFile: (p) => fs.readFileSync(p),
        isSherpaLocalProvider: (provider) => isSherpaLocalProvider(provider),
        transcribeLocalWhisper: (audioBuffer, opts) =>
          this.whisperManager.transcribeLocalWhisper(audioBuffer, opts),
        transcribeLocalParakeet: (audioBuffer, opts) =>
          this.parakeetManager.transcribeLocalParakeet(audioBuffer, opts),
        resolveWhisperVadOptions: (context) => this._resolveWhisperVadOptions(context),
      },
      filePath,
      options
    );
  }

  approveAudioPath(filePath) {
    approveAudioPath(filePath);
  }

  listLocalTranscriptionModels() {
    return listLocalTranscriptionModels({
      whisperManager: this.whisperManager,
      parakeetManager: this.parakeetManager,
    });
  }

  _resolveWhisperVadOptions(context) {
    const settings = this._getWhisperVadSettings();
    const {
      noteRecordingSileroEnabled,
      meetingSileroEnabled,
      ...vadConfig
    } = settings;
    return {
      vadEnabled: resolveContextSileroEnabled(settings, context),
      vadConfig,
    };
  }

  _mirrorDeleteFolderIfUnshared(folderName) {
    if (!this._noteFilesEnabled) return;
    // Folder names are only unique per space — a live same-named folder in
    // another space shares the mirror directory, so leave it on disk.
    const stillLive = this.databaseManager.db
      .prepare("SELECT 1 FROM folders WHERE name = ? AND deleted_at IS NULL")
      .get(folderName);
    if (stillLive) return;
    const markdownMirror = require("./markdownMirror");
    markdownMirror.deleteFolder(folderName);
  }

  _asyncMirrorWrite(note) {
    if (!this._noteFilesEnabled) {
      debugLogger.debug(
        "Mirror write skipped: note files disabled",
        { noteId: note.id },
        "note-files"
      );
      return;
    }
    setImmediate(() => {
      const markdownMirror = require("./markdownMirror");
      const folderName = this._getFolderName(note.folder_id);
      markdownMirror.writeNote(note, folderName);
      if (note.transcript) {
        markdownMirror.writeTranscript(note, folderName, this._buildSpeakerMappings(note.id));
      }
    });
  }

  _asyncMirrorDelete(noteId) {
    if (!this._noteFilesEnabled) {
      debugLogger.debug("Mirror delete skipped: note files disabled", { noteId }, "note-files");
      return;
    }
    setImmediate(() => {
      const markdownMirror = require("./markdownMirror");
      markdownMirror.deleteNote(noteId);
    });
  }

  _buildFolderMap() {
    const folders = this.databaseManager.getFolders();
    const map = {};
    for (const f of folders) {
      map[f.id] = f.name;
    }
    return map;
  }

  _buildSpeakerMappings(noteId) {
    const arr = this.databaseManager.getSpeakerMappings(noteId);
    const map = {};
    for (const m of arr) {
      map[m.speaker_id] = m.display_name;
    }
    return map;
  }

  _resolveOneOnOneOtherParticipant(participantsJson) {
    return this._meetingCoordinator?.resolveOneOnOneOtherParticipant(participantsJson) ?? null;
  }

  _rebuildMirror(basePath) {
    const markdownMirror = require("./markdownMirror");
    if (basePath) markdownMirror.init(basePath);
    const notes = this.databaseManager.getNotes(null, 99999);
    const speakerMappingsMap = {};
    for (const note of notes) {
      if (note.transcript) {
        speakerMappingsMap[note.id] = this._buildSpeakerMappings(note.id);
      }
    }
    markdownMirror.rebuildAll(notes, this._buildFolderMap(), speakerMappingsMap);
  }

  _getFolderName(folderId) {
    if (!folderId) return "Personal";
    const folder = this.databaseManager.db
      .prepare("SELECT name FROM folders WHERE id = ?")
      .get(folderId);
    return folder?.name || "Personal";
  }

  _getDictionarySafe() {
    try {
      return this.databaseManager.getDictionary();
    } catch {
      return [];
    }
  }

  _setupRetentionCleanup() {
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
    // No sweep at startup: _retentionSettings still holds the 30-day default
    // until the renderer syncs, so sweeping here deletes audio a user set to
    // keep for 60/90 days or forever (#1370). The first sync runs the first
    // sweep instead.
    this._retentionCleanupInterval = setInterval(() => {
      if (this._retentionSettingsSynced) this._runRetentionCleanup();
    }, SIX_HOURS_MS);
  }

  _runRetentionCleanup() {
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
      debugLogger.error("Retention cleanup failed", { error: error.message }, "audio-storage");
    }
  }

  _syncStartupEnv(setVars, clearVars = []) {
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
      this.environmentManager.saveAllKeysToEnvFile().catch((err) => {
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
  async _mintStoredCortiToken(options = {}) {
    const clientId = this.environmentManager.getCortiClientId();
    const clientSecret = this.environmentManager.getCortiClientSecret();
    if (!clientId || !clientSecret) {
      const err = new Error("No Corti credentials configured. Add them in Settings.");
      err.code = "NO_API";
      throw err;
    }
    const environment = options.environment || "us";
    const tenant = (options.tenant || "").trim() || "base";
    const token = await getCortiToken({ environment, tenant, clientId, clientSecret });
    return { token, environment, tenant };
  }

  setupHandlers() {
    const proxyFetch = (url, init = {}) => net.fetch(url, { ...init, useSessionCookies: false });

    // Local/remote transcription execution, temp audio, retry and provider
    // connection/model discovery live in the typed module. Heavy SDKs and the
    // Corti client stay lazy behind these factories.
    registerTranscriptionExecutionHandlers(ipcMain, {
      whisperManager: this.whisperManager,
      parakeetManager: this.parakeetManager,
      resolveWhisperVadOptions: (context) => this._resolveWhisperVadOptions(context),
      environmentManager: this.environmentManager,
      proxyFetch: (url, init) => proxyFetch(url, init),
      transcribeWithCorti: async (args) => {
        const { transcribeAudio } = require("./cortiTranscription");
        return transcribeAudio(args);
      },
      mintStoredCortiToken: (tokenOptions) => this._mintStoredCortiToken(tokenOptions),
      generateText: (options) => require("ai").generateText(options),
      getEnterpriseAIModel: (provider, model, apiKey, enterprise) =>
        require("./enterpriseAiProviders").getEnterpriseAIModel(
          provider,
          model,
          apiKey,
          enterprise
        ),
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
        clearAllPersistedData: () => this.environmentManager.clearAllPersistedData(),
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
      stopLlamaServer: () => require("./modelManagerBridge").default.stopServer(),
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
          const { getModelsDirForService } = require("./modelDirUtils");
          const whisperDir = getModelsDirForService("whisper");
          if (fs.existsSync(whisperDir)) fs.rmSync(whisperDir, { recursive: true, force: true });
        },
        deleteParakeetModels: () => this.parakeetManager.deleteAllParakeetModels(),
        deleteDiarizationModels: () => this.diarizationManager.deleteModels(),
        deleteLlmModels: () => require("./modelManagerBridge").default.deleteAllModels(),
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
      broadcast: broadcastToWindows,
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
      getNotesForSpace: (spaceId, limit) =>
        this.databaseManager.getNotesForSpace(spaceId, limit),
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
      mirrorEnsureFolder: (name) => require("./markdownMirror").ensureFolder(name),
      mirrorRenameFolder: (oldName, newName) =>
        require("./markdownMirror").renameFolder(oldName, newName),
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
    const urlDownloader = require("./urlAudioDownloader");
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
        this.whisperManager.transcribeLocalWhisper(audioBuffer, options),
      transcribeLocalParakeet: (audioBuffer, options) =>
        this.parakeetManager.transcribeLocalParakeet(audioBuffer, options),
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
      transcribeWithTinfoil: (args) => transcribeWithTinfoil(args),
      transcribeWithGemini: (args) => transcribeWithGemini(args),
      // Lazy like the pre-cutover handler: the Corti client is only loaded
      // when its route actually runs.
      transcribeWithCorti: async (args) => {
        const { transcribeAudio } = require("./cortiTranscription");
        return transcribeAudio(args);
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
        require("./ffmpegUtils").convertToWav(inputPath, outputPath, options),
      createTempWavPath: () =>
        path.join(require("./safeTempDir").getSafeTempDir(), `ow-diarize-${Date.now()}.wav`),
      fileSize: (filePath) => fs.statSync(filePath).size,
      resolveClusterThreshold: (durationSeconds, requestedThreshold) =>
        require("./diarizationPolicy").resolveClusterThreshold(durationSeconds, requestedThreshold),
      dropNegligibleClusters: (segments) =>
        require("./diarizationPolicy").dropNegligibleClusters(segments),
      pcm16Mono16kBytesPerSecond: require("./transcriptionTimeout").PCM16_MONO_16K_BYTES_PER_SECOND,
      maxSpeakerCount: MAX_SPEAKER_COUNT,
      removeFile: (filePath) => fs.unlinkSync(filePath),
      mergeSpeakersWithText: (segments, text, duration) =>
        require("./speakerMerge").mergeSpeakersWithText(segments, text, duration),
      formatSpeakerTranscript: (merged) => require("./speakerMerge").formatSpeakerTranscript(merged),
      uploadCancelRegistry: this._uploadCancelRegistry,
      logDebug: (message, data) => debugLogger.debug(message, data),
      logError: (message, data) => debugLogger.error(message, data),
    });

    // Main-owned reasoning lives in the typed module: local/Anthropic/
    // enterprise one-shots plus the sender-scoped enterprise stream
    // lifecycle. Provider factories stay lazy and injected so startup never
    // eager-loads the enterprise SDKs.
    registerReasoningHandlers(ipcMain, {
      localService: require("../services/localReasoningBridge").default,
      getAnthropicKey: () => this.environmentManager.getAnthropicKey(),
      proxyFetch: (url, init) => proxyFetch(url, init),
      extractAnthropicText,
      describeMissingAnthropicText,
      isEnterpriseProvider,
      mapEnterpriseError,
      runAbortableOperation,
      runBedrockRequest,
      validateEnterpriseEndpoint,
      generateText: (options) => require("ai").generateText(options),
      getEnterpriseAIModel: (provider, model, apiKey, enterprise) =>
        require("./enterpriseAiProviders").getEnterpriseAIModel(
          provider,
          model,
          apiKey,
          enterprise
        ),
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
      mirror: require("./markdownMirror"),
      getDefaultNotesPath: () => path.join(app.getPath("userData"), "notes"),
      setNoteFilesEnabled: (enabled) => {
        this._noteFilesEnabled = !!enabled;
      },
      isNoteFilesEnabled: () => this._noteFilesEnabled,
      rebuildMirror: (basePath) => this._rebuildMirror(basePath),
      showItemInFolder: (filePath) => shell.showItemInFolder(filePath),
      openPath: (dirPath) => shell.openPath(dirPath),
      pickFolder: async () => {
        const { dialog } = require("electron");
        const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
        if (result.canceled || !result.filePaths.length) return { canceled: true };
        return { canceled: false, path: result.filePaths[0] };
      },
      pickGranolaCsvFiles: async (event) => {
        const { dialog } = require("electron");
        // Parent the dialog so it opens as a sheet on the settings window —
        // a parentless panel can land invisible on another display/Space.
        const parentWindow = BrowserWindow.fromWebContents(event?.sender);
        const dialogOptions = {
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
      whisperManager: this.whisperManager,
      parakeetManager: this.parakeetManager,
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
      modelManager: require("./modelManagerBridge").default,
      llamaCppInstaller: require("./llamaCppInstaller").default,
      downloadStatus: this.localModelDownloadStatus,
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
      getUpcomingEvents: (windowMinutes) => this.googleCalendarManager.getUpcomingEvents(windowMinutes),
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
      databaseManager: this.databaseManager,
      diarizationManager: this.diarizationManager,
      meetingDetectionEngine: this.meetingDetectionEngine,
      audioTapManager: this.audioTapManager,
      meetingAecManager: this.meetingAecManager,
      whisperManager: this.whisperManager,
      parakeetManager: this.parakeetManager,
      liveSpeakerIdentifier,
      fetchRealtimeToken: (event, options, extra) =>
        fetchRealtimeTokenForProvider(
          options.provider,
          {
            environmentManager: this.environmentManager,
            proxyFetch,
            mintCortiToken: (tokenOptions) => this._mintStoredCortiToken(tokenOptions),
          },
          options,
          extra
        ),
      resolveWhisperVadOptions: (context) => this._resolveWhisperVadOptions(context),
      speakerEmbeddings: () => require("./speakerEmbeddings"),
      getControlPanelWindow: () => this.windowManager.controlPanelWindow,
      getMeetingNotificationData: () => this.windowManager?._pendingNotificationData ?? null,
      consumePendingMeetingNoteNavigation: () =>
        this.windowManager?.consumePendingMeetingNoteNavigation() ?? null,
      showNotificationWindow: (sender) => this.windowManager?.showNotificationWindow(sender),
    });

    registerSpeakerHandlers(ipcMain, {
      databaseManager: this.databaseManager,
      liveSpeakerIdentifier,
      diarizationManager: this.diarizationManager,
      retroactiveMapping: (profile) => this._retroactiveMapping(profile),
      tryAutoLabelOneOnOne: (noteId) => this._tryAutoLabelOneOnOne(noteId),
      logError: (message, data) => debugLogger.error(message, data, "speaker"),
    });
  }

  _retroactiveMapping(profile) {
    setImmediate(async () => {
      try {
        const speakerEmbeddings = require("./speakerEmbeddings");
        const noteIds = this.databaseManager.getNotesWithUnmappedSpeakers();

        const profileEmb = new Float32Array(
          profile.embedding.buffer,
          profile.embedding.byteOffset,
          profile.embedding.byteLength / 4
        );

        for (const noteId of noteIds) {
          const embeddings = this.databaseManager.getNoteSpeakerEmbeddings(noteId);
          const existing = this.databaseManager.getSpeakerMappings(noteId);
          const mappedSpeakers = new Set(existing.map((m) => m.speaker_id));
          for (const emb of embeddings) {
            if (mappedSpeakers.has(emb.speaker_id)) continue;

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
                } catch (_) {}
              }
            }
          }
        }
      } catch (err) {
        debugLogger.warn("Retroactive speaker mapping failed", { error: err.message });
      }
    });
  }

  _tryAutoLabelOneOnOne(noteId) {
    setImmediate(async () => {
      try {
        const note = this.databaseManager.getNote(noteId);
        const other = this._resolveOneOnOneOtherParticipant(note?.participants);
        if (!other) return;
        const { displayName, email } = other;

        const embeddings = this.databaseManager.getNoteSpeakerEmbeddings(noteId);
        if (!embeddings.length) return;

        const existingMappings = this.databaseManager.getSpeakerMappings(noteId);
        const mappedSpeakers = new Set(existingMappings.map((m) => m.speaker_id));

        const transcript = note.transcript ? JSON.parse(note.transcript) : [];
        const systemSpeakers = new Set(
          transcript.filter((s) => s.source !== "mic" && s.speaker).map((s) => s.speaker)
        );

        const unmapped = embeddings.filter(
          (e) => !mappedSpeakers.has(e.speaker_id) && systemSpeakers.has(e.speaker_id)
        );
        if (!unmapped.length) return;

        let profile = null;
        for (const emb of unmapped) {
          profile = this.databaseManager.upsertSpeakerProfile(
            displayName,
            email,
            emb.embedding,
            profile?.id ?? null
          );
          this.databaseManager.setSpeakerMapping(noteId, emb.speaker_id, profile.id, displayName);
          liveSpeakerIdentifier.mapSpeaker(emb.speaker_id, profile.id, displayName, noteId);
        }

        const unmappedSystemSpeakers = new Set(unmapped.map((e) => e.speaker_id));
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

        if (profile) this._retroactiveMapping(profile);

        debugLogger.info(
          "Auto-labeled 1-on-1 meeting speakers",
          { noteId, displayName, speakerCount: unmapped.length },
          "speaker"
        );
      } catch (err) {
        debugLogger.warn("Auto-label 1-on-1 failed", { noteId, error: err.message }, "speaker");
      }
    });
  }

  deleteTranscriptionInternal(id) {
    this.audioStorageManager.deleteAudio(id);
    const result = this.databaseManager.deleteTranscription(id);
    if (result?.success) {
      setImmediate(() => {
        broadcastToWindows("transcription-deleted", { id });
      });
    }
    return result;
  }

  deleteNoteInternal(id) {
    const result = this.databaseManager.deleteNote(id);
    if (result?.success) {
      setImmediate(() => sendNoteDeleted({ id }));
      this._asyncMirrorDelete(id);
    }
    return result;
  }
}

module.exports = IPCHandlers;
