import { useState, useCallback, useEffect, useRef } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useLocalStorage } from "./useLocalStorage";
import logger from "../utils/logger";
import { useMeetingRecordingStore } from "../stores/meetingRecordingStore";

export interface UsePermissionsReturn {
  // State
  micPermissionGranted: boolean;
  accessibilityPermissionGranted: boolean;
  micPermissionError: string | null;
  accessibilityTroubleshooting: boolean;
  accessibilityPromptRequested: boolean;

  requestMicPermission: () => Promise<void>;
  requestAccessibilityPermission: () => Promise<void>;
  openMicPrivacySettings: () => Promise<void>;
  openSoundInputSettings: () => Promise<void>;
  setMicPermissionGranted: (granted: boolean) => void;
  setAccessibilityPermissionGranted: (granted: boolean) => void;
}

export interface UsePermissionsProps {
  showAlertDialog: (dialog: { title: string; description?: string }) => void;
}

interface UsePermissionsOptions {
  macAccessibilityChecksEnabled?: boolean;
}

const stopTracks = (stream?: MediaStream) => {
  try {
    stream?.getTracks?.().forEach((track) => track.stop());
  } catch {
    // ignore track cleanup errors
  }
};

const describeMicError = (error: unknown, t: TFunction): string => {
  if (!error || typeof error !== "object") {
    return t("hooks.permissions.micErrors.accessFailed");
  }

  const err = error as { name?: string; message?: string };
  const name = err.name || "";
  const message = (err.message || "").toLowerCase();
  const settingsPath = t("hooks.permissions.paths.defaultSound");
  const privacyPath = t("hooks.permissions.paths.defaultPrivacy");

  if (name === "NotFoundError") {
    return t("hooks.permissions.micErrors.noMicrophones", { settingsPath });
  }

  if (name === "NotAllowedError" || name === "SecurityError") {
    return t("hooks.permissions.micErrors.permissionDenied", { privacyPath });
  }

  if (name === "NotReadableError" || name === "AbortError") {
    return t("hooks.permissions.micErrors.couldNotStart", { settingsPath });
  }

  if (message.includes("no audio input") || message.includes("not available")) {
    return t("hooks.permissions.micErrors.noActiveInput", { settingsPath });
  }

  return t("hooks.permissions.micErrors.unknown", {
    error: err.message || t("hooks.permissions.micErrors.unknownFallback"),
  });
};

