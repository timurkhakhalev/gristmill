import { useCallback } from "react";
import { resetOnboardingProgress } from "../components/onboarding/flow";

// Restart the local setup flow without changing any provider or model settings.
// The setup screen owns those choices, so this hook only clears its progress
// marker and asks the renderer to reopen onboarding.
export function useStartOnboarding(): () => void {
  return useCallback(() => {
    resetOnboardingProgress(localStorage);
    window.location.reload();
  }, []);
}
