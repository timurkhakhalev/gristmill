import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { SelectField } from "./SelectField";
import { SettingsRow } from "./SettingsSection";
import { Button } from "./button";
import { RefreshCw } from "../icons";
import { isBuiltInMicrophone } from "../../utils/audioDeviceUtils";
import { resolveSystemDefaultMicDevice } from "../../helpers/microphoneSelection";
import { resolveMicDeviceSelection } from "../../helpers/micDeviceSelection";

interface AudioDevice {
  kind: "audioinput";
  deviceId: string;
  label: string;
  isBuiltIn: boolean;
}

interface MicrophoneSettingsProps {
  microphoneSelectionMode: "system" | "built-in" | "specific";
  selectedMicDeviceId: string;
  selectedMicDeviceLabel: string;
  onSelectionModeChange: (mode: "system" | "built-in" | "specific") => void;
  onDeviceSelect: (deviceId: string, label: string) => void;
}

export const MicrophoneSettings: React.FC<MicrophoneSettingsProps> = ({
  microphoneSelectionMode,
  selectedMicDeviceId,
  selectedMicDeviceLabel,
  onSelectionModeChange,
  onDeviceSelect,
}) => {
  const { t } = useTranslation();
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [systemDefaultLabel, setSystemDefaultLabel] = useState("");

  const loadDevices = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Acquiring the mic just to read labels interrupts other audio (pauses
      // music on macOS), so only do it when labels are missing (no permission yet).
      let allDevices = await navigator.mediaDevices.enumerateDevices();
      const hasLabels = allDevices.some((d) => d.kind === "audioinput" && d.label);

      if (!hasLabels) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
        allDevices = await navigator.mediaDevices.enumerateDevices();
      }

      const audioInputs = allDevices
        .filter((d) => d.kind === "audioinput")
        .map((d) => ({
          kind: "audioinput" as const,
          deviceId: d.deviceId,
          label: d.label || `Microphone ${d.deviceId.slice(0, 8)}`,
          isBuiltIn: isBuiltInMicrophone(d.label),
        }));

      setDevices(audioInputs);

      const resolvedSelection = resolveMicDeviceSelection(
        audioInputs,
        selectedMicDeviceId,
        selectedMicDeviceLabel
      );

      if (
        resolvedSelection.device &&
        (resolvedSelection.status === "remapped" || !selectedMicDeviceLabel)
      ) {
        onDeviceSelect(resolvedSelection.device.deviceId, resolvedSelection.device.label);
      }

      const nativeDefault = await window.electronAPI?.getSystemDefaultMicrophone?.();
      const resolvedDefault = resolveSystemDefaultMicDevice(audioInputs, nativeDefault);
      setSystemDefaultLabel(nativeDefault?.name || resolvedDefault.device?.label || "");
    } catch {
      setError(t("microphoneSettings.errors.unableToAccess"));
    } finally {
      setIsLoading(false);
    }
  }, [onDeviceSelect, selectedMicDeviceId, selectedMicDeviceLabel, t]);

  useEffect(() => {
    loadDevices();

    const handleDeviceChange = () => loadDevices();
    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);

    return () => {
      navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
    };
  }, [loadDevices]);

  const builtInDevice = devices.find((d) => d.isBuiltIn);
  const selectedDevice = devices.find((d) => d.deviceId === selectedMicDeviceId);

  const selectorValue =
    microphoneSelectionMode === "system"
      ? "__system__"
      : microphoneSelectionMode === "built-in"
        ? "__built-in__"
        : selectedMicDeviceId || "__specific__";

  const options = [
    {
      id: "__system__",
      label: `${t("microphoneSettings.systemDefault")}${systemDefaultLabel ? ` — ${systemDefaultLabel}` : ""}`,
    },
    { id: "__built-in__", label: t("microphoneSettings.preferBuiltIn.label") },
    ...devices
      .filter((device) => device.deviceId !== "default")
      .map((device) => ({
        id: device.deviceId,
        label: device.isBuiltIn
          ? `${device.label} · ${t("microphoneSettings.builtIn")}`
          : device.label,
      })),
  ];

  if (!options.some((option) => option.id === selectorValue)) {
    options.push({
      id: selectorValue,
      label: selectedDevice?.label || t("microphoneSettings.unknownDevice"),
    });
  }

  const builtInNotice =
    microphoneSelectionMode === "built-in"
      ? builtInDevice
        ? t("microphoneSettings.using", { device: builtInDevice.label })
        : devices.length > 0
          ? t("microphoneSettings.noBuiltInDetected")
          : null
      : null;

  return (
    <SettingsRow
      label={t("microphoneSettings.inputDevice")}
      description={
        error ? (
          <span className="text-danger">{error}</span>
        ) : (
          <>
            {t("microphoneSettings.helpText")}
            {builtInNotice && <span className="mt-1 block text-foreground">{builtInNotice}</span>}
          </>
        )
      }
    >
      <div className="flex items-center gap-1.5">
        <SelectField
          value={selectorValue}
          options={options}
          className="w-64"
          isDisabled={Boolean(error)}
          onChange={(value) => {
            if (value === "__system__") {
              onSelectionModeChange("system");

              return;
            }

            if (value === "__built-in__") {
              onSelectionModeChange("built-in");

              return;
            }

            const device = devices.find((candidate) => candidate.deviceId === value);

            if (!device) return;
            onDeviceSelect(value, device.label);
            onSelectionModeChange("specific");
          }}
        />
        <Button
          variant="ghost"
          size="icon"
          onClick={loadDevices}
          disabled={isLoading}
          aria-label={t("microphoneSettings.refresh", { defaultValue: "Refresh devices" })}
          title={t("microphoneSettings.refresh", { defaultValue: "Refresh devices" })}
        >
          <RefreshCw className={`size-3.5 ${isLoading ? "animate-spin" : ""}`} />
        </Button>
      </div>
    </SettingsRow>
  );
};

export default MicrophoneSettings;
