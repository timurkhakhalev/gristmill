export const LEGACY_ONBOARDING_STEP_KEY = "onboardingCurrentStep";

export interface OnboardingByokDraft {
  selectedProvider: string;
  selectedModel: string;
  baseUrl: string;
  customModel: string;
}

export interface OnboardingProgressState {
  /** Zero-based position among the counted setup steps. */
  index: number;
  /** Number of counted setup steps. */
  total: number;
}

/** Clear the local setup marker before the compact onboarding flow is reopened. */
export function resetOnboardingProgress(storage: Pick<Storage, "removeItem" | "setItem">): void {
  storage.removeItem("onboardingCompleted");
  storage.removeItem(LEGACY_ONBOARDING_STEP_KEY);
  storage.setItem(LEGACY_ONBOARDING_STEP_KEY, "0");
}
