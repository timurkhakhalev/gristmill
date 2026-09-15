// The macOS System Settings launcher behind the permission/open-settings IPC
// channels and the calendar privacy settings. Moved out of ipcHandlers.js so
// the typed desktop module and the calendar integration vertical open the
// exact same URLs. macOS is the only supported runtime platform.
import { shell } from "electron";
import debugLogger from "./debugLogger.js";
import { i18nMain } from "./i18nMain.js";

export type SystemSettingType =
  | "microphone"
  | "sound"
  | "accessibility"
  | "systemAudio"
  | "screenRecording"
  | "loginItems"
  | "calendars";

const SYSTEM_SETTINGS_URLS: Record<string, Partial<Record<SystemSettingType, string>>> = {
  darwin: {
    microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    sound: "x-apple.systempreferences:com.apple.preference.sound?input",
    accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    systemAudio: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    screenRecording:
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    calendars: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
    loginItems: "x-apple.systempreferences:com.apple.LoginItems-Settings.extension",
  },
};

export async function openSystemSettings(
  settingType: SystemSettingType
): Promise<{ success: boolean; error?: string }> {
  const platform = process.platform;
  const url = SYSTEM_SETTINGS_URLS[platform]?.[settingType];

  if (!url) {
    // macOS is the only supported runtime platform.
    const messages: Partial<Record<SystemSettingType, string>> = {
      microphone: i18nMain.t("systemSettings.microphone"),
      sound: i18nMain.t("systemSettings.sound"),
      accessibility: i18nMain.t("systemSettings.accessibility"),
      systemAudio: i18nMain.t("systemSettings.systemAudio"),
      screenRecording: i18nMain.t("systemSettings.screenRecording"),
      loginItems: i18nMain.t("systemSettings.loginItems"),
    };
    return {
      success: false,
      error: messages[settingType] || `${settingType} settings are not available on this platform.`,
    };
  }

  try {
    await shell.openExternal(url);
    return { success: true };
  } catch (error) {
    debugLogger.error(`Failed to open ${settingType} settings:`, error);
    return { success: false, error: (error as Error).message };
  }
}
