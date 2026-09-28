import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import { createNotesBridge } from "./src/preload/notesBridge";
import { createVocabularyBridge } from "./src/preload/vocabularyBridge";
import { createContainersBridge } from "./src/preload/containerBridge";
import { createChatPersistenceBridge } from "./src/preload/chatBridge";
import { createUrlDownloadBridge } from "./src/preload/urlDownloadBridge";
import { createActionsBridge } from "./src/preload/actionsBridge";
import { createLocalFileTranscriptionBridge } from "./src/preload/localFileTranscriptionBridge";
import { createUploadTranscriptionBridge } from "./src/preload/uploadTranscriptionBridge";
import { createCalendarAvailabilityBridge } from "./src/preload/calendarAvailabilityBridge";
import { createReasoningBridge } from "./src/preload/reasoningBridge";
import { createBbBridge } from "./src/preload/bbBridge";
import { createCalendarIntegrationBridge } from "./src/preload/calendarBridge";
import { createNoteFilesBridge } from "./src/preload/noteFilesBridge";
import { createLocalModelLifecycleBridge } from "./src/preload/localModelLifecycleBridge";
import { createLocalLlmModelsBridge } from "./src/preload/localLlmModelsBridge";
import { createSpeakerBridge } from "./src/preload/speakerBridge";
import { createTranscriptionExecutionBridge } from "./src/preload/transcriptionExecutionBridge";
import { createTranscriptionDataBridge } from "./src/preload/transcriptionDataBridge";
import { createDesktopSettingsBridge } from "./src/preload/desktopSettingsBridge";
import { createMeetingCoordinatorBridge } from "./src/preload/meetingCoordinatorBridge";
import { createMeetingProcessingBridge } from "./src/preload/meetingProcessingBridge";
import { createMeetingCompanionBridge } from "./src/preload/meetingCompanionBridge";

/** Unsubscribe returned to the renderer for every subscription. */
type Unsubscribe = () => void;

/**
 * Helper to register an IPC listener and return a cleanup function.
 * Ensures renderer code can easily remove listeners to avoid leaks.
 */
