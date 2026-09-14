const { contextBridge, ipcRenderer, webUtils } = require("electron");
const { createNotesBridge } = require("./src/preload/notesBridge");
const { createVocabularyBridge } = require("./src/preload/vocabularyBridge");
const { createUrlDownloadBridge } = require("./src/preload/urlDownloadBridge");

// BYOK API-key bridges, built once instead of hand-listed per key. Sandboxed
// preloads can't require local modules, so the {base, get, save} tuples are
// inlined here; keep them in sync with the BYOK_API_KEYS manifest in
// src/config/secretKeys.js (the main process derives its plumbing from that).
const BYOK_KEY_BRIDGES = [
  { base: "openai", get: "getOpenAIKey", save: "saveOpenAIKey" },
  { base: "anthropic", get: "getAnthropicKey", save: "saveAnthropicKey" },
  { base: "gemini", get: "getGeminiKey", save: "saveGeminiKey" },
  { base: "groq", get: "getGroqKey", save: "saveGroqKey" },
  { base: "xai", get: "getXaiKey", save: "saveXaiKey" },
  { base: "mistral", get: "getMistralKey", save: "saveMistralKey" },
  { base: "openrouter", get: "getOpenrouterKey", save: "saveOpenrouterKey" },
  { base: "tinfoil", get: "getTinfoilKey", save: "saveTinfoilKey" },
  { base: "corti", get: "getCortiKey", save: "saveCortiKey" },
  { base: "deepgram", get: "getDeepgramKey", save: "saveDeepgramKey" },
  { base: "assemblyai", get: "getAssemblyAIKey", save: "saveAssemblyAIKey" },
  {
    base: "note-formatting-custom",
    get: "getNoteFormattingCustomKey",
    save: "saveNoteFormattingCustomKey",
  },
  { base: "chat-agent-custom", get: "getChatAgentCustomKey", save: "saveChatAgentCustomKey" },
];
const secretKeyApi = {};
for (const k of BYOK_KEY_BRIDGES) {
  secretKeyApi[k.get] = () => ipcRenderer.invoke(`get-${k.base}-key`);
  secretKeyApi[k.save] = (key) => ipcRenderer.invoke(`save-${k.base}-key`, key);
}

/**
 * Helper to register an IPC listener and return a cleanup function.
 * Ensures renderer code can easily remove listeners to avoid leaks.
 */
const registerListener = (channel, handlerFactory) => {
  return (callback) => {
    if (typeof callback !== "function") {
      return () => {};
    }

    const listener =
      typeof handlerFactory === "function"
        ? handlerFactory(callback)
        : (event, ...args) => callback(event, ...args);

    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  };
};

