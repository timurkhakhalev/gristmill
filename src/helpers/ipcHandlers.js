const { ipcMain, app, shell, BrowserWindow, net } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const debugLogger = require("./debugLogger");
const { getModelType, isSherpaLocalProvider } = require("./parakeetModelInfo");
const { broadcastToWindows } = require("./windowBroadcast");
const { BYOK_API_KEYS } = require("../config/secretKeys");
const { extractAnthropicText, describeMissingAnthropicText } = require("./anthropicResponse");
const { classifyAndLog } = require("./networkErrors");
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
const { resolveLocalServerNeeds } = require("./localServerPolicy");
const { approveAudioPath, resolveAllowedAudioPath } = require("./audioPathAllowlist");
const { openSystemSettings } = require("./systemSettingsLauncher");
const { registerNotesHandlers } = require("./notesIpcHandlers");
const { registerUrlDownloadHandlers } = require("./urlDownloadIpcHandlers");
const { registerVocabularyHandlers } = require("./vocabularyIpcHandlers");
const { registerContainerHandlers } = require("./containerIpcHandlers");
const { registerChatPersistenceHandlers } = require("./chatPersistenceIpcHandlers");
const { registerActionsHandlers } = require("./actionsIpcHandlers");
const { registerLocalFileTranscriptionHandler } = require("./localFileTranscriptionIpcHandler");
const { sendNoteAdded, sendNoteUpdated, sendNoteDeleted } = require("./notesEvents");
const AssemblyAiStreaming = require("./assemblyAiStreaming");
const DeepgramStreaming = require("./deepgramStreaming");
const { GeminiLiveStreaming, GEMINI_LIVE_MODEL } = require("./geminiLiveStreaming");
const CortiStreaming = require("./cortiStreaming");
const OpenAIRealtimeStreaming = require("./openaiRealtimeStreaming");
const { getCortiToken } = require("./cortiAuth");
const { createTinfoilRealtimeSocket } = require("./tinfoilSecureClient");
const { TINFOIL_REALTIME_MODEL } = require("./tinfoilRealtimeStreaming");
const { transcribeWithTinfoil } = require("./tinfoilTranscription");
const { transcribeWithGemini } = require("./geminiTranscription");
const AudioStorageManager = require("./audioStorage");
const { AgentStreamRequestRegistry } = require("./agentStreamRequestRegistry");
const { createUploadCancelRegistry } = require("./uploadCancelRegistry");
const LocalModelDownloadStatus = require("./localModelDownloadStatus");
const createMeetingTranscriptionLifecycle = require("./meetingTranscriptionLifecycle");
const { registerMeetingAutoEndLifecycleHandlers } = require("./meetingAutoEndLifecycle");
const liveSpeakerIdentifier = require("./liveSpeakerIdentifier");
const { supportsLiveSpeakerIdentification } = require("./liveSpeakerIdPolicy");
const MeetingEchoLeakDetector = require("./meetingEchoLeakDetector");
const createMeetingSystemAudioWatchdog = require("./meetingSystemAudioWatchdog");
const {
  partitionPendingMicFinals,
  isRiskyMicDuplicateProfile,
  isDuplicateMicSegment,
  selectRacingMicEntryIndices,
  partitionOverlappingPendingMicFinals,
} = require("./meetingMicHoldback");
const {
  computeChunkStats,
  resolveMicChunkAction,
  MEETING_MIC_SILENCE_RMS,
  MEETING_MIC_SILENCE_PEAK,
} = require("./meetingMicGate");
const { resolveDiarizationInput } = require("./meetingDiarizationInput");
const {
  DEFAULT_RETENTION_SETTINGS,
  createRetentionSettingsHandler,
} = require("./retentionSettings");
const {
  transcriptsOverlap,
  transcriptsLooselyOverlap,
  buildMergedCandidates,
} = require("./transcriptText");
const {
  applyConfirmedSpeaker,
  applySuggestedSpeaker,
  canAutoRelabelSpeaker,
  isSpeakerLocked,
} = require("./speakerAssignmentPolicy");
const { normalizeStoredSpeakerCount } = require("./speakerCount");
const { downsample24kTo16k, pcm16ToWav } = require("../utils/audioUtils");
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
  ALLOWED_MEETING_PROVIDERS,
  getMeetingStreamingClient,
  getMeetingConnectionKey,
} = require("./meetingStreamingProviders");
const { fetchRealtimeTokenForProvider } = require("./realtimeTokenProviders");
const { registerCalendarAvailabilityHandler } = require("./calendarAvailabilityIpcHandler");
const { registerCalendarIntegrationHandlers } = require("./calendarIpcHandlers");
const { registerNoteFilesHandlers } = require("./noteFilesIpcHandlers");
const { registerLocalModelLifecycleHandlers } = require("./localModelLifecycleIpcHandlers");
const { registerLocalLlmModelHandlers } = require("./localLlmModelIpcHandlers");
const { registerSpeakerHandlers } = require("./speakerIpcHandlers");
const { registerRemoteTranscriptionHandler } = require("./remoteTranscriptionIpcHandler");
const { registerReasoningHandlers, resolveEnterpriseRuntime } = require("./reasoningIpcHandlers");
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
    this._micHoldSenders = new Map();
    this.assemblyAiStreaming = null;
    this.deepgramStreaming = null;
    this.geminiStreaming = null;
    this.cortiStreaming = null;
    this._meetingMicStreaming = null;
    this._meetingSystemStreaming = null;
    this._hotkeyCaptureMode = false;
    this._activeRecordingPipeline = null;
    this.audioStorageManager = new AudioStorageManager();
    this.localModelDownloadStatus = new LocalModelDownloadStatus();
    this._retentionCleanupInterval = null;
    this._retentionSettings = { ...DEFAULT_RETENTION_SETTINGS }; // Synced from renderer
    this._retentionSettingsSynced = false;
    this._noteFilesEnabled = false;
    this._granolaImportPending = null;
    this.speakerDiarizationEnabled = true;
    this.activeMeetingSpeakerConfig = null;
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

  _releaseMicHold(sender) {
    const release = this._micHoldSenders.get(sender.id);
    if (!release) return;
    this._micHoldSenders.delete(sender.id);
    sender.off("destroyed", release);
    sender.off("did-finish-load", release);
    this.meetingDetectionEngine?.setMicWarmHold(this._micHoldSenders.size > 0);
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

  _parseNonSelfParticipants(participantsJson) {
    if (!participantsJson) return [];
    let participants;
    try {
      participants = JSON.parse(participantsJson);
    } catch (_) {
      return [];
    }
    if (!Array.isArray(participants) || participants.length === 0) return [];
    const googleEmails = new Set(
      this.databaseManager.getGoogleAccounts().map((a) => a.email.toLowerCase())
    );
    return participants.filter(
      (p) => p && p.self !== true && !googleEmails.has((p.email || "").toLowerCase())
    );
  }

  _getNoteNonSelfParticipants(noteId) {
    if (!noteId) return [];
    try {
      const note = this.databaseManager.getNote(noteId);
      return this._parseNonSelfParticipants(note?.participants);
    } catch (_) {
      return [];
    }
  }

  _resolveOneOnOneOtherParticipant(participantsJson) {
    const others = this._parseNonSelfParticipants(participantsJson);
    if (others.length !== 1) return null;
    const displayName = others[0].displayName || others[0].email;
    if (!displayName) return null;
    const email = (others[0].email || "").toLowerCase().trim() || null;
    return { displayName, email };
  }

  _noteExpectedSpeakerCountOrNull(note) {
    const stored = normalizeStoredSpeakerCount(note?.expected_speaker_count);
    if (stored != null) {
      return stored;
    }
    const others = this._parseNonSelfParticipants(note?.participants).length;
    if (others > 0) {
      return Math.min(others + 1, MAX_SPEAKER_COUNT);
    }
    return null;
  }

  _resolveNoteExpectedSpeakerCount(note) {
    return this._noteExpectedSpeakerCountOrNull(note) ?? DEFAULT_EXPECTED_SPEAKER_COUNT;
  }

  _resolveInitialMeetingSpeakerConfig(noteId) {
    let note = null;
    if (noteId != null) {
      try {
        note = this.databaseManager.getNote(noteId);
      } catch (_) {
        note = null;
      }
    }
    const enabled =
      (note?.diarization_enabled == null
        ? this.speakerDiarizationEnabled
        : note.diarization_enabled !== 0) !== false;
    return { enabled, expectedCount: this._resolveNoteExpectedSpeakerCount(note) };
  }

  // Participants added mid-meeting must raise the speaker cap that was derived
  // from the note at recording start. A count the user set via the stepper
  // (explicit) is never overridden.
  //
  // Raise-only: lowering the cap below the clusters already discovered would make
  // _assignOrForceCluster fold every later voice onto an existing speaker — the
  // exact identity collapse this refresh exists to prevent. A roster that shrinks
  // (or empties) mid-meeting therefore leaves the cap where it is.
  _refreshMeetingSpeakerConfigFromNote(noteId, note) {
    const config = this.activeMeetingSpeakerConfig;
    if (!config || config.explicit) return;
    if (noteId == null || this._activeMeetingNoteId !== noteId) return;

    const expectedCount = this._noteExpectedSpeakerCountOrNull(note);
    if (expectedCount == null || expectedCount <= config.expectedCount) return;

    this.activeMeetingSpeakerConfig = { ...config, expectedCount };
    liveSpeakerIdentifier.setMaxSpeakers(Math.max(1, expectedCount - 1));
    broadcastToWindows("meeting-session-speaker-config-updated", {
      enabled: config.enabled,
      expectedCount,
    });
    debugLogger.info(
      "Meeting speaker config refreshed from participants",
      { noteId, expectedCount },
      "speaker"
    );
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

    // Every window's AudioManager can hold the mic open outside a recording, so
    // gate the audio-evidence meeting detector until they all release. A
    // renderer that reloads or goes away releases implicitly — otherwise a
    // crash mid-hold would gate detection for the rest of the session.
    ipcMain.on("mic-warm-hold-changed", (event, active) => {
      if (!active) {
        this._releaseMicHold(event.sender);
        return;
      }
      if (this._micHoldSenders.has(event.sender.id)) return;
      const release = () => this._releaseMicHold(event.sender);
      this._micHoldSenders.set(event.sender.id, release);
      event.sender.on("destroyed", release);
      event.sender.on("did-finish-load", release);
      this.meetingDetectionEngine?.setMicWarmHold(true);
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
        this._refreshMeetingSpeakerConfigFromNote(noteId, note),
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

    let meetingTranscriptionStartInProgress = false;
    let meetingTranscriptionPrepareInProgress = false;
    let meetingTranscriptionPreparePromise = null;

    const DUPLICATE_TRANSCRIPT_WINDOW_MS = 6000;
    const DUPLICATE_TRANSCRIPT_MERGE_LIMIT = 3;
    const STREAMING_RISKY_MIC_SEGMENT_HOLDBACK_MS = 3000;
    const LOCAL_MEETING_CHUNK_INTERVAL_MS = 5000;
    // Must outlast one local transcription cycle so a straddling remote
    // utterance's next-cycle system transcript can confirm buffered echo.
    const LOCAL_RISKY_MIC_SEGMENT_HOLDBACK_MS = LOCAL_MEETING_CHUNK_INTERVAL_MS + 1000;
    const RACING_MIC_RETRACT_WINDOW_MS = 4000;

    const buildNearbyTranscriptCandidates = (
      targetSource,
      timestamp,
      { extraSegment = null } = {}
    ) => {
      const relevant = meetingDiarizationSegments.filter(
        (candidate) =>
          candidate.source === targetSource && candidate.timestamp != null && candidate.text
      );

      return buildMergedCandidates({
        segments: relevant,
        timestamp,
        windowMs: DUPLICATE_TRANSCRIPT_WINDOW_MS,
        mergeLimit: DUPLICATE_TRANSCRIPT_MERGE_LIMIT,
        extraSegment,
      });
    };

    const hasNearbyTranscriptMatch = (targetSource, text, timestamp, options = {}) => {
      if (!text) return false;

      const matcher = options.relaxed ? transcriptsLooselyOverlap : transcriptsOverlap;
      const candidates = buildNearbyTranscriptCandidates(targetSource, timestamp, options);
      for (const candidateText of candidates) {
        if (matcher(text, candidateText)) {
          return true;
        }
      }

      return false;
    };

    const shouldSkipDuplicateMicSegment = (text, timestamp, suppression = null) =>
      isDuplicateMicSegment({ text, timestamp, suppression, hasNearbyTranscriptMatch });

    const isWithinMeetingStartupWarmup = () =>
      meetingStartedAt != null && Date.now() - meetingStartedAt < MEETING_STARTUP_WARMUP_MS;

    const hasRiskyMicDuplicateProfile = (suppression = null) =>
      isRiskyMicDuplicateProfile({
        suppression,
        inStartupWarmup: isWithinMeetingStartupWarmup(),
      });

    const removeRacingMicEntriesFor = (systemText, systemTimestamp) => {
      const indices = selectRacingMicEntryIndices({
        segments: meetingDiarizationSegments,
        systemText,
        systemTimestamp,
        hasNearbyTranscriptMatch,
        duplicateWindowMs: DUPLICATE_TRANSCRIPT_WINDOW_MS,
        retractWindowMs: RACING_MIC_RETRACT_WINDOW_MS,
      });
      const removed = [];
      // Indices are descending, so splicing in order never shifts a later index.
      for (const index of indices) {
        removed.push(meetingDiarizationSegments[index]);
        meetingDiarizationSegments.splice(index, 1);
      }
      return removed;
    };

    const appendMeetingLocalTranscript = (text) => {
      if (!text) return;
      meetingLocalTranscript += `${meetingLocalTranscript ? " " : ""}${text}`;
    };

    // Held-back mic segments are appended at release time, so insertion order
    // is not spoken order.
    const buildOrderedTranscriptText = (segments) =>
      segments
        .slice()
        .sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0))
        .map((segment) => segment.text)
        .join(" ")
        .trim();

    const storeMeetingDiarizationSegment = (text, source, timestamp, micSuppression = null) => {
      meetingDiarizationSegments.push({
        text,
        source,
        timestamp,
        committedAt: Date.now(),
        suppressionReason: source === "mic" ? micSuppression?.reason || null : null,
        hasBleedEvidence: source === "mic" ? !!micSuppression?.hasBleedEvidence : false,
        likelyRenderBleed: source === "mic" ? !!micSuppression?.likelyRenderBleed : false,
      });
    };

    const sendMeetingFinalSegment = ({
      text,
      source,
      timestamp,
      micSuppression = null,
      send = null,
      includeInLocalTranscript = false,
    }) => {
      if (includeInLocalTranscript) {
        appendMeetingLocalTranscript(text);
      }

      storeMeetingDiarizationSegment(text, source, timestamp, micSuppression);

      if (send) {
        send("meeting-transcription-segment", {
          text,
          source,
          type: "final",
          timestamp,
        });
      }
    };

    function flushPendingMicFinals(force = false) {
      if (meetingPendingMicFinals.length === 0) {
        if (meetingPendingMicFinalTimer) {
          clearTimeout(meetingPendingMicFinalTimer);
          meetingPendingMicFinalTimer = null;
        }
        return;
      }

      const { deferred, duplicates, releases } = partitionPendingMicFinals({
        pending: meetingPendingMicFinals,
        now: Date.now(),
        force,
        isDuplicate: (entry) =>
          shouldSkipDuplicateMicSegment(entry.text, entry.timestamp, entry.micSuppression),
      });

      meetingPendingMicFinals = deferred;
      schedulePendingMicFinalFlush();

      for (const pending of duplicates) {
        debugLogger.debug(
          "Dropping buffered mic segment after system context confirmed duplicate",
          {
            text: pending.text.slice(0, 80),
            averageCorrelation: pending.micSuppression?.averageCorrelation?.toFixed(3),
            averageResidual: pending.micSuppression?.averageResidual?.toFixed(3),
          }
        );
      }

      for (const pending of releases) {
        debugLogger.debug(
          pending.micSuppression?.hasBleedEvidence
            ? "Releasing bleed-flagged mic segment after holdback (no transcript match)"
            : "Releasing buffered mic segment after duplicate holdback",
          {
            text: pending.text.slice(0, 80),
            holdbackMs: pending.holdbackMs,
            reason: pending.micSuppression?.reason,
            averageCorrelation: pending.micSuppression?.averageCorrelation?.toFixed(3),
            averageResidual: pending.micSuppression?.averageResidual?.toFixed(3),
          }
        );
        pending.emit();
      }
    }

    const schedulePendingMicFinalFlush = () => {
      if (meetingPendingMicFinalTimer) {
        clearTimeout(meetingPendingMicFinalTimer);
        meetingPendingMicFinalTimer = null;
      }

      if (meetingPendingMicFinals.length === 0) {
        return;
      }

      const nextDelay = Math.max(0, meetingPendingMicFinals[0].releaseAt - Date.now());
      meetingPendingMicFinalTimer = setTimeout(() => {
        meetingPendingMicFinalTimer = null;
        flushPendingMicFinals();
      }, nextDelay);
    };

    const resetPendingMicFinals = () => {
      meetingPendingMicFinals = [];
      if (meetingPendingMicFinalTimer) {
        clearTimeout(meetingPendingMicFinalTimer);
        meetingPendingMicFinalTimer = null;
      }
    };

    const removePendingMicFinalsFor = (systemText, systemTimestamp) => {
      const { kept, removed } = partitionOverlappingPendingMicFinals({
        pending: meetingPendingMicFinals,
        systemText,
        systemTimestamp,
        hasNearbyTranscriptMatch,
      });
      meetingPendingMicFinals = kept;
      schedulePendingMicFinalFlush();
      return removed;
    };

    const queuePendingMicFinal = ({ text, timestamp, micSuppression, holdbackMs, emit }) => {
      meetingPendingMicFinals.push({
        text,
        timestamp,
        micSuppression,
        holdbackMs,
        releaseAt: Date.now() + holdbackMs,
        emit,
      });
      meetingPendingMicFinals.sort((left, right) => left.releaseAt - right.releaseAt);
      schedulePendingMicFinalFlush();
    };

    const captureMeetingDiarizationState = async () => {
      const systemPcmPath = meetingDiarizationPath;
      const systemStartedAt = meetingDiarizationStartedAt;
      const micPcmPath = meetingMicDiarizationPath;
      const micStartedAt = meetingMicDiarizationStartedAt;
      const systemAudioHeard = meetingSystemAudioHeard;
      const diarizationSegments = meetingDiarizationSegments;
      if (meetingDiarizationStream) {
        await new Promise((resolve) => meetingDiarizationStream.end(resolve));
        meetingDiarizationStream = null;
      }
      if (meetingMicDiarizationStream) {
        await new Promise((resolve) => meetingMicDiarizationStream.end(resolve));
        meetingMicDiarizationStream = null;
      }
      meetingDiarizationPath = null;
      meetingDiarizationStartedAt = null;
      meetingMicDiarizationPath = null;
      meetingMicDiarizationStartedAt = null;
      meetingSystemAudioHeard = false;
      meetingSystemAudioDegraded = false;
      meetingDiarizationSegments = [];
      const { pcmPath, startedAt, diarizedSource, cleanupPcmPaths } = resolveDiarizationInput({
        systemPcmPath,
        micPcmPath,
        systemAudioHeard,
        systemStartedAt,
        micStartedAt,
      });
      for (const stalePath of cleanupPcmPaths) {
        fs.unlink(stalePath, () => {});
      }
      return {
        diarizationPcmPath: pcmPath,
        diarizationSegments,
        diarizationStartedAt: startedAt,
        diarizedSource,
      };
    };

    const attachMeetingStreamingHandlers = (streaming, win, source) => {
      const send = (channel, data) => {
        if (!win || win.isDestroyed()) {
          debugLogger.error("Meeting segment send failed: window unavailable", {
            channel,
            source,
            winExists: !!win,
          });
          return;
        }
        win.webContents.send(channel, data);
      };

      streaming.onPartialTranscript = (text) => {
        if (source === "mic" && meetingEchoLeakDetector.isMicProbablyRenderBleed()) {
          send("meeting-transcription-segment", { text: "", source, type: "partial" });
          return;
        }

        send("meeting-transcription-segment", { text, source, type: "partial" });
      };
      streaming.onFinalTranscript = (text, timestamp) => {
        const segments = streaming.completedSegments;
        const latestSegment = segments.length > 0 ? segments[segments.length - 1] : text;
        let micSuppression = null;
        if (source === "mic") {
          micSuppression = shouldSuppressMicTranscriptSegment(timestamp, Date.now());
          if (micSuppression.suppress) {
            debugLogger.debug("Suppressing contaminated mic segment", {
              reason: micSuppression.reason,
              averageCorrelation: micSuppression.averageCorrelation?.toFixed(3),
              averageResidual: micSuppression.averageResidual?.toFixed(3),
              text: latestSegment.slice(0, 80),
            });
            send("meeting-transcription-segment", { text: "", source, type: "partial" });
            return;
          }

          if (shouldSkipDuplicateMicSegment(latestSegment, timestamp, micSuppression)) {
            debugLogger.debug("Skipping duplicate mic segment that matches recent system audio", {
              text: latestSegment.slice(0, 80),
              averageCorrelation: micSuppression.averageCorrelation?.toFixed(3),
              averageResidual: micSuppression.averageResidual?.toFixed(3),
            });
            send("meeting-transcription-segment", { text: "", source, type: "partial" });
            return;
          }
        }

        if (source === "system") {
          const pending = removePendingMicFinalsFor(latestSegment, timestamp);
          if (pending.length > 0) {
            debugLogger.debug("Dropping buffered mic segments after system transcript arrived", {
              count: pending.length,
              text: latestSegment.slice(0, 80),
            });
          }

          const retracted = removeRacingMicEntriesFor(latestSegment, timestamp);
          for (const stale of retracted) {
            send("meeting-transcription-segment", {
              text: stale.text,
              source: "mic",
              type: "retract",
              timestamp: stale.timestamp,
            });
          }
        }

        debugLogger.debug("Meeting segment sending to renderer", {
          source,
          text: latestSegment.slice(0, 80),
          segmentCount: segments.length,
          micCorrelation: micSuppression?.averageCorrelation?.toFixed(3),
          micSuppressionReason: micSuppression?.reason,
          micHasBleedEvidence: micSuppression?.hasBleedEvidence,
          micLikelyRenderBleed: micSuppression?.likelyRenderBleed,
          systemSpeaking: micSuppression?.systemSpeaking,
        });
        if (source === "mic" && hasRiskyMicDuplicateProfile(micSuppression)) {
          debugLogger.debug("Buffering risky mic segment before renderer commit", {
            text: latestSegment.slice(0, 80),
            holdbackMs: STREAMING_RISKY_MIC_SEGMENT_HOLDBACK_MS,
            reason: micSuppression?.reason,
            hasBleedEvidence: micSuppression?.hasBleedEvidence,
          });
          send("meeting-transcription-segment", { text: "", source, type: "partial" });
          queuePendingMicFinal({
            text: latestSegment,
            timestamp,
            micSuppression,
            holdbackMs: STREAMING_RISKY_MIC_SEGMENT_HOLDBACK_MS,
            emit: () =>
              sendMeetingFinalSegment({
                text: latestSegment,
                source,
                timestamp,
                micSuppression,
                send,
              }),
          });
          return;
        }

        sendMeetingFinalSegment({
          text: latestSegment,
          source,
          timestamp,
          micSuppression,
          send,
        });
      };
      streaming.onError = (error) => {
        send("meeting-transcription-error", error.message);
      };
      const recoverConnection = async (error, restoreOldOnFailure) => {
        let recovered = false;
        try {
          recovered = await reconnectMeetingStreams({ restoreOldOnFailure });
        } catch (reconnectError) {
          debugLogger.error("Meeting stream recovery failed unexpectedly", {
            error: reconnectError.message,
          });
        }
        if (!recovered && !meetingFatalErrorSent) {
          meetingFatalErrorSent = true;
          send(
            "meeting-transcription-fatal-error",
            error?.message || "Meeting transcription connection could not be restored."
          );
        }
      };
      streaming.onConnectionLost = (error) => {
        void recoverConnection(error, false);
      };
      streaming.onSessionExpired = ({ proactive = false } = {}) => {
        void recoverConnection(
          new Error("Meeting transcription session could not be renewed."),
          proactive
        );
      };
    };

    const resetMeetingReconnectAudio = () => {
      meetingReconnectAudioBuffers = { mic: [], system: [] };
      meetingReconnectAudioBytes = { mic: 0, system: 0 };
      meetingReconnectReplaySources = new Set();
    };

    const sendMeetingStreamingAudio = (streaming, buffer, capturedAt = null) => {
      const firstSampleAt = streaming.audioBytesSent === 0 ? capturedAt : null;
      const sent = streaming.sendAudio(buffer);
      if (
        sent &&
        streaming.isConnected &&
        firstSampleAt !== null &&
        streaming.sessionStartedAt != null
      ) {
        // Deepgram/Corti time segments from the first PCM sample, which can
        // precede a replacement socket's creation when replaying recovery audio.
        streaming.sessionStartedAt = firstSampleAt;
      }
      return sent;
    };

    const queueMeetingReconnectAudio = (source, buffer, capturedAt = null) => {
      if (!meetingReconnectReplaySources.has(source)) return;
      const copy = Buffer.from(buffer);
      const queue = meetingReconnectAudioBuffers[source];
      queue.push({ buffer: copy, capturedAt });
      meetingReconnectAudioBytes[source] += copy.length;
      while (
        meetingReconnectAudioBytes[source] > MEETING_RECONNECT_BUFFER_MAX_BYTES &&
        queue.length > 1
      ) {
        meetingReconnectAudioBytes[source] -= queue.shift().buffer.length;
      }
    };

    const replayMeetingReconnectAudio = (source, streaming) => {
      if (!meetingReconnectReplaySources.has(source)) return true;
      const queue = meetingReconnectAudioBuffers[source];
      const replayed = queue.every(({ buffer, capturedAt }) =>
        sendMeetingStreamingAudio(streaming, buffer, capturedAt)
      );
      debugLogger.info("Replayed meeting audio after reconnect", {
        source,
        chunks: queue.length,
        bytes: meetingReconnectAudioBytes[source],
      });
      return replayed;
    };

    // Labels the socket for field logs and, for system, swaps in the more
    // sensitive threshold (see MEETING_SYSTEM_VAD_THRESHOLD).
    const withMeetingSourceConnectOpts = (connectOpts, source) => ({
      ...connectOpts,
      streamLabel: source,
      ...(source === "system" ? { vadThreshold: MEETING_SYSTEM_VAD_THRESHOLD } : {}),
    });

    const reconnectMeetingStreams = ({ restoreOldOnFailure = false } = {}) => {
      if (meetingReconnectPromise) return meetingReconnectPromise;

      const pending = (async () => {
        if (meetingLocalMode) return false;

        const options = meetingConnectionOptions;
        const win = meetingConnectionWin;
        if (!options || !win || win.isDestroyed()) {
          debugLogger.error("Cannot reconnect meeting streams: missing connection context");
          return false;
        }

        if (meetingReconnectCount >= MAX_MEETING_RECONNECTS) {
          debugLogger.error("Meeting reconnect limit reached", { count: meetingReconnectCount });
          return false;
        }

        meetingReconnectCount++;

        const oldMic = this._meetingMicStreaming;
        const oldSystem = this._meetingSystemStreaming;
        meetingReconnectReplaySources = new Set([
          ...(!oldMic?.isConnected ? ["mic"] : []),
          ...(oldSystem && !oldSystem.isConnected ? ["system"] : []),
        ]);
        let newMic = null;
        let newSystem = null;

        try {
          const StreamingClass = getMeetingStreamingClient(options.provider);
          newMic = new StreamingClass();
          attachMeetingStreamingHandlers(newMic, win, "mic");
          if (oldSystem) {
            newSystem = new StreamingClass();
            attachMeetingStreamingHandlers(newSystem, win, "system");
          }

          debugLogger.info("Reconnecting meeting streams", {
            attempt: meetingReconnectCount,
            maxAttempts: MAX_MEETING_RECONNECTS,
          });

          const tokenEvent = { sender: win.webContents };
          const connectOpts = {
            model: options.model,
            language: options.language,
            mode: options.mode,
            preconfigured: options.mode !== "byok",
            environment: options.environment,
            tenant: options.tenant,
            keyterms: options.keyterms,
            sampleRate: MEETING_STREAM_SAMPLE_RATE,
          };

          let pairs;
          if (newSystem) {
            const secrets = await fetchRealtimeToken(tokenEvent, options, { streams: 2 });
            pairs = [
              { streaming: newMic, secret: secrets[0], source: "mic" },
              { streaming: newSystem, secret: secrets[1], source: "system" },
            ];
          } else {
            pairs = [
              {
                streaming: newMic,
                secret: await fetchRealtimeToken(tokenEvent, options),
                source: "mic",
              },
            ];
          }

          await Promise.all(
            pairs.map(({ streaming, secret, source }) =>
              streaming.connect({
                apiKey: secret,
                token: secret,
                ...withMeetingSourceConnectOpts(connectOpts, source),
              })
            )
          );

          if (pairs.some(({ streaming }) => !streaming.isConnected)) {
            throw new Error("Meeting transcription connection closed during reconnect.");
          }

          if (meetingConnectionOptions !== options) {
            for (const { streaming } of pairs) streaming.disconnect().catch(() => {});
            oldMic?.disconnect().catch(() => {});
            oldSystem?.disconnect().catch(() => {});
            resetMeetingReconnectAudio();
            return true;
          }

          const replayedMic = replayMeetingReconnectAudio("mic", newMic);
          const replayedSystem = !newSystem || replayMeetingReconnectAudio("system", newSystem);
          if (!replayedMic || !replayedSystem) {
            throw new Error("Meeting audio could not be restored after reconnect.");
          }
          this._meetingMicStreaming = newMic;
          this._meetingSystemStreaming = newSystem;
          resetMeetingReconnectAudio();
          oldMic?.disconnect().catch(() => {});
          oldSystem?.disconnect().catch(() => {});
          meetingConnectionKey = getMeetingConnectionKey(options);

          debugLogger.info("Meeting streams reconnected", { attempt: meetingReconnectCount });
          meetingReconnectCount = 0;
          return true;
        } catch (error) {
          debugLogger.error("Meeting stream reconnect failed", {
            error: error.message,
            attempt: meetingReconnectCount,
          });
          newMic?.disconnect().catch(() => {});
          newSystem?.disconnect().catch(() => {});
          if (meetingConnectionOptions !== options) {
            oldMic?.disconnect().catch(() => {});
            oldSystem?.disconnect().catch(() => {});
            resetMeetingReconnectAudio();
            return true;
          }

          const canRestoreOld =
            restoreOldOnFailure && !!oldMic?.isConnected && (!oldSystem || oldSystem.isConnected);
          if (canRestoreOld) {
            this._meetingMicStreaming = oldMic;
            this._meetingSystemStreaming = oldSystem;
          } else {
            oldMic?.disconnect().catch(() => {});
            oldSystem?.disconnect().catch(() => {});
            this._meetingMicStreaming = null;
            this._meetingSystemStreaming = null;
            meetingConnectionKey = null;
          }
          resetMeetingReconnectAudio();
          if (!win.isDestroyed()) {
            win.webContents.send("meeting-transcription-error", error.message);
          }
          return canRestoreOld;
        }
      })();

      meetingReconnectPromise = pending;
      return pending.finally(() => {
        if (meetingReconnectPromise === pending) meetingReconnectPromise = null;
      });
    };

    const fetchRealtimeToken = async (event, options, { streams } = {}) => {
      return fetchRealtimeTokenForProvider(
        options.provider,
        {
          environmentManager: this.environmentManager,
          proxyFetch,
          mintCortiToken: (tokenOptions) => this._mintStoredCortiToken(tokenOptions),
        },
        options,
        { streams }
      );
    };

    const getMeetingSystemAudioCapabilityMode = () => {
      if (this.audioTapManager?.isSupported()) return "native";
      return "unsupported";
    };

    const getMeetingSystemAudioMode = () => getMeetingSystemAudioCapabilityMode();

    const getMeetingSystemAudioPlan = async () => {
      const mode = getMeetingSystemAudioMode();
      if (mode === "unsupported") {
        return { mode, strategy: "unsupported" };
      }

      return { mode, strategy: "native" };
    };

    const hasNativeMeetingSystemAudio = () => getMeetingSystemAudioMode() === "native";

    const isMeetingStreamingConnected = (systemAudioMode = getMeetingSystemAudioCapabilityMode()) =>
      !!this._meetingMicStreaming?.isConnected &&
      (systemAudioMode === "unsupported" || !!this._meetingSystemStreaming?.isConnected);

    const connectRealtimeStreaming = async (event, options) => {
      const connectionKey = getMeetingConnectionKey(options);
      const StreamingClass = getMeetingStreamingClient(options.provider);
      if (this._meetingMicStreaming?.isConnected) {
        await this._meetingMicStreaming.disconnect();
      }
      if (this._meetingSystemStreaming?.isConnected) {
        await this._meetingSystemStreaming.disconnect();
      }
      this._meetingMicStreaming = null;
      this._meetingSystemStreaming = null;
      const win = BrowserWindow.fromWebContents(event.sender);

      const connectOpts = {
        model: options.model,
        language: options.language,
        mode: options.mode,
        preconfigured: options.mode !== "byok",
        environment: options.environment,
        tenant: options.tenant,
        keyterms: options.keyterms,
        sampleRate: MEETING_STREAM_SAMPLE_RATE,
      };
      const { mode: systemAudioMode } = await getMeetingSystemAudioPlan();
      let pairs;
      if (systemAudioMode !== "unsupported") {
        const secrets = await fetchRealtimeToken(event, options, { streams: 2 });
        pairs = [
          { ref: "_meetingMicStreaming", secret: secrets[0], source: "mic" },
          { ref: "_meetingSystemStreaming", secret: secrets[1], source: "system" },
        ];
      } else {
        pairs = [
          {
            ref: "_meetingMicStreaming",
            secret: await fetchRealtimeToken(event, options),
            source: "mic",
          },
        ];
      }

      for (const { ref, source } of pairs) {
        this[ref] = new StreamingClass();
        attachMeetingStreamingHandlers(this[ref], win, source);
      }

      try {
        await Promise.all(
          pairs.map(({ ref, secret, source }) =>
            this[ref].connect({
              apiKey: secret,
              token: secret,
              ...withMeetingSourceConnectOpts(connectOpts, source),
            })
          )
        );
        if (pairs.some(({ ref }) => !this[ref]?.isConnected)) {
          throw new Error("Meeting transcription connection closed during startup.");
        }
        meetingConnectionKey = connectionKey;
      } catch (error) {
        await Promise.all(
          pairs.map(({ ref }) => this[ref]?.disconnect().catch(() => ({ text: "" })))
        );
        this._meetingMicStreaming = null;
        this._meetingSystemStreaming = null;
        meetingConnectionKey = null;
        throw error;
      }

      return win;
    };

    const MEETING_MIC_REFERENCE_ALIGNMENT_MS = 320;
    const MEETING_STARTUP_WARMUP_MS = 1500;
    const MEETING_MIC_BLEED_LOOKBACK_MS = 500;
    const MEETING_MIC_STATS_LOG_LIMIT = 200;
    const MEETING_SYSTEM_AUDIO_SILENCE_WARNING_MS = 45000;
    const MEETING_SYSTEM_AUDIO_TICK_MS = 2000;
    let meetingMicStatsLogCount = 0;
    let meetingSystemAudioSilenceTimer = null;
    let meetingSystemAudioTicker = null;
    let meetingSystemAudioWatchdogWin = null;

    const meetingSystemAudioWatchdog = createMeetingSystemAudioWatchdog({
      onResumed: () => {
        const win = meetingSystemAudioWatchdogWin;
        if (win && !win.isDestroyed()) {
          win.webContents.send("meeting-system-audio-resumed");
        }
      },
      onInterrupted: (payload) => {
        // debugLogger.error flattens its arguments into one string, dropping
        // both the meta and the scope, so the give-up event would vanish from a
        // log filtered on "meeting", the one filter used to triage this bug.
        if (payload.recovering) {
          debugLogger.warn("Meeting system audio interrupted, restarting", payload, "meeting");
        } else {
          debugLogger.warn("Meeting system audio capture gave up", payload, "meeting");
        }
        const win = meetingSystemAudioWatchdogWin;
        if (win && !win.isDestroyed()) {
          win.webContents.send("meeting-system-audio-interrupted", payload);
        }
      },
    });
    let meetingStartedAt = null;
    let meetingSendCounts = { mic: 0, system: 0 };
    const meetingEchoLeakDetector = new MeetingEchoLeakDetector();
    let meetingReconnectPromise = null;
    let meetingFatalErrorSent = false;
    let meetingReconnectCount = 0;
    const MAX_MEETING_RECONNECTS = 5;
    let meetingConnectionOptions = null;
    let meetingConnectionWin = null;
    let meetingConnectionKey = null;
    let meetingReconnectAudioBuffers = { mic: [], system: [] };
    let meetingReconnectAudioBytes = { mic: 0, system: 0 };
    let meetingReconnectReplaySources = new Set();

    const fs = require("fs");
    let meetingDiarizationStream = null;
    let meetingDiarizationPath = null;
    let meetingDiarizationStartedAt = null;
    // Parallel raw mic capture so an in-person session (no audible system
    // audio) can be diarized; dropped as soon as the session proves to be a call.
    let meetingMicDiarizationStream = null;
    let meetingMicDiarizationPath = null;
    let meetingMicDiarizationStartedAt = null;
    let meetingSystemAudioHeard = false;
    let meetingSystemAudioDegraded = false;
    let meetingDiarizationSegments = [];
    let meetingLiveSpeakerActive = false;
    let meetingLiveSpeakerState = null;
    let meetingLiveSpeakerStartedAt = null;
    let meetingReclusterTimer = null;

    let meetingLocalMode = false;
    let meetingLocalBuffers = { mic: [], system: [] };
    let meetingLocalTimer = null;
    let meetingLocalWin = null;
    let meetingLocalTranscript = "";
    let meetingLocalProvider = null;
    let meetingLocalModel = null;
    let meetingLocalLanguage = null;
    let meetingLocalTranscribing = false;
    let meetingPendingMicChunks = [];
    let meetingPendingMicFinals = [];
    let meetingPendingMicFinalTimer = null;
    let meetingAecEnabled = false;
    let meetingOneOnOneAttendee = null;
    let meetingOneOnOneProfileBound = false;
    let meetingNoteId = null;

    const getLiveSpeakerProfiles = () => {
      const attendees = this._getNoteNonSelfParticipants(meetingNoteId);
      const attendeeEmails = new Set();
      for (const p of attendees) {
        const email = (p.email || "").toLowerCase().trim();
        if (email) attendeeEmails.add(email);
      }
      if (attendeeEmails.size === 0) return [];
      return this.databaseManager
        .getSpeakerProfiles(true)
        .filter((p) => p.email && attendeeEmails.has(p.email.toLowerCase()));
    };
    const shouldSuppressMicTranscriptSegment = (startedAt, endedAt = Date.now()) =>
      meetingEchoLeakDetector.shouldSuppressMicSegment(startedAt, endedAt);

    const resolveOneOnOneAttendeeForNote = (noteId) => {
      if (!noteId) return null;
      try {
        const note = this.databaseManager.getNote(noteId);
        return this._resolveOneOnOneOtherParticipant(note?.participants);
      } catch (_) {
        return null;
      }
    };

    const resolveDiarizationEnabled = () =>
      (this.activeMeetingSpeakerConfig?.enabled ?? this.speakerDiarizationEnabled) !== false;

    const resolveSessionMaxSpeakers = () => {
      const count = this.activeMeetingSpeakerConfig?.expectedCount;
      const total = count ? Math.min(count, MAX_SPEAKER_COUNT) : DEFAULT_EXPECTED_SPEAKER_COUNT;
      return Math.max(1, total - 1);
    };

    const bindOneOnOneAttendeeToSpeaker = (speakerId) => {
      if (!meetingOneOnOneAttendee || meetingOneOnOneProfileBound || !speakerId) return;
      if (!resolveDiarizationEnabled()) return;
      const embedding = liveSpeakerIdentifier.getSpeakerEmbedding(speakerId);
      if (!embedding) return;
      try {
        const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
        const profile = this.databaseManager.upsertSpeakerProfile(
          meetingOneOnOneAttendee.displayName,
          meetingOneOnOneAttendee.email,
          buffer
        );
        liveSpeakerIdentifier.mapSpeaker(
          speakerId,
          profile.id,
          meetingOneOnOneAttendee.displayName,
          null
        );
        meetingOneOnOneProfileBound = true;
      } catch (error) {
        debugLogger.warn(
          "1-on-1 attendee profile binding failed",
          { error: error.message },
          "speaker"
        );
      }
    };

    const dispatchMeetingAudioBuffer = (buffer, source, synthetic = false, capturedAt = null) => {
      if (meetingLocalMode) {
        // Local STT timestamps each batch with wall time, not a sample cursor.
        // Large synthetic gaps would dilute speech and inflate the next batch.
        if (synthetic) return;
        meetingLocalBuffers[source].push(buffer);
        return;
      }

      const streaming = source === "mic" ? this._meetingMicStreaming : this._meetingSystemStreaming;
      if (!streaming) {
        if (meetingSendCounts[source] === 0) {
          debugLogger.error("Meeting audio send: no streaming instance", { source });
        }
        return;
      }

      let outbound = buffer;
      if (source === "mic" && buffer.length >= 2) {
        const { rms, peak, sampleCount } = computeChunkStats(buffer);
        // Evaluated eagerly (as before) because the stats log reports it.
        const systemSpeaking = meetingEchoLeakDetector.isSystemSpeaking(
          Date.now() - MEETING_MIC_BLEED_LOOKBACK_MS
        );
        const verdict = resolveMicChunkAction({
          mode: "streaming",
          source,
          rms,
          peak,
          sampleCount,
          isSystemSpeaking: () => systemSpeaking,
        });
        if (verdict.action === "zero") {
          outbound = Buffer.alloc(buffer.length);
        }
        if (
          meetingMicStatsLogCount < MEETING_MIC_STATS_LOG_LIMIT &&
          (systemSpeaking || rms > 0.02)
        ) {
          meetingMicStatsLogCount += 1;
          debugLogger.debug("Meeting mic audio stats", {
            rms: rms.toFixed(4),
            peak: peak.toFixed(4),
            systemSpeaking,
            zeroed: outbound !== buffer,
          });
        }
      } else if (source === "system" && buffer.length >= 2 && !synthetic) {
        // System chunks stream verbatim (no gate), so a periodic level readout
        // is the only way field logs can tell real audio from capture silence.
        const chunkCount = meetingSendCounts.system + 1;
        if (chunkCount === 1 || chunkCount % 200 === 0) {
          const { rms, peak } = computeChunkStats(buffer);
          debugLogger.debug("Meeting system audio stats", {
            rms: rms.toFixed(4),
            peak: peak.toFixed(4),
            chunkCount,
          });
        }
      }

      queueMeetingReconnectAudio(source, outbound, capturedAt);
      const sent = sendMeetingStreamingAudio(streaming, outbound, capturedAt);
      if (synthetic) return;
      meetingSendCounts[source]++;
      if (meetingSendCounts[source] <= 5 || meetingSendCounts[source] % 100 === 0) {
        debugLogger.debug("Meeting audio send", {
          source,
          bytes: buffer.length,
          sent,
          wsReady: streaming.ws?.readyState,
          totalSent: streaming.audioBytesSent,
          count: meetingSendCounts[source],
        });
      }
    };

    const stopMeetingAec = async () => {
      meetingAecEnabled = false;
      if (this.meetingAecManager) {
        await this.meetingAecManager.stop().catch(() => {});
      }
    };

    const startMeetingAec = async (systemAudioMode) => {
      meetingAecEnabled = false;
      if (systemAudioMode === "unsupported" || !this.meetingAecManager?.isAvailable()) {
        return false;
      }

      const started = await this.meetingAecManager
        .start({
          onMicChunk: (chunk) => {
            dispatchMeetingAudioBuffer(chunk, "mic");
          },
          onError: (error) => {
            debugLogger.warn("Meeting AEC helper disabled", { error: error.message }, "meeting");
            meetingAecEnabled = false;
            void this.meetingAecManager.stop().catch(() => {});
          },
          onWarning: (warning) => {
            debugLogger.debug("Meeting AEC helper warning", warning, "meeting");
          },
        })
        .catch((error) => {
          debugLogger.warn("Meeting AEC helper start failed", { error: error.message }, "meeting");
          return false;
        });

      meetingAecEnabled = !!started;
      if (meetingAecEnabled) {
        debugLogger.info("Meeting AEC helper started", { systemAudioMode }, "meeting");
      }
      return meetingAecEnabled;
    };

    const flushPendingMeetingMicChunks = (force = false) => {
      if (!meetingPendingMicChunks.length) {
        return;
      }

      const now = Date.now();
      while (meetingPendingMicChunks.length > 0) {
        const next = meetingPendingMicChunks[0];
        if (!force && now - next.queuedAt < MEETING_MIC_REFERENCE_ALIGNMENT_MS) {
          break;
        }

        meetingPendingMicChunks.shift();
        const analysis = meetingEchoLeakDetector.analyzeMicChunk(next.buffer);
        if (next.analysisOnly) {
          continue;
        }
        if (analysis?.shouldMute && !meetingAecEnabled) {
          if (!meetingLocalMode) {
            dispatchMeetingAudioBuffer(Buffer.alloc(next.buffer.length), "mic");
          }
          continue;
        }

        dispatchMeetingAudioBuffer(next.buffer, "mic");
      }
    };

    const processMeetingMicWithAec = (buffer) => {
      if (!meetingAecEnabled) {
        return false;
      }

      const sent = this.meetingAecManager?.processMicBuffer(buffer);
      if (sent) {
        meetingPendingMicChunks.push({
          buffer,
          queuedAt: Date.now(),
          analysisOnly: true,
        });
        flushPendingMeetingMicChunks();
        return true;
      }

      meetingAecEnabled = false;
      return false;
    };

    const stopLiveSpeakerIdentification = async () => {
      if (!meetingLiveSpeakerActive) {
        return null;
      }

      if (meetingReclusterTimer) {
        clearInterval(meetingReclusterTimer);
        meetingReclusterTimer = null;
      }

      meetingLiveSpeakerActive = false;
      meetingLiveSpeakerState = await liveSpeakerIdentifier.stop();
      return meetingLiveSpeakerState;
    };

    const startLiveSpeakerIdentification = async (win, systemAudioMode) => {
      await stopLiveSpeakerIdentification();

      if (
        !supportsLiveSpeakerIdentification(systemAudioMode) ||
        !liveSpeakerIdentifier.isAvailable()
      ) {
        return false;
      }

      const diarizationEnabled = resolveDiarizationEnabled();
      if (!diarizationEnabled) {
        return false;
      }

      meetingLiveSpeakerState = null;
      // Anchored on the first system chunk instead, in sendMeetingAudio.
      meetingLiveSpeakerStartedAt = null;
      const started = await liveSpeakerIdentifier
        .start(
          (identification) => {
            if (!win || win.isDestroyed() || meetingLiveSpeakerStartedAt == null) {
              return;
            }

            bindOneOnOneAttendeeToSpeaker(identification.speakerId);

            const displayName = meetingOneOnOneAttendee
              ? meetingOneOnOneAttendee.displayName
              : identification.displayName;

            const startTime = Math.max(
              meetingLiveSpeakerStartedAt,
              meetingLiveSpeakerStartedAt + identification.startTime * 1000
            );
            const endTime = Math.max(
              startTime,
              meetingLiveSpeakerStartedAt + identification.endTime * 1000
            );
            const enrichedIdentification = {
              ...identification,
              displayName,
              startTime,
              endTime,
            };

            win.webContents.send("meeting-speaker-identified", enrichedIdentification);

            for (const seg of meetingDiarizationSegments) {
              if (
                seg.source === "system" &&
                seg.timestamp != null &&
                seg.timestamp >= startTime &&
                seg.timestamp <= endTime &&
                (!seg.speaker || seg.speakerIsPlaceholder)
              ) {
                applyConfirmedSpeaker(seg, {
                  speaker: identification.speakerId,
                  speakerName: displayName || seg.speakerName,
                  speakerIsPlaceholder: false,
                });
              }
            }
          },
          {
            getSpeakerProfiles: getLiveSpeakerProfiles,
            maxSpeakers: resolveSessionMaxSpeakers(),
            enabled: true,
          }
        )
        .catch((error) => {
          // isAvailable() only stats the model file, so a corrupt model or an
          // onnxruntime binding that won't load still throws here. Speaker labels
          // are an enhancement — never let them take the recording down with them.
          debugLogger.warn(
            "Live speaker identification start failed",
            { error: error.message },
            "speaker"
          );
          return false;
        });

      if (started) {
        meetingLiveSpeakerActive = true;
        meetingReclusterTimer = setInterval(async () => {
          if (!meetingLiveSpeakerActive || !win || win.isDestroyed()) return;

          const merges = await liveSpeakerIdentifier.recluster();
          if (!merges.length) return;

          for (const { keep, remove, displayName } of merges) {
            for (const seg of meetingDiarizationSegments) {
              if (seg.speaker === remove) {
                seg.speaker = keep;
                if (displayName) seg.speakerName = displayName;
              }
            }
          }

          win.webContents.send("meeting-speakers-merged", merges);
        }, 30_000);
      } else {
        meetingLiveSpeakerStartedAt = null;
      }

      return started;
    };

    const transcribeLocalMeetingChunk = async (source) => {
      const chunks = meetingLocalBuffers[source];
      if (!chunks.length) return;

      const pcm24k = Buffer.concat(chunks);
      meetingLocalBuffers[source] = [];

      const pcm16k = downsample24kTo16k(pcm24k);

      const { rms, peak, sampleCount } = computeChunkStats(pcm16k);
      const verdict = resolveMicChunkAction({
        mode: "local",
        source,
        rms,
        peak,
        sampleCount,
        isSystemSpeaking: () =>
          meetingEchoLeakDetector.isSystemSpeaking(Date.now() - LOCAL_MEETING_CHUNK_INTERVAL_MS),
      });
      if (verdict.action === "skip") {
        debugLogger.debug(
          verdict.reason === "silence"
            ? "Skipping silent meeting chunk"
            : "Skipping system-dominant mic chunk",
          {
            source,
            rms: rms.toFixed(4),
            peak: peak.toFixed(4),
          }
        );
        return;
      }

      const wav = pcm16ToWav(pcm16k);

      try {
        let result;
        if (isSherpaLocalProvider(meetingLocalProvider)) {
          result = await this.parakeetManager.transcribeLocalParakeet(wav, {
            model: meetingLocalModel,
            language: meetingLocalLanguage,
          });
        } else {
          const vadOptions = this._resolveWhisperVadOptions("meeting");
          result = await this.whisperManager.transcribeLocalWhisper(wav, {
            model: meetingLocalModel,
            language: meetingLocalLanguage,
            // Keep whisper.cpp's default decoder thresholds on this continuous
            // load: the raised #1458 values multiply temperature-fallback
            // re-decodes, and meeting chunks already have RMS-gate, VAD, and
            // holdback/dedup hallucination protection.
            skipDecoderThresholds: true,
            ...vadOptions,
          });
        }

        if (result?.success && result.text?.trim()) {
          const text = result.text.trim();
          const segTimestamp = Date.now();
          let micSuppression = null;
          if (source === "mic") {
            const chunkDurationMs = (pcm24k.length / 2 / 24000) * 1000;
            micSuppression = shouldSuppressMicTranscriptSegment(
              segTimestamp - chunkDurationMs,
              segTimestamp
            );
            debugLogger.debug("Local meeting transcription candidate", {
              source,
              text: text.slice(0, 80),
              suppress: micSuppression.suppress,
              reason: micSuppression.reason,
              hasBleedEvidence: micSuppression.hasBleedEvidence,
              likelyRenderBleed: micSuppression.likelyRenderBleed,
              averageCorrelation: micSuppression.averageCorrelation?.toFixed(3),
              averageResidual: micSuppression.averageResidual?.toFixed(3),
            });
            if (micSuppression.suppress) {
              debugLogger.debug("Suppressing contaminated local mic segment", {
                reason: micSuppression.reason,
                averageCorrelation: micSuppression.averageCorrelation?.toFixed(3),
                averageResidual: micSuppression.averageResidual?.toFixed(3),
                text: text.slice(0, 80),
              });
              return;
            }

            if (shouldSkipDuplicateMicSegment(text, segTimestamp, micSuppression)) {
              debugLogger.debug("Skipping duplicate local mic segment that matches system audio", {
                text: text.slice(0, 80),
                averageCorrelation: micSuppression.averageCorrelation?.toFixed(3),
                averageResidual: micSuppression.averageResidual?.toFixed(3),
              });
              return;
            }
          } else {
            debugLogger.debug("Local meeting transcription candidate", {
              source,
              text: text.slice(0, 80),
            });
          }

          if (source === "system") {
            const pending = removePendingMicFinalsFor(text, segTimestamp);
            if (pending.length > 0) {
              debugLogger.debug(
                "Dropping buffered local mic segments after system transcript arrived",
                {
                  count: pending.length,
                  text: text.slice(0, 80),
                }
              );
            }

            const retracted = removeRacingMicEntriesFor(text, segTimestamp);
            for (const stale of retracted) {
              if (meetingLocalWin && !meetingLocalWin.isDestroyed()) {
                meetingLocalWin.webContents.send("meeting-transcription-segment", {
                  text: stale.text,
                  source: "mic",
                  type: "retract",
                  timestamp: stale.timestamp,
                });
              }
            }
          }

          const sendLocalSegment = (channel, payload) => {
            if (channel !== "meeting-transcription-segment") {
              return;
            }

            if (meetingLocalWin && !meetingLocalWin.isDestroyed()) {
              meetingLocalWin.webContents.send(channel, payload);
            }
          };

          if (source === "mic" && hasRiskyMicDuplicateProfile(micSuppression)) {
            debugLogger.debug("Buffering risky local mic segment before renderer commit", {
              text: text.slice(0, 80),
              holdbackMs: LOCAL_RISKY_MIC_SEGMENT_HOLDBACK_MS,
              reason: micSuppression?.reason,
              hasBleedEvidence: micSuppression?.hasBleedEvidence,
            });
            queuePendingMicFinal({
              text,
              timestamp: segTimestamp,
              micSuppression,
              holdbackMs: LOCAL_RISKY_MIC_SEGMENT_HOLDBACK_MS,
              emit: () =>
                sendMeetingFinalSegment({
                  text,
                  source,
                  timestamp: segTimestamp,
                  micSuppression,
                  send: sendLocalSegment,
                  includeInLocalTranscript: true,
                }),
            });
            return;
          }

          sendMeetingFinalSegment({
            text,
            source,
            timestamp: segTimestamp,
            micSuppression,
            send: sendLocalSegment,
            includeInLocalTranscript: true,
          });
        }
      } catch (error) {
        debugLogger.error("Local meeting transcription chunk failed", {
          source,
          error: error.message,
        });
        if (meetingLocalWin && !meetingLocalWin.isDestroyed()) {
          meetingLocalWin.webContents.send("meeting-transcription-error", error.message);
        }
      }
    };

    const transcribeAllLocalBuffers = async () => {
      if (meetingLocalTranscribing) return;
      meetingLocalTranscribing = true;
      try {
        await transcribeLocalMeetingChunk("system");
        await transcribeLocalMeetingChunk("mic");
      } finally {
        meetingLocalTranscribing = false;
      }
    };

    const dropMeetingMicDiarizationCapture = () => {
      if (meetingMicDiarizationStream) {
        meetingMicDiarizationStream.end();
        meetingMicDiarizationStream = null;
      }
      if (meetingMicDiarizationPath) {
        fs.unlink(meetingMicDiarizationPath, () => {});
        meetingMicDiarizationPath = null;
      }
      meetingMicDiarizationStartedAt = null;
    };

    const resetMeetingLocalState = () => {
      if (meetingLocalTimer) {
        clearInterval(meetingLocalTimer);
        meetingLocalTimer = null;
      }
      if (meetingReclusterTimer) {
        clearInterval(meetingReclusterTimer);
        meetingReclusterTimer = null;
      }
      void stopLiveSpeakerIdentification();
      meetingLiveSpeakerState = null;
      meetingLiveSpeakerStartedAt = null;
      meetingOneOnOneAttendee = null;
      meetingOneOnOneProfileBound = false;
      meetingNoteId = null;
      this._activeMeetingNoteId = null;
      meetingLocalMode = false;
      meetingLocalBuffers = { mic: [], system: [] };
      if (meetingDiarizationStream) {
        meetingDiarizationStream.end();
        meetingDiarizationStream = null;
      }
      if (meetingDiarizationPath) {
        fs.unlink(meetingDiarizationPath, () => {});
        meetingDiarizationPath = null;
      }
      meetingDiarizationStartedAt = null;
      dropMeetingMicDiarizationCapture();
      meetingSystemAudioHeard = false;
      meetingSystemAudioDegraded = false;
      meetingDiarizationSegments = [];
      meetingLocalWin = null;
      meetingLocalTranscript = "";
      meetingLocalProvider = null;
      meetingLocalModel = null;
      meetingLocalLanguage = null;
      meetingLocalTranscribing = false;
      meetingPendingMicChunks = [];
      resetPendingMicFinals();
      meetingAecEnabled = false;
      meetingStartedAt = null;
      meetingEchoLeakDetector.reset();
    };

    const resetMeetingStreamingState = () => {
      this._meetingMicStreaming = null;
      this._meetingSystemStreaming = null;
      meetingSendCounts = { mic: 0, system: 0 };
      meetingLiveSpeakerStartedAt = null;
      meetingPendingMicChunks = [];
      resetPendingMicFinals();
      meetingAecEnabled = false;
      meetingEchoLeakDetector.reset();
      meetingReconnectPromise = null;
      meetingFatalErrorSent = false;
      meetingReconnectCount = 0;
      meetingConnectionOptions = null;
      meetingConnectionWin = null;
      meetingConnectionKey = null;
      resetMeetingReconnectAudio();
    };

    const disconnectMeetingStreaming = async ({ flushPending = false } = {}) => {
      const results = await Promise.all([
        this._meetingMicStreaming
          ? this._meetingMicStreaming.disconnect().catch(() => ({ text: "" }))
          : Promise.resolve({ text: "" }),
        this._meetingSystemStreaming
          ? this._meetingSystemStreaming.disconnect().catch(() => ({ text: "" }))
          : Promise.resolve({ text: "" }),
      ]);
      if (flushPending) flushPendingMicFinals(true);
      resetMeetingStreamingState();
      return results;
    };

    const clearMeetingSystemAudioSilenceTimer = () => {
      if (meetingSystemAudioSilenceTimer) {
        clearTimeout(meetingSystemAudioSilenceTimer);
        meetingSystemAudioSilenceTimer = null;
      }
    };

    const armMeetingSystemAudioSilenceTimer = (win, systemAudioStrategy) => {
      clearMeetingSystemAudioSilenceTimer();
      meetingSystemAudioSilenceTimer = setTimeout(() => {
        meetingSystemAudioSilenceTimer = null;
        if (meetingSystemAudioHeard) return;
        debugLogger.debug(
          "Meeting system audio still silent past warning window",
          { systemAudioStrategy, timeoutMs: MEETING_SYSTEM_AUDIO_SILENCE_WARNING_MS },
          "meeting"
        );
        if (win && !win.isDestroyed()) {
          win.webContents.send("meeting-system-audio-silent", { systemAudioStrategy });
        }
      }, MEETING_SYSTEM_AUDIO_SILENCE_WARNING_MS);
    };

    const clearMeetingSystemAudioTicker = () => {
      if (meetingSystemAudioTicker) {
        clearInterval(meetingSystemAudioTicker);
        meetingSystemAudioTicker = null;
      }
    };

    const stopMeetingSystemAudioWatchdog = () => {
      clearMeetingSystemAudioTicker();
      meetingSystemAudioWatchdog.stop();
      meetingSystemAudioWatchdogWin = null;
    };

    const startMeetingSystemAudioWatchdog = (win, systemAudioStrategy) => {
      clearMeetingSystemAudioTicker();
      meetingSystemAudioWatchdogWin = win;
      meetingSystemAudioWatchdog.start({
        systemAudioStrategy,
        watchesDelivery: systemAudioStrategy === "native",
      });
      meetingSystemAudioTicker = setInterval(
        () => meetingSystemAudioWatchdog.tick(),
        MEETING_SYSTEM_AUDIO_TICK_MS
      );
    };

    const rollbackMeetingTranscriptionStart = async () => {
      clearMeetingSystemAudioSilenceTimer();
      stopMeetingSystemAudioWatchdog();
      if (this.audioTapManager) await this.audioTapManager.stop().catch(() => {});
      await stopMeetingAec();
      await stopLiveSpeakerIdentification().catch(() => {});
      resetMeetingLocalState();
      await disconnectMeetingStreaming().catch(() => {});
      this.activeMeetingSpeakerConfig = null;
    };

    ipcMain.handle("meeting-transcription-prepare", async (event, options = {}) => {
      if (meetingTranscriptionPrepareInProgress || meetingTranscriptionStartInProgress) {
        debugLogger.debug("Meeting transcription prepare already in progress, ignoring");
        return { success: false, error: "Operation in progress" };
      }
      if (!ALLOWED_MEETING_PROVIDERS.has(options.provider)) {
        return { success: false, error: `Unsupported provider: ${options.provider}` };
      }
      if (options.provider === "local") return { success: true };

      const { mode: systemAudioMode } = await getMeetingSystemAudioPlan();
      const requestedConnectionKey = getMeetingConnectionKey(options);
      if (
        isMeetingStreamingConnected(systemAudioMode) &&
        meetingConnectionKey === requestedConnectionKey
      ) {
        return { success: true, alreadyPrepared: true };
      }
      meetingTranscriptionPrepareInProgress = true;
      meetingTranscriptionPreparePromise = (async () => {
        let timeoutHandle;
        try {
          await Promise.race([
            connectRealtimeStreaming(event, options),
            new Promise((_, reject) => {
              timeoutHandle = setTimeout(() => reject(new Error("Prepare timed out")), 15000);
            }),
          ]);
          return { success: true };
        } catch (error) {
          debugLogger.error("Meeting transcription prepare error", { error: error.message });
          return { success: false, error: error.message };
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          meetingTranscriptionPrepareInProgress = false;
          meetingTranscriptionPreparePromise = null;
        }
      })();
      return meetingTranscriptionPreparePromise;
    });

    ipcMain.handle("meeting-transcription-cancel", async () => {
      if (isMeetingStreamingConnected() || meetingLocalTimer) {
        return { success: false, reason: "recording-active" };
      }
      meetingTranscriptionPrepareInProgress = false;
      meetingTranscriptionStartInProgress = false;
      meetingTranscriptionPreparePromise = null;
      return { success: true };
    });

    const meetingFailure = (error) => ({
      success: false,
      error: error?.message || String(error),
      ...(error?.code ? { code: error.code } : {}),
      ...(error?.messageKey ? { messageKey: error.messageKey } : {}),
    });

    const startMeetingTranscription = async (event, options = {}) => {
      if (meetingTranscriptionPreparePromise) await meetingTranscriptionPreparePromise;
      if (meetingTranscriptionStartInProgress) {
        return { success: false, error: "Operation in progress" };
      }
      if (!ALLOWED_MEETING_PROVIDERS.has(options.provider)) {
        return { success: false, error: `Unsupported provider: ${options.provider}` };
      }

      meetingTranscriptionStartInProgress = true;
      const recordingSessionId = options.sessionId;
      meetingStartedAt = Date.now();
      meetingConnectionOptions = options;
      meetingConnectionWin = BrowserWindow.fromWebContents(event.sender);
      meetingReconnectCount = 0;
      meetingFatalErrorSent = false;
      this.meetingDetectionEngine?.endRecordingSession();
      this.meetingDetectionEngine?.setUserRecording(true);

      const completeStart = async (result) => {
        await this.meetingDetectionEngine?.beginRecordingSession({
          sessionId: recordingSessionId,
          autoEndEligible: options.autoEndEligible === true,
          ownerWebContents: event.sender,
          systemAudioAvailable: false,
        });
        if (result.systemAudioStrategy && result.systemAudioStrategy !== "unsupported") {
          armMeetingSystemAudioSilenceTimer(meetingConnectionWin, result.systemAudioStrategy);
          startMeetingSystemAudioWatchdog(meetingConnectionWin, result.systemAudioStrategy);
        }
        return { ...result, sessionId: recordingSessionId };
      };

      try {
        const { mode: systemAudioMode, strategy: systemAudioStrategy } =
          await getMeetingSystemAudioPlan();
        const requestedConnectionKey = getMeetingConnectionKey(options);
        meetingEchoLeakDetector.reset();
        meetingOneOnOneAttendee = resolveOneOnOneAttendeeForNote(options.noteId);
        meetingOneOnOneProfileBound = false;
        meetingNoteId = options.noteId ?? null;
        this._activeMeetingNoteId = meetingNoteId;
        if (!this.activeMeetingSpeakerConfig) {
          this.activeMeetingSpeakerConfig = this._resolveInitialMeetingSpeakerConfig(meetingNoteId);
        }

        if (systemAudioMode === "unsupported" && this._meetingSystemStreaming?.isConnected) {
          await this._meetingSystemStreaming.disconnect().catch(() => ({ text: "" }));
          this._meetingSystemStreaming = null;
        }

        if (
          !meetingLocalMode &&
          isMeetingStreamingConnected(systemAudioMode) &&
          meetingConnectionKey === requestedConnectionKey
        ) {
          const win = BrowserWindow.fromWebContents(event.sender);
          attachMeetingStreamingHandlers(this._meetingMicStreaming, win, "mic");
          if (systemAudioMode !== "unsupported") {
            attachMeetingStreamingHandlers(this._meetingSystemStreaming, win, "system");
          }
          await startMeetingAec(systemAudioMode);
          await startLiveSpeakerIdentification(win, systemAudioMode);
          const started = await startMeetingSystemAudio(
            event,
            systemAudioMode,
            systemAudioStrategy,
            "during warm-start reuse"
          );
          return completeStart({ success: true, ...started, oneOnOneAttendee: meetingOneOnOneAttendee });
        }

        if (options.provider === "local") {
          meetingLocalMode = true;
          meetingLocalProvider = options.localProvider || "whisper";
          meetingLocalModel = options.localModel || null;
          meetingLocalLanguage = options.language || null;
          meetingLocalWin = BrowserWindow.fromWebContents(event.sender);
          meetingLocalBuffers = { mic: [], system: [] };
          meetingLocalTranscript = "";
          await startLiveSpeakerIdentification(meetingLocalWin, systemAudioMode);
          await startMeetingAec(systemAudioMode);
          meetingLocalTimer = setInterval(() => transcribeAllLocalBuffers(), LOCAL_MEETING_CHUNK_INTERVAL_MS);
          const started = await startMeetingSystemAudio(
            event,
            systemAudioMode,
            systemAudioStrategy,
            "in local meeting mode"
          );
          return completeStart({ success: true, ...started, oneOnOneAttendee: meetingOneOnOneAttendee });
        }

        await connectRealtimeStreaming(event, options);
        const realtimeWin = BrowserWindow.fromWebContents(event.sender);
        await startLiveSpeakerIdentification(realtimeWin, systemAudioMode);
        await startMeetingAec(systemAudioMode);
        const started = await startMeetingSystemAudio(
          event,
          systemAudioMode,
          systemAudioStrategy,
          "in realtime mode"
        );
        return completeStart({ success: true, ...started, oneOnOneAttendee: meetingOneOnOneAttendee });
      } catch (error) {
        await rollbackMeetingTranscriptionStart();
        this.meetingDetectionEngine?.endRecordingSession(recordingSessionId);
        this.meetingDetectionEngine?.setUserRecording(false);
        debugLogger.error("Meeting transcription start error", { error: error.message });
        return meetingFailure(error);
      } finally {
        meetingTranscriptionStartInProgress = false;
      }
    };

    const sendMeetingAudio = (audioBuffer, source, synthetic = false, capturedAt = null) => {
      const outboundBuffer = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
      if (!synthetic) {
        this.meetingDetectionEngine?.recordMeetingAudioChunk(source, outboundBuffer);
      }

      if (source === "system") {
        const receivedAt = Date.now();
        if (!synthetic) {
          meetingEchoLeakDetector.recordSystemChunk(outboundBuffer, receivedAt);
          if (meetingAecEnabled && !this.meetingAecManager?.processSystemBuffer(outboundBuffer)) {
            meetingAecEnabled = false;
          }
          flushPendingMeetingMicChunks();
        }
        if (meetingLiveSpeakerActive) {
          meetingLiveSpeakerStartedAt ??= receivedAt;
          void liveSpeakerIdentifier.feedAudio(outboundBuffer);
        }
        if (!meetingDiarizationStream) {
          meetingDiarizationPath = path.join(os.tmpdir(), `ow-diarize-raw-${Date.now()}.pcm`);
          meetingDiarizationStream = fs.createWriteStream(meetingDiarizationPath);
          meetingDiarizationStartedAt = receivedAt;
        }
        meetingDiarizationStream.write(outboundBuffer);
        if (!synthetic) {
          // Every real chunk feeds the watchdog, including actual silence.
          const { rms, peak } = computeChunkStats(outboundBuffer);
          const audible = rms >= MEETING_MIC_SILENCE_RMS || peak >= MEETING_MIC_SILENCE_PEAK;
          meetingSystemAudioWatchdog.recordChunk(audible);
          if (audible && !meetingSystemAudioHeard) {
            meetingSystemAudioHeard = true;
            dropMeetingMicDiarizationCapture();
            clearMeetingSystemAudioSilenceTimer();
          }
        }
        dispatchMeetingAudioBuffer(outboundBuffer, "system", synthetic, capturedAt);
        return;
      }

      if (source !== "mic") return;
      if (!meetingSystemAudioHeard) {
        if (!meetingMicDiarizationStream) {
          const receivedAt = Date.now();
          meetingMicDiarizationPath = path.join(os.tmpdir(), `ow-diarize-raw-mic-${receivedAt}.pcm`);
          meetingMicDiarizationStream = fs.createWriteStream(meetingMicDiarizationPath);
          meetingMicDiarizationStartedAt = receivedAt;
        }
        meetingMicDiarizationStream.write(outboundBuffer);
      }
      if (processMeetingMicWithAec(outboundBuffer)) return;
      if (!hasNativeMeetingSystemAudio()) {
        const analysis = meetingEchoLeakDetector.analyzeMicChunk(outboundBuffer);
        if (analysis?.shouldMute && !meetingAecEnabled) {
          if (!meetingLocalMode) dispatchMeetingAudioBuffer(Buffer.alloc(outboundBuffer.length), "mic");
          return;
        }
        dispatchMeetingAudioBuffer(outboundBuffer, "mic");
        return;
      }
      meetingPendingMicChunks.push({ buffer: outboundBuffer, queuedAt: Date.now() });
      flushPendingMeetingMicChunks();
    };

    const startManagedMeetingSystemAudio = (event, manager, warningLabel, onWarningCode) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const timeline = manager === this.audioTapManager ? require("./meetingAudioTimeline")() : null;
      let captureStarted = false;
      const startCapture = () => {
        if (captureStarted) timeline?.markRestart();
        captureStarted = true;
        return manager.start({
          onChunk: (chunk) => {
            if (timeline) {
              timeline.write(chunk, (buffer, synthetic, capturedAt) =>
                sendMeetingAudio(buffer, "system", synthetic, capturedAt)
              );
            } else {
              sendMeetingAudio(chunk, "system");
            }
          },
          onError: (error) => {
            if (win && !win.isDestroyed()) {
              win.webContents.send("meeting-transcription-error", error.message);
            }
          },
          onWarning: (warning) => {
            debugLogger.warn(warningLabel, { code: warning.code, message: warning.message }, "meeting");
            onWarningCode?.(warning.code);
          },
        });
      };
      meetingSystemAudioWatchdog.attachCapture({
        stop: () => manager.stop(),
        start: startCapture,
      });
      return startCapture();
    };

    const fallBackToMicOnly = async (context) => {
      if (this._meetingSystemStreaming?.isConnected) {
        await this._meetingSystemStreaming.disconnect().catch((error) => {
          debugLogger.debug(`System streaming disconnect during ${context} fallback failed`, {
            error: error.message,
          }, "meeting");
        });
      }
      this._meetingSystemStreaming = null;
      stopMeetingSystemAudioWatchdog();
      await stopLiveSpeakerIdentification().catch(() => {});
    };

    const startMeetingSystemAudio = async (
      event,
      systemAudioMode,
      systemAudioStrategy,
      context
    ) => {
      if (systemAudioMode !== "native") {
        return { systemAudioMode, systemAudioStrategy };
      }
      try {
        await startManagedMeetingSystemAudio(
          event,
          this.audioTapManager,
          "macOS system audio tap warning",
          (code) => {
            if (code === "device_invalidated") {
              meetingSystemAudioWatchdog.reportDeviceInvalidated();
            }
          }
        );
        return { systemAudioMode, systemAudioStrategy };
      } catch (error) {
        debugLogger.warn(`Native system audio tap failed ${context}, falling back to mic-only`, {
          error: error.message,
        }, "meeting");
        await fallBackToMicOnly("native");
        return { systemAudioMode: "unsupported", systemAudioStrategy: "unsupported" };
      }
    };

    ipcMain.on("meeting-transcription-send", (_event, audioBuffer, source) => {
      sendMeetingAudio(audioBuffer, source);
    });

    const stopMeetingTranscription = async (expectedSessionId) => {
      if (this.meetingDetectionEngine?.endRecordingSession(expectedSessionId) === false) {
        return { success: false, reason: "stale-session" };
      }
      this.meetingDetectionEngine?.setUserRecording(false);
      clearMeetingSystemAudioSilenceTimer();
      stopMeetingSystemAudioWatchdog();
      try {
        if (this.audioTapManager) await this.audioTapManager.stop().catch(() => {});
        flushPendingMeetingMicChunks(true);
        await stopMeetingAec();
        const liveSpeakerState = await stopLiveSpeakerIdentification().catch(() => null);
        const diarizationSessionId = `diar-${Date.now()}`;
        const diarizationWin = meetingLocalWin || this.windowManager.controlPanelWindow;

        if (meetingLocalMode) {
          if (meetingLocalTimer) {
            clearInterval(meetingLocalTimer);
            meetingLocalTimer = null;
          }
          try {
            await transcribeAllLocalBuffers();
          } catch (error) {
            debugLogger.error("Local meeting final transcription failed", { error: error.message });
          }
          flushPendingMicFinals(true);
          const state = await captureMeetingDiarizationState();
          const transcript = buildOrderedTranscriptText(state.diarizationSegments) || meetingLocalTranscript;
          const sessionSpeakerConfigSnapshot = this.activeMeetingSpeakerConfig;
          const noteIdSnapshot = meetingNoteId;
          this.activeMeetingSpeakerConfig = null;
          resetMeetingLocalState();
          this._startOrSkipDiarization(
            diarizationSessionId,
            state.diarizationPcmPath,
            state.diarizationStartedAt,
            state.diarizationSegments,
            diarizationWin,
            liveSpeakerState,
            sessionSpeakerConfigSnapshot,
            noteIdSnapshot,
            state.diarizedSource
          );
          return { success: true, transcript, diarizationSessionId };
        }

        const results = await disconnectMeetingStreaming({ flushPending: true });
        const state = await captureMeetingDiarizationState();
        const transcript = buildOrderedTranscriptText(state.diarizationSegments) ||
          [results[0]?.text, results[1]?.text].filter(Boolean).join(" ");
        const sessionSpeakerConfigSnapshot = this.activeMeetingSpeakerConfig;
        const noteIdSnapshot = meetingNoteId;
        this.activeMeetingSpeakerConfig = null;
        this._startOrSkipDiarization(
          diarizationSessionId,
          state.diarizationPcmPath,
          state.diarizationStartedAt,
          state.diarizationSegments,
          diarizationWin,
          liveSpeakerState,
          sessionSpeakerConfigSnapshot,
          noteIdSnapshot,
          state.diarizedSource
        );
        return { success: true, transcript, diarizationSessionId };
      } catch (error) {
        debugLogger.error("Meeting transcription stop error", { error: error.message });
        return { success: false, error: error.message };
      }
    };

    const meetingTranscriptionLifecycle = createMeetingTranscriptionLifecycle({
      start: ({ sessionId, ownerWebContents, options }) =>
        startMeetingTranscription({ sender: ownerWebContents }, { ...options, sessionId }),
      stop: (sessionId) => stopMeetingTranscription(sessionId),
      onError: (error, sessionId) => {
        debugLogger.error("Meeting transcription owner-loss teardown failed", {
          error: error?.message,
          sessionId,
        }, "meeting");
      },
    });

    ipcMain.handle("meeting-transcription-start", (event, options = {}) => {
      const sessionId =
        typeof options.sessionId === "string" && options.sessionId.length > 0
          ? options.sessionId
          : crypto.randomUUID();
      return meetingTranscriptionLifecycle.startSession({
        sessionId,
        ownerWebContents: event.sender,
        options,
      });
    });

    ipcMain.handle("meeting-transcription-stop", (_event, expectedSessionId) =>
      meetingTranscriptionLifecycle.stopSession(expectedSessionId)
    );

    ipcMain.handle(
      "meeting-transcription-set-system-audio-available",
      async (event, sessionId, available) => {
        const updated = await this.meetingDetectionEngine?.setRecordingSystemAudioAvailable(
          sessionId,
          available === true,
          event.sender
        );
        return updated === true ? { success: true } : { success: false, reason: "stale-session" };
      }
    );

    ipcMain.handle("acquire-recording-lock", async (_event, pipeline) => {
      if (this._activeRecordingPipeline && this._activeRecordingPipeline !== pipeline) {
        return { success: false, holder: this._activeRecordingPipeline };
      }
      this._activeRecordingPipeline = pipeline;
      return { success: true };
    });

    ipcMain.handle("release-recording-lock", async (_event, pipeline) => {
      if (this._activeRecordingPipeline === pipeline) {
        this._activeRecordingPipeline = null;
      }
      return { success: true };
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

    registerSpeakerHandlers(ipcMain, {
      databaseManager: this.databaseManager,
      liveSpeakerIdentifier,
      diarizationManager: this.diarizationManager,
      retroactiveMapping: (profile) => this._retroactiveMapping(profile),
      tryAutoLabelOneOnOne: (noteId) => this._tryAutoLabelOneOnOne(noteId),
      logError: (message, data) => debugLogger.error(message, data, "speaker"),
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

    ipcMain.handle("meeting-detection-get-preferences", async () => {
      try {
        return { success: true, preferences: this.meetingDetectionEngine.getPreferences() };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("meeting-detection-set-preferences", async (_event, prefs) => {
      try {
        this.meetingDetectionEngine.setPreferences(prefs);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("meeting-set-speaker-diarization-enabled", async (_event, payload) => {
      try {
        this.speakerDiarizationEnabled = payload?.enabled !== false;
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("meeting-set-session-speaker-config", async (_event, payload) => {
      try {
        const enabled = payload?.enabled !== false;
        const expectedCount = Math.max(
          1,
          Math.min(
            MAX_SPEAKER_COUNT,
            Number(payload?.expectedCount) || DEFAULT_EXPECTED_SPEAKER_COUNT
          )
        );
        // Only a stepper-set count is explicit; the diarization toggle reuses this
        // channel and must not freeze the count against roster-driven refreshes.
        this.activeMeetingSpeakerConfig = {
          enabled,
          expectedCount,
          explicit: payload?.countIsExplicit === true,
        };
        liveSpeakerIdentifier.setEnabled(enabled);
        // Live identification only labels other speakers (the mic track is "you"),
        // so cap at expectedCount - 1 to match resolveSessionMaxSpeakers().
        liveSpeakerIdentifier.setMaxSpeakers(Math.max(1, expectedCount - 1));
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("meeting-notification-respond", async (_event, detectionId, action) => {
      try {
        await this.meetingDetectionEngine.handleNotificationResponse(detectionId, action);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    registerMeetingAutoEndLifecycleHandlers(ipcMain, () => this.meetingDetectionEngine);

    ipcMain.handle("join-calendar-meeting", async (_event, eventId) => {
      try {
        await this.meetingDetectionEngine.joinCalendarMeeting(eventId);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-meeting-notification-data", async () => {
      return this.windowManager?._pendingNotificationData ?? null;
    });

    ipcMain.handle("get-pending-meeting-note-navigation", async () => {
      return this.windowManager?.consumePendingMeetingNoteNavigation() ?? null;
    });

    ipcMain.handle("meeting-notification-ready", async (event) => {
      this.windowManager?.showNotificationWindow(event.sender);
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

  _applySpeakerName(segments, speakerId, displayName) {
    if (!displayName) {
      return;
    }

    for (const segment of segments) {
      if (segment.speaker !== speakerId) {
        continue;
      }

      applyConfirmedSpeaker(segment, {
        speakerName: displayName,
        speakerIsPlaceholder: false,
        suggestedName: undefined,
        suggestedProfileId: undefined,
      });
    }
  }

  _reconcileLiveSpeakerState(liveSpeakerState, speakerEmbeddingsMap, enrichedSegments) {
    if (!liveSpeakerState || !speakerEmbeddingsMap) {
      return new Set();
    }

    const speakerEmbeddings = require("./speakerEmbeddings");
    const reconciledSpeakers = new Set();
    const usedLiveSpeakers = new Set();
    const noteMappings = new Map();

    const liveEntries = Object.entries(liveSpeakerState)
      .map(([speakerId, data]) => ({
        speakerId,
        displayName: data?.displayName || null,
        profileId: data?.profileId ?? null,
        noteId: data?.noteId ?? null,
        embedding: Array.isArray(data?.embedding) ? new Float32Array(data.embedding) : null,
      }))
      .filter((entry) => entry.embedding);

    const getMappingsForNote = (noteId) => {
      if (!noteMappings.has(noteId)) {
        noteMappings.set(noteId, this.databaseManager.getSpeakerMappings(noteId));
      }
      return noteMappings.get(noteId);
    };

    for (const [mappedId, embeddingArray] of Object.entries(speakerEmbeddingsMap)) {
      let bestEntry = null;
      let bestSimilarity = 0;

      for (const entry of liveEntries) {
        if (usedLiveSpeakers.has(entry.speakerId)) {
          continue;
        }

        const similarity = speakerEmbeddings.cosineSimilarity(
          new Float32Array(embeddingArray),
          entry.embedding
        );
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestEntry = entry;
        }
      }

      if (!bestEntry || bestSimilarity <= 0.6) {
        continue;
      }

      usedLiveSpeakers.add(bestEntry.speakerId);
      reconciledSpeakers.add(mappedId);

      let displayName = bestEntry.displayName;
      let profileId = bestEntry.profileId;

      if (bestEntry.noteId) {
        const liveMapping = getMappingsForNote(bestEntry.noteId).find(
          (mapping) => mapping.speaker_id === bestEntry.speakerId
        );
        if (liveMapping) {
          displayName = liveMapping.display_name || displayName;
          profileId = liveMapping.profile_id ?? profileId;
          this.databaseManager.setSpeakerMapping(
            bestEntry.noteId,
            mappedId,
            profileId,
            displayName
          );
          // Live and offline ids share one namespace now, so they often match —
          // removing the "old" row would delete the mapping just written.
          if (bestEntry.speakerId !== mappedId) {
            this.databaseManager.removeSpeakerMapping(bestEntry.noteId, bestEntry.speakerId);
          }
        } else if (displayName) {
          this.databaseManager.setSpeakerMapping(
            bestEntry.noteId,
            mappedId,
            profileId,
            displayName
          );
        }
      }

      this._applySpeakerName(enrichedSegments, mappedId, displayName);
    }

    return reconciledSpeakers;
  }

  _resolveSpeakerExpectation({ sessionConfig, noteId, observedSpeakerIds, diarizedSource }) {
    // Only a count the user set explicitly outranks the note: participants added
    // mid-meeting postdate the config snapshot taken at recording start.
    let expectedTotal = sessionConfig?.explicit ? sessionConfig.expectedCount : null;

    if (!expectedTotal && noteId != null) {
      try {
        expectedTotal = this._noteExpectedSpeakerCountOrNull(this.databaseManager.getNote(noteId));
      } catch (_) {
        expectedTotal = null;
      }
    }

    // Diarizing the mic track (in-person session) means the user is one of the
    // diarized voices, so the expected total applies without the -1 the
    // system-audio branches use.
    const micMode = diarizedSource === "mic";

    if (expectedTotal) {
      const total = Math.min(expectedTotal, MAX_SPEAKER_COUNT);
      const numSpeakers = micMode ? total : Math.max(1, total - 1);
      return { numSpeakers, cap: numSpeakers };
    }

    if (observedSpeakerIds.size >= 2) {
      const numSpeakers = Math.min(observedSpeakerIds.size, MAX_SPEAKER_COUNT);
      return { numSpeakers, cap: numSpeakers };
    }

    if (micMode) {
      return { numSpeakers: -1, cap: DEFAULT_EXPECTED_SPEAKER_COUNT };
    }

    // Only system audio reaches the diarizer (the mic track is "you"), so the cap
    // counts other speakers — same total - 1 basis as the branches above.
    return { numSpeakers: -1, cap: Math.max(1, DEFAULT_EXPECTED_SPEAKER_COUNT - 1) };
  }

  _startOrSkipDiarization(
    sessionId,
    rawPcmPath,
    audioStartedAt,
    transcriptSegments,
    win,
    liveSpeakerState = null,
    sessionConfig = null,
    noteId = null,
    diarizedSource = "system"
  ) {
    const send = (payload) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send("meeting-diarization-complete", { sessionId, noteId, ...payload });
      }
    };

    const diarizationEnabled = (sessionConfig?.enabled ?? this.speakerDiarizationEnabled) !== false;

    if (!diarizationEnabled || !this.diarizationManager?.isAvailable() || !rawPcmPath) {
      send({
        segments: transcriptSegments.map((segment, index) => ({
          ...segment,
          id: segment.id || `segment-${index}`,
        })),
      });
      return;
    }

    const fs = require("fs");

    (async () => {
      let tmpWav = null;
      try {
        tmpWav = await this.diarizationManager.convertRawPcmToWav(rawPcmPath, 24000);
        const observedSpeakerIds = new Set(
          transcriptSegments
            .filter((segment) => segment.source === "system" && segment.speaker)
            .map((segment) => segment.speaker)
        );
        for (const speakerId of Object.keys(liveSpeakerState || {})) {
          observedSpeakerIds.add(speakerId);
        }

        if (observedSpeakerIds.size > 10) {
          debugLogger.warn("Excessive speaker count from live identification", {
            observedSpeakers: observedSpeakerIds.size,
          });
        }

        const { numSpeakers, cap } = this._resolveSpeakerExpectation({
          sessionConfig,
          noteId,
          observedSpeakerIds,
          diarizedSource,
        });
        let diarizationSegments = await this.diarizationManager.diarize(
          tmpWav,
          numSpeakers > 0 ? { numSpeakers } : {}
        );
        if (cap != null) {
          diarizationSegments = this.diarizationManager.capSpeakerClusters(
            diarizationSegments,
            cap
          );
        }

        const startMs =
          (Number.isFinite(audioStartedAt) && audioStartedAt) ||
          transcriptSegments.find((segment) => segment.source === diarizedSource)?.timestamp ||
          transcriptSegments[0]?.timestamp ||
          0;
        const isEpochMs = startMs > 1e9;
        const normalized = transcriptSegments.map((seg) => ({
          ...seg,
          timestamp:
            seg.timestamp != null
              ? isEpochMs
                ? (seg.timestamp - startMs) / 1000
                : seg.timestamp
              : undefined,
        }));

        const enrichedSegments = this.diarizationManager.mergeWithTranscript(
          normalized,
          diarizationSegments,
          { diarizedSource }
        );

        const speakerSet = new Set(diarizationSegments.map((d) => d.speaker));
        const speakerRenumber = new Map();
        let sIdx = 0;
        for (const sp of speakerSet) {
          speakerRenumber.set(sp, `speaker_${sIdx}`);
          sIdx++;
        }

        // Mirrors the mic-mode single-cluster softening in mergeWithTranscript:
        // every segment stays "you", so persisting an embedding keyed to a
        // cluster id that owns no segments would leave the note inconsistent.
        const micSingleClusterSoftened = diarizedSource === "mic" && speakerSet.size === 1;

        let speakerEmbeddingsMap = null;
        const speakerEmb = require("./speakerEmbeddings");
        try {
          if (!micSingleClusterSoftened && speakerEmb.isAvailable() && tmpWav) {
            const speakerIds = [...new Set(diarizationSegments.map((s) => s.speaker))];
            speakerEmbeddingsMap = {};

            for (const spk of speakerIds) {
              const segs = diarizationSegments.filter((s) => s.speaker === spk);
              const sorted = segs.sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, 3);
              const embeddings = [];
              for (const seg of sorted) {
                if (seg.end - seg.start < 1.5) continue;
                const emb = await speakerEmb.extractEmbedding(tmpWav, seg.start, seg.end);
                if (emb) embeddings.push(emb);
              }
              if (embeddings.length > 0) {
                const centroid = speakerEmb.computeCentroid(embeddings);
                const mappedId = speakerRenumber.get(spk) || spk;
                speakerEmbeddingsMap[mappedId] = Array.from(centroid);
              }
            }
          }
        } catch (err) {
          debugLogger.debug("Speaker embedding extraction skipped", { error: err.message });
        }

        const reconciledSpeakers = this._reconcileLiveSpeakerState(
          liveSpeakerState,
          speakerEmbeddingsMap,
          enrichedSegments
        );

        if (speakerEmbeddingsMap) {
          try {
            const profiles = this.databaseManager.getSpeakerProfiles(true);

            if (profiles.length > 0) {
              for (const [mappedId, embArr] of Object.entries(speakerEmbeddingsMap)) {
                const alreadyMapped = enrichedSegments.some(
                  (segment) => segment.speaker === mappedId && segment.speakerName
                );
                if (reconciledSpeakers.has(mappedId) || alreadyMapped) {
                  continue;
                }

                const emb = new Float32Array(embArr);
                let bestProfile = null;
                let bestSim = 0;

                for (const profile of profiles) {
                  const profileEmb = new Float32Array(
                    profile.embedding.buffer,
                    profile.embedding.byteOffset,
                    profile.embedding.byteLength / 4
                  );
                  const sim = speakerEmb.cosineSimilarity(emb, profileEmb);
                  if (sim > bestSim) {
                    bestSim = sim;
                    bestProfile = profile;
                  }
                }

                if (bestProfile && bestSim > 0.6) {
                  for (const seg of enrichedSegments) {
                    if (seg.speaker === mappedId) {
                      applyConfirmedSpeaker(seg, {
                        speakerName: bestProfile.display_name,
                        speakerIsPlaceholder: false,
                        suggestedName: undefined,
                        suggestedProfileId: undefined,
                      });
                    }
                  }
                } else if (bestProfile && bestSim > 0.5) {
                  for (const seg of enrichedSegments) {
                    if (seg.speaker === mappedId) {
                      if (isSpeakerLocked(seg)) {
                        continue;
                      }
                      applySuggestedSpeaker(seg, {
                        suggestedName: bestProfile.display_name,
                        suggestedProfileId: bestProfile.id,
                      });
                    }
                  }
                }
              }
            }
          } catch (err) {
            debugLogger.debug("Auto speaker recognition skipped", { error: err.message });
          }
        }

        send({ segments: enrichedSegments, speakerEmbeddings: speakerEmbeddingsMap });
      } catch (err) {
        debugLogger.warn("Background diarization failed", { error: err.message });
        send({ segments: [] });
      } finally {
        try {
          fs.unlinkSync(rawPcmPath);
        } catch (_) {}
        if (tmpWav) {
          try {
            fs.unlinkSync(tmpWav);
          } catch (_) {}
        }
      }
    })();
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
