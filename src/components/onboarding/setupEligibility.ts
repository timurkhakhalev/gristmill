interface ProviderOption {
  id: string;
}

export interface OnboardingSetupAvailability {
  cloud: boolean;
  local: boolean;
  byok: boolean;
  selfHosted: boolean;
}

/** Setup availability is a local capability check. */
export function getOnboardingSetupAvailability({
  transcriptionProviders,
}: {
  transcriptionProviders: ProviderOption[];
}): OnboardingSetupAvailability {
  const hasProvider = transcriptionProviders.length > 0;
  return {
    cloud: false,
    local: true,
    byok: hasProvider,
    selfHosted: true,
  };
}

export function hasAvailableOnboardingSetup(availability: OnboardingSetupAvailability): boolean {
  return Object.values(availability).some(Boolean);
}