contextBridge.exposeInMainWorld("electronAPI", {
  ...createNotesBridge(ipcRenderer),
  ...createVocabularyBridge(ipcRenderer),
  setOnboardingWindowMode: (mode) => ipcRenderer.invoke("onboarding-set-window-mode", mode),
  setOnboardingActive: (active) => ipcRenderer.invoke("onboarding-set-active", active),
  onFolderDeleted: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("folder-deleted", listener);
    return () => ipcRenderer.removeListener("folder-deleted", listener);
  },
  meetingTranscriptionPrepare: (options) =>
    ipcRenderer.invoke("meeting-transcription-prepare", options),
  meetingTranscriptionStart: (options) =>
    ipcRenderer.invoke("meeting-transcription-start", options),
  meetingTranscriptionSend: (buffer, source) =>
    ipcRenderer.send("meeting-transcription-send", buffer, source),
  meetingTranscriptionSetSystemAudioAvailable: (sessionId, available) =>
    ipcRenderer.invoke("meeting-transcription-set-system-audio-available", sessionId, available),
  meetingTranscriptionStop: (expectedSessionId) =>
    ipcRenderer.invoke("meeting-transcription-stop", expectedSessionId),
  meetingTranscriptionCancel: () => ipcRenderer.invoke("meeting-transcription-cancel"),
  onMeetingTranscriptionSegment: registerListener(
    "meeting-transcription-segment",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingSpeakerIdentified: registerListener(
    "meeting-speaker-identified",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingSpeakersMerged: registerListener(
    "meeting-speakers-merged",
    (callback) => (_event, data) => callback(data)
  ),
  testProviderConnection: (config) => ipcRenderer.invoke("test-provider-connection", config),




  // Database functions
  saveTranscription: (text, rawText, options) =>
    ipcRenderer.invoke("db-save-transcription", text, rawText, options),
  getTranscriptions: (limit, options) =>
    ipcRenderer.invoke("db-get-transcriptions", limit, options),
  clearTranscriptions: () => ipcRenderer.invoke("db-clear-transcriptions"),
  deleteTranscription: (id) => ipcRenderer.invoke("db-delete-transcription", id),

  // Audio storage functions
  saveTranscriptionAudio: (id, audioBuffer, metadata) =>
    ipcRenderer.invoke("save-transcription-audio", id, audioBuffer, metadata),
  mergeAudioSegments: (segments) => ipcRenderer.invoke("merge-audio-segments", segments),
  getAudioPath: (id) => ipcRenderer.invoke("get-audio-path", id),
  showAudioInFolder: (id) => ipcRenderer.invoke("show-audio-in-folder", id),
  getAudioBuffer: (id) => ipcRenderer.invoke("get-audio-buffer", id),
  deleteTranscriptionAudio: (id) => ipcRenderer.invoke("delete-transcription-audio", id),
  getAudioStorageUsage: () => ipcRenderer.invoke("get-audio-storage-usage"),
  deleteAllAudio: () => ipcRenderer.invoke("delete-all-audio"),
  syncRetentionSettings: (settings) => ipcRenderer.send("retention-settings-changed", settings),
  retryTranscription: (id, settings) => ipcRenderer.invoke("retry-transcription", id, settings),
  updateTranscriptionText: (id, text, rawText) =>
    ipcRenderer.invoke("update-transcription-text", id, text, rawText),
  getTranscriptionById: (id) => ipcRenderer.invoke("get-transcription-by-id", id),

  // Vocabulary functions: getDictionary/setDictionary/applyDictionaryChanges/
  // getSnippets/setSnippets + the two subscriptions come from the typed
  // vocabularyBridge above.

  // Note functions: saveNote/getNote/getNotes/getSpaceNotes/updateNote/
  // deleteNote/searchNotes + the three note subscriptions come from the typed
  // notesBridge above. exportNote/exportTranscript stay here.
  exportNote: (noteId, format) => ipcRenderer.invoke("export-note", noteId, format),
  exportTranscript: (noteId, format) => ipcRenderer.invoke("export-transcript", noteId, format),
  exportDictionary: (words) => ipcRenderer.invoke("export-dictionary", words),
  // Folder functions
  getFolders: (spaceId) => ipcRenderer.invoke("db-get-folders", spaceId),
  createFolder: (name, spaceId) => ipcRenderer.invoke("db-create-folder", name, spaceId),
  deleteFolder: (id) => ipcRenderer.invoke("db-delete-folder", id),
  renameFolder: (id, name) => ipcRenderer.invoke("db-rename-folder", id, name),
  moveFolderToSpace: (id, spaceId) => ipcRenderer.invoke("db-move-folder-to-space", id, spaceId),
  getFolderNoteCounts: () => ipcRenderer.invoke("db-get-folder-note-counts"),

  // Space functions
  getSpaces: () => ipcRenderer.invoke("db-get-spaces"),
  updateSpace: (id, updates) => ipcRenderer.invoke("db-update-space", id, updates),
  onSpacePurged: (callback) => {
    const listener = (_event, payload) => callback?.(payload);
    ipcRenderer.on("space-purged", listener);
    return () => ipcRenderer.removeListener("space-purged", listener);
  },
  // Note files (markdown mirror) functions
  noteFilesSetEnabled: (enabled, customPath, options) =>
    ipcRenderer.invoke("note-files-set-enabled", enabled, customPath, options),
  noteFilesSetPath: (path) => ipcRenderer.invoke("note-files-set-path", path),
  noteFilesRebuild: () => ipcRenderer.invoke("note-files-rebuild"),
  noteFilesGetDefaultPath: () => ipcRenderer.invoke("note-files-get-default-path"),
  noteFilesPickFolder: () => ipcRenderer.invoke("note-files-pick-folder"),
  granolaImportPickAndPreview: () => ipcRenderer.invoke("granola-import-pick-and-preview"),
  granolaImportRun: () => ipcRenderer.invoke("granola-import-run"),
  showNoteFile: (noteId) => ipcRenderer.invoke("show-note-file", noteId),
  showFolderInExplorer: (folderName) => ipcRenderer.invoke("show-folder-in-explorer", folderName),

  // Action functions
  getActions: () => ipcRenderer.invoke("db-get-actions"),
  getAction: (id) => ipcRenderer.invoke("db-get-action", id),
  createAction: (name, description, prompt, icon) =>
    ipcRenderer.invoke("db-create-action", name, description, prompt, icon),
  updateAction: (id, updates) => ipcRenderer.invoke("db-update-action", id, updates),
  deleteAction: (id) => ipcRenderer.invoke("db-delete-action", id),

  // Audio file operations
  selectAudioFile: (options) => ipcRenderer.invoke("select-audio-file", options),
  getFileSize: (filePath) => ipcRenderer.invoke("get-file-size", filePath),
  transcribeAudioFile: (filePath, options) =>
    ipcRenderer.invoke("transcribe-audio-file", filePath, options),
  getPathForFile: (file) => {
    const filePath = webUtils.getPathForFile(file);
    // Register real dropped-file paths so the main-process audio allowlist accepts them.
    if (filePath) ipcRenderer.send("approve-audio-path", filePath);
    return filePath;
  },

  // URL audio download lives in the typed bridge module
  ...createUrlDownloadBridge(ipcRenderer),

  onActionCreated: (callback) => {
    const listener = (_event, action) => callback?.(action);
    ipcRenderer.on("action-created", listener);
    return () => ipcRenderer.removeListener("action-created", listener);
  },
  onActionUpdated: (callback) => {
    const listener = (_event, action) => callback?.(action);
    ipcRenderer.on("action-updated", listener);
    return () => ipcRenderer.removeListener("action-updated", listener);
  },
  onActionDeleted: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("action-deleted", listener);
    return () => ipcRenderer.removeListener("action-deleted", listener);
  },

  onTranscriptionAdded: (callback) => {
    const listener = (_event, transcription) => callback?.(transcription);
    ipcRenderer.on("transcription-added", listener);
    return () => ipcRenderer.removeListener("transcription-added", listener);
  },
  onTranscriptionDeleted: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("transcription-deleted", listener);
    return () => ipcRenderer.removeListener("transcription-deleted", listener);
  },
  onTranscriptionsCleared: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("transcriptions-cleared", listener);
    return () => ipcRenderer.removeListener("transcriptions-cleared", listener);
  },
  onTranscriptionUpdated: (callback) => {
    const listener = (_event, transcription) => callback?.(transcription);
    ipcRenderer.on("transcription-updated", listener);
    return () => ipcRenderer.removeListener("transcription-updated", listener);
  },
  // BYOK API keys (get/save for every provider in the secretKeys manifest)
  ...secretKeyApi,

  // Clipboard functions
  checkAccessibilityPermission: (silent) =>
    ipcRenderer.invoke("check-accessibility-permission", silent),
  promptAccessibilityPermission: () => ipcRenderer.invoke("prompt-accessibility-permission"),
  readClipboard: () => ipcRenderer.invoke("read-clipboard"),
  writeClipboard: (text) => ipcRenderer.invoke("write-clipboard", text),

  // Voice drafts (chat input recordings)
  saveTempAudio: (buffer) => ipcRenderer.invoke("save-temp-audio", buffer),
  deleteTempAudio: (tempPath) => ipcRenderer.invoke("delete-temp-audio", tempPath),

  // Local Whisper functions (whisper.cpp)
  transcribeLocalWhisper: (audioBlob, options) =>
    ipcRenderer.invoke("transcribe-local-whisper", audioBlob, options),
  checkWhisperInstallation: () => ipcRenderer.invoke("check-whisper-installation"),
  downloadWhisperModel: (modelName) => ipcRenderer.invoke("download-whisper-model", modelName),
  onWhisperDownloadProgress: registerListener("whisper-download-progress"),
  checkModelStatus: (modelName) => ipcRenderer.invoke("check-model-status", modelName),
  listWhisperModels: () => ipcRenderer.invoke("list-whisper-models"),
  deleteWhisperModel: (modelName) => ipcRenderer.invoke("delete-whisper-model", modelName),
  deleteAllWhisperModels: () => ipcRenderer.invoke("delete-all-whisper-models"),
  cancelWhisperDownload: () => ipcRenderer.invoke("cancel-whisper-download"),
  checkFFmpegAvailability: () => ipcRenderer.invoke("check-ffmpeg-availability"),
  getAudioDiagnostics: () => ipcRenderer.invoke("get-audio-diagnostics"),

  // Whisper server functions (faster repeated transcriptions)
  whisperServerStart: (modelName) => ipcRenderer.invoke("whisper-server-start", modelName),
  whisperServerStop: () => ipcRenderer.invoke("whisper-server-stop"),
  whisperServerStatus: () => ipcRenderer.invoke("whisper-server-status"),

  // Local Parakeet (NVIDIA) functions
  transcribeLocalParakeet: (audioBlob, options) =>
    ipcRenderer.invoke("transcribe-local-parakeet", audioBlob, options),
  checkParakeetInstallation: () => ipcRenderer.invoke("check-parakeet-installation"),
  downloadParakeetModel: (modelName) => ipcRenderer.invoke("download-parakeet-model", modelName),
  onParakeetDownloadProgress: registerListener("parakeet-download-progress"),
  checkParakeetModelStatus: (modelName) =>
    ipcRenderer.invoke("check-parakeet-model-status", modelName),
  listParakeetModels: () => ipcRenderer.invoke("list-parakeet-models"),
  deleteParakeetModel: (modelName) => ipcRenderer.invoke("delete-parakeet-model", modelName),
  deleteAllParakeetModels: () => ipcRenderer.invoke("delete-all-parakeet-models"),
  cancelParakeetDownload: () => ipcRenderer.invoke("cancel-parakeet-download"),
  getParakeetDiagnostics: () => ipcRenderer.invoke("get-parakeet-diagnostics"),

  // Parakeet server functions (faster repeated transcriptions)
  parakeetServerStart: (modelName) => ipcRenderer.invoke("parakeet-server-start", modelName),
  parakeetServerStop: () => ipcRenderer.invoke("parakeet-server-stop"),
  parakeetServerStatus: () => ipcRenderer.invoke("parakeet-server-status"),

  // Diarization (speaker identification) functions
  downloadDiarizationModels: () => ipcRenderer.invoke("download-diarization-models"),
  getDiarizationModelStatus: () => ipcRenderer.invoke("get-diarization-model-status"),
  deleteDiarizationModels: () => ipcRenderer.invoke("delete-diarization-models"),
  cancelDiarizationDownload: () => ipcRenderer.invoke("cancel-diarization-download"),
  diarizeAudioFile: (filePath, options) =>
    ipcRenderer.invoke("diarize-audio-file", filePath, options),
  mergeSpeakerText: (segments, text, duration) =>
    ipcRenderer.invoke("merge-speaker-text", { segments, text, duration }),
  onDiarizationDownloadProgress: registerListener(
    "diarization-download-progress",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingDiarizationComplete: registerListener(
    "meeting-diarization-complete",
    (callback) => (_event, data) => callback(data)
  ),

  // Speaker name mapping
  getSpeakerMappings: (noteId) => ipcRenderer.invoke("get-speaker-mappings", noteId),
  setSpeakerMapping: (noteId, speakerId, displayName, email, profileId) =>
    ipcRenderer.invoke("set-speaker-mapping", noteId, speakerId, displayName, email, profileId),
  removeSpeakerMapping: (noteId, speakerId) =>
    ipcRenderer.invoke("remove-speaker-mapping", noteId, speakerId),
  getSpeakerProfiles: () => ipcRenderer.invoke("get-speaker-profiles"),
  attachSpeakerEmail: (profileId, email) =>
    ipcRenderer.invoke("attach-speaker-email", profileId, email),
  saveNoteSpeakerEmbeddings: (noteId, embeddings) =>
    ipcRenderer.invoke("save-note-speaker-embeddings", noteId, embeddings),

  // Window control functions
  windowMinimize: () => ipcRenderer.invoke("window-minimize"),
  windowMaximize: () => ipcRenderer.invoke("window-maximize"),
  windowClose: () => ipcRenderer.invoke("window-close"),
  windowIsMaximized: () => ipcRenderer.invoke("window-is-maximized"),
  snapToMeetingMode: () => ipcRenderer.invoke("snap-to-meeting-mode"),
  restoreFromMeetingMode: () => ipcRenderer.invoke("restore-from-meeting-mode"),
  getPlatform: () => process.platform,

  // Cleanup function
  cleanupApp: () => ipcRenderer.invoke("cleanup-app"),
  setHotkeyListeningMode: (enabled) => ipcRenderer.invoke("set-hotkey-listening-mode", enabled),
  getHotkeyModeInfo: (hotkey) => ipcRenderer.invoke("get-hotkey-mode-info", hotkey),
  startControlPanelDrag: () => ipcRenderer.invoke("start-control-panel-drag"),
  stopControlPanelDrag: () => ipcRenderer.invoke("stop-control-panel-drag"),
  onMainWindowHorizontalDirectionChanged: registerListener(
    "main-window-horizontal-direction-changed",
    (callback) => (_event, direction) => callback(direction)
  ),
  onMainWindowWillResize: registerListener(
    "main-window-will-resize",
    (callback) => (_event, resize) => callback(resize)
  ),
  setNotificationInteractivity: (interactive) =>
    ipcRenderer.invoke("set-notification-interactivity", interactive),
  getOAuthProtocolRegistered: () => ipcRenderer.invoke("get-oauth-protocol-registered"),
  getOAuthProtocol: () => ipcRenderer.invoke("get-oauth-protocol"),
  // Audio event listeners
  onCancelHotkeyPressed: registerListener("cancel-hotkey-pressed", (cb) => () => cb()),
  registerCancelHotkey: (key) => ipcRenderer.invoke("register-cancel-hotkey", key),
  unregisterCancelHotkey: () => ipcRenderer.invoke("unregister-cancel-hotkey"),

  // External link opener
  openExternal: (url) => ipcRenderer.invoke("open-external", url),

  // Model management functions
  modelGetAll: () => ipcRenderer.invoke("model-get-all"),
  modelGetActiveDownloads: () => ipcRenderer.invoke("model-get-active-downloads"),
  modelCheck: (modelId) => ipcRenderer.invoke("model-check", modelId),
  modelDownload: (modelId) => ipcRenderer.invoke("model-download", modelId),
  modelDelete: (modelId) => ipcRenderer.invoke("model-delete", modelId),
  modelDeleteAll: () => ipcRenderer.invoke("model-delete-all"),
  modelCheckRuntime: () => ipcRenderer.invoke("model-check-runtime"),
  modelCancelDownload: (modelId) => ipcRenderer.invoke("model-cancel-download", modelId),
  onModelDownloadProgress: registerListener("model-download-progress"),

  getUiLanguage: () => ipcRenderer.invoke("get-ui-language"),
  saveUiLanguage: (language) => ipcRenderer.invoke("save-ui-language", language),
  setUiLanguage: (language) => ipcRenderer.invoke("set-ui-language", language),

  // xAI / Mistral transcription proxies (keys handled by the manifest bridge)
  proxyXaiTranscription: (data) => ipcRenderer.invoke("proxy-xai-transcription", data),
  proxyMistralTranscription: (data) => ipcRenderer.invoke("proxy-mistral-transcription", data),
  proxyGeminiTranscription: (data) => ipcRenderer.invoke("proxy-gemini-transcription", data),

  // Corti API
  getCortiClientId: () => ipcRenderer.invoke("get-corti-client-id"),
  saveCortiClientId: (key) => ipcRenderer.invoke("save-corti-client-id", key),
  getCortiClientSecret: () => ipcRenderer.invoke("get-corti-client-secret"),
  saveCortiClientSecret: (key) => ipcRenderer.invoke("save-corti-client-secret", key),
  proxyCortiTranscription: (data) => ipcRenderer.invoke("proxy-corti-transcription", data),
  getTinfoilChatModels: () => ipcRenderer.invoke("get-tinfoil-chat-models"),
  proxyTinfoilTranscription: (data) => ipcRenderer.invoke("proxy-tinfoil-transcription", data),

  // Custom endpoint API keys
  getCustomTranscriptionKey: () => ipcRenderer.invoke("get-custom-transcription-key"),
  saveCustomTranscriptionKey: (key) => ipcRenderer.invoke("save-custom-transcription-key", key),
  getCleanupCustomKey: () => ipcRenderer.invoke("get-cleanup-custom-key"),
  saveCleanupCustomKey: (key) => ipcRenderer.invoke("save-cleanup-custom-key", key),

  // Enterprise provider key management
  getBedrockRegion: () => ipcRenderer.invoke("get-bedrock-region"),
  saveBedrockRegion: (value) => ipcRenderer.invoke("save-bedrock-region", value),
  getBedrockProfile: () => ipcRenderer.invoke("get-bedrock-profile"),
  saveBedrockProfile: (value) => ipcRenderer.invoke("save-bedrock-profile", value),
  getBedrockAccessKeyId: () => ipcRenderer.invoke("get-bedrock-access-key-id"),
  saveBedrockAccessKeyId: (key) => ipcRenderer.invoke("save-bedrock-access-key-id", key),
  getBedrockSecretAccessKey: () => ipcRenderer.invoke("get-bedrock-secret-access-key"),
  saveBedrockSecretAccessKey: (key) => ipcRenderer.invoke("save-bedrock-secret-access-key", key),
  getBedrockSessionToken: () => ipcRenderer.invoke("get-bedrock-session-token"),
  saveBedrockSessionToken: (key) => ipcRenderer.invoke("save-bedrock-session-token", key),
  getAzureEndpoint: () => ipcRenderer.invoke("get-azure-endpoint"),
  saveAzureEndpoint: (value) => ipcRenderer.invoke("save-azure-endpoint", value),
  getAzureApiKey: () => ipcRenderer.invoke("get-azure-api-key"),
  saveAzureApiKey: (key) => ipcRenderer.invoke("save-azure-api-key", key),
  getAzureDeployment: () => ipcRenderer.invoke("get-azure-deployment"),
  saveAzureDeployment: (value) => ipcRenderer.invoke("save-azure-deployment", value),
  getAzureApiVersion: () => ipcRenderer.invoke("get-azure-api-version"),
  saveAzureApiVersion: (value) => ipcRenderer.invoke("save-azure-api-version", value),
  getVertexProject: () => ipcRenderer.invoke("get-vertex-project"),
  saveVertexProject: (value) => ipcRenderer.invoke("save-vertex-project", value),
  getVertexLocation: () => ipcRenderer.invoke("get-vertex-location"),
  saveVertexLocation: (value) => ipcRenderer.invoke("save-vertex-location", value),
  getVertexApiKey: () => ipcRenderer.invoke("get-vertex-api-key"),
  saveVertexApiKey: (key) => ipcRenderer.invoke("save-vertex-api-key", key),
  testEnterpriseConnection: (provider, config) =>
    ipcRenderer.invoke("test-enterprise-connection", provider, config),

  // App metadata
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),

  // Activation mode persistence (file-based for reliable startup)
  getActivationMode: () => ipcRenderer.invoke("get-activation-mode"),
  saveActivationMode: (mode) => ipcRenderer.invoke("save-activation-mode", mode),

  saveAllKeysToEnv: () => ipcRenderer.invoke("save-all-keys-to-env"),
  syncStartupPreferences: (prefs) => ipcRenderer.invoke("sync-startup-preferences", prefs),

  // Local reasoning
  processLocalReasoning: (text, modelId, agentName, config) =>
    ipcRenderer.invoke("process-local-reasoning", text, modelId, agentName, config),
  checkLocalReasoningAvailable: () => ipcRenderer.invoke("check-local-reasoning-available"),

  // Anthropic reasoning
  processAnthropicReasoning: (text, modelId, agentName, config) =>
    ipcRenderer.invoke("process-anthropic-reasoning", text, modelId, agentName, config),

  // Enterprise reasoning (Bedrock, Azure, Vertex) — runs in main process so
  // Node-only SDKs (AWS/Azure/Google credential providers) can resolve.
  processEnterpriseReasoning: (text, modelId, agentName, config) =>
    ipcRenderer.invoke("process-enterprise-reasoning", text, modelId, agentName, config),
  cancelEnterpriseReasoning: () => ipcRenderer.send("enterprise-reasoning-cancel"),
  enterpriseStreamStart: (payload) => ipcRenderer.invoke("enterprise-stream-start", payload),
  enterpriseStreamCancel: (streamId) => ipcRenderer.invoke("enterprise-stream-cancel", streamId),
  onEnterpriseStreamPart: registerListener(
    "enterprise-stream-part",
    (callback) => (_event, payload) => callback(payload)
  ),
  listBedrockModels: (config) => ipcRenderer.invoke("bedrock-list-models", config),
  // llama.cpp
  llamaCppCheck: () => ipcRenderer.invoke("llama-cpp-check"),
  llamaCppInstall: () => ipcRenderer.invoke("llama-cpp-install"),
  llamaCppUninstall: () => ipcRenderer.invoke("llama-cpp-uninstall"),

  // llama-server
  llamaServerStart: (modelId) => ipcRenderer.invoke("llama-server-start", modelId),
  llamaServerStop: () => ipcRenderer.invoke("llama-server-stop"),
  llamaServerStatus: () => ipcRenderer.invoke("llama-server-status"),

  getLogLevel: () => ipcRenderer.invoke("get-log-level"),
  log: (entry) => ipcRenderer.invoke("app-log", entry),

  // Debug logging management
  getDebugState: () => ipcRenderer.invoke("get-debug-state"),
  setDebugLogging: (enabled) => ipcRenderer.invoke("set-debug-logging", enabled),
  openLogsFolder: () => ipcRenderer.invoke("open-logs-folder"),

  // System settings helpers for microphone/audio permissions
  requestMicrophoneAccess: () => ipcRenderer.invoke("request-microphone-access"),
  checkMicrophoneAccess: () => ipcRenderer.invoke("check-microphone-access"),
  getSystemDefaultMicrophone: (options) =>
    ipcRenderer.invoke("get-system-default-microphone", options),
  checkSystemAudioAccess: () => ipcRenderer.invoke("check-system-audio-access"),
  requestSystemAudioAccess: () => ipcRenderer.invoke("request-system-audio-access"),
  openMicrophoneSettings: () => ipcRenderer.invoke("open-microphone-settings"),
  openSoundInputSettings: () => ipcRenderer.invoke("open-sound-input-settings"),
  openAccessibilitySettings: () => ipcRenderer.invoke("open-accessibility-settings"),
  openSystemAudioSettings: () => ipcRenderer.invoke("open-system-audio-settings"),
  openScreenRecordingSettings: () => ipcRenderer.invoke("open-screen-recording-settings"),
  openLoginItemsSettings: () => ipcRenderer.invoke("open-login-items-settings"),
  showEmojiPanel: () => ipcRenderer.invoke("show-emoji-panel"),
  getModelCacheRoot: () => ipcRenderer.invoke("get-model-cache-root"),
  openWhisperModelsFolder: () => ipcRenderer.invoke("open-whisper-models-folder"),
  transcribeAudioFileByok: (options) => ipcRenderer.invoke("transcribe-audio-file-byok", options),
  onUploadTranscriptionProgress: registerListener(
    "upload-transcription-progress",
    (callback) => (_event, data) => callback(data)
  ),

  onMeetingSessionSpeakerConfigUpdated: registerListener(
    "meeting-session-speaker-config-updated",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingTranscriptionError: registerListener(
    "meeting-transcription-error",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingTranscriptionFatalError: registerListener(
    "meeting-transcription-fatal-error",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingSystemAudioSilent: registerListener(
    "meeting-system-audio-silent",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingSystemAudioDegraded: registerListener(
    "meeting-system-audio-degraded",
    (callback) => () => callback()
  ),
  onMeetingSystemAudioInterrupted: registerListener(
    "meeting-system-audio-interrupted",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingSystemAudioResumed: registerListener(
    "meeting-system-audio-resumed",
    (callback) => () => callback()
  ),

  // Globe key listener for hotkey capture (macOS only)
  onGlobeKeyPressed: (callback) => {
    const listener = () => callback?.();
    ipcRenderer.on("globe-key-pressed", listener);
    return () => ipcRenderer.removeListener("globe-key-pressed", listener);
  },
  onGlobeKeyReleased: (callback) => {
    const listener = () => callback?.();
    ipcRenderer.on("globe-key-released", listener);
    return () => ipcRenderer.removeListener("globe-key-released", listener);
  },

  // Hotkey registration events (for notifying user when hotkey fails)
  onHotkeyFallbackUsed: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("hotkey-fallback-used", listener);
    return () => ipcRenderer.removeListener("hotkey-fallback-used", listener);
  },
  onHotkeyRegistrationFailed: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("hotkey-registration-failed", listener);
    return () => ipcRenderer.removeListener("hotkey-registration-failed", listener);
  },
  onSettingUpdated: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("setting-updated", listener);
    return () => ipcRenderer.removeListener("setting-updated", listener);
  },
  // Settings shortcut (Cmd+, / Ctrl+,)
  onShowSettings: registerListener("show-settings", (callback) => () => callback()),

  // Accessibility permission events (macOS)
  onAccessibilityMissing: (callback) => {
    const listener = () => callback?.();
    ipcRenderer.on("accessibility-missing", listener);
    return () => ipcRenderer.removeListener("accessibility-missing", listener);
  },

  // Notify main process of activation mode changes.
  notifyActivationModeChanged: (mode) => ipcRenderer.send("activation-mode-changed", mode),
  notifyHotkeyChanged: (hotkey) => ipcRenderer.send("hotkey-changed", hotkey),
  registerMeetingHotkey: (hotkey) => ipcRenderer.invoke("register-meeting-hotkey", hotkey),

  // Floating icon auto-hide
  notifyFloatingIconAutoHideChanged: (enabled) =>
    ipcRenderer.send("floating-icon-auto-hide-changed", enabled),
  onFloatingIconAutoHideChanged: registerListener(
    "floating-icon-auto-hide-changed",
    (callback) => (_event, enabled) => callback(enabled)
  ),

  // Panel start position
  notifyPanelStartPositionChanged: (position) =>
    ipcRenderer.send("panel-start-position-changed", position),

  // Start minimized
  notifyStartMinimizedChanged: (enabled) => ipcRenderer.send("start-minimized-changed", enabled),

  // Auto-start management
  getAutoStartEnabled: () => ipcRenderer.invoke("get-auto-start-enabled"),
  setAutoStartEnabled: (enabled) => ipcRenderer.invoke("set-auto-start-enabled", enabled),

  acquireRecordingLock: (pipeline) => ipcRenderer.invoke("acquire-recording-lock", pipeline),
  releaseRecordingLock: (pipeline) => ipcRenderer.invoke("release-recording-lock", pipeline),

  // Agent conversation persistence
  createAgentConversation: (title, noteId, spaceId, folderId) =>
    ipcRenderer.invoke("db-create-agent-conversation", title, noteId, spaceId, folderId),
  getAgentConversations: (limit) => ipcRenderer.invoke("db-get-agent-conversations", limit),
  getAgentConversation: (id) => ipcRenderer.invoke("db-get-agent-conversation", id),
  deleteAgentConversation: (id) => ipcRenderer.invoke("db-delete-agent-conversation", id),
  updateAgentConversationTitle: (id, title) =>
    ipcRenderer.invoke("db-update-agent-conversation-title", id, title),
  addAgentMessage: (conversationId, role, content, metadata) =>
    ipcRenderer.invoke("db-add-agent-message", conversationId, role, content, metadata),
  getAgentMessages: (conversationId) => ipcRenderer.invoke("db-get-agent-messages", conversationId),
  getAgentConversationsWithPreview: (limit, offset, includeArchived) =>
    ipcRenderer.invoke("db-get-agent-conversations-with-preview", limit, offset, includeArchived),
  searchAgentConversations: (query, limit) =>
    ipcRenderer.invoke("db-search-agent-conversations", query, limit),
  getConversationsForNote: (noteId, limit) =>
    ipcRenderer.invoke("db-get-conversations-for-note", noteId, limit),
  getConversationsForContainer: (spaceId, folderId, limit) =>
    ipcRenderer.invoke("db-get-conversations-for-container", spaceId, folderId, limit),
  archiveAgentConversation: (id) => ipcRenderer.invoke("db-archive-agent-conversation", id),
  unarchiveAgentConversation: (id) => ipcRenderer.invoke("db-unarchive-agent-conversation", id),
  // Google Calendar
  gcalStartOAuth: () => ipcRenderer.invoke("gcal-start-oauth"),
  gcalDisconnect: (email) => ipcRenderer.invoke("gcal-disconnect", email),
  gcalGetConnectionStatus: () => ipcRenderer.invoke("gcal-get-connection-status"),
  gcalGetCalendars: () => ipcRenderer.invoke("gcal-get-calendars"),
  gcalSetCalendarSelection: (calendarId, isSelected) =>
    ipcRenderer.invoke("gcal-set-calendar-selection", calendarId, isSelected),
  gcalSetPrimaryOnly: (value) => ipcRenderer.invoke("gcal-set-primary-only", value),
  gcalSyncEvents: () => ipcRenderer.invoke("gcal-sync-events"),
  gcalGetUpcomingEvents: (windowMinutes) =>
    ipcRenderer.invoke("gcal-get-upcoming-events", windowMinutes),
  calendarGetAvailability: (request) => ipcRenderer.invoke("calendar-get-availability", request),
  gcalGetEvent: (eventId) => ipcRenderer.invoke("gcal-get-event", eventId),

  // Microsoft Calendar
  mcalStartOAuth: () => ipcRenderer.invoke("mcal-start-oauth"),
  mcalDisconnect: (email) => ipcRenderer.invoke("mcal-disconnect", email),
  mcalGetConnectionStatus: () => ipcRenderer.invoke("mcal-get-connection-status"),
  mcalSetPrimaryOnly: (value) => ipcRenderer.invoke("mcal-set-primary-only", value),

  // Apple Calendar (macOS EventKit)
  acalConnect: () => ipcRenderer.invoke("acal-connect"),
  acalDisconnect: () => ipcRenderer.invoke("acal-disconnect"),
  acalGetConnectionStatus: () => ipcRenderer.invoke("acal-get-connection-status"),
  openCalendarPrivacySettings: () => ipcRenderer.invoke("open-calendar-privacy-settings"),

  // Contacts
  searchContacts: (query) => ipcRenderer.invoke("search-contacts", query),
  upsertContact: (contact) => ipcRenderer.invoke("upsert-contact", contact),
  getMD5Hash: (text) => ipcRenderer.invoke("get-md5-hash", text),

  // Google Calendar event listeners
  onGcalConnectionChanged: registerListener(
    "gcal-connection-changed",
    (callback) => (_event, data) => callback(data)
  ),
  onGcalEventsSynced: registerListener(
    "gcal-events-synced",
    (callback) => (_event, data) => callback(data)
  ),

  // Microsoft Calendar event listeners
  onMcalConnectionChanged: registerListener(
    "mcal-connection-changed",
    (callback) => (_event, data) => callback(data)
  ),
  onMcalEventsSynced: registerListener(
    "mcal-events-synced",
    (callback) => (_event, data) => callback(data)
  ),

  // Apple Calendar event listeners
  onAcalConnectionChanged: registerListener(
    "acal-connection-changed",
    (callback) => (_event, data) => callback(data)
  ),
  onAcalEventsSynced: registerListener(
    "acal-events-synced",
    (callback) => (_event, data) => callback(data)
  ),

  // Meeting detection
  meetingDetectionGetPreferences: () => ipcRenderer.invoke("meeting-detection-get-preferences"),
  meetingDetectionSetPreferences: (prefs) =>
    ipcRenderer.invoke("meeting-detection-set-preferences", prefs),
  syncNotificationPreferences: (prefs) =>
    ipcRenderer.invoke("sync-notification-preferences", prefs),
  setSpeakerDiarizationEnabled: (enabled) =>
    ipcRenderer.invoke("meeting-set-speaker-diarization-enabled", { enabled }),
  setMeetingSessionSpeakerConfig: (config) =>
    ipcRenderer.invoke("meeting-set-session-speaker-config", config),
  getWhisperVadConfig: () => ipcRenderer.invoke("whisper-vad-get-config"),
  setWhisperVadConfig: (config) => ipcRenderer.invoke("whisper-vad-set-config", config),
  onMeetingNotificationData: registerListener(
    "meeting-notification-data",
    (callback) => (_event, data) => callback(data)
  ),
  onMeetingAutoEndRequested: registerListener(
    "meeting-auto-end-requested",
    (callback) => (_event, data) => callback(data)
  ),
  meetingAutoEndCompleted: (sessionId) =>
    ipcRenderer.invoke("meeting-auto-end-completed", sessionId),
  meetingAutoEndRespond: (sessionId, action) =>
    ipcRenderer.invoke("meeting-auto-end-respond", sessionId, action),
  onMeetingAutoEndRestartRequested: registerListener(
    "meeting-auto-end-restart-requested",
    (callback) => (_event, data) => callback(data)
  ),
  getMeetingNotificationData: () => ipcRenderer.invoke("get-meeting-notification-data"),
  meetingNotificationReady: () => ipcRenderer.invoke("meeting-notification-ready"),
  meetingNotificationRespond: (detectionId, action) =>
    ipcRenderer.invoke("meeting-notification-respond", detectionId, action),
  joinCalendarMeeting: (eventId) => ipcRenderer.invoke("join-calendar-meeting", eventId),
  getPendingMeetingNoteNavigation: () => ipcRenderer.invoke("get-pending-meeting-note-navigation"),
  onMeetingNoteNavigationPending: registerListener(
    "meeting-note-navigation-pending",
    (callback) => () => callback()
  ),
  getPendingNoteNavigation: () => ipcRenderer.invoke("get-pending-note-navigation"),
  onNoteNavigationPending: registerListener(
    "note-navigation-pending",
    (callback) => () => callback()
  ),
});
