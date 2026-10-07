// Pure resolver for the "retention-settings-changed" IPC sync. The renderer
// re-syncs on mount, so the handler needs to know whether the incoming values
// actually differ before kicking off another cleanup sweep.
import { z } from "zod";

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

// The renderer sends a partial patch. Each field is decoded independently and
// falls back to `undefined` when unusable, so one bad value never discards the
// rest — the same per-field tolerance the previous `toDays`/`typeof` guards had.
const daysField = z
  .union([z.number(), z.string(), z.boolean(), z.null()])
  .optional()
  .catch(undefined);

const booleanField = z.boolean().optional().catch(undefined);

const retentionPatchSchema = z.object({
  audioRetentionDays: daysField,
  transcriptRetentionDays: daysField,
  dataRetentionEnabled: booleanField,
  localHistoryPolicyResolved: booleanField,
});

type RetentionPatch = z.infer<typeof retentionPatchSchema>;

function toDays(value: number | string | boolean | null | undefined, fallback: number): number {
  const days = Math.trunc(Number(value));

  return Number.isFinite(days) && days >= 0 ? days : fallback;
}

export interface RetentionApplyResult {
  changed: boolean;
  settings: RetentionSettings;
}

function parseIncoming<T>(incoming: T): RetentionPatch {
  const parsed = retentionPatchSchema.safeParse(incoming);

  return parsed.success ? parsed.data : {};
}

export function applyRetentionSettings<T>(
  current: RetentionSettings,
  incoming: T
): RetentionApplyResult {
  const record = parseIncoming(incoming);

  const settings: RetentionSettings = {
    audioRetentionDays: toDays(record.audioRetentionDays, current.audioRetentionDays),
    transcriptRetentionDays: toDays(
      record.transcriptRetentionDays,
      current.transcriptRetentionDays
    ),
    dataRetentionEnabled: record.dataRetentionEnabled ?? current.dataRetentionEnabled,
    localHistoryPolicyResolved:
      record.localHistoryPolicyResolved ?? current.localHistoryPolicyResolved,
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

export interface RetentionSettingsHandlerDeps<Owner = object> {
  getCurrentSettings(): RetentionSettings;
  // The webContents that owns retention cleanup; syncs from anyone else are
  // ignored. null/undefined while the owner is not mounted. Its identity is
  // compared, never inspected, so it stays opaque here.
  getOwner(): Owner | null | undefined;
  hasSynced(): boolean;
  onSettingsChanged(settings: RetentionSettings): void;
}

export type RetentionSettingsHandler = <T>(event: { sender?: unknown }, incoming: T) => void;

export function createRetentionSettingsHandler<Owner>(
  deps: RetentionSettingsHandlerDeps<Owner>
): RetentionSettingsHandler {
  return (event, incoming) => {
    const owner = deps.getOwner();

    if (!owner || event.sender !== owner) return;

    const { changed, settings } = applyRetentionSettings(deps.getCurrentSettings(), incoming);

    // Before the first sync the current values are defaults, not the user's, so
    // "unchanged" only means they happen to match the default — the consumer
    // still needs that first sync to know the settings are real (#1370).
    if (changed || !deps.hasSynced()) deps.onSettingsChanged(settings);
  };
}
