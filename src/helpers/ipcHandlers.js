const { ipcMain, app, shell, BrowserWindow, systemPreferences, net, clipboard } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const debugLogger = require("./debugLogger");
const { PARAKEET_UNSUPPORTED_OS_CODE } = require("./parakeetCapability");
const { getModelType, isSherpaLocalProvider } = require("./parakeetModelInfo");
const { broadcastToWindows } = require("./windowBroadcast");
const { openExternalUrl } = require("./externalUrlOpener");
const { BYOK_API_KEYS } = require("../config/secretKeys");
const { extractAnthropicText, describeMissingAnthropicText } = require("./anthropicResponse");
const { classifyAndLog } = require("./networkErrors");
const { resolveSystemDefaultMicrophone } = require("./systemDefaultMicrophone");
const { pickEnterpriseConfig } = require("./enterpriseProviderErrors");
// The renderer's ModelRegistry is not main-loadable; the raw registry data is
// packaged, and the route resolver only needs {id, baseUrl} per provider.
const transcriptionProviderBaseUrls = () =>
  require("../models/modelRegistryData.json").transcriptionProviders;
// ipcMain.handle keeps only the message when a promise rejects, dropping custom
// props — proxy handlers return {error, code, messageKey} so the renderer can
// rebuild the error.
const serializeIpcError =
  (fn) =>
  async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      return { error: error.message, code: error.code, messageKey: error.messageKey };
    }
  };

// Which diarization dialect a resolved endpoint speaks, for Custom endpoints
// that front a known provider. Null when the host offers no known dialect.
const diarizationHost = (endpoint) => {
  try {
    const host = new URL(endpoint).hostname;
    if (host === "mistral.ai" || host.endsWith(".mistral.ai")) return "mistral";
    if (host === "openai.com" || host.endsWith(".openai.com")) return "openai";
  } catch {}
  return null;
};

// Enterprise providers run with credentials and endpoints supplied by the
// user's local settings. Hosted identity/cloud bootstrap is not part of the
// desktop runtime.
function resolveEnterpriseRuntime(provider, modelId, config = {}) {
  return {
    provider,
    model: config.model || modelId,
    apiKey: config.apiKey || "",
    enterprise: pickEnterpriseConfig(config),
  };
}

const { resolveLocalServerNeeds } = require("./localServerPolicy");
const { registerNotesHandlers } = require("./notesIpcHandlers");
const { registerUrlDownloadHandlers } = require("./urlDownloadIpcHandlers");
const { registerVocabularyHandlers } = require("./vocabularyIpcHandlers");
const { registerContainerHandlers } = require("./containerIpcHandlers");
const { registerChatPersistenceHandlers } = require("./chatPersistenceIpcHandlers");
const { registerActionsHandlers } = require("./actionsIpcHandlers");
const { registerLocalFileTranscriptionHandler } = require("./localFileTranscriptionIpcHandler");
const { sendNoteAdded, sendNoteUpdated, sendNoteDeleted } = require("./notesEvents");
const autoStart = require("./autoStart");
const AssemblyAiStreaming = require("./assemblyAiStreaming");
const { i18nMain, changeLanguage } = require("./i18nMain");
const DeepgramStreaming = require("./deepgramStreaming");
const { GeminiLiveStreaming, GEMINI_LIVE_MODEL } = require("./geminiLiveStreaming");
const CortiStreaming = require("./cortiStreaming");
const OpenAIRealtimeStreaming = require("./openaiRealtimeStreaming");
const { getCortiToken } = require("./cortiAuth");
const { createTinfoilRealtimeSocket } = require("./tinfoilSecureClient");
const { TINFOIL_REALTIME_MODEL } = require("./tinfoilRealtimeStreaming");
const { getTinfoilChatModels } = require("./tinfoilCatalog");
const { transcribeWithTinfoil } = require("./tinfoilTranscription");
const { transcribeWithGemini } = require("./geminiTranscription");
const AudioStorageManager = require("./audioStorage");
const AgentStreamRequestRegistry = require("./agentStreamRequestRegistry");
const { createUploadCancelRegistry } = require("./uploadCancelRegistry");
const { testProviderConnection } = require("./providerConnectionTest");
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

// Meeting capture runs at 24 kHz (see meetingRecordingStore AudioContext); realtime
// streaming providers must be told the true PCM rate or they misread the audio.
const MEETING_STREAM_SAMPLE_RATE = 24000;
const MEETING_RECONNECT_BUFFER_MAX_BYTES = MEETING_STREAM_SAMPLE_RATE * 2 * 30;
// The realtime clients default to a 0.6 server-VAD threshold, raised in #630 to
// keep mic ambient noise from opening turns. The direct system-audio channel
// uses a lower threshold so quiet remote speech still opens a turn.
const MEETING_SYSTEM_VAD_THRESHOLD = 0.3;

const MISTRAL_TRANSCRIPTION_URL = "https://api.mistral.ai/v1/audio/transcriptions";

const XAI_STT_URL = "https://api.x.ai/v1/stt";

// Debounce delay: wait for user to stop typing before processing corrections

// Route caps vary by provider (Gemini's inline-base64 limit is the lowest), so
// the message reports the cap that actually applied.
const byokSizeCapError = (sizeCapBytes) =>
  `File too large. Maximum size for bring-your-own-key is ${Math.floor(sizeCapBytes / (1024 * 1024))} MB.`;

const AUDIO_MIME_TYPES = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  webm: "audio/webm",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  opus: "audio/ogg",
};

// Azure Responses rejects probes with fewer than 16 output tokens. The probe
// only needs one word, but this is the provider's minimum accepted value.
const CONNECTION_TEST_MAX_OUTPUT_TOKENS = 16;

const {
  formatTimestamp: formatDiarTime,
  mergeSpeakersWithText,
  formatSpeakerTranscript,
} = require("./speakerMerge");
const { timestampRequestFields, mapVerboseSegments } = require("./uploadTimestamps");
const { listLocalTranscriptionModels } = require("./localTranscriptionModels");

// Canonicalize allowed dirs so realpath'd inputs match on macOS (/var -> /private/var).
// Deliberately narrow: user-picked paths anywhere else are approved individually via
// approvedAudioPaths, so a compromised renderer can't read arbitrary files.
function getCanonicalAllowedAudioDirs() {
  const os = require("os");
  const { getSafeTempDir } = require("./safeTempDir");
  const dirs = [os.tmpdir(), getSafeTempDir(), app.getPath("userData")];
  return dirs.map((d) => {
    try {
      return fs.realpathSync(d);
    } catch {
      return d;
    }
  });
}

// User-picked paths (OS file dialog, real drag-dropped files) may live outside the
// static dirs (external volumes, /mnt, D:\) and are approved individually.
const approvedAudioPaths = new Set();

function approveAudioPath(filePath) {
  if (typeof filePath !== "string" || !filePath) return;
  try {
    approvedAudioPaths.add(fs.realpathSync(path.resolve(filePath)));
  } catch {
    // File vanished or unreadable; nothing to approve.
  }
}

// Returns the realpath'd file path if it lives under an allowed dir, else null.
function resolveAllowedAudioPath(filePath) {
  const real = fs.realpathSync(path.resolve(filePath));
  if (approvedAudioPaths.has(real)) {
    return real;
  }
  const allowed = getCanonicalAllowedAudioDirs();
  if (allowed.some((dir) => real === dir || real.startsWith(dir + path.sep))) {
    return real;
  }
  return null;
}

