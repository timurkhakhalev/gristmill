import { isBuiltInMicrophone } from "../utils/audioDeviceUtils.js";
import {
  resolveMicDeviceSelection,
  type MicDeviceSelectionStatus,
  type MicrophoneDeviceLike,
} from "./micDeviceSelection.js";

export const MICROPHONE_SELECTION_MODES = ["system", "built-in", "specific"] as const;

export type MicrophoneSelectionMode = (typeof MICROPHONE_SELECTION_MODES)[number];

export interface MicrophoneSelectionSettings {
  microphoneSelectionMode?: string;
  preferBuiltInMic?: boolean;
  selectedMicDeviceId?: string;
  selectedMicDeviceLabel?: string;
  setSelectedMicDevice?: (deviceId: string, label: string) => void;
}

export interface SystemDefaultMicrophone {
  name: string;
  nativeId?: string;
  platform?: string;
  source?: "system" | "unavailable";
}

export type MicrophoneResolutionStatus =
  | MicDeviceSelectionStatus
  | "native-exact"
  | "native-compatible"
  | "chromium-default-unmatched"
  | "chromium-default"
  | "native-unmatched"
  | "unavailable"
  | "built-in";

export interface MicrophoneResolution<Device extends MicrophoneDeviceLike> {
  mode: MicrophoneSelectionMode;
  device: Device | null;
  status: MicrophoneResolutionStatus;
  systemDefault?: SystemDefaultMicrophone | null;
}

const isMicrophoneSelectionMode = (value: string | undefined): value is MicrophoneSelectionMode =>
  MICROPHONE_SELECTION_MODES.some((mode) => mode === value);

export function getMicrophoneSelectionMode(
  settings: MicrophoneSelectionSettings = {}
): MicrophoneSelectionMode {
  if (isMicrophoneSelectionMode(settings.microphoneSelectionMode)) {
    return settings.microphoneSelectionMode;
  }

  if (settings.preferBuiltInMic) return "built-in";

  return settings.selectedMicDeviceId && settings.selectedMicDeviceId !== "default"
    ? "specific"
    : "system";
}

export function normalizeMicrophoneLabel(label: string | null | undefined = ""): string {
  return String(label)
    .normalize("NFKC")
    .replace(/^\s*(?:default|communications)\s*-\s*/i, "")
    .replace(/\s*\((?:built[ -]?in|default)\)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function comparableLabel(label: string | null | undefined): string {
  return normalizeMicrophoneLabel(label).replace(/[^\p{L}\p{N}]+/gu, "");
}

export function resolveSystemDefaultMicDevice<Device extends MicrophoneDeviceLike>(
  devices: readonly Device[],
  systemDefault: SystemDefaultMicrophone | null = null
): Omit<MicrophoneResolution<Device>, "mode"> {
  const inputs = devices.filter((device) => device.kind === "audioinput");
  const chromiumDefault = inputs.find((device) => device.deviceId === "default") || null;
  const physicalInputs = inputs.filter((device) => device.deviceId !== "default");
  const nativeName = systemDefault?.name?.trim();

  if (nativeName) {
    const target = comparableLabel(nativeName);

    const exactMatches = physicalInputs.filter(
      (device) => target && comparableLabel(device.label) === target
    );

    if (exactMatches.length === 1) {
      return { device: exactMatches[0], status: "native-exact", systemDefault };
    }

    const containedMatches = physicalInputs.filter((device) => {
      const candidate = comparableLabel(device.label);

      return (
        target.length >= 8 &&
        candidate.length >= 8 &&
        (candidate.includes(target) || target.includes(candidate))
      );
    });

    if (containedMatches.length === 1) {
      return { device: containedMatches[0], status: "native-compatible", systemDefault };
    }
  }

  if (chromiumDefault) {
    return {
      device: chromiumDefault,
      status: nativeName ? "chromium-default-unmatched" : "chromium-default",
      systemDefault,
    };
  }

  return {
    device: null,
    status: nativeName ? "native-unmatched" : "unavailable",
    systemDefault,
  };
}

export function resolveMicrophoneSelection<Device extends MicrophoneDeviceLike>(
  devices: readonly Device[],
  settings: MicrophoneSelectionSettings,
  systemDefault: SystemDefaultMicrophone | null = null
): MicrophoneResolution<Device> {
  const mode = getMicrophoneSelectionMode(settings);
  const inputs = devices.filter((device) => device.kind === "audioinput");

  if (mode === "system") {
    return { mode, ...resolveSystemDefaultMicDevice(inputs, systemDefault) };
  }

  if (mode === "built-in") {
    const device = inputs.find(
      (candidate) => candidate.deviceId !== "default" && isBuiltInMicrophone(candidate.label)
    );

    return { mode, device: device || null, status: device ? "built-in" : "unavailable" };
  }

  const selection = resolveMicDeviceSelection(
    inputs,
    settings.selectedMicDeviceId,
    settings.selectedMicDeviceLabel
  );

  return { mode, ...selection };
}

export function isCacheableMicrophoneResolution(
  resolution: Pick<MicrophoneResolution<MicrophoneDeviceLike>, "device"> | null | undefined
): boolean {
  const deviceId = resolution?.device?.deviceId;

  return Boolean(deviceId && deviceId !== "default");
}

export async function resolvePreferredMicrophone({
  settings,
  mediaDevices = navigator.mediaDevices,
  forceSystemDefault = false,
  refreshSystemDefault = false,
  getSystemDefault = (options) => window.electronAPI?.getSystemDefaultMicrophone?.(options),
}: {
  settings: MicrophoneSelectionSettings;
  mediaDevices?: Pick<MediaDevices, "enumerateDevices">;
  forceSystemDefault?: boolean;
  refreshSystemDefault?: boolean;
  getSystemDefault?: (options: {
    refresh: boolean;
  }) => Promise<SystemDefaultMicrophone | null | undefined> | undefined;
}): Promise<MicrophoneResolution<MediaDeviceInfo>> {
  const effectiveSettings: MicrophoneSelectionSettings = forceSystemDefault
    ? { ...settings, microphoneSelectionMode: "system", preferBuiltInMic: false }
    : settings;

  const mode = getMicrophoneSelectionMode(effectiveSettings);
  const devices = await mediaDevices.enumerateDevices();
  let systemDefault = null;

  if (mode === "system") {
    try {
      systemDefault = (await getSystemDefault?.({ refresh: refreshSystemDefault })) || null;
    } catch {
      // The explicit Chromium "default" device below remains the safe fallback.
    }
  }

  const result = resolveMicrophoneSelection(devices, effectiveSettings, systemDefault);

  if (
    result.mode === "specific" &&
    result.device &&
    (result.status === "remapped" || !settings.selectedMicDeviceLabel)
  ) {
    settings.setSelectedMicDevice?.(result.device.deviceId, result.device.label);
  }

  return result;
}
