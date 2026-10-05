// Pure resolver for the "retention-settings-changed" IPC sync. The renderer
// re-syncs on mount, so the handler needs to know whether the incoming values
// actually differ before kicking off another cleanup sweep.

export interface RetentionSettings {
  audioRetentionDays: number;
  transcriptRetentionDays: number;
  // The renderer's policy-aware "keep local history" switch. Defaults to true
  // so a renderer that predates this field is never read as history-off, and
  // so the value only becomes trustworthy once hasSynced() says it is real.
  dataRetentionEnabled: boolean;
  // Whether the switch above reflects a settled managed policy rather than the
  // permissive default the renderer reports while one is still being fetched.
  // Defaults false: an unreported policy must never read as a resolved one.
  localHistoryPolicyResolved: boolean;
}

export const DEFAULT_RETENTION_SETTINGS: RetentionSettings = {
  audioRetentionDays: 7,
  transcriptRetentionDays: 0, // 0 = keep transcripts forever
  dataRetentionEnabled: true,
  localHistoryPolicyResolved: false,
};

function toDays(value: unknown, fallback: number): number {
  const days = Math.trunc(Number(value));

  return Number.isFinite(days) && days >= 0 ? days : fallback;
}

export function applyRetentionSettings(
  current: RetentionSettings,
  incoming: unknown
): { changed: boolean; settings: RetentionSettings } {
  const record = (typeof incoming === "object" && incoming !== null ? incoming : {}) as Record<
    string,
    unknown
  >;

  const settings: RetentionSettings = {
    audioRetentionDays: toDays(record.audioRetentionDays, current.audioRetentionDays),
    transcriptRetentionDays: toDays(
      record.transcriptRetentionDays,
      current.transcriptRetentionDays
    ),
    dataRetentionEnabled:
      typeof record.dataRetentionEnabled === "boolean"
        ? record.dataRetentionEnabled
        : current.dataRetentionEnabled,
    localHistoryPolicyResolved:
      typeof record.localHistoryPolicyResolved === "boolean"
        ? record.localHistoryPolicyResolved
        : current.localHistoryPolicyResolved,
  };

  const changed =
    settings.audioRetentionDays !== current.audioRetentionDays ||
    settings.transcriptRetentionDays !== current.transcriptRetentionDays ||
    settings.dataRetentionEnabled !== current.dataRetentionEnabled ||
    // The policy settling is what unblocks reconstruction, so it has to count
    // as a change even when every other value stayed put.
    settings.localHistoryPolicyResolved !== current.localHistoryPolicyResolved;

  return { changed, settings };
}

export interface RetentionSettingsHandlerDeps {
  getCurrentSettings(): RetentionSettings;
  // The webContents that owns retention cleanup; syncs from anyone else are
  // ignored. null while the owner is not mounted.
  getOwner(): unknown;
  hasSynced(): boolean;
  onSettingsChanged(settings: RetentionSettings): void;
}

export function createRetentionSettingsHandler({
  getCurrentSettings,
  getOwner,
  hasSynced,
  onSettingsChanged,
}: RetentionSettingsHandlerDeps) {
  return (event: { sender?: unknown }, incoming: unknown): void => {
    const owner = getOwner();

    if (!owner || event.sender !== owner) return;

    const { changed, settings } = applyRetentionSettings(getCurrentSettings(), incoming);

    // Before the first sync the current values are defaults, not the user's, so
    // "unchanged" only means they happen to match the default — the consumer
    // still needs that first sync to know the settings are real (#1370).
    if (changed || !hasSynced()) onSettingsChanged(settings);
  };
}
