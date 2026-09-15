/**
 * Reconcile a saved microphone preference with the devices Chromium currently
 * exposes. deviceId is preferred while it remains valid; the label is only a
 * recovery key when exactly one current input has that label.
 */
export interface MicrophoneDeviceLike {
  kind?: string;
  deviceId: string;
  groupId?: string;
  label: string;
}

export type MicDeviceSelectionStatus = "default" | "exact" | "missing" | "remapped" | "ambiguous";

export interface MicDeviceSelection<Device extends MicrophoneDeviceLike> {
  device: Device | null;
  status: MicDeviceSelectionStatus;
}

export function resolveMicDeviceSelection<Device extends MicrophoneDeviceLike>(
  devices: readonly Device[],
  selectedDeviceId?: string | null,
  selectedDeviceLabel?: string | null
): MicDeviceSelection<Device> {
  if (!selectedDeviceId) {
    return { device: null, status: "default" };
  }

  // Callers pass raw MediaDeviceInfo lists or pre-filtered inputs without a kind.
  const audioInputs = devices.filter(
    (device) => device.kind === undefined || device.kind === "audioinput"
  );
  const exactMatch = audioInputs.find((device) => device.deviceId === selectedDeviceId);

  if (exactMatch) {
    return { device: exactMatch, status: "exact" };
  }

  if (!selectedDeviceLabel) {
    return { device: null, status: "missing" };
  }

  const labelMatches = audioInputs.filter(
    (device) => device.deviceId !== "default" && device.label === selectedDeviceLabel
  );

  if (labelMatches.length === 1) {
    return { device: labelMatches[0], status: "remapped" };
  }

  return {
    device: null,
    status: labelMatches.length > 1 ? "ambiguous" : "missing",
  };
}
