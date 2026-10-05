export const PARAKEET_MINIMUM_MACOS_VERSION = "15.5";

export const PARAKEET_UNSUPPORTED_OS_CODE = "PARAKEET_UNSUPPORTED_OS";

export function compareVersions(left: string, right: string): number {
  const leftParts = String(left).split(".").map(Number);
  const rightParts = String(right).split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);

    if (difference !== 0) return difference > 0 ? 1 : -1;
  }

  return 0;
}

export interface ParakeetCapabilityOptions {
  platform?: NodeJS.Platform;
  systemVersion?: string | null;
}

export interface ParakeetCapability {
  supported: boolean;
  code?: string;
  message?: string;
  minimumMacOSVersion?: string;
}

export function getParakeetCapability({
  platform = process.platform,
  systemVersion,
}: ParakeetCapabilityOptions = {}): ParakeetCapability {
  if (platform !== "darwin") return { supported: true };

  const detectedVersion =
    systemVersion ??
    (typeof (process as { getSystemVersion?: () => string }).getSystemVersion === "function"
      ? (process as { getSystemVersion: () => string }).getSystemVersion()
      : null);

  // Plain Node does not expose Electron's system-version API. Production main-process
  // calls always provide it; allowing Node keeps build tooling and unit tests portable.
  if (!detectedVersion || compareVersions(detectedVersion, PARAKEET_MINIMUM_MACOS_VERSION) >= 0) {
    return { supported: true };
  }

  return {
    supported: false,
    code: PARAKEET_UNSUPPORTED_OS_CODE,
    message: `Parakeet requires macOS ${PARAKEET_MINIMUM_MACOS_VERSION} or later. Use cloud transcription (or Whisper where supported) on this Mac.`,
    minimumMacOSVersion: PARAKEET_MINIMUM_MACOS_VERSION,
  };
}

export function assertParakeetSupported(options?: ParakeetCapabilityOptions): void {
  const capability = getParakeetCapability(options);

  if (capability.supported) return;

  throw Object.assign(new Error(capability.message as string), {
    code: capability.code,
    minimumMacOSVersion: capability.minimumMacOSVersion,
  });
}
