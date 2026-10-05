# First launch

As a Gristmill user, I want to set up recording and optional integrations.

## User journey

1. Grant microphone access. Review optional system audio and Accessibility access.
2. Set a profile name or skip it.
3. Configure a transcription provider or choose Configure later.
4. Select spoken languages.
5. Optionally connect a calendar and finish.

## Behavior and limits

- The main ControlPanel stays unavailable until onboarding completes. Completion is stored in localStorage.
- Microphone access is required to continue. System audio and Accessibility are optional in this flow.
- The provider step configures transcription, not Chat or Summary. Its direct picker offers only file models with a working single-key credential handler. AssemblyAI and Corti are excluded from this form. A confirmed choice applies through the existing all-scope transcription setter; Meeting still enforces its narrower file-provider capabilities. Continue and Proceed share one in-flight secure save. The footer is disabled during that save, and a failed save permits Retry. A pending secure save may finish, but its result changes routing and advances the step only while the same configuration and mounted step still own that operation.
- An empty language selection does not block Continue. Calendar connection is optional.
- A restart begins the flow again if it is incomplete; the current step is not persisted.
- Normal Finish opens the main view. The flow does not request automatic Settings opening.
- Calendar setup in onboarding continues after system audio permission is refused; Settings has a different permission gate.

## Tray startup

Start minimized and launch-at-login load the control panel renderer in a hidden window. The renderer hydrates settings and resolves persisted onboarding before meeting input is allowed. A fresh profile remains gated. Window restore and the load backstop do not show a tray-started panel; an explicit tray or navigation action shows it. A failed hidden load leaves the gate closed and permits tray startup to finish. An explicit open retries that load.

## What to check

- The main view appears after Finish.
- Skipped provider/calendar setup remains available in Settings.

## BDD acceptance criteria

- Given microphone permission is missing, when I view Permissions, then Continue is unavailable.
- Given I skip provider and calendar setup, when I finish, then Home opens.

## Entry points

- [AppRouter.tsx](../../../src/AppRouter.tsx) — completion gate.
- [OnboardingFlow.tsx](../../../src/components/OnboardingFlow.tsx) — step order.
- [CompactPermissionsStep.tsx](../../../src/components/onboarding/CompactPermissionsStep.tsx) — permissions.
- [ProviderSetupStep.tsx](../../../src/components/onboarding/ProviderSetupStep.tsx) — transcription setup.
- [CalendarConnectionsStep.tsx](../../../src/components/onboarding/CalendarConnectionsStep.tsx) — optional calendar setup.
