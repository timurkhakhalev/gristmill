const { contextBridge, ipcRenderer, webUtils } = require("electron");
const { createNotesBridge } = require("./src/preload/notesBridge");
const { createVocabularyBridge } = require("./src/preload/vocabularyBridge");
const { createContainersBridge } = require("./src/preload/containerBridge");
const { createChatPersistenceBridge } = require("./src/preload/chatBridge");
const { createUrlDownloadBridge } = require("./src/preload/urlDownloadBridge");
const { createActionsBridge } = require("./src/preload/actionsBridge");
const { createLocalFileTranscriptionBridge } = require("./src/preload/localFileTranscriptionBridge");
const { createUploadTranscriptionBridge } = require("./src/preload/uploadTranscriptionBridge");
const { createCalendarAvailabilityBridge } = require("./src/preload/calendarAvailabilityBridge");
const { createReasoningBridge } = require("./src/preload/reasoningBridge");
const { createCalendarIntegrationBridge } = require("./src/preload/calendarBridge");
const { createNoteFilesBridge } = require("./src/preload/noteFilesBridge");
const { createLocalModelLifecycleBridge } = require("./src/preload/localModelLifecycleBridge");
const { createLocalLlmModelsBridge } = require("./src/preload/localLlmModelsBridge");
const { createSpeakerBridge } = require("./src/preload/speakerBridge");
const { createTranscriptionExecutionBridge } = require("./src/preload/transcriptionExecutionBridge");
const { createTranscriptionDataBridge } = require("./src/preload/transcriptionDataBridge");
const { createDesktopSettingsBridge } = require("./src/preload/desktopSettingsBridge");
const { createMeetingCoordinatorBridge } = require("./src/preload/meetingCoordinatorBridge");

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
  ...createActionsBridge(ipcRenderer),
  ...createLocalFileTranscriptionBridge(ipcRenderer),
  ...createUploadTranscriptionBridge(ipcRenderer),
  ...createCalendarAvailabilityBridge(ipcRenderer),
  ...createReasoningBridge(ipcRenderer),
  ...createCalendarIntegrationBridge(ipcRenderer),
  ...createNoteFilesBridge(ipcRenderer),
  ...createLocalModelLifecycleBridge(ipcRenderer),
  ...createLocalLlmModelsBridge(ipcRenderer),
  ...createSpeakerBridge(ipcRenderer),
  ...createTranscriptionExecutionBridge(ipcRenderer),
  ...createTranscriptionDataBridge(ipcRenderer),
  ...createDesktopSettingsBridge(ipcRenderer),
  ...createMeetingCoordinatorBridge(ipcRenderer),
  ...createContainersBridge(ipcRenderer),
  ...createChatPersistenceBridge(ipcRenderer),
  // Provider connection tests, local/remote transcription execution and the
  // voice-draft temp audio come from the typed transcriptionExecutionBridge
  // above.

  // Vocabulary functions: getDictionary/setDictionary/applyDictionaryChanges/
  // getSnippets/setSnippets + the two subscriptions come from the typed
  // vocabularyBridge above.

  // Note functions: saveNote/getNote/getNotes/getSpaceNotes/updateNote/
  // deleteNote/searchNotes + the three note subscriptions come from the typed
  // notesBridge above; the record/audio/export/file-selection channels and
  // the four transcription events come from the typed
  // transcriptionDataBridge above.
  // Folder/space functions + the onFolderDeleted subscription come from the
  // typed containersBridge above. onSpacePurged has no main-side producer and
  // is not exposed.

  // Note files / Granola import live in the typed noteFilesBridge above.

  // AI Actions catalog lives in the typed actionsBridge above.

  getPathForFile: (file) => {
    const filePath = webUtils.getPathForFile(file);
    // Register real dropped-file paths so the main-process audio allowlist accepts them.
    if (filePath) ipcRenderer.send("approve-audio-path", filePath);
    return filePath;
  },

  // URL audio download lives in the typed bridge module
  ...createUrlDownloadBridge(ipcRenderer),


  // Local Whisper/Parakeet model lifecycle (downloads, status, servers,
  // VAD config, diagnostics) lives in the typed localModelLifecycleBridge.

  getPlatform: () => process.platform,

  onMainWindowHorizontalDirectionChanged: registerListener(
    "main-window-horizontal-direction-changed",
    (callback) => (_event, direction) => callback(direction)
  ),
  onMainWindowWillResize: registerListener(
    "main-window-will-resize",
    (callback) => (_event, resize) => callback(resize)
  ),
  // Audio event listeners
  // The xAI/Mistral/Corti/Tinfoil/Gemini transcription proxies and the
  // Tinfoil chat model catalog come from the typed
  // transcriptionExecutionBridge above.

  // Local, Anthropic and enterprise one-shot reasoning plus the enterprise
  // stream lifecycle come from the typed reasoningBridge above.

  // Enterprise reasoning (Bedrock, Azure, Vertex) and its streams live in the
  // typed reasoningBridge above; the Bedrock model listing comes from the
  // transcriptionExecutionBridge.
  // BYOK file transcription and its hard cancel come from the typed
  // uploadTranscriptionBridge above.
  onUploadTranscriptionProgress: registerListener(
    "upload-transcription-progress",
    (callback) => (_event, data) => callback(data)
  ),

  // Meeting transcription/detection/auto-end/notification operations and
  // events come from the typed meetingCoordinatorBridge above.

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

  // Agent conversation persistence lives in the typed chatBridge above.
  // Google/Microsoft/Apple Calendar commands and events live in the typed
  // calendarBridge above (availability has its own bridge).

});
