import { useState, useCallback } from "react";
import { useSettingsStore } from "../stores/settingsStore";

interface UseNotesOnboardingReturn {
  isComplete: boolean;
  isProUser: boolean;
  isProLoading: boolean;
  isLLMConfigured: boolean;
  complete: () => void;
}

export function useNotesOnboarding(): UseNotesOnboardingReturn {
  const useCleanupModel = useSettingsStore((settings) => settings.useCleanupModel);
  const effectiveModel = useSettingsStore((settings) => settings.cleanupModel);

  const [isComplete, setIsComplete] = useState(
    () => localStorage.getItem("notesOnboardingComplete") === "true"
  );

  const isLLMConfigured = useCleanupModel && !!effectiveModel;

  const complete = useCallback(() => {
    localStorage.setItem("notesOnboardingComplete", "true");
    setIsComplete(true);
  }, []);

  return { isComplete, isProUser: true, isProLoading: false, isLLMConfigured, complete };
}