export const usePermissions = (
  showAlertDialog?: UsePermissionsProps["showAlertDialog"],
  { macAccessibilityChecksEnabled = true }: UsePermissionsOptions = {}
): UsePermissionsReturn => {
  const { t } = useTranslation();
  const [micPermissionGranted, setMicPermissionGranted] = useLocalStorage(
    "micPermissionGranted",
    false
  );
  const [micPermissionError, setMicPermissionError] = useState<string | null>(null);
  const micCaptureActive = useMeetingRecordingStore((state) => state.isRecording && state.micCaptureStatus === "active");
  const [accessibilityPermissionGranted, setAccessibilityPermissionGranted] = useLocalStorage(
    "accessibilityPermissionGranted",
    false
  );
  const [accessibilityTroubleshooting, setAccessibilityTroubleshooting] = useState(false);
  const accessibilityPollCount = useRef(0);
  const [accessibilityPromptRequested, setAccessibilityPromptRequested] = useState(false);

  const openSystemSettings = useCallback(
    async (
      settingType: "microphone" | "sound" | "accessibility",
      apiMethod: () => Promise<{ success: boolean; error?: string } | undefined> | undefined
    ) => {
      const titles = {
        microphone: t("hooks.permissions.settingsTitles.microphone"),
        sound: t("hooks.permissions.settingsTitles.sound"),
        accessibility: t("hooks.permissions.settingsTitles.accessibility"),
      };
      const unableToOpenDescriptions = {
        microphone: t("hooks.permissions.settingsErrors.unableToOpenMicrophone"),
        sound: t("hooks.permissions.settingsErrors.unableToOpenSound"),
        accessibility: t("hooks.permissions.settingsErrors.unableToOpenAccessibility"),
      };
      try {
        const result = await apiMethod?.();
        if (result && !result.success && result.error) {
          showAlertDialog?.({ title: titles[settingType], description: result.error });
        }
      } catch (error) {
        logger.error(`Failed to open ${settingType} settings:`, error);
        showAlertDialog?.({
          title: titles[settingType],
          description: unableToOpenDescriptions[settingType],
        });
      }
    },
    [showAlertDialog, t]
  );

  const openMicPrivacySettings = useCallback(
    () => openSystemSettings("microphone", window.electronAPI?.openMicrophoneSettings),
    [openSystemSettings]
  );

  const openSoundInputSettings = useCallback(
    () => openSystemSettings("sound", window.electronAPI?.openSoundInputSettings),
    [openSystemSettings]
  );

  const requestMicPermission = useCallback(async () => {
    if (!navigator?.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      const message = t("hooks.permissions.micUnavailable");
      setMicPermissionError(message);
      if (showAlertDialog) {
        showAlertDialog({
          title: t("hooks.permissions.titles.microphoneUnavailable"),
          description: message,
        });
      }
      return;
    }

    setMicPermissionError(null);

    try {
      const currentAccess = await window.electronAPI?.checkMicrophoneAccess?.();
      if (currentAccess?.status === "denied" || currentAccess?.status === "restricted") {
        setMicPermissionError(t("hooks.permissions.micErrors.permissionDenied", {
          privacyPath: t("hooks.permissions.paths.defaultPrivacy"),
        }));
        await openMicPrivacySettings();
        return;
      }

      // macOS hardened runtime requires main-process mic prompt before getUserMedia works
      if (window.electronAPI?.requestMicrophoneAccess) {
        try {
          await window.electronAPI.requestMicrophoneAccess();
        } catch {
          // ignored — getUserMedia below will surface the error
        }
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stopTracks(stream);
      setMicPermissionGranted(true);
      setMicPermissionError(null);
    } catch (err) {
      logger.error("Microphone permission denied:", err);
      const message = describeMicError(err, t);
      setMicPermissionError(message);
      if (showAlertDialog) {
        showAlertDialog({
          title: t("hooks.permissions.titles.microphonePermissionRequired"),
          description: message,
        });
      }
    }
  }, [openMicPrivacySettings, showAlertDialog, t, setMicPermissionGranted]);

  const requestAccessibilityPermission = useCallback(async () => {
    const alreadyGranted = await window.electronAPI?.checkAccessibilityPermission?.(true);
    if (alreadyGranted) {
      setAccessibilityPermissionGranted(true);
      setAccessibilityTroubleshooting(false);
      return;
    }

    if (accessibilityPromptRequested) {
      setAccessibilityTroubleshooting(true);
      await openSystemSettings("accessibility", window.electronAPI?.openAccessibilitySettings);
      return;
    }

    setAccessibilityTroubleshooting(false);
    setAccessibilityPromptRequested(true);
    // The native prompt offers its own System Settings button.
    const granted = await window.electronAPI?.promptAccessibilityPermission?.();
    if (granted) {
      setAccessibilityPermissionGranted(true);
      return;
    }
    setAccessibilityTroubleshooting(true);
  }, [accessibilityPromptRequested, openSystemSettings, setAccessibilityPermissionGranted]);

  // On macOS, re-validate microphone permission on mount to override stale
  // localStorage values (e.g. after TCC reset or app update).
  useEffect(() => {
    const refresh = () => window.electronAPI?.checkMicrophoneAccess?.().then((result) => {
      const capture = useMeetingRecordingStore.getState();
      if (result && !(capture.isRecording && capture.micCaptureStatus === "active")) setMicPermissionGranted(result.granted);
    });
    void refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [setMicPermissionGranted]);
  useEffect(() => {
    if (micCaptureActive) setMicPermissionGranted(true);
  }, [micCaptureActive, setMicPermissionGranted]);

  // On macOS, re-validate accessibility permission once this screen is allowed
  // to touch protected features, overriding stale localStorage values.
  useEffect(() => {
    if (!macAccessibilityChecksEnabled) return;
    window.electronAPI?.checkAccessibilityPermission?.(true).then((granted) => {
      setAccessibilityPermissionGranted(granted);
    });
  }, [macAccessibilityChecksEnabled, setAccessibilityPermissionGranted]);

  // Poll for accessibility permission changes on macOS (e.g. user grants in System Settings)
  useEffect(() => {
    if (!macAccessibilityChecksEnabled) return;
    if (accessibilityPermissionGranted) {
      setAccessibilityTroubleshooting(false);
      accessibilityPollCount.current = 0;
      return;
    }

    const interval = setInterval(() => {
      window.electronAPI?.checkAccessibilityPermission?.(true).then((granted) => {
        if (granted) {
          setAccessibilityPermissionGranted(true);
          setAccessibilityTroubleshooting(false);
          accessibilityPollCount.current = 0;
        } else {
          accessibilityPollCount.current += 1;
          // After ~10s of failed polls, show troubleshooting tips
          if (accessibilityPollCount.current >= 5) {
            setAccessibilityTroubleshooting(true);
          }
        }
      });
    }, 2000);

    return () => clearInterval(interval);
  }, [
    accessibilityPermissionGranted,
    macAccessibilityChecksEnabled,
    setAccessibilityPermissionGranted,
  ]);

  return {
    micPermissionGranted,
    accessibilityPermissionGranted,
    micPermissionError,
    accessibilityTroubleshooting,
    accessibilityPromptRequested,
    requestMicPermission,
    requestAccessibilityPermission,
    openMicPrivacySettings,
    openSoundInputSettings,
    setMicPermissionGranted,
    setAccessibilityPermissionGranted,
  };
};
