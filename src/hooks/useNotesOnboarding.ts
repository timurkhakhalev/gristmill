import { useState, useCallback } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import { selectResolvedLLMConfig } from "../config/settingsSelectors";

interface UseNotesOnboardingReturn {
  isComplete: boolean;
  isLLMConfigured: boolean;
  complete: () => void;
}

export function useNotesOnboarding(): UseNotesOnboardingReturn {
  const effectiveModel = useSettingsStore((settings) => selectResolvedLLMConfig(settings, "noteFormatting").model);

  const [isComplete, setIsComplete] = useState(
    () => localStorage.getItem("notesOnboardingComplete") === "true"
  );

  const isLLMConfigured = !!effectiveModel;

  const complete = useCallback(() => {
    localStorage.setItem("notesOnboardingComplete", "true");
    setIsComplete(true);
  }, []);

  return { isComplete, isLLMConfigured, complete };
}