function buildMultipartBody(fileBuffer, fileName, contentType, fields = {}) {
  const boundary = `----OpenHercules${Date.now()}`;
  const parts = [];

  parts.push(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`
  );
  parts.push(fileBuffer);
  parts.push("\r\n");

  for (const [name, value] of Object.entries(fields)) {
    if (value != null) {
      parts.push(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
          `${value}\r\n`
      );
    }
  }

  parts.push(`--${boundary}--\r\n`);

  const bodyParts = parts.map((p) => (typeof p === "string" ? Buffer.from(p) : p));
  return { body: Buffer.concat(bodyParts), boundary };
}

async function postMultipart(
  url,
  body,
  boundary,
  headers = {},
  { signal, session: fetchSession } = {}
) {
  const response = await (fetchSession ?? net).fetch(url.toString(), {
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

    ipcMain.handle("onboarding-set-window-mode", (_event, mode) =>
      this.windowManager.setOnboardingWindowMode(mode)
    );

    ipcMain.handle("onboarding-set-active", (_event, active) => {
      if (typeof active !== "boolean") return false;
      return this.windowManager.setOnboardingActive(active);
    });

    ipcMain.handle("test-provider-connection", async (_event, config) => {
      if (config?.provider === "corti" && config?.scope === "transcription") {
        try {
          const clientId = String(config.clientId || "").trim();
          const clientSecret = String(config.clientSecret || "").trim();
          if (clientId && clientSecret) {
            await getCortiToken({
              environment: config.environment || "us",
              tenant: String(config.tenant || "").trim() || "base",
              clientId,
              clientSecret,
            });
          } else {
            await this._mintStoredCortiToken({
              environment: config.environment,
              tenant: config.tenant,
            });
          }
          return { success: true };
        } catch (error) {
          // errorCode is the machine-readable field the renderer maps to i18n;
          // the English string stays for logs/back-compat. Only a response
          // Corti actually sent counts as a rejection (getCortiToken prefixes
          // those); a fetch that never reached it is a network problem, and
          // reporting it as "credentials rejected" sends the user to re-type a
          // key that was never the issue.
          if (error?.name === "AbortError") {
            return {
              success: false,
              errorCode: "timeout",
              error: "The connection test timed out.",
            };
          }
          if (!/^(Corti authentication failed|Invalid Corti)/.test(error?.message || "")) {
            return {
              success: false,
              errorCode: "network",
              error: "The provider could not be reached.",
            };
          }
          return {
            success: false,
            errorCode: "credentialsRejected",
            error: "Corti rejected these credentials.",
          };
        }
      }
      return testProviderConnection(config);
    });

    ipcMain.handle("window-minimize", () => {
      if (this.windowManager.controlPanelWindow) {
        this.windowManager.controlPanelWindow.minimize();
      }
    });

    ipcMain.handle("window-maximize", () => {
      if (this.windowManager.controlPanelWindow) {
        if (this.windowManager.controlPanelWindow.isMaximized()) {
          this.windowManager.controlPanelWindow.unmaximize();
        } else {
          this.windowManager.controlPanelWindow.maximize();
        }
      }
    });

    ipcMain.handle("window-close", () => {
      if (this.windowManager.controlPanelWindow) {
        this.windowManager.controlPanelWindow.close();
      }
    });

    ipcMain.handle("window-is-maximized", () => {
      if (this.windowManager.controlPanelWindow) {
        return this.windowManager.controlPanelWindow.isMaximized();
      }
      return false;
    });

    ipcMain.handle("snap-to-meeting-mode", () => {
      this.windowManager.snapControlPanelToMeetingMode();
    });

    ipcMain.handle("restore-from-meeting-mode", () => {
      this.windowManager.restoreControlPanelFromMeetingMode();
      this.meetingDetectionEngine?.setMeetingModeActive(false);
    });

    ipcMain.handle("set-notification-interactivity", (event, interactive) => {
      this.windowManager.setNotificationInteractivity(event.sender, Boolean(interactive));
      return { success: true };
    });

    for (const k of BYOK_API_KEYS) {
      ipcMain.handle(`get-${k.base}-key`, () => this.environmentManager[k.get]());
      ipcMain.handle(`save-${k.base}-key`, (event, key) => this.environmentManager[k.save](key));
    }

    ipcMain.handle("db-save-transcription", async (event, text, rawText, options) => {
      const result = this.databaseManager.saveTranscription(text, rawText, options);
      if (result?.success && result?.transcription) {
        setImmediate(() => {
          broadcastToWindows("transcription-added", result.transcription);
        });
      }
      return result;
    });

    ipcMain.handle("db-get-transcriptions", async (event, limit = 50, options = {}) => {
      return this.databaseManager.getTranscriptions(limit, options);
    });

    ipcMain.handle("db-clear-transcriptions", async (event) => {
      this.audioStorageManager.deleteAllAudio();
      const result = this.databaseManager.clearTranscriptions();
      if (result?.success) {
        setImmediate(() => {
          broadcastToWindows("transcriptions-cleared", {
            cleared: result.cleared,
          });
        });
      }
      return result;
    });

    ipcMain.handle("db-delete-transcription", async (event, id) => {
      return this.deleteTranscriptionInternal(id);
    });

    // Audio storage handlers
    ipcMain.handle("save-transcription-audio", async (event, id, audioBuffer, metadata) => {
      const transcription = this.databaseManager.getTranscriptionById(id);
      const timestamp = transcription?.timestamp || null;
      const result = this.audioStorageManager.saveAudio(id, Buffer.from(audioBuffer), timestamp);
      if (result.success) {
        this.databaseManager.updateTranscriptionAudio(id, {
          hasAudio: 1,
          audioDurationMs: metadata?.durationMs || null,
          provider: metadata?.provider || null,
          model: metadata?.model || null,
        });
        const updated = this.databaseManager.getTranscriptionById(id);
        if (updated) broadcastToWindows("transcription-updated", updated);
      }
      return result;
    });

    ipcMain.handle("merge-audio-segments", async (_event, segments) => {
      try {
        if (!Array.isArray(segments) || segments.length < 2 || segments.length > 100) {
          throw new Error("Invalid audio segment count");
        }
        const normalized = segments.map((segment) => {
          if (!segment?.buffer || typeof segment.mimeType !== "string") {
            throw new Error("Invalid audio segment");
          }
          return { buffer: Buffer.from(segment.buffer), mimeType: segment.mimeType };
        });
        const { mergeAudioSegments } = require("./ffmpegUtils");
        const buffer = await mergeAudioSegments(normalized);
        // Slice to a real ArrayBuffer: Buffers sent over IPC arrive as Uint8Array,
        // and pooled Buffers share a larger underlying allocation.
        return {
          success: true,
          buffer: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
          mimeType: "audio/webm",
        };
      } catch (error) {
        debugLogger.error("Failed to merge recovered audio segments", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-audio-path", async (event, id) => {
      return this.audioStorageManager.getAudioPath(id);
    });

    ipcMain.handle("show-audio-in-folder", async (event, id) => {
      const filePath = this.audioStorageManager.getAudioPath(id);
      if (!filePath) return { success: false };
      shell.showItemInFolder(filePath);
      return { success: true };
    });

    ipcMain.handle("get-audio-buffer", async (event, id) => {
      const buffer = this.audioStorageManager.getAudioBuffer(id);
      return buffer ? buffer.buffer : null;
    });

    ipcMain.handle("delete-transcription-audio", async (event, id) => {
      const result = this.audioStorageManager.deleteAudio(id);
      if (result.success) {
        this.databaseManager.updateTranscriptionAudio(id, {
          hasAudio: 0,
          audioDurationMs: null,
          provider: null,
          model: null,
        });
      }
      return result;
    });

    ipcMain.handle("get-audio-storage-usage", async () => {
      return this.audioStorageManager.getStorageUsage();
    });

    ipcMain.on(
      "retention-settings-changed",
      createRetentionSettingsHandler({
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
      })
    );

    ipcMain.handle("delete-all-audio", async () => {
      const result = this.audioStorageManager.deleteAllAudio();
      try {
        const rows = this.databaseManager.db
          .prepare("SELECT id FROM transcriptions WHERE has_audio = 1")
          .all();
        if (rows.length > 0) {
          this.databaseManager.clearAudioFlags(rows.map((r) => r.id));
        }
      } catch (error) {
        debugLogger.error(
          "Failed to clear audio flags after delete-all",
          { error: error.message },
          "audio-storage"
        );
      }
      return result;
    });

    ipcMain.handle("get-transcription-by-id", async (event, id) => {
      return this.databaseManager.getTranscriptionById(id);
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

    ipcMain.handle("export-note", async (event, noteId, format) => {
      try {
        const note = this.databaseManager.getNote(noteId);
        if (!note) return { success: false, error: "Note not found" };

        const { dialog } = require("electron");
        const fs = require("fs");
        const ext = format === "txt" ? "txt" : "md";
        const safeName = (note.title || "Untitled").replace(/[/\\?%*:|"<>]/g, "-");

        const result = await dialog.showSaveDialog({
          defaultPath: `${safeName}.${ext}`,
          filters: [
            { name: "Markdown", extensions: ["md"] },
            { name: "Text", extensions: ["txt"] },
          ],
        });

        if (result.canceled || !result.filePath) return { success: false };

        let exportContent;
        if (format === "txt") {
          exportContent = (note.content || "")
            .replace(/#{1,6}\s+/g, "")
            .replace(/[*_~`]+/g, "")
            .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
            .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
            .replace(/^>\s+/gm, "")
            .trim();
        } else {
          exportContent = note.enhanced_content || note.content;
        }

        fs.writeFileSync(result.filePath, exportContent, "utf-8");
        return { success: true };
      } catch (error) {
        debugLogger.error("Error exporting note", { error: error.message }, "notes");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("export-transcript", async (event, noteId, format) => {
      try {
        const note = this.databaseManager.getNote(noteId);
        if (!note) return { success: false, error: "Note not found" };

        const segments = JSON.parse(note.transcript || "[]");
        if (!segments.length) return { success: false, error: "No transcript available" };

        const speakerMappings = this._buildSpeakerMappings(noteId);

        const { dialog } = require("electron");
        const fs = require("fs");
        const extMap = { srt: "srt", json: "json", md: "md" };
        const ext = extMap[format] || "txt";
        const safeName = (note.title || "Untitled").replace(/[/\\?%*:|"<>]/g, "-");

        const result = await dialog.showSaveDialog({
          defaultPath: `${safeName}.${ext}`,
          filters: [
            { name: "Text", extensions: ["txt"] },
            { name: "SubRip Subtitles", extensions: ["srt"] },
            { name: "JSON", extensions: ["json"] },
            { name: "Markdown", extensions: ["md"] },
          ],
        });

        if (result.canceled || !result.filePath) return { success: false };

        const transcriptFormatter = require("./transcriptFormatter");
        let exportContent;
        if (format === "txt") {
          exportContent = transcriptFormatter.formatTxt(note, segments, speakerMappings);
        } else if (format === "srt") {
          exportContent = transcriptFormatter.formatSrt(segments, speakerMappings, note);
        } else if (format === "md") {
          exportContent = transcriptFormatter.formatMd(note, segments, speakerMappings);
        } else {
          exportContent = transcriptFormatter.formatJson(note, segments, speakerMappings);
        }

        fs.writeFileSync(result.filePath, exportContent, "utf-8");
        return { success: true };
      } catch (error) {
        debugLogger.error("Error exporting transcript", { error: error.message }, "notes");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("export-dictionary", async (event, words) => {
      try {
        const { dialog } = require("electron");
        const fs = require("fs");

        const result = await dialog.showSaveDialog({
          defaultPath: "dictionary.txt",
          filters: [{ name: "Text", extensions: ["txt"] }],
        });

        if (result.canceled || !result.filePath) return { success: false };

        fs.writeFileSync(result.filePath, words.join("\n"), "utf-8");
        return { success: true };
      } catch (error) {
        debugLogger.error("Error exporting dictionary", { error: error.message }, "dictionary");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("select-audio-file", async (event, options = {}) => {
      const { dialog } = require("electron");
      const properties = ["openFile"];
      if (options.multiple === true) properties.push("multiSelections");
      const result = await dialog.showOpenDialog({
        properties,
        filters: [
          {
            name: "Audio Files",
            extensions: ["mp3", "wav", "m4a", "webm", "ogg", "oga", "flac", "aac", "opus"],
          },
        ],
      });
      if (result.canceled || !result.filePaths.length) {
        return { canceled: true };
      }
      result.filePaths.forEach(approveAudioPath);
      if (options.multiple === true) {
        return { canceled: false, filePaths: result.filePaths };
      }
      return { canceled: false, filePath: result.filePaths[0] };
    });

    // Fired by the preload's getPathForFile for real drag-dropped files; a
    // renderer-constructed File yields "" there, so this can't be forged.
    ipcMain.on("approve-audio-path", (_event, filePath) => {
      approveAudioPath(filePath);
    });

    ipcMain.handle("get-file-size", async (_event, filePath) => {
      const fs = require("fs");
      try {
        if (typeof filePath !== "string") return 0;
        const real = resolveAllowedAudioPath(filePath);
        if (!real) return 0;
        const stats = fs.statSync(real);
        return stats.size;
      } catch {
        return 0;
      }
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

    ipcMain.handle("check-accessibility-permission", async () => {
      return systemPreferences.isTrustedAccessibilityClient(false);
    });

    // Passes `true` to isTrustedAccessibilityClient to trigger the macOS system prompt
    ipcMain.handle("prompt-accessibility-permission", async () => {
      return systemPreferences.isTrustedAccessibilityClient(true);
    });

    ipcMain.handle("read-clipboard", async (event) => {
      return clipboard.readText();
    });

    ipcMain.handle("write-clipboard", async (_event, text) => {
      if (typeof text !== "string") throw new TypeError("Clipboard text must be a string");
      clipboard.writeText(text);
      return { success: true };
    });


    // Voice drafts (chat input): persist a recorded buffer so the file-based
    // transcription pipeline (all providers) can consume it, then delete it.
    ipcMain.handle("save-temp-audio", async (_event, buffer) => {
      const tempPath = path.join(
        os.tmpdir(),
        `ow-voice-draft-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.webm`
      );
      fs.writeFileSync(tempPath, Buffer.from(buffer));
      return { success: true, path: tempPath };
    });

    ipcMain.handle("delete-temp-audio", async (_event, tempPath) => {
      // Only files this handler family created are deletable.
      const resolved = path.resolve(tempPath);
      const validPrefix = path.join(os.tmpdir(), "ow-voice-draft-");
      if (!resolved.startsWith(validPrefix)) {
        return { success: false, error: "Invalid temp path" };
      }
      try {
        fs.unlinkSync(resolved);
      } catch {
        // Already gone — fine.
      }
      return { success: true };
    });

    ipcMain.handle("transcribe-local-whisper", async (_event, audioBlob, options = {}) => {
      debugLogger.log("transcribe-local-whisper called", {
        audioBlobType: typeof audioBlob,
        audioBlobSize: audioBlob?.byteLength || audioBlob?.length || 0,
        options,
      });

      try {
        // skipVad: dictionary-echo rescue retries decode VAD-free, since VAD
        // stripping the speech is what turned the transcript into prompt echo.
        const { skipVad, ...requestOptions } = options;
        const vadOptions = skipVad
          ? { vadEnabled: false }
          : this._resolveWhisperVadOptions("noteRecording");
        const result = await this.whisperManager.transcribeLocalWhisper(audioBlob, {
          ...requestOptions,
          ...vadOptions,
        });

        debugLogger.log("Whisper result", {
          success: result.success,
          hasText: !!result.text,
          message: result.message,
          error: result.error,
        });

        return result;
      } catch (error) {
        debugLogger.error("Local Whisper transcription error", error);
        const errorMessage = error.message || "Unknown error";

        // Return specific error types for better user feedback
        if (errorMessage.includes("FFmpeg not found")) {
          return {
            success: false,
            error: "ffmpeg_not_found",
            message: "FFmpeg is missing. Please reinstall the app or install FFmpeg manually.",
          };
        }
        if (
          errorMessage.includes("FFmpeg conversion failed") ||
          errorMessage.includes("FFmpeg process error")
        ) {
          return {
            success: false,
            error: "ffmpeg_error",
            message: "Audio conversion failed. The recording may be corrupted.",
          };
        }
        if (
          errorMessage.includes("whisper.cpp not found") ||
          errorMessage.includes("whisper-cpp")
        ) {
          return {
            success: false,
            error: "whisper_not_found",
            message: "Whisper binary is missing. Please reinstall the app.",
          };
        }
        if (
          errorMessage.includes("Audio buffer is empty") ||
          errorMessage.includes("Audio data too small")
        ) {
          return {
            success: false,
            error: "no_audio_data",
            message: "No audio detected",
          };
        }
        if (errorMessage.includes("model") && errorMessage.includes("not downloaded")) {
          return {
            success: false,
            error: "model_not_found",
            message: errorMessage,
          };
        }

        throw error;
      }
    });

    ipcMain.handle("check-whisper-installation", async (event) => {
      return this.whisperManager.checkWhisperInstallation();
    });

    ipcMain.handle("get-audio-diagnostics", async () => {
      return this.whisperManager.getDiagnostics();
    });

    ipcMain.handle("download-whisper-model", async (event, modelName) => {
      const hadActiveDownload = this.localModelDownloadStatus.has("whisper", modelName);
      this.localModelDownloadStatus.start("whisper", modelName);
      try {
        const result = await this.whisperManager.downloadWhisperModel(modelName, (progressData) => {
          const status = this._updateNativeModelDownloadStatus("whisper", modelName, progressData);
          this.windowManager.sendToControlPanel("whisper-download-progress", {
            ...progressData,
            sequence: status?.sequence,
          });
        });
        const status = this.localModelDownloadStatus.has("whisper", modelName)
          ? this.localModelDownloadStatus.finish("whisper", modelName)
          : null;
        if (status) {
          this.windowManager.sendToControlPanel("whisper-download-progress", {
            type: "complete",
            model: modelName,
            percentage: 100,
            sequence: status.sequence,
          });
        }
        return result;
      } catch (error) {
        const status = hadActiveDownload
          ? null
          : this.localModelDownloadStatus.finish("whisper", modelName);
        if (!hadActiveDownload && error.code !== "DOWNLOAD_IN_PROGRESS") {
          this.windowManager.sendToControlPanel("whisper-download-progress", {
            type: "error",
            model: modelName,
            error: error.message,
            code: error.code || "DOWNLOAD_FAILED",
            sequence: status?.sequence,
          });
        }
        return {
          success: false,
          error: error.message,
          code: error.code || "DOWNLOAD_FAILED",
        };
      }
    });

    ipcMain.handle("check-model-status", async (event, modelName) => {
      return this.whisperManager.checkModelStatus(modelName);
    });

    ipcMain.handle("list-whisper-models", async (event) => {
      return this.whisperManager.listWhisperModels();
    });

    ipcMain.handle("delete-whisper-model", async (event, modelName) => {
      return this.whisperManager.deleteWhisperModel(modelName);
    });

    ipcMain.handle("delete-all-whisper-models", async () => {
      return this.whisperManager.deleteAllWhisperModels();
    });

    ipcMain.handle("cancel-whisper-download", async (event) => {
      return this.whisperManager.cancelDownload();
    });

    ipcMain.handle("whisper-server-start", async (event, modelName) => {
      return this.whisperManager.startServer(modelName);
    });

    ipcMain.handle("whisper-server-stop", async () => {
      return this.whisperManager.stopServer();
    });

    ipcMain.handle("whisper-server-status", async () => {
      return this.whisperManager.getServerStatus();
    });

    ipcMain.handle("check-ffmpeg-availability", async (event) => {
      return this.whisperManager.checkFFmpegAvailability();
    });

    ipcMain.handle("transcribe-local-parakeet", async (_event, audioBlob, options = {}) => {
      debugLogger.log("transcribe-local-parakeet called", {
        audioBlobType: typeof audioBlob,
        audioBlobSize: audioBlob?.byteLength || audioBlob?.length || 0,
        options,
      });

      try {
        const result = await this.parakeetManager.transcribeLocalParakeet(audioBlob, options);

        debugLogger.log("Parakeet result", {
          success: result.success,
          hasText: !!result.text,
          message: result.message,
          error: result.error,
        });

        return result;
      } catch (error) {
        debugLogger.error("Local Parakeet transcription error", error);
        const errorMessage = error.message || "Unknown error";

        if (errorMessage.includes("sherpa-onnx") && errorMessage.includes("not found")) {
          return {
            success: false,
            error: "parakeet_not_found",
            message: "Parakeet binary is missing. Please reinstall the app.",
          };
        }
        if (errorMessage.includes("model") && errorMessage.includes("not downloaded")) {
          return {
            success: false,
            error: "model_not_found",
            message: errorMessage,
          };
        }
        if (error.code === PARAKEET_UNSUPPORTED_OS_CODE) {
          return {
            success: false,
            error: error.code,
            message: errorMessage,
          };
        }

        throw error;
      }
    });

    ipcMain.handle("check-parakeet-installation", async () => {
      return this.parakeetManager.checkInstallation();
    });

    ipcMain.handle("download-parakeet-model", async (event, modelName) => {
      const hadActiveDownload = this.localModelDownloadStatus.has("parakeet", modelName);
      this.localModelDownloadStatus.start("parakeet", modelName);
      try {
        const result = await this.parakeetManager.downloadParakeetModel(
          modelName,
          (progressData) => {
            const status = this._updateNativeModelDownloadStatus(
              "parakeet",
              modelName,
              progressData
            );
            this.windowManager.sendToControlPanel("parakeet-download-progress", {
              ...progressData,
              sequence: status?.sequence,
            });
          }
        );
        const status = this.localModelDownloadStatus.has("parakeet", modelName)
          ? this.localModelDownloadStatus.finish("parakeet", modelName)
          : null;
        if (status) {
          this.windowManager.sendToControlPanel("parakeet-download-progress", {
            type: "complete",
            model: modelName,
            percentage: 100,
            sequence: status.sequence,
          });
        }
        return result;
      } catch (error) {
        const status = hadActiveDownload
          ? null
          : this.localModelDownloadStatus.finish("parakeet", modelName);
        if (!hadActiveDownload && error.code !== "DOWNLOAD_IN_PROGRESS") {
          this.windowManager.sendToControlPanel("parakeet-download-progress", {
            type: "error",
            model: modelName,
            error: error.message,
            code: error.code || "DOWNLOAD_FAILED",
            sequence: status?.sequence,
          });
        }
        return {
          success: false,
          error: error.message,
          code: error.code || "DOWNLOAD_FAILED",
        };
      }
    });

    ipcMain.handle("check-parakeet-model-status", async (_event, modelName) => {
      return this.parakeetManager.checkModelStatus(modelName);
    });

    ipcMain.handle("list-parakeet-models", async () => {
      return this.parakeetManager.listParakeetModels();
    });

    ipcMain.handle("delete-parakeet-model", async (_event, modelName) => {
      return this.parakeetManager.deleteParakeetModel(modelName);
    });

    ipcMain.handle("delete-all-parakeet-models", async () => {
      return this.parakeetManager.deleteAllParakeetModels();
    });

    ipcMain.handle("cancel-parakeet-download", async () => {
      return this.parakeetManager.cancelDownload();
    });

    ipcMain.handle("get-parakeet-diagnostics", async () => {
      return this.parakeetManager.getDiagnostics();
    });

    ipcMain.handle("parakeet-server-start", async (event, modelName) => {
      const result = await this.parakeetManager.startServer(modelName);
      // Persisting a provider that failed to start would wedge every launch
      // into a failing pre-warm.
      if (result.success) {
        process.env.LOCAL_TRANSCRIPTION_PROVIDER =
          getModelType(modelName) === "cohere-transcribe" ? "cohere" : "nvidia";
        process.env.PARAKEET_MODEL = modelName;
        await this.environmentManager.saveAllKeysToEnvFile();
      }
      return result;
    });

    ipcMain.handle("parakeet-server-stop", async () => {
      const result = await this.parakeetManager.stopServer();
      delete process.env.LOCAL_TRANSCRIPTION_PROVIDER;
      delete process.env.PARAKEET_MODEL;
      await this.environmentManager.saveAllKeysToEnvFile();
      return result;
    });

    ipcMain.handle("parakeet-server-status", async () => {
      return this.parakeetManager.getServerStatus();
    });

    // Diarization model management
    ipcMain.handle("download-diarization-models", async (event) => {
      try {
        const result = await this.diarizationManager.downloadModels((progressData) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send("diarization-download-progress", progressData);
          }
        });
        return result;
      } catch (error) {
        if (!event.sender.isDestroyed()) {
          event.sender.send("diarization-download-progress", {
            type: "error",
            error: error.message,
            code: error.code || "DOWNLOAD_FAILED",
          });
        }
        return {
          success: false,
          error: error.message,
          code: error.code || "DOWNLOAD_FAILED",
        };
      }
    });

    ipcMain.handle("get-diarization-model-status", async () => {
      return {
        available: this.diarizationManager?.isAvailable() ?? false,
        modelsDownloaded:
          (this.diarizationManager?.isModelDownloaded() ?? false) &&
          (this.diarizationManager?.isVadModelDownloaded() ?? false),
      };
    });

    ipcMain.handle("delete-diarization-models", async () => {
      try {
        await this.diarizationManager.deleteModels();
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to delete diarization models", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("diarize-audio-file", async (event, filePath, options = {}) => {
      // Registered under the same requestId as the upload's transcription, so
      // one cancel kills both the decode and the diarization child process.
      const { signal, release } = this._uploadCancelRegistry.register(options.requestId);
      try {
        if (!this.diarizationManager) {
          return { success: false, error: "Diarization not available" };
        }
        if (!this.diarizationManager.isModelDownloaded()) {
          return { success: false, error: "Diarization models not downloaded" };
        }

        if (typeof filePath !== "string") {
          return { success: false, error: "Invalid file path" };
        }
        const realPath = resolveAllowedAudioPath(filePath);
        if (!realPath) return { success: false, error: "File path not allowed" };
        filePath = realPath;

        const numSpeakers = Math.min(
          MAX_SPEAKER_COUNT,
          Math.max(-1, Math.round(Number(options.numSpeakers) || -1))
        );

        const { convertToWav } = require("./ffmpegUtils");
        const { getSafeTempDir } = require("./safeTempDir");
        const { resolveClusterThreshold, dropNegligibleClusters } = require("./diarizationPolicy");
        const { PCM16_MONO_16K_BYTES_PER_SECOND } = require("./transcriptionTimeout");
        const wavPath = path.join(getSafeTempDir(), `ow-diarize-${Date.now()}.wav`);

        try {
          await convertToWav(filePath, wavPath, { sampleRate: 16000, channels: 1 });
          if (signal?.aborted) {
            return { success: false, error: "Cancelled", code: "UPLOAD_CANCELLED" };
          }
          // Auto-clustering over-splits long single-mic audio at the 0.55
          // default, so the threshold ramps with duration unless pinned.
          const durationSeconds = fs.statSync(wavPath).size / PCM16_MONO_16K_BYTES_PER_SECOND;
          const threshold = resolveClusterThreshold(durationSeconds, options.threshold);

          let segments = await this.diarizationManager.diarize(wavPath, {
            numSpeakers,
            threshold,
            signal,
          });
          if (signal?.aborted) {
            return { success: false, error: "Cancelled", code: "UPLOAD_CANCELLED" };
          }
          // The meeting path caps clusters via its expectation resolver; this
          // path fed raw sherpa output to the merge, which is how a 2-person
          // voice memo surfaced 46 speakers.
          segments = dropNegligibleClusters(segments);
          segments = this.diarizationManager.capSpeakerClusters(
            segments,
            numSpeakers > 0 ? numSpeakers : MAX_SPEAKER_COUNT
          );
          // Callers persist this as audio_duration_seconds: for picked files
          // the renderer has no other duration source.
          return { success: true, segments, durationSeconds };
        } finally {
          try {
            fs.unlinkSync(wavPath);
          } catch {}
        }
      } catch (error) {
        if (error?.name === "AbortError" || signal?.aborted) {
          debugLogger.debug("Diarization cancelled", { requestId: options.requestId });
          return { success: false, error: "Cancelled", code: "UPLOAD_CANCELLED" };
        }
        debugLogger.error("Diarization error", { error: error.message });
        return { success: false, error: error.message };
      } finally {
        release();
      }
    });

    ipcMain.handle("merge-speaker-text", async (event, { segments, text, duration }) => {
      try {
        if (
          !Array.isArray(segments) ||
          typeof text !== "string" ||
          typeof duration !== "number" ||
          !isFinite(duration)
        ) {
          return { success: false, error: "Invalid arguments" };
        }
        if (segments.length > 10000 || text.length > 1_000_000) {
          return { success: false, error: "Input too large" };
        }
        const sanitizedSegments = segments.map((s) => ({
          speaker: typeof s.speaker === "string" ? s.speaker.slice(0, 100) : "unknown",
          start: typeof s.start === "number" && isFinite(s.start) ? s.start : 0,
          end: typeof s.end === "number" && isFinite(s.end) ? s.end : 0,
        }));
        const merged = mergeSpeakersWithText(sanitizedSegments, text, duration);
        return { success: true, text: formatSpeakerTranscript(merged) };
      } catch (error) {
        debugLogger.error("Speaker merge error", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("cancel-diarization-download", async () => {
      return this.diarizationManager.cancelDownload();
    });

    ipcMain.handle("cleanup-app", async (event) => {
      const fs = require("fs");
      const os = require("os");
      const errors = [];
      const mainWindow = this.windowManager.mainWindow;

      // Stop services before deleting files they hold open
      try {
        await this.parakeetManager?.stopServer();
      } catch (e) {
        errors.push(`Parakeet stop: ${e.message}`);
      }
      try {
        this.whisperManager?.stopServer();
      } catch (e) {
        errors.push(`Whisper stop: ${e.message}`);
      }
      try {
        this.googleCalendarManager?.stop();
      } catch (e) {
        errors.push(`GCal stop: ${e.message}`);
      }
      try {
        this.microsoftCalendarManager?.stop();
      } catch (e) {
        errors.push(`MCal stop: ${e.message}`);
      }
      try {
        this.appleCalendarManager?.stop();
      } catch (e) {
        errors.push(`ACal stop: ${e.message}`);
      }
      try {
        await this.diarizationManager?.shutdown();
      } catch (e) {
        errors.push(`Diarization stop: ${e.message}`);
      }
      // Revoke Google OAuth tokens before DB is closed
      try {
        await this.googleCalendarManager?.revokeAllTokens();
      } catch (e) {
        errors.push(`GCal revoke: ${e.message}`);
      }

      // Close DB connection before deleting the file
      try {
        this.databaseManager?.db?.close();
      } catch (e) {
        errors.push(`DB close: ${e.message}`);
      }

      // Delete audio files
      try {
        this.audioStorageManager.deleteAllAudio();
      } catch (e) {
        errors.push(`Audio delete: ${e.message}`);
      }

      // Delete downloaded models
      try {
        const { getModelsDirForService } = require("./modelDirUtils");
        const whisperDir = getModelsDirForService("whisper");
        if (fs.existsSync(whisperDir)) fs.rmSync(whisperDir, { recursive: true, force: true });
      } catch (e) {
        errors.push(`Whisper models: ${e.message}`);
      }
      try {
        await this.parakeetManager?.deleteAllParakeetModels();
      } catch (e) {
        errors.push(`Parakeet models: ${e.message}`);
      }
      try {
        await this.diarizationManager?.deleteModels();
      } catch (e) {
        errors.push(`Diarization models: ${e.message}`);
      }
      try {
        const modelManager = require("./modelManagerBridge").default;
        await modelManager.deleteAllModels();
      } catch (e) {
        errors.push(`LLM models: ${e.message}`);
      }

      // These caches are not owned by one account. Remove them only through
      // the explicit device-erasure path, never during normal account deletion.
      const homeCacheRoot = path.join(os.homedir(), ".cache", "openhercules");
      for (const cacheName of []) {
        try {
          fs.rmSync(path.join(homeCacheRoot, cacheName), { recursive: true, force: true });
        } catch (e) {
          errors.push(`${cacheName} cache: ${e.message}`);
        }
      }

      // Delete database file + WAL/SHM
      try {
        const dbPath = path.join(
          app.getPath("userData"),
          process.env.NODE_ENV === "development" ? "transcriptions-dev.db" : "transcriptions.db"
        );
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
        if (fs.existsSync(dbPath + "-wal")) fs.unlinkSync(dbPath + "-wal");
        if (fs.existsSync(dbPath + "-shm")) fs.unlinkSync(dbPath + "-shm");
      } catch (e) {
        errors.push(`DB file: ${e.message}`);
      }

      // Delete device-wide settings and encrypted credentials.
      try {
        await this.environmentManager?.clearAllPersistedData();
      } catch (e) {
        errors.push(`Environment settings: ${e.message}`);
      }
      try {
        for (const fileName of [
          "globe-preference-state.json",
          ".system-audio-permission",
        ]) {
          fs.rmSync(path.join(app.getPath("userData"), fileName), { force: true });
        }
      } catch (e) {
        errors.push(`Device setting files: ${e.message}`);
      }
      for (const directoryName of ["bin", "llama-cpp"]) {
        try {
          fs.rmSync(path.join(app.getPath("userData"), directoryName), {
            recursive: true,
            force: true,
          });
        } catch (e) {
          errors.push(`${directoryName} runtime: ${e.message}`);
        }
      }
      try {
        autoStart.setAutoStartEnabled(false);
      } catch (e) {
        errors.push(`Launch at login: ${e.message}`);
      }

      // Clear browser-held account/session state, including cookies, IndexedDB,
      // Cache Storage and localStorage persisted by any app window.
      try {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
          await win.webContents.session.clearStorageData();
          await win.webContents.session.clearCache();
        }
      } catch (e) {
        errors.push(`Browser data: ${e.message}`);
      }

      // Clear localStorage
      if (mainWindow?.webContents) {
        try {
          await mainWindow.webContents.executeJavaScript("localStorage.clear()");
        } catch (e) {
          errors.push(`localStorage: ${e.message}`);
        }
      }

      if (errors.length > 0) {
        debugLogger.warn("Cleanup completed with errors", { errors }, "cleanup");
      }

      return { success: errors.length === 0, message: "Cleanup completed", errors };
    });

    ipcMain.handle("set-hotkey-listening-mode", async (_event, enabled) => {
      if (this._hotkeyCaptureMode === enabled) return { success: true, skipped: true };
      this._hotkeyCaptureMode = enabled;
      this.windowManager.setHotkeyListeningMode(enabled);
      ipcMain.emit("hotkey-listening-mode-changed", null, enabled);
      const hotkeyManager = this.windowManager.hotkeyManager;

      if (enabled) {
        // Entering capture mode — unregister ALL slots so none intercept keypresses.
        // Dictation is always active; meeting and agent may or may not be set.
        const allSlots = hotkeyManager.slots;
        for (const [slot, info] of allSlots) {
          // Native-listener entries (null accelerator) are handled by the
          // platform hotkey manager.
          for (const accel of info?.accelerators || []) {
            if (!accel) continue;
            debugLogger.log(
              `[IPC] Unregistering globalShortcut "${accel}" (slot "${slot}") for capture mode`
            );
            const { globalShortcut } = require("electron");
            try {
              globalShortcut.unregister(accel);
            } catch {}
          }
        }

      } else {
        // Exiting capture mode — re-register globalShortcut-backed hotkeys.
        // Re-register non-dictation slots (meeting, agent) that were unregistered on capture enter
        for (const [slot, info] of hotkeyManager.slots) {
          const hotkeys = info?.hotkeys || [];
          if (hotkeys.length === 0 || !info?.callback)
            continue;
          debugLogger.log(
            `[IPC] Re-registering slot "${slot}" ("${hotkeys.join(", ")}") after capture mode`
          );
          await hotkeyManager.registerSlot(slot, hotkeys, info.callback).catch((err) => {
            debugLogger.warn(`[IPC] Failed to re-register slot "${slot}":`, err.message);
          });
        }
      }

      return { success: true };
    });

    ipcMain.handle("get-hotkey-mode-info", async (_event, requestedHotkey) => {
      const hotkeyManager = this.windowManager.hotkeyManager;
      const hotkey =
        typeof requestedHotkey === "string" && requestedHotkey.trim()
          ? requestedHotkey.split(",")[0].trim()
          : hotkeyManager.getCurrentHotkey();
      const isUsingNativeShortcut = this.windowManager.isUsingNativeShortcutHotkeys();
      const supportsPushToTalk = hotkeyManager.supportsPushToTalk(hotkey);

      return {
        isUsingGnome: false,
        isUsingHyprland: false,
        isUsingKDE: false,
        isUsingNativeShortcut,
        supportsPushToTalk,
        pushToTalkUnavailableReason: supportsPushToTalk
          ? null
          : hotkeyManager.getPushToTalkUnavailableReason(hotkey),
      };
    });

    ipcMain.handle("register-cancel-hotkey", async (event, key) => {
      const hotkeyManager = this.windowManager.hotkeyManager;
      const mainWindow = this.windowManager.mainWindow;
      return hotkeyManager.registerSlot("cancel", key, () => {
        mainWindow?.webContents?.send("cancel-hotkey-pressed");
      });
    });

    ipcMain.handle("unregister-cancel-hotkey", async () => {
      this.windowManager.hotkeyManager.unregisterSlot("cancel");
      return { success: true };
    });

    ipcMain.handle("start-control-panel-drag", async () => {
      return await this.windowManager.startControlPanelDrag();
    });

    ipcMain.handle("stop-control-panel-drag", async () => {
      return await this.windowManager.stopControlPanelDrag();
    });

    ipcMain.handle("open-external", async (event, url) => {
      try {
        const { protocol } = new URL(url);
        if (!["http:", "https:", "mailto:"].includes(protocol)) {
          return { success: false, error: `Blocked URL scheme: ${protocol}` };
        }
        await openExternalUrl(url);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-auto-start-enabled", async () => {
      try {
        return autoStart.getAutoStartState();
      } catch (error) {
        debugLogger.error("Error getting auto-start status:", error);
        return { enabled: false, requiresApproval: false };
      }
    });

    ipcMain.handle("set-auto-start-enabled", async (event, enabled) => {
      try {
        autoStart.setAutoStartEnabled(enabled);
        debugLogger.debug("Auto-start setting updated", { enabled });
        return { success: true };
      } catch (error) {
        debugLogger.error("Error setting auto-start:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("model-get-all", async () => {
      try {
        debugLogger.debug("model-get-all called", undefined, "ipc");
        const modelManager = require("./modelManagerBridge").default;
        const models = await modelManager.getModelsWithStatus();
        debugLogger.debug("Returning models", { count: models.length }, "ipc");
        return models;
      } catch (error) {
        debugLogger.error("Error in model-get-all:", error);
        throw error;
      }
    });

    ipcMain.handle("model-get-active-downloads", async () => {
      return this.localModelDownloadStatus.getActiveDownloads();
    });

    ipcMain.handle("model-check", async (_, modelId) => {
      const modelManager = require("./modelManagerBridge").default;
      return modelManager.isModelDownloaded(modelId);
    });

    ipcMain.handle("model-download", async (event, modelId) => {
      if (this.localModelDownloadStatus.has("llm", modelId)) {
        return {
          success: false,
          error: "Model is already being downloaded",
          code: "DOWNLOAD_IN_PROGRESS",
          details: { modelId },
        };
      }
      // Claim ownership before the manager's asynchronous filesystem preflight.
      this.localModelDownloadStatus.start("llm", modelId);
      try {
        const modelManager = require("./modelManagerBridge").default;
        const result = await modelManager.downloadModel(
          modelId,
          (progress, downloadedSize, totalSize) => {
            const status = this.localModelDownloadStatus.update("llm", modelId, {
              phase: "downloading",
              progress,
              downloadedBytes: downloadedSize,
              totalBytes: totalSize,
            });
            this.windowManager.sendToControlPanel("model-download-progress", {
              modelId,
              type: "progress",
              progress,
              downloadedSize,
              totalSize,
              sequence: status.sequence,
            });
          }
        );
        const status = this.localModelDownloadStatus.finish("llm", modelId);
        this.windowManager.sendToControlPanel("model-download-progress", {
          modelId,
          type: "complete",
          progress: 100,
          downloadedSize: status?.downloadedBytes,
          totalSize: status?.totalBytes,
          sequence: status?.sequence,
        });
        return { success: true, path: result };
      } catch (error) {
        const status = this.localModelDownloadStatus.finish("llm", modelId);
        if (error.code !== "DOWNLOAD_IN_PROGRESS") {
          this.windowManager.sendToControlPanel("model-download-progress", {
            modelId,
            type: "error",
            error: error.message,
            code: error.code,
            details: error.details,
            sequence: status?.sequence,
          });
        }
        return {
          success: false,
          error: error.message,
          code: error.code,
          details: error.details,
        };
      }
    });

    ipcMain.handle("model-delete", async (event, modelId) => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        await modelManager.deleteModel(modelId);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          code: error.code,
          details: error.details,
        };
      }
    });

    ipcMain.handle("model-delete-all", async () => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        await modelManager.deleteAllModels();
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          code: error.code,
          details: error.details,
        };
      }
    });

    ipcMain.handle("model-cancel-download", async (event, modelId) => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        const cancelled = modelManager.cancelDownload(modelId);
        return { success: cancelled };
      } catch (error) {
        return {
          success: false,
          error: error.message,
        };
      }
    });

    ipcMain.handle("model-check-runtime", async (event) => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        await modelManager.ensureLlamaCpp();
        return { available: true };
      } catch (error) {
        return {
          available: false,
          error: error.message,
          code: error.code,
          details: error.details,
        };
      }
    });

    ipcMain.handle(
      "proxy-xai-transcription",
      serializeIpcError(async (event, { audioBuffer, language, keyterms }) => {
        const apiKey = this.environmentManager.getXaiKey();
        if (!apiKey) {
          throw new Error("xAI API key not configured");
        }

        const formData = new FormData();
        const audioBlob = new Blob([Buffer.from(audioBuffer)], { type: "audio/webm" });
        formData.append("file", audioBlob, "audio.webm");
        const { XAI_STT_LANGUAGES } = await import("./transcriptionRoute.ts");
        if (language && language !== "auto" && XAI_STT_LANGUAGES.has(language)) {
          formData.append("language", language);
          formData.append("format", "true");
        }
        if (keyterms && keyterms.length > 0) {
          for (const term of keyterms) {
            formData.append("keyterm", term);
          }
        }

        const response = await proxyFetch(XAI_STT_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: formData,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`xAI API Error: ${response.status} ${errorText}`);
        }

        return await response.json();
      })
    );

    ipcMain.handle(
      "proxy-mistral-transcription",
      serializeIpcError(async (event, { audioBuffer, model, language, contextBias }) => {
        const apiKey = this.environmentManager.getMistralKey();
        if (!apiKey) {
          throw new Error("Mistral API key not configured");
        }

        const formData = new FormData();
        const audioBlob = new Blob([Buffer.from(audioBuffer)], { type: "audio/webm" });
        formData.append("file", audioBlob, "audio.webm");
        formData.append("model", model || "voxtral-mini-latest");
        if (language && language !== "auto") {
          formData.append("language", language);
        }
        if (contextBias && contextBias.length > 0) {
          for (const token of contextBias) {
            formData.append("context_bias", token);
          }
        }

        const response = await proxyFetch(MISTRAL_TRANSCRIPTION_URL, {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
          },
          body: formData,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Mistral API Error: ${response.status} ${errorText}`);
        }

        return await response.json();
      })
    );

    ipcMain.handle("get-corti-client-id", async () => {
      return this.environmentManager.getCortiClientId();
    });

    ipcMain.handle("save-corti-client-id", async (event, key) => {
      return this.environmentManager.saveCortiClientId(key);
    });

    ipcMain.handle("get-corti-client-secret", async () => {
      return this.environmentManager.getCortiClientSecret();
    });

    ipcMain.handle("save-corti-client-secret", async (event, key) => {
      return this.environmentManager.saveCortiClientSecret(key);
    });

    ipcMain.handle(
      "proxy-corti-transcription",
      serializeIpcError(async (event, { audioBuffer, language, environment, tenant }) => {
        const clientId = this.environmentManager.getCortiClientId();
        const clientSecret = this.environmentManager.getCortiClientSecret();
        if (!clientId || !clientSecret) {
          throw new Error("Corti credentials not configured");
        }

        const { transcribeAudio } = require("./cortiTranscription");
        return await transcribeAudio({
          environment,
          tenant,
          clientId,
          clientSecret,
          audioBuffer,
          language,
        });
      })
    );

    ipcMain.handle("get-tinfoil-chat-models", async () => {
      return getTinfoilChatModels();
    });

    // Enclave attestation is Node-only, so batch transcription is proxied through main.
    ipcMain.handle(
      "proxy-tinfoil-transcription",
      serializeIpcError(async (event, { audioBuffer, language, prompt }) => {
        return await transcribeWithTinfoil({
          audioBuffer: Buffer.from(audioBuffer),
          fileName: "audio.webm",
          contentType: "audio/webm",
          language,
          prompt,
          apiKey: this.environmentManager.getTinfoilKey(),
        });
      })
    );

    // Gemini's Interactions API takes JSON with inline base64 audio, not
    // OpenAI-compatible multipart, so batch transcription is proxied through main.
    ipcMain.handle(
      "proxy-gemini-transcription",
      serializeIpcError(async (event, { audioBuffer, model, language, keyterms }) => {
        return await transcribeWithGemini({
          audioBuffer: Buffer.from(audioBuffer),
          model,
          contentType: "audio/webm",
          language,
          keyterms,
          apiKey: this.environmentManager.getGeminiKey(),
        });
      })
    );

    ipcMain.handle("get-custom-transcription-key", async () => {
      return this.environmentManager.getCustomTranscriptionKey();
    });

    ipcMain.handle("save-custom-transcription-key", async (event, key) => {
      return this.environmentManager.saveCustomTranscriptionKey(key);
    });

    ipcMain.handle("get-cleanup-custom-key", async () => {
      return this.environmentManager.getCleanupCustomKey();
    });

    ipcMain.handle("save-cleanup-custom-key", async (event, key) => {
      return this.environmentManager.saveCleanupCustomKey(key);
    });

    // Enterprise provider key handlers
    ipcMain.handle("get-bedrock-region", async () => {
      return this.environmentManager.getBedrockRegion();
    });
    ipcMain.handle("save-bedrock-region", async (event, value) => {
      return this.environmentManager.saveBedrockRegion(value);
    });
    ipcMain.handle("get-bedrock-profile", async () => {
      return this.environmentManager.getBedrockProfile();
    });
    ipcMain.handle("save-bedrock-profile", async (event, value) => {
      return this.environmentManager.saveBedrockProfile(value);
    });
    ipcMain.handle("get-bedrock-access-key-id", async () => {
      return this.environmentManager.getBedrockAccessKeyId();
    });
    ipcMain.handle("save-bedrock-access-key-id", async (event, key) => {
      return this.environmentManager.saveBedrockAccessKeyId(key);
    });
    ipcMain.handle("get-bedrock-secret-access-key", async () => {
      return this.environmentManager.getBedrockSecretAccessKey();
    });
    ipcMain.handle("save-bedrock-secret-access-key", async (event, key) => {
      return this.environmentManager.saveBedrockSecretAccessKey(key);
    });
    ipcMain.handle("get-bedrock-session-token", async () => {
      return this.environmentManager.getBedrockSessionToken();
    });
    ipcMain.handle("save-bedrock-session-token", async (event, key) => {
      return this.environmentManager.saveBedrockSessionToken(key);
    });
    ipcMain.handle("get-azure-endpoint", async () => {
      return this.environmentManager.getAzureEndpoint();
    });
    ipcMain.handle("save-azure-endpoint", async (event, value) => {
      return this.environmentManager.saveAzureEndpoint(value);
    });
    ipcMain.handle("get-azure-api-key", async () => {
      return this.environmentManager.getAzureApiKey();
    });
    ipcMain.handle("save-azure-api-key", async (event, key) => {
      return this.environmentManager.saveAzureApiKey(key);
    });
    ipcMain.handle("get-azure-deployment", async () => {
      return this.environmentManager.getAzureDeployment();
    });
    ipcMain.handle("save-azure-deployment", async (event, value) => {
      return this.environmentManager.saveAzureDeployment(value);
    });
    ipcMain.handle("get-azure-api-version", async () => {
      return this.environmentManager.getAzureApiVersion();
    });
    ipcMain.handle("save-azure-api-version", async (event, value) => {
      return this.environmentManager.saveAzureApiVersion(value);
    });
    ipcMain.handle("get-vertex-project", async () => {
      return this.environmentManager.getVertexProject();
    });
    ipcMain.handle("save-vertex-project", async (event, value) => {
      return this.environmentManager.saveVertexProject(value);
    });
    ipcMain.handle("get-vertex-location", async () => {
      return this.environmentManager.getVertexLocation();
    });
    ipcMain.handle("save-vertex-location", async (event, value) => {
      return this.environmentManager.saveVertexLocation(value);
    });
    ipcMain.handle("get-vertex-api-key", async () => {
      return this.environmentManager.getVertexApiKey();
    });
    ipcMain.handle("save-vertex-api-key", async (event, key) => {
      return this.environmentManager.saveVertexApiKey(key);
    });

    // Enterprise provider test connection
    ipcMain.handle("test-enterprise-connection", async (event, provider, config) => {
      const {
        mapEnterpriseError,
        runAbortableOperation,
        runBedrockRequest,
        validateEnterpriseEndpoint,
      } = require("./enterpriseProviderErrors");
      let runtime;
      try {
        const { generateText } = require("ai");
        const { getEnterpriseAIModel } = require("./enterpriseAiProviders");

        const resolveModel = (abortSignal) =>
          runAbortableOperation(async () => {
            runtime = resolveEnterpriseRuntime(provider, config?.model || "test", config);
            abortSignal?.throwIfAborted();
            validateEnterpriseEndpoint(runtime.enterprise.azureEndpoint);
            return getEnterpriseAIModel(
              runtime.provider,
              runtime.model,
              runtime.apiKey,
              runtime.enterprise
            );
          }, abortSignal);

        if (provider === "bedrock") {
          await runBedrockRequest(async () => {
            const abortSignal = AbortSignal.timeout(config?.timeoutMs || 30_000);
            const model = await resolveModel(abortSignal);
            return generateText({
              model,
              prompt: "Say hello in one word.",
              maxOutputTokens: CONNECTION_TEST_MAX_OUTPUT_TOKENS,
              abortSignal,
              maxRetries: 0,
            });
          });
        } else {
          const model = await resolveModel();
          await generateText({
            model,
            prompt: "Say hello in one word.",
            maxOutputTokens: CONNECTION_TEST_MAX_OUTPUT_TOKENS,
          });
        }

        return { success: true };
      } catch (err) {
        const mappingConfig =
          runtime?.provider === "bedrock" && runtime.enterprise?.bedrockRegion
            ? { ...(config || {}), bedrockRegion: runtime.enterprise.bedrockRegion }
            : config;
        const mapped = mapEnterpriseError(provider, err, mappingConfig);
        return {
          success: false,
          error: mapped.message,
          messageKey: mapped.messageKey,
          messageParams: mapped.messageParams,
          action: mapped.action,
          actionKey: mapped.actionKey,
          copyCommand: mapped.copyCommand,
          retryable: mapped.retryable,
          technicalDetails: mapped.technicalDetails,
        };
      }
    });

    ipcMain.handle(
      "process-enterprise-reasoning",
      async (event, text, modelId, _agentName, config) => {
        const {
          isEnterpriseProvider,
          mapEnterpriseError,
          runAbortableOperation,
          runBedrockRequest,
          validateEnterpriseEndpoint,
        } = require("./enterpriseProviderErrors");
        const provider = config?.provider;
        let runtime;
        try {
          if (!isEnterpriseProvider(provider)) {
            throw new Error(`Unsupported enterprise provider: ${provider}`);
          }
          const isBedrockCleanup =
            provider === "bedrock" && config?.inferenceScope === "cleanup";
          const sender = isBedrockCleanup ? event.sender : null;
          const senderId = sender?.id;
          const requestId = isBedrockCleanup ? crypto.randomUUID() : null;
          const controller = isBedrockCleanup
            ? this._enterpriseReasoningRequests.begin(senderId, requestId)
            : null;
          const cancelSenderRequests = () =>
            this._enterpriseReasoningRequests.cancelSender(senderId);
          try {
            if (controller) {
              sender.once("destroyed", cancelSenderRequests);
              if (sender.isDestroyed()) controller.abort();
            }
            controller?.signal.throwIfAborted();

            const { generateText } = require("ai");
            const { getEnterpriseAIModel } = require("./enterpriseAiProviders");
            const timeoutMs = config?.timeoutMs || 60000;
            // Opus 4.7 / GPT-5 / o-series dropped `temperature`; renderer
            // derives support from the model registry and we honor that here.
            const useTemperature = config?.supportsTemperature !== false;
            const resolveModel = (abortSignal) =>
              runAbortableOperation(async () => {
                runtime = resolveEnterpriseRuntime(provider, modelId, config || {});
                abortSignal?.throwIfAborted();
                if (!runtime.model) throw new Error("No model specified for enterprise reasoning");
                validateEnterpriseEndpoint(runtime.enterprise.azureEndpoint);
                return getEnterpriseAIModel(
                  runtime.provider,
                  runtime.model,
                  runtime.apiKey,
                  runtime.enterprise
                );
              }, abortSignal);
            const generate = (model, abortSignal, disableNestedRetries = false) => {
              return generateText({
                model,
                system: config?.systemPrompt || "",
                prompt: text,
                maxOutputTokens: config?.maxTokens || 4096,
                ...(useTemperature ? { temperature: config?.temperature ?? 0.3 } : {}),
                abortSignal,
                ...(disableNestedRetries ? { maxRetries: 0 } : {}),
              });
            };
            let result;
            if (isBedrockCleanup) {
              result = await runBedrockRequest(
                async () => {
                  const abortSignal = AbortSignal.any([
                    controller.signal,
                    AbortSignal.timeout(timeoutMs),
                  ]);
                  const model = await resolveModel(abortSignal);
                  return generate(model, abortSignal, true);
                },
                { signal: controller.signal }
              );
            } else {
              const model = await resolveModel();
              result = await generate(model, AbortSignal.timeout(timeoutMs));
            }
            const { text: generated, finishReason } = result;

            if (
              config?.requireCompleteOutput &&
              ["length", "max-tokens", "max_tokens"].includes(finishReason)
            ) {
              throw new Error("Model output was truncated before the selection edit completed");
            }

            return { success: true, text: (generated || "").trim() };
          } finally {
            if (controller) {
              sender.removeListener("destroyed", cancelSenderRequests);
              this._enterpriseReasoningRequests.complete(senderId, requestId, controller);
            }
          }
        } catch (err) {
          debugLogger.error("Enterprise reasoning error:", err);
          const mappingConfig =
            runtime?.provider === "bedrock" && runtime.enterprise?.bedrockRegion
              ? { ...(config || {}), bedrockRegion: runtime.enterprise.bedrockRegion }
              : config || {};
          const mapped = mapEnterpriseError(provider, err, mappingConfig);
          return {
            success: false,
            error: mapped.message,
            messageKey: mapped.messageKey,
            messageParams: mapped.messageParams,
            action: mapped.action,
            actionKey: mapped.actionKey,
            copyCommand: mapped.copyCommand,
            retryable: mapped.retryable,
            technicalDetails: mapped.technicalDetails,
          };
        }
      }
    );

    ipcMain.on("enterprise-reasoning-cancel", (event) => {
      this._enterpriseReasoningRequests.cancelSender(event.sender.id);
    });

    // Runs doStream for the renderer's enterprise chat model shim; parts are
    // relayed verbatim over enterprise-stream-part, ending with {done}/{error}.
    this.enterpriseStreamAborts = new Map();
    ipcMain.handle("enterprise-stream-start", async (event, payload) => {
      const {
        isEnterpriseProvider,
        mapEnterpriseError,
        validateEnterpriseEndpoint,
      } = require("./enterpriseProviderErrors");
      const { streamId, provider, modelId, config, options } = payload || {};
      let runtime;
      const send = (message) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send("enterprise-stream-part", { streamId, ...message });
        }
      };
      const abortController = new AbortController();
      this.enterpriseStreamAborts.set(streamId, abortController);
      // isDestroyed() stays false across reload/navigation, which wipes the
      // renderer listeners — abort so the provider request isn't billed for
      // a generation nobody receives.
      const abortOnGone = (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) abortController.abort();
      };
      const abortOnDestroyed = () => abortController.abort();
      event.sender.on("did-start-navigation", abortOnGone);
      event.sender.once("destroyed", abortOnDestroyed);
      try {
        if (!streamId || !isEnterpriseProvider(provider)) {
          throw new Error(`Unsupported enterprise provider: ${provider}`);
        }
        runtime = resolveEnterpriseRuntime(provider, modelId, config || {});
        if (!runtime.model) throw new Error("No model specified for enterprise streaming");
        validateEnterpriseEndpoint(runtime.enterprise.azureEndpoint);

        const { getEnterpriseAIModel } = require("./enterpriseAiProviders");
        const model = await getEnterpriseAIModel(
          runtime.provider,
          runtime.model,
          runtime.apiKey,
          runtime.enterprise
        );

        const { stream } = await model.doStream({
          ...options,
          abortSignal: abortController.signal,
        });
        const reader = stream.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (event.sender.isDestroyed()) {
              abortController.abort();
              break;
            }
            send({ part: value });
          }
        } finally {
          reader.releaseLock();
        }
        send({ done: true });
        return { success: true };
      } catch (err) {
        debugLogger.error("Enterprise stream error:", err);
        const mappingConfig =
          runtime?.provider === "bedrock" && runtime.enterprise?.bedrockRegion
            ? { ...(config || {}), bedrockRegion: runtime.enterprise.bedrockRegion }
            : config || {};
        const mapped = mapEnterpriseError(provider, err, mappingConfig);
        send({ error: mapped.message });
        return { success: false, error: mapped.message };
      } finally {
        this.enterpriseStreamAborts.delete(streamId);
        if (!event.sender.isDestroyed()) {
          event.sender.removeListener("did-start-navigation", abortOnGone);
          event.sender.removeListener("destroyed", abortOnDestroyed);
        }
      }
    });

    ipcMain.handle("enterprise-stream-cancel", async (event, streamId) => {
      this.enterpriseStreamAborts.get(streamId)?.abort();
      this.enterpriseStreamAborts.delete(streamId);
    });

    // Lists the text models the account serves in the selected region,
    // resolved to invocable IDs (bare on-demand or geo-scoped profile IDs).
    ipcMain.handle("bedrock-list-models", async (event, config) => {
      const { mapEnterpriseError } = require("./enterpriseProviderErrors");
      try {
        const runtime = resolveEnterpriseRuntime("bedrock", config?.model || "test", config);
        const {
          BedrockClient,
          ListFoundationModelsCommand,
          paginateListInferenceProfiles,
        } = require("@aws-sdk/client-bedrock");
        const { normalizeBedrockCatalog } = require("./bedrockCatalog");

        const region = runtime.enterprise.bedrockRegion || "us-east-1";
        let credentials;
        if (runtime.enterprise.bedrockProfile) {
          const { fromNodeProviderChain } = require("@aws-sdk/credential-providers");
          credentials = fromNodeProviderChain({ profile: runtime.enterprise.bedrockProfile });
        } else if (
          runtime.enterprise.bedrockAccessKeyId &&
          runtime.enterprise.bedrockSecretAccessKey
        ) {
          credentials = {
            accessKeyId: runtime.enterprise.bedrockAccessKeyId,
            secretAccessKey: runtime.enterprise.bedrockSecretAccessKey,
            sessionToken: runtime.enterprise.bedrockSessionToken || undefined,
          };
        }
        const client = new BedrockClient({ region, ...(credentials ? { credentials } : {}) });

        const [foundationModels, profileSummaries] = await Promise.all([
          client.send(new ListFoundationModelsCommand({ byOutputModality: "TEXT" })),
          (async () => {
            const summaries = [];
            const paginator = paginateListInferenceProfiles(
              { client },
              { typeEquals: "SYSTEM_DEFINED" }
            );
            for await (const page of paginator) {
              summaries.push(...(page.inferenceProfileSummaries || []));
            }
            return summaries;
          })(),
        ]);

        return {
          success: true,
          models: normalizeBedrockCatalog(foundationModels.modelSummaries, profileSummaries),
        };
      } catch (err) {
        debugLogger.error("Bedrock model listing error:", err);
        const mapped = mapEnterpriseError("bedrock", err, config || {});
        return { success: false, error: mapped.message };
      }
    });

    ipcMain.handle("get-effective-default-hotkey", async () => {
      return this.windowManager?.hotkeyManager?.getEffectiveDefaultHotkey() ?? null;
    });

    ipcMain.handle("get-activation-mode", async () => {
      return this.environmentManager.getActivationMode();
    });

    ipcMain.handle("save-activation-mode", async (event, mode) => {
      return this.environmentManager.saveActivationMode(mode);
    });

    ipcMain.handle("get-ui-language", async () => {
      return this.environmentManager.getUiLanguage();
    });

    ipcMain.handle("save-ui-language", async (event, language) => {
      return this.environmentManager.saveUiLanguage(language);
    });

    ipcMain.handle("set-ui-language", async (event, language) => {
      const result = this.environmentManager.saveUiLanguage(language);
      process.env.UI_LANGUAGE = result.language;
      changeLanguage(result.language);
      this.windowManager?.refreshLocalizedUi?.();
      this.getTrayManager?.()?.updateTrayMenu?.();
      return { success: true, language: result.language };
    });

    ipcMain.handle("save-all-keys-to-env", async () => {
      return this.environmentManager.saveAllKeysToEnvFile();
    });

    ipcMain.handle("sync-startup-preferences", async (event, prefs) => {
      const setVars = {};
      const clearVars = [];

      if (prefs.useLocalWhisper && prefs.model) {
        // Local mode with model selected - set provider and model for pre-warming
        setVars.LOCAL_TRANSCRIPTION_PROVIDER = prefs.localTranscriptionProvider;
        if (prefs.language) setVars.DICTATION_LANGUAGE = prefs.language;
        if (isSherpaLocalProvider(prefs.localTranscriptionProvider)) {
          setVars.PARAKEET_MODEL = prefs.model;
          clearVars.push("LOCAL_WHISPER_MODEL");
          this.whisperManager.stopServer().catch((err) => {
            debugLogger.error("Failed to stop whisper-server on provider switch", {
              error: err.message,
            });
          });
        } else {
          setVars.LOCAL_WHISPER_MODEL = prefs.model;
          clearVars.push("PARAKEET_MODEL");
          this.parakeetManager.stopServer().catch((err) => {
            debugLogger.error("Failed to stop parakeet-server on provider switch", {
              error: err.message,
            });
          });
        }
      } else if (prefs.useLocalWhisper) {
        // Local mode enabled but no model selected - clear pre-warming vars
        clearVars.push("LOCAL_TRANSCRIPTION_PROVIDER", "PARAKEET_MODEL", "LOCAL_WHISPER_MODEL");
      } else {
        // Direct mode - stop local servers when unused
        clearVars.push("LOCAL_TRANSCRIPTION_PROVIDER", "PARAKEET_MODEL", "LOCAL_WHISPER_MODEL");
        this.whisperManager.stopServer().catch((err) => {
          debugLogger.error("Failed to stop whisper-server after direct-mode switch", {
            error: err.message,
          });
        });
        this.parakeetManager.stopServer().catch((err) => {
          debugLogger.error("Failed to stop parakeet-server on cloud switch", {
            error: err.message,
          });
        });
      }

      const localServer = resolveLocalServerNeeds(prefs);

      if (localServer.cleanup) {
        setVars.CLEANUP_PROVIDER = "local";
        setVars.LOCAL_CLEANUP_MODEL = localServer.cleanup;
      } else {
        clearVars.push("CLEANUP_PROVIDER", "LOCAL_CLEANUP_MODEL");
      }
      // TODO: drop legacy REASONING_PROVIDER / LOCAL_REASONING_MODEL clears once
      // the read fallback is removed (~2 releases after this lands).
      clearVars.push("REASONING_PROVIDER", "LOCAL_REASONING_MODEL");

      // Stop the shared llama-server only when neither scope still needs it, so
      // the active scope keeps its server when the other one switches away.
      if (localServer.stopServer) {
        const modelManager = require("./modelManagerBridge").default;
        modelManager.stopServer().catch((err) => {
          debugLogger.error("Failed to stop llama-server on provider switch", {
            error: err.message,
          });
        });
      }

      this._syncStartupEnv(setVars, clearVars);
    });

    ipcMain.handle("process-local-reasoning", async (event, text, modelId, _agentName, config) => {
      try {
        const LocalReasoningService = require("../services/localReasoningBridge").default;
        const result = await LocalReasoningService.processText(text, modelId, config);
        return { success: true, text: result };
      } catch (error) {
        // code/details carry the machine-readable failure across to the
        // renderer, which owns the translation keys. Flattening to a bare
        // string is how llama.cpp JSON used to reach users (#2142).
        return {
          success: false,
          error: error.message,
          code: error.code,
          details: error.details,
        };
      }
    });

    ipcMain.handle(
      "process-anthropic-reasoning",
      async (event, text, modelId, _agentName, config) => {
        try {
          const apiKey = this.environmentManager.getAnthropicKey();

          if (!apiKey) {
            throw new Error("Anthropic API key not configured");
          }

          const systemPrompt = config?.systemPrompt || "";
          const userPrompt = text;

          if (!modelId) {
            throw new Error("No model specified for Anthropic API call");
          }

          const screenContext = config?.screenContext;
          const userContent = screenContext
            ? [
                { type: "text", text: userPrompt },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: screenContext.mediaType,
                    data: screenContext.data,
                  },
                },
              ]
            : userPrompt;

          // Claude models from Opus 4.7 onward reject `temperature` with a 400;
          // the renderer derives support from the model registry.
          const useTemperature = config?.supportsTemperature === true;
          const requestBody = {
            model: modelId,
            messages: [{ role: "user", content: userContent }],
            system: systemPrompt,
            max_tokens: config?.maxTokens || Math.max(100, Math.min(text.length * 2, 4096)),
            ...(useTemperature ? { temperature: config?.temperature ?? 0.3 } : {}),
          };

          const response = await proxyFetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-API-Key": apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify(requestBody),
          });

          if (!response.ok) {
            const errorText = await response.text();
            let errorData = { error: response.statusText };
            try {
              errorData = JSON.parse(errorText);
            } catch {
              errorData = { error: errorText || response.statusText };
            }
            throw new Error(
              errorData.error?.message ||
                errorData.error ||
                `Anthropic API error: ${response.status}`
            );
          }

          const data = await response.json();
          if (config?.requireCompleteOutput && data.stop_reason === "max_tokens") {
            throw new Error("Model output was truncated before the selection edit completed");
          }
          const outputText = extractAnthropicText(data);
          if (outputText === null) {
            throw new Error(describeMissingAnthropicText(data));
          }
          return { success: true, text: outputText };
        } catch (error) {
          debugLogger.error("Anthropic reasoning error:", error);
          return { success: false, error: error.message };
        }
      }
    );

    ipcMain.handle("check-local-reasoning-available", async () => {
      try {
        const LocalReasoningService = require("../services/localReasoningBridge").default;
        return await LocalReasoningService.isAvailable();
      } catch (error) {
        return false;
      }
    });

    ipcMain.handle("llama-cpp-check", async () => {
      try {
        const llamaCppInstaller = require("./llamaCppInstaller").default;
        const isInstalled = await llamaCppInstaller.isInstalled();
        const version = isInstalled ? await llamaCppInstaller.getVersion() : null;
        return { isInstalled, version };
      } catch (error) {
        return { isInstalled: false, error: error.message };
      }
    });

    ipcMain.handle("llama-cpp-install", async () => {
      try {
        const llamaCppInstaller = require("./llamaCppInstaller").default;
        const result = await llamaCppInstaller.install();
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("llama-cpp-uninstall", async () => {
      try {
        const llamaCppInstaller = require("./llamaCppInstaller").default;
        const result = await llamaCppInstaller.uninstall();
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("llama-server-start", async (event, modelId) => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        modelManager.ensureInitialized();
        const modelInfo = modelManager.findModelById(modelId);
        if (!modelInfo) {
          return { success: false, error: `Model "${modelId}" not found` };
        }

        const modelPath = require("path").join(modelManager.modelsDir, modelInfo.model.fileName);

        await modelManager.serverManager.start(
          modelPath,
          await modelManager.serverStartOptions(modelInfo)
        );
        modelManager.currentServerModelId = modelId;

        this.environmentManager.saveAllKeysToEnvFile().catch(() => {});
        return { success: true, port: modelManager.serverManager.port };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("llama-server-stop", async () => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        await modelManager.stopServer();
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("llama-server-status", async () => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        return modelManager.getServerStatus();
      } catch (error) {
        return { available: false, running: false, error: error.message };
      }
    });

    ipcMain.handle("get-log-level", async () => {
      return debugLogger.getLevel();
    });

    ipcMain.handle("app-log", async (event, entry) => {
      debugLogger.logEntry(entry);
      return { success: true };
    });

    const SYSTEM_SETTINGS_URLS = {
      darwin: {
        microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        sound: "x-apple.systempreferences:com.apple.preference.sound?input",
        accessibility:
          "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        systemAudio:
          "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        screenRecording:
          "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        calendars: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
        loginItems: "x-apple.systempreferences:com.apple.LoginItems-Settings.extension",
      },
    };

    const openSystemSettings = async (settingType) => {
      const platform = process.platform;
      const urls = SYSTEM_SETTINGS_URLS[platform];
      const url = urls?.[settingType];

      if (!url) {
        // macOS is the only supported runtime platform.
        const messages = {
          microphone: i18nMain.t("systemSettings.microphone"),
          sound: i18nMain.t("systemSettings.sound"),
          accessibility: i18nMain.t("systemSettings.accessibility"),
          systemAudio: i18nMain.t("systemSettings.systemAudio"),
          screenRecording: i18nMain.t("systemSettings.screenRecording"),
          loginItems: i18nMain.t("systemSettings.loginItems"),
        };
        return {
          success: false,
          error:
            messages[settingType] || `${settingType} settings are not available on this platform.`,
        };
      }

      try {
        await shell.openExternal(url);
        return { success: true };
      } catch (error) {
        debugLogger.error(`Failed to open ${settingType} settings:`, error);
        return { success: false, error: error.message };
      }
    };

    ipcMain.handle("open-microphone-settings", () => openSystemSettings("microphone"));
    ipcMain.handle("open-sound-input-settings", () => openSystemSettings("sound"));
    ipcMain.handle("get-system-default-microphone", (_event, options = {}) =>
      resolveSystemDefaultMicrophone({ refresh: options?.refresh === true })
    );
    ipcMain.handle("open-accessibility-settings", () => openSystemSettings("accessibility"));
    ipcMain.handle("open-system-audio-settings", () => openSystemSettings("systemAudio"));
    ipcMain.handle("open-screen-recording-settings", () => openSystemSettings("screenRecording"));
    ipcMain.handle("open-login-items-settings", () => openSystemSettings("loginItems"));

    ipcMain.handle("open-calendar-privacy-settings", () => openSystemSettings("calendars"));

    ipcMain.handle("show-emoji-panel", () => {
      try {
        if (app.isEmojiPanelSupported()) {
          app.showEmojiPanel();
          return true;
        }
      } catch (error) {
        debugLogger.error("Failed to show native emoji panel:", error);
      }
      return false;
    });




    ipcMain.handle("request-microphone-access", async () => {
      const granted = await systemPreferences.askForMediaAccess("microphone");
      return { granted };
    });

    ipcMain.handle("check-microphone-access", () => {
      const status = systemPreferences.getMediaAccessStatus("microphone");
      return { granted: status === "granted", status };
    });

    const buildSystemAudioAccess = (partial = {}) => ({
      granted: false,
      status: "unsupported",
      mode: "unsupported",
      supportsPersistentGrant: false,
      supportsPersistentPortalGrant: false,
      supportsNativeCapture: false,
      supportsOnboardingGrant: false,
      requiresRuntimeSharePrompt: false,
      strategy: "unsupported",
      restoreTokenAvailable: false,
      portalVersion: null,
      ...partial,
    });

    const getSystemAudioAccess = async () => {
      if (!this.audioTapManager?.isSupported()) {
        return buildSystemAudioAccess();
      }

      const result = this.audioTapManager.checkAccess();
      return buildSystemAudioAccess({
        granted: result.granted,
        status: result.status,
        mode: "native",
        strategy: "native",
      });
    };

    ipcMain.handle("check-system-audio-access", () => getSystemAudioAccess());

    ipcMain.handle("request-system-audio-access", async () => {
      if (!this.audioTapManager?.isSupported()) {
        return buildSystemAudioAccess();
      }

      try {
        const result = await this.audioTapManager.requestAccess();
        if (result.granted) {
          return buildSystemAudioAccess({
            granted: true,
            status: "granted",
            mode: "native",
            strategy: "native",
          });
        }
      } catch {
        // Falls through to opening System Settings
      }

      await openSystemSettings("systemAudio");
      const status = this.audioTapManager.getPermissionStatus();
      return buildSystemAudioAccess({
        granted: false,
        status,
        mode: "native",
        strategy: "native",
      });
    });

    ipcMain.handle("retry-transcription", async (event, id, settings) => {
      const buffer = this.audioStorageManager.getAudioBuffer(id);
      if (!buffer) return { success: false, error: "Audio file not found" };
      try {
        let result;
        const preferredLanguage = settings?.preferredLanguage;
        const language =
          preferredLanguage && preferredLanguage !== "auto"
            ? preferredLanguage.split("-")[0]
            : undefined;
        const { resolveTranscriptionRoute } = await import("./transcriptionRoute.ts");
        // Renderer pre-flight owns policy; retry re-routes stored audio through
        // whatever is selected NOW.
        const route = resolveTranscriptionRoute({
          settings: settings || {},
          providers: transcriptionProviderBaseUrls(),
          request: { effectiveLanguage: language },
        });

        // A misconfigured direct route fails closed.
        if (route.transport === "error") {
          const err = new Error(route.message);
          if (route.code) err.code = route.code;
          if (route.messageKey) err.messageKey = route.messageKey;
          throw err;
        }

        if (route.transport === "proxied" && route.provider === "tinfoil") {
          // Attested transport, so this can't reuse the generic fetch below.
          const { text, model } = await transcribeWithTinfoil({
            audioBuffer: buffer,
            fileName: "audio.webm",
            contentType: "audio/webm",
            language: route.language,
            apiKey: this.environmentManager.getTinfoilKey(),
          });
          if (text) result = { text, source: "tinfoil", model };
        } else if (route.transport === "proxied" && route.provider === "corti") {
          // Corti uses OAuth + an interaction-based REST flow, so it can't use
          // the generic fetch below.
          const clientId = this.environmentManager.getCortiClientId();
          const clientSecret = this.environmentManager.getCortiClientSecret();
          if (!clientId || !clientSecret) {
            throw new Error("Corti credentials not configured. Add them in Settings.");
          }
          const { transcribeAudio } = require("./cortiTranscription");
          const { text } = await transcribeAudio({
            environment: route.cortiEnvironment,
            tenant: route.cortiTenant,
            clientId,
            clientSecret,
            audioBuffer: buffer,
            language: route.language,
          });
          if (text) result = { text, source: "corti", model: route.model };
        } else if (route.transport === "proxied" && route.provider === "gemini") {
          if (route.sizeCapBytes && buffer.byteLength > route.sizeCapBytes) {
            throw new Error(byokSizeCapError(route.sizeCapBytes));
          }
          const { text } = await transcribeWithGemini({
            audioBuffer: buffer,
            model: route.model,
            contentType: "audio/webm",
            language: route.language,
            apiKey: this.environmentManager.getGeminiKey(),
          });
          if (text) result = { text, source: "gemini", model: route.model };
        } else {
          // mistral/xai have no OpenAI-compatible endpoint — main talks to them
          // directly; everything else consumes the route endpoint as-is.
          const provider = route.provider;
          const endpoint =
            provider === "mistral"
              ? MISTRAL_TRANSCRIPTION_URL
              : provider === "xai"
                ? XAI_STT_URL
                : route.endpoint;
          const apiKey =
            provider === "mistral"
              ? this.environmentManager.getMistralKey()
              : provider === "xai"
                ? this.environmentManager.getXaiKey()
                : route.auth.keyRef === "custom"
                  ? this.environmentManager.getCustomTranscriptionKey()
                  : route.auth.keyRef === "groq"
                    ? this.environmentManager.getGroqKey()
                    : this.environmentManager.getOpenAIKey();
          if (!apiKey && provider !== "custom") {
            throw new Error(`${provider} API key not configured`);
          }

          const formData = new FormData();
          formData.append("file", new Blob([buffer], { type: "audio/webm" }), "audio.webm");
          if (provider === "xai") {
            // xAI STT does not accept a model field; the route pre-filters language
            if (route.language) {
              formData.append("language", route.language);
              formData.append("format", "true");
            }
          } else {
            formData.append("model", route.model);
            if (route.language) formData.append("language", route.language);
          }
          const headers = {};
          if (provider === "mistral") {
            headers["x-api-key"] = apiKey;
          } else if (apiKey) {
            if (route.transport === "http-batch" && route.auth.scheme === "azure-api-key") {
              headers["api-key"] = apiKey;
            } else {
              headers.Authorization = `Bearer ${apiKey}`;
            }
          }

          const response = await proxyFetch(endpoint, { method: "POST", headers, body: formData });
          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`${provider} API Error: ${response.status} ${errorText}`);
          }
          const data = await response.json();
          if (data?.text) {
            result = { text: data.text, source: provider, model: route.model };
          }
        }

        if (!result?.text) {
          return { success: false, error: "No transcription engine available" };
        }

        this.databaseManager.updateTranscriptionText(id, result.text, result.text);
        this.databaseManager.updateTranscriptionStatus(id, "completed");
        const providerName = result.source || "local";
        const modelName = result.model || null;
        const existingRow = this.databaseManager.getTranscriptionById(id);
        this.databaseManager.updateTranscriptionAudio(id, {
          hasAudio: 1,
          audioDurationMs: existingRow?.audio_duration_ms ?? null,
          provider: providerName,
          model: modelName,
        });
        const updated = this.databaseManager.getTranscriptionById(id);
        if (updated) {
          setImmediate(() => {
            broadcastToWindows("transcription-updated", updated);
            // A row that just reached "completed" is newly eligible.
          });
        }
        return { success: true, transcription: updated };
      } catch (error) {
        debugLogger.error(
          "Retry transcription failed",
          { id, error: error.message, code: error.code },
          "audio-storage"
        );
        if (error.code) {
          return { success: false, error: error.message, code: error.code, ...error };
        }
        return { success: false, error: error.message };
      }
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

    ipcMain.handle("update-transcription-text", async (_event, id, text, rawText) => {
      try {
        this.databaseManager.updateTranscriptionText(id, text, rawText);
        const updated = this.databaseManager.getTranscriptionById(id);
        return { success: true, transcription: updated };
      } catch (error) {
        debugLogger.error(
          "Failed to update transcription text",
          { id, error: error.message },
          "audio-storage"
        );
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("agent-open-note", async (_event, noteId) => {
      try {
        const note = this.databaseManager.getNote(noteId);
        await this.windowManager.queueNoteNavigation({
          noteId,
          folderId: note?.folder_id ?? null,
        });
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to open note from agent:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle(
      "transcribe-audio-file-byok",
      async (
        event,
        {
          filePath,
          apiKey,
          baseUrl,
          model,
          diarize,
          timestamps,
          provider,
          language,
          environment,
          tenant,
          transcriptionMode,
          remoteTranscriptionUrl,
          remoteTranscriptionModel,
        }
      ) => {
        const fs = require("fs");
        try {
          if (typeof filePath !== "string") {
            return { success: false, error: "Invalid file path" };
          }
          const realByok = resolveAllowedAudioPath(filePath);
          if (!realByok) return { success: false, error: "File path not allowed" };

          const { resolveTranscriptionRoute } = await import("./transcriptionRoute.ts");
          const route = resolveTranscriptionRoute({
            settings: {
              transcriptionMode,
              remoteTranscriptionUrl,
              remoteTranscriptionModel,
              cloudTranscriptionProvider: provider,
              cloudTranscriptionModel: model,
              cloudTranscriptionBaseUrl: baseUrl,
              cortiEnvironment: environment,
              cortiTenant: tenant,
            },
            providers: transcriptionProviderBaseUrls(),
            request: { effectiveLanguage: language || undefined },
          });

          // Fail closed: a misconfigured route must never fall through to a default.
          if (route.transport === "error") {
            return {
              success: false,
              error: route.message,
              code: route.code,
              messageKey: route.messageKey,
            };
          }

          if (route.transport === "http-batch" && route.provider === "self-hosted") {
            // User's own server, so the 25 MB third-party cap does not apply.
            const ext = path.extname(realByok).toLowerCase().replace(".", "");
            const { body, boundary } = buildMultipartBody(
              fs.readFileSync(realByok),
              path.basename(realByok),
              AUDIO_MIME_TYPES[ext] || "audio/mpeg",
              { model: route.model, language: route.language }
            );
            const data = await postMultipart(new URL(route.endpoint), body, boundary);
            if (data.statusCode !== 200) {
              throw new Error(
                data.data?.error?.message ||
                  data.data?.error ||
                  `Self-hosted API Error: ${data.statusCode}`
              );
            }
            return { success: true, text: data.data.text };
          }

          const fileSize = fs.statSync(realByok).size;
          if (route.sizeCapBytes && fileSize > route.sizeCapBytes) {
            return { success: false, error: byokSizeCapError(route.sizeCapBytes) };
          }

          if (route.transport === "proxied" && route.provider === "corti") {
            const clientId = this.environmentManager.getCortiClientId();
            const clientSecret = this.environmentManager.getCortiClientSecret();
            if (!clientId || !clientSecret) {
              throw new Error("Corti credentials not configured. Add them in Settings.");
            }
            const { transcribeAudio } = require("./cortiTranscription");
            const { text } = await transcribeAudio({
              environment: route.cortiEnvironment,
              tenant: route.cortiTenant,
              clientId,
              clientSecret,
              audioBuffer: fs.readFileSync(realByok),
              language: route.language,
            });
            return { success: true, text };
          }

          if (route.transport === "proxied" && route.provider === "tinfoil") {
            const ext = path.extname(realByok).toLowerCase().replace(".", "");
            const { text } = await transcribeWithTinfoil({
              audioBuffer: fs.readFileSync(realByok),
              fileName: path.basename(realByok),
              contentType: AUDIO_MIME_TYPES[ext] || "audio/mpeg",
              language: route.language,
              apiKey: this.environmentManager.getTinfoilKey(),
            });
            return { success: true, text };
          }

          if (route.transport === "proxied" && route.provider === "gemini") {
            const ext = path.extname(realByok).toLowerCase().replace(".", "");
            // Deliberately no language hint — same rationale as the multipart
            // branch below, and Gemini's language_codes is a hard constraint.
            const { text } = await transcribeWithGemini({
              audioBuffer: fs.readFileSync(realByok),
              model: route.model,
              contentType: AUDIO_MIME_TYPES[ext] || "audio/mpeg",
              apiKey: apiKey || this.environmentManager.getGeminiKey(),
            });
            return { success: true, text };
          }

          if (!apiKey && route.provider !== "custom") {
            throw new Error("No API key configured. Add your key in Settings.");
          }

          const audioBuffer = fs.readFileSync(realByok);
          const ext = path.extname(realByok).toLowerCase().replace(".", "");
          const contentType = AUDIO_MIME_TYPES[ext] || "audio/mpeg";
          const fileName = path.basename(realByok);

          // mistral/xai have no OpenAI-compatible endpoint — talk to them
          // directly; everything else consumes the route endpoint as-is.
          let transcriptionUrl;
          const multipartFields = {};
          if (route.provider === "xai") {
            transcriptionUrl = XAI_STT_URL;
            // xAI STT accepts no model field; the route pre-filters language
            if (route.language) {
              multipartFields.language = route.language;
              multipartFields.format = "true";
            }
          } else {
            transcriptionUrl =
              route.provider === "mistral" ? MISTRAL_TRANSCRIPTION_URL : route.endpoint;
            multipartFields.model = route.model;
            // No language field: an uploaded file may use a different language
            // language, and a wrong hint silently mistranscribes it. Providers
            // that require one (Corti) are handled on their own branch above.
          }

          if (diarize) {
            // A Custom endpoint may front OpenAI or Mistral, so fall back to the
            // resolved host before giving up on speaker labels.
            const diarizeTarget =
              route.provider === "custom" ? diarizationHost(route.endpoint) : route.provider;
            if (diarizeTarget === "mistral") {
              multipartFields.diarize = "true";
              multipartFields.timestamp_granularities = "segment";
            } else if (diarizeTarget === "openai") {
              multipartFields.model = "gpt-4o-transcribe-diarize";
              // Speaker annotations require diarized_json; verbose_json is not supported by this model.
              multipartFields.response_format = "diarized_json";
              multipartFields.chunking_strategy = "auto";
            } else {
              // Degrade to a plain transcript, never fail the upload.
              debugLogger.warn(
                "BYOK diarization requested but provider is not OpenAI/Mistral; transcribing without speakers",
                { provider: route.provider, endpoint: route.endpoint }
              );
            }
          } else if (timestamps) {
            // Providers/models that don't support the request keep the
            // plain-text request untouched (helper returns null).
            const fields = timestampRequestFields(route.provider, route.model);
            if (fields) Object.assign(multipartFields, fields);
          }

          const { body, boundary } = buildMultipartBody(
            audioBuffer,
            fileName,
            contentType,
            multipartFields
          );

          const url = new URL(transcriptionUrl);
          // Mistral authenticates with x-api-key, not Bearer.
          const headers = apiKey
            ? route.provider === "mistral"
              ? { "x-api-key": apiKey }
              : route.transport === "http-batch" && route.auth.scheme === "azure-api-key"
                ? { "api-key": apiKey }
                : { Authorization: `Bearer ${apiKey}` }
            : undefined;
          const data = await postMultipart(url, body, boundary, headers);

          if (data.statusCode === 401) {
            return { success: false, error: "Invalid API key. Check your key in Settings." };
          }
          if (data.statusCode === 429) {
            return { success: false, error: "Rate limit exceeded. Please try again later." };
          }
          if (data.statusCode !== 200) {
            throw new Error(
              data.data?.error?.message || data.data?.error || `API error: ${data.statusCode}`
            );
          }

          if (diarize && data.data?.speakers) {
            const segments = (data.data.speakers || []).map((s) => ({
              speaker: s.id || `Speaker ${s.speaker || "?"}`,
              text: s.text || "",
              start: s.start || 0,
              end: s.end || 0,
            }));
            const formatted = segments
              .map(
                (s) =>
                  `[${s.speaker}] ${formatDiarTime(s.start)} - ${formatDiarTime(s.end)}\n${s.text}`
              )
              .join("\n\n");
            return { success: true, text: formatted, diarized: true, segments };
          }

          if (diarize && data.data?.segments) {
            const segments = (data.data.segments || []).map((s) => ({
              speaker: s.speaker || "Speaker ?",
              text: s.text || "",
              start: s.start || 0,
              end: s.end || 0,
            }));
            const formatted = segments
              .map(
                (s) =>
                  `[${s.speaker}] ${formatDiarTime(s.start)} - ${formatDiarTime(s.end)}\n${s.text}`
              )
              .join("\n\n");
            return { success: true, text: formatted, diarized: true, segments };
          }

          if (diarize) {
            debugLogger.warn("BYOK diarization requested but provider returned no speaker data");
          }
          const segments = timestamps ? mapVerboseSegments(data.data) : null;
          return { success: true, text: data.data.text, ...(segments ? { segments } : {}) };
        } catch (error) {
          debugLogger.error("BYOK audio file transcription error", { error: error.message });
          return {
            success: false,
            error: error.message,
            code: error.code,
            messageKey: error.messageKey,
          };
        }
      }
    );

    ipcMain.handle("get-model-cache-root", () => {
      const { getCacheRoot } = require("./modelDirUtils");
      return getCacheRoot();
    });

    ipcMain.handle("open-whisper-models-folder", async () => {
      try {
        const { getCacheRoot } = require("./modelDirUtils");
        const cacheRoot = getCacheRoot();
        await fs.promises.mkdir(cacheRoot, { recursive: true });
        const errMsg = await shell.openPath(cacheRoot);
        if (errMsg) return { success: false, error: errMsg };
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to open model cache folder:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-debug-state", async () => {
      try {
        return {
          enabled: debugLogger.isEnabled(),
          logPath: debugLogger.getLogPath(),
          logLevel: debugLogger.getLevel(),
        };
      } catch (error) {
        debugLogger.error("Failed to get debug state:", error);
        return { enabled: false, logPath: null, logLevel: "info" };
      }
    });

    ipcMain.handle("set-debug-logging", async (event, enabled) => {
      try {
        const path = require("path");
        const fs = require("fs");
        const envPath = path.join(app.getPath("userData"), ".env");

        // Read current .env content
        let envContent = "";
        if (fs.existsSync(envPath)) {
          envContent = fs.readFileSync(envPath, "utf8");
        }

        // Parse lines
        const lines = envContent.split("\n");
        const logLevelIndex = lines.findIndex((line) =>
          line.trim().startsWith("OPENHERCULES_LOG_LEVEL=")
        );

        if (enabled) {
          // Set to debug
          if (logLevelIndex !== -1) {
            lines[logLevelIndex] = "OPENHERCULES_LOG_LEVEL=debug";
          } else {
            // Add new line
            if (lines.length > 0 && lines[lines.length - 1] !== "") {
              lines.push("");
            }
            lines.push("# Debug logging setting");
            lines.push("OPENHERCULES_LOG_LEVEL=debug");
          }
        } else {
          // Remove or set to info
          if (logLevelIndex !== -1) {
            lines[logLevelIndex] = "OPENHERCULES_LOG_LEVEL=info";
          }
        }

        // Write back
        fs.writeFileSync(envPath, lines.join("\n"), "utf8");

        // Update environment variable
        process.env.OPENHERCULES_LOG_LEVEL = enabled ? "debug" : "info";

        // Refresh logger state
        debugLogger.refreshLogLevel();

        return {
          success: true,
          enabled: debugLogger.isEnabled(),
          logPath: debugLogger.getLogPath(),
        };
      } catch (error) {
        debugLogger.error("Failed to set debug logging:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("open-logs-folder", async () => {
      try {
        const logsDir = path.join(app.getPath("userData"), "logs");
        await shell.openPath(logsDir);
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to open logs folder:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-oauth-protocol-registered", () => this.oauthProtocolRegistered);

    ipcMain.handle("get-oauth-protocol", () => this.oauthProtocol);

    ipcMain.handle("get-app-version", () => ({ version: app.getVersion() }));

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

    // Google Calendar
    ipcMain.handle("gcal-start-oauth", async () => {
      try {
        return await this.googleCalendarManager.startOAuth();
      } catch (error) {
        debugLogger.error("Google Calendar OAuth failed", { error: error.message }, "calendar");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("gcal-disconnect", async (_event, email) => {
      try {
        this.googleCalendarManager.disconnect(email);
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Google Calendar disconnect failed",
          { error: error.message },
          "calendar"
        );
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("gcal-get-connection-status", async () => {
      try {
        return this.googleCalendarManager.getConnectionStatus();
      } catch (error) {
        return { connected: false, email: null };
      }
    });

    ipcMain.handle("gcal-get-calendars", async () => {
      try {
        return { success: true, calendars: this.googleCalendarManager.getCalendars() };
      } catch (error) {
        return { success: false, calendars: [] };
      }
    });

    ipcMain.handle("gcal-set-calendar-selection", async (_event, calendarId, isSelected) => {
      try {
        await this.googleCalendarManager.setCalendarSelection(calendarId, isSelected);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("gcal-set-primary-only", async (_event, value) => {
      try {
        await this.googleCalendarManager.setPrimaryOnly(value);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("gcal-sync-events", async () => {
      try {
        await this.googleCalendarManager.syncEvents();
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("gcal-get-upcoming-events", async (_event, windowMinutes) => {
      try {
        return {
          success: true,
          events: await this.googleCalendarManager.getUpcomingEvents(windowMinutes),
        };
      } catch (error) {
        return { success: false, events: [] };
      }
    });

    ipcMain.handle("gcal-get-event", async (_event, eventId) => {
      try {
        const event = this.databaseManager.getCalendarEventById(eventId);
        return { success: true, event };
      } catch (error) {
        return { success: false, event: null };
      }
    });

    // Microsoft Calendar
    ipcMain.handle("mcal-start-oauth", async () => {
      try {
        return await this.microsoftCalendarManager.startOAuth();
      } catch (error) {
        debugLogger.error("Microsoft Calendar OAuth failed", { error: error.message }, "calendar");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("mcal-disconnect", async (_event, email) => {
      try {
        this.microsoftCalendarManager.disconnect(email);
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Microsoft Calendar disconnect failed",
          { error: error.message },
          "calendar"
        );
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("mcal-get-connection-status", async () => {
      try {
        return this.microsoftCalendarManager.getConnectionStatus();
      } catch (error) {
        debugLogger.error(
          "Microsoft Calendar connection status failed",
          { error: error.message },
          "calendar"
        );
        return { connected: false, accounts: [] };
      }
    });

    ipcMain.handle("mcal-set-primary-only", async (_event, value) => {
      try {
        await this.microsoftCalendarManager.setPrimaryOnly(value);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    // Apple Calendar (macOS EventKit)
    ipcMain.handle("acal-connect", async () => {
      try {
        return await this.appleCalendarManager.connect();
      } catch (error) {
        debugLogger.error("Apple Calendar connect failed", { error: error.message }, "acal");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("acal-disconnect", async () => {
      try {
        return this.appleCalendarManager.disconnect();
      } catch (error) {
        debugLogger.error("Apple Calendar disconnect failed", { error: error.message }, "acal");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("acal-get-connection-status", async () => {
      try {
        return this.appleCalendarManager.getConnectionStatus();
      } catch (error) {
        debugLogger.error(
          "Apple Calendar connection status failed",
          { error: error.message },
          "acal"
        );
        return { connected: false, sourceNames: [] };
      }
    });

    ipcMain.handle("search-contacts", async (_event, query) => {
      try {
        const contacts = this.databaseManager.searchContacts(query);
        return { success: true, contacts };
      } catch (error) {
        return { success: false, contacts: [] };
      }
    });

    ipcMain.handle("upsert-contact", async (_event, contact) => {
      try {
        this.databaseManager.upsertContacts([contact]);
        return { success: true };
      } catch (error) {
        return { success: false };
      }
    });

    ipcMain.handle("get-md5-hash", (_event, text) => {
      return crypto.createHash("md5").update(text.toLowerCase().trim()).digest("hex");
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

    const NOTIFICATION_PREF_KEYS = new Set([
      "notificationsEnabled",
      "notifyMeetingDetection",
      "notifyCalendarReminders",
    ]);

    ipcMain.handle("sync-notification-preferences", async (_event, prefs) => {
      try {
        if (!prefs || typeof prefs !== "object") {
          return { success: false, error: "Invalid preferences" };
        }
        for (const [k, v] of Object.entries(prefs)) {
          if (NOTIFICATION_PREF_KEYS.has(k)) {
            this.windowManager.notificationPrefs[k] = !!v;
          }
        }
        // Detection only serves the notification, so the toggle also gates the detector.
        const { notificationsEnabled, notifyMeetingDetection } =
          this.windowManager.notificationPrefs;
        this.meetingDetectionEngine?.setPreferences({
          audioDetection: notificationsEnabled && notifyMeetingDetection,
        });
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

    ipcMain.handle("whisper-vad-get-config", async () => {
      try {
        return { success: true, config: this._getWhisperVadSettings() };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("whisper-vad-set-config", async (_event, payload) => {
      try {
        const config = this._setWhisperVadSettings(payload || {});
        return { success: true, config };
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

    ipcMain.handle("get-pending-note-navigation", async () => {
      return this.windowManager?.consumePendingNoteNavigation() ?? null;
    });

    ipcMain.handle("meeting-notification-ready", async (event) => {
      this.windowManager?.showNotificationWindow(event.sender);
    });

    // Note files (markdown mirror) handlers
    ipcMain.handle("note-files-set-enabled", async (_event, enabled, customPath, options) => {
      try {
        this._noteFilesEnabled = !!enabled;
        if (!enabled) return { success: true };
        const basePath = customPath || path.join(app.getPath("userData"), "notes");
        if (options?.skipRebuild) {
          require("./markdownMirror").init(basePath);
        } else {
          this._rebuildMirror(basePath);
        }
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Failed to set note-files enabled",
          { error: error.message },
          "note-files"
        );
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("note-files-set-path", async (_event, newPath) => {
      try {
        if (!this._noteFilesEnabled) return { success: false, error: "Note files not enabled" };
        this._rebuildMirror(newPath);
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to set note-files path", { error: error.message }, "note-files");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("note-files-rebuild", async () => {
      try {
        if (!this._noteFilesEnabled) return { success: false, error: "Note files not enabled" };
        this._rebuildMirror();
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to rebuild note files", { error: error.message }, "note-files");
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("note-files-get-default-path", async () => {
      return path.join(app.getPath("userData"), "notes");
    });

    ipcMain.handle("show-note-file", async (_event, noteId) => {
      try {
        const markdownMirror = require("./markdownMirror");
        const filePath = markdownMirror.getNotePath(noteId);
        if (!filePath) return { success: false };
        shell.showItemInFolder(filePath);
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Failed to show note file",
          { noteId, error: error.message },
          "note-files"
        );
        return { success: false };
      }
    });

    ipcMain.handle("show-folder-in-explorer", async (_event, folderName) => {
      try {
        const markdownMirror = require("./markdownMirror");
        const dirPath = markdownMirror.getFolderPath(folderName);
        if (!dirPath) return { success: false };
        await shell.openPath(dirPath);
        return { success: true };
      } catch (error) {
        debugLogger.error(
          "Failed to show folder",
          { folderName, error: error.message },
          "note-files"
        );
        return { success: false };
      }
    });

    ipcMain.handle("note-files-pick-folder", async () => {
      try {
        const { dialog } = require("electron");
        const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
        if (result.canceled || !result.filePaths.length) {
          return { canceled: true };
        }
        return { canceled: false, path: result.filePaths[0] };
      } catch (error) {
        debugLogger.error("Failed to pick folder", { error: error.message }, "note-files");
        return { canceled: true };
      }
    });

    ipcMain.handle("granola-import-pick-and-preview", async (event) => {
      try {
        const { dialog } = require("electron");
        // Parent the dialog so it opens as a sheet on the settings window —
        // a parentless panel can land invisible on another display/Space.
        const parentWindow = BrowserWindow.fromWebContents(event.sender);
        // Granola chunks large exports into numbered files (…-000.csv, -001, …),
        // so let the user grab the whole set in one pick.
        const dialogOptions = {
          properties: ["openFile", "multiSelections"],
          filters: [{ name: "CSV", extensions: ["csv"] }],
        };
        const result = parentWindow
          ? await dialog.showOpenDialog(parentWindow, dialogOptions)
          : await dialog.showOpenDialog(dialogOptions);
        if (result.canceled || !result.filePaths.length) {
          return { canceled: true };
        }
        const filePaths = [...result.filePaths].sort();
        const MAX_IMPORT_BYTES = 200 * 1024 * 1024;
        const { createGranolaNoteKeyAllocator, parseGranolaCsv } =
          await import("./granolaImport.js");
        const allocateNoteKey = createGranolaNoteKeyAllocator();
        const notes = [];
        const seenSourceFiles = new Set();
        let rowIssueCount = 0;
        for (const filePath of filePaths) {
          if (fs.statSync(filePath).size > MAX_IMPORT_BYTES) {
            return { canceled: false, success: false, error: "FILE_TOO_LARGE" };
          }
          const parsed = parseGranolaCsv(fs.readFileSync(filePath, "utf8"), {
            allocateNoteKey,
          });
          if (!parsed.ok) {
            return { canceled: false, success: false, error: parsed.error.code };
          }
          // File-level warnings (e.g. ignored columns) are expected on every
          // real export; only row-scoped problems belong in the issue count.
          rowIssueCount += parsed.warnings.filter((warning) => warning.row != null).length;
          for (const note of parsed.notes) {
            // Granola's source key is deterministic and local. It is enough
            // to avoid showing the same row twice when a chunked export is
            // selected twice, without consulting a server identity column.
            const sourceFile = typeof note.sourceFile === "string" ? note.sourceFile : null;
            if (!sourceFile || !seenSourceFiles.has(sourceFile)) {
              if (sourceFile) seenSourceFiles.add(sourceFile);
              notes.push(note);
            }
          }
        }
        // The run handler only ever imports what this preview parsed — the
        // renderer never sends a file path across the bridge.
        this._granolaImportPending = { notes };
        return {
          canceled: false,
          success: true,
          fileName: filePaths.map((p) => path.basename(p)).join(", "),
          total: notes.length,
          newCount: notes.length,
          duplicateCount: 0,
          sampleTitles: notes.slice(0, 5).map((n) => n.title),
          rowIssueCount,
        };
      } catch (error) {
        debugLogger.error(
          "Granola import preview failed",
          { error: error.message },
          "granola-import"
        );
        return { canceled: false, success: false, error: "READ_FAILED" };
      }
    });

    ipcMain.handle("granola-import-run", async () => {
      const pending = this._granolaImportPending;
      this._granolaImportPending = null;
      if (!pending) return { success: false, error: "NO_PENDING_IMPORT" };
      try {
        const result = this.databaseManager.importNotes(pending.notes);
        if (result.imported > 0) {
          const importedIds = result.noteIds;
          if (this._noteFilesEnabled) this._rebuildMirror();
        }
        return {
          success: true,
          imported: result.imported,
          skipped: result.skipped,
          errors: result.errors,
        };
      } catch (error) {
        debugLogger.error("Granola import failed", { error: error.message }, "granola-import");
        return { success: false, error: "IMPORT_FAILED" };
      }
    });

    ipcMain.handle("get-speaker-mappings", async (_event, noteId) => {
      return this.databaseManager.getSpeakerMappings(noteId);
    });

    ipcMain.handle(
      "set-speaker-mapping",
      async (_event, noteId, speakerId, displayName, email, profileId) => {
        const embeddings = this.databaseManager.getNoteSpeakerEmbeddings(noteId);
        const noteSpeakerEmbedding = embeddings.find((e) => e.speaker_id === speakerId);
        const liveSpeakerEmbedding = liveSpeakerIdentifier.getSpeakerEmbedding(speakerId);
        const speakerEmbeddingBuffer =
          noteSpeakerEmbedding?.embedding ||
          (liveSpeakerEmbedding ? Buffer.from(liveSpeakerEmbedding.buffer) : null);

        let resolvedProfileId = profileId ?? null;
        if (speakerEmbeddingBuffer) {
          const profile = this.databaseManager.upsertSpeakerProfile(
            displayName,
            email || null,
            speakerEmbeddingBuffer,
            resolvedProfileId
          );
          resolvedProfileId = profile.id;
          this._retroactiveMapping(profile);
        }

        this.databaseManager.setSpeakerMapping(noteId, speakerId, resolvedProfileId, displayName);
        liveSpeakerIdentifier.mapSpeaker(speakerId, resolvedProfileId, displayName, noteId);
        return { success: true, profileId: resolvedProfileId };
      }
    );

    ipcMain.handle("remove-speaker-mapping", async (_event, noteId, speakerId) => {
      this.databaseManager.removeSpeakerMapping(noteId, speakerId);
      return { success: true };
    });

    ipcMain.handle("get-speaker-profiles", async () => {
      return this.databaseManager.getSpeakerProfiles();
    });

    ipcMain.handle("attach-speaker-email", async (_event, profileId, email) => {
      try {
        const profile = this.databaseManager.attachEmailToProfile(profileId, email);
        this._retroactiveMapping(profile);
        return {
          success: true,
          profile: {
            id: profile.id,
            display_name: profile.display_name,
            email: profile.email,
            sample_count: profile.sample_count,
          },
        };
      } catch (error) {
        debugLogger.error(
          "Failed to attach email to speaker profile",
          { error: error.message },
          "speaker"
        );
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("save-note-speaker-embeddings", async (_event, noteId, embeddingsObj) => {
      const buffers = {};
      for (const [speakerId, arr] of Object.entries(embeddingsObj)) {
        buffers[speakerId] = Buffer.from(new Float32Array(arr).buffer);
      }
      this.databaseManager.saveNoteSpeakerEmbeddings(noteId, buffers);
      this._tryAutoLabelOneOnOne(noteId);
      return { success: true };
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