const registerListener = <T>(
  channel: string,
  handlerFactory: (callback: (data: T) => void) => (event: IpcRendererEvent, ...args: unknown[]) => void
): ((callback: (data: T) => void) => Unsubscribe) => {
  return (callback) => {
    if (typeof callback !== "function") {
      return () => {};
    }

    const listener =
      typeof handlerFactory === "function"
        ? handlerFactory(callback)
        : (event: IpcRendererEvent, ...args: unknown[]) =>
            (callback as (...args: unknown[]) => void)(event, ...args);

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
  ...createBbBridge(ipcRenderer),
  ...createCalendarIntegrationBridge(ipcRenderer),
  ...createNoteFilesBridge(ipcRenderer),
  ...createLocalModelLifecycleBridge(ipcRenderer),
  ...createLocalLlmModelsBridge(ipcRenderer),
  ...createSpeakerBridge(ipcRenderer),
  ...createTranscriptionExecutionBridge(ipcRenderer),
  ...createTranscriptionDataBridge(ipcRenderer),
  ...createDesktopSettingsBridge(ipcRenderer),
  ...createMeetingCoordinatorBridge(ipcRenderer),
  ...createMeetingProcessingBridge(ipcRenderer),
  ...createMeetingCompanionBridge(ipcRenderer),
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

  getPathForFile: (file: File): string => {
    const filePath = webUtils.getPathForFile(file);
    // Register real dropped-file paths so the main-process audio allowlist accepts them.
    if (filePath) ipcRenderer.send("approve-audio-path", filePath);
    return filePath;
  },

  // URL audio download lives in the typed bridge module
  ...createUrlDownloadBridge(ipcRenderer),


  // Local Whisper/Parakeet model lifecycle (downloads, status, servers,
  // VAD config, diagnostics) lives in the typed localModelLifecycleBridge.

  getPlatform: (): string => process.platform,

  onMainWindowHorizontalDirectionChanged: registerListener<"left" | "right">(
    "main-window-horizontal-direction-changed",
    (callback) => (_event, direction) => callback(direction as "left" | "right")
  ),
  onMainWindowWillResize: registerListener<{
    bounds: Electron.Rectangle;
    anchor: "bottom-left" | "bottom-right" | "center";
  }>(
    "main-window-will-resize",
    (callback) => (_event, resize) =>
      callback(resize as {
        bounds: Electron.Rectangle;
        anchor: "bottom-left" | "bottom-right" | "center";
      })
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
  onUploadTranscriptionProgress: registerListener<unknown>(
    "upload-transcription-progress",
    (callback) => (_event, data) => callback(data)
  ),

  // Meeting transcription/detection/auto-end/notification operations and
  // events come from the typed meetingCoordinatorBridge above.

  // Globe key listener for hotkey capture (macOS only)
  onGlobeKeyPressed: (callback: (() => void) | undefined): Unsubscribe => {
    const listener = () => callback?.();
    ipcRenderer.on("globe-key-pressed", listener);
    return () => ipcRenderer.removeListener("globe-key-pressed", listener);
  },
  onGlobeKeyReleased: (callback: (() => void) | undefined): Unsubscribe => {
    const listener = () => callback?.();
    ipcRenderer.on("globe-key-released", listener);
    return () => ipcRenderer.removeListener("globe-key-released", listener);
  },

  // Hotkey registration events (for notifying user when hotkey fails)
  onHotkeyFallbackUsed: (callback: ((data: { original: string; fallback: string }) => void) | undefined): Unsubscribe => {
    const listener = (_event: IpcRendererEvent, data: { original: string; fallback: string }) => callback?.(data);
    ipcRenderer.on("hotkey-fallback-used", listener);
    return () => ipcRenderer.removeListener("hotkey-fallback-used", listener);
  },
  onHotkeyRegistrationFailed: (
    callback: ((data: { hotkey: string; error: string; suggestions: string[] }) => void) | undefined
  ): Unsubscribe => {
    const listener = (_event: IpcRendererEvent, data: { hotkey: string; error: string; suggestions: string[] }) =>
      callback?.(data);
    ipcRenderer.on("hotkey-registration-failed", listener);
    return () => ipcRenderer.removeListener("hotkey-registration-failed", listener);
  },
  onSettingUpdated: (callback: ((data: { key: string; value: unknown }) => void) | undefined): Unsubscribe => {
    const listener = (_event: IpcRendererEvent, data: { key: string; value: unknown }) => callback?.(data);
    ipcRenderer.on("setting-updated", listener);
    return () => ipcRenderer.removeListener("setting-updated", listener);
  },
  // Settings shortcut (Cmd+, / Ctrl+,)
  onShowSettings: registerListener<void>("show-settings", (callback) => () => callback()),

  onTrayOpenEvent: registerListener<unknown>("tray-open-event", (callback) => (_event, data) => callback(data)),
  onTrayNewNote: registerListener<void>("tray-new-note", (callback) => () => callback()),

  // Accessibility permission events (macOS)
  onAccessibilityMissing: (callback: (() => void) | undefined): Unsubscribe => {
    const listener = () => callback?.();
    ipcRenderer.on("accessibility-missing", listener);
    return () => ipcRenderer.removeListener("accessibility-missing", listener);
  },

  // Notify main process of activation mode changes.
  notifyActivationModeChanged: (mode: "tap" | "push"): void =>
    ipcRenderer.send("activation-mode-changed", mode),
  notifyHotkeyChanged: (hotkey: string): void => ipcRenderer.send("hotkey-changed", hotkey),

  // Floating icon auto-hide
  notifyFloatingIconAutoHideChanged: (enabled: boolean): void =>
    ipcRenderer.send("floating-icon-auto-hide-changed", enabled),
  onFloatingIconAutoHideChanged: registerListener<boolean>(
    "floating-icon-auto-hide-changed",
    (callback) => (_event, enabled) => callback(enabled as boolean)
  ),

  // Panel start position
  notifyPanelStartPositionChanged: (position: string): void =>
    ipcRenderer.send("panel-start-position-changed", position),

  // Start minimized
  notifyStartMinimizedChanged: (enabled: boolean): void =>
    ipcRenderer.send("start-minimized-changed", enabled),

  // Agent conversation persistence lives in the typed chatBridge above.
  // Google/Microsoft/Apple Calendar commands and events live in the typed
  // calendarBridge above (availability has its own bridge).

});
