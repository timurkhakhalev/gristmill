import { useEffect, useMemo, useState } from "react";
import { useSettingsStore } from "../../stores/settingsStore";
import {
  isBbHarnessEnabled,
  orderBbHarnesses,
  seedBbAgentPreferences,
} from "../../config/bbAgentPreferences";
import type { BbHarness, BbModel } from "../../contracts/bb";

// Shared across every picker on screen; failures are not cached so the next open retries.
let catalogRequest: Promise<BbHarness[]> | null = null;

const modelRequests = new Map<string, Promise<BbModel[]>>();

// Settled results, read during the first render so a remounted picker shows its
// final label instead of "Choose model" → raw id → display name.
let resolvedHarnesses: BbHarness[] | null = null;

const resolvedModels = new Map<string, BbModel[]>();

function loadCatalog(): Promise<BbHarness[]> {
  catalogRequest ??= window.electronAPI.bbCatalog().then(
    (items) => {
      resolvedHarnesses = items.filter((item) => item.available);

      return items;
    },
    (error: unknown) => {
      catalogRequest = null;
      throw error;
    }
  );

  return catalogRequest;
}

function loadModels(provider: string): Promise<BbModel[]> {
  let request = modelRequests.get(provider);

  if (!request) {
    request = window.electronAPI.bbModels(provider).then(
      (models) => {
        resolvedModels.set(provider, models);

        return models;
      },
      (error: unknown) => {
        modelRequests.delete(provider);
        throw error;
      }
    );
    modelRequests.set(provider, request);
  }

  return request;
}

/** Warms the catalog and one harness's models before any picker mounts. */
export function prefetchBbCatalog(provider: string | null | undefined): void {
  loadCatalog().catch(() => {});

  if (provider) loadModels(provider).catch(() => {});
}

export function defaultReasoningFor(model: BbModel | undefined): string {
  return (
    model?.defaultReasoningEffort ??
    model?.supportedReasoningEfforts?.[0]?.reasoningEffort ??
    "medium"
  );
}

async function seedPreferences(available: BbHarness[]): Promise<void> {
  if (useSettingsStore.getState().bbAgentPreferences) return;
  const host = await window.electronAPI.bbHostPreferences().catch(() => null);

  if (useSettingsStore.getState().bbAgentPreferences) return;
  useSettingsStore.getState().setBbAgentPreferences(
    seedBbAgentPreferences(
      host?.providerOrder.length
        ? host
        : {
            providerOrder: available.map((item) => item.id),
            defaultProviderId: available[0]?.id ?? null,
          }
    )
  );
}

/** Available harnesses in the user's order; `enabled` is what pickers offer. */
export function useBbCatalog() {
  const preferences = useSettingsStore((state) => state.bbAgentPreferences);
  const [harnesses, setHarnesses] = useState<BbHarness[]>(() => resolvedHarnesses ?? []);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(() => resolvedHarnesses == null);

  useEffect(() => {
    let active = true;
    loadCatalog()
      .then(async (items) => {
        const available = items.filter((item) => item.available);
        await seedPreferences(available);

        if (!active) return;
        setHarnesses(available);
        setError("");
      })
      .catch((failure: Error) => {
        if (active) setError(failure.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  return useMemo(() => {
    const ordered = orderBbHarnesses(harnesses, preferences);

    return {
      harnesses: ordered,
      enabled: ordered.filter((item) => isBbHarnessEnabled(preferences, item.id)),
      error,
      loading,
    };
  }, [harnesses, preferences, error, loading]);
}

/**
 * Models of one harness. Once loaded, a harness without a usable default model
 * gets its first model as default, so "use default" always resolves to a model.
 */
export function useBbModels(provider: string) {
  const [state, setState] = useState<{ provider: string; models: BbModel[]; error: string }>(() => {
    const models = resolvedModels.get(provider);

    return models ? { provider, models, error: "" } : { provider: "", models: [], error: "" };
  });

  useEffect(() => {
    if (!provider) return;
    let active = true;
    loadModels(provider)
      .then((models) => {
        if (!active) return;
        setState({ provider, models, error: "" });

        const { bbAgentPreferences: preferences, setBbAgentPreferences } =
          useSettingsStore.getState();

        const saved = preferences?.defaults[provider];

        if (preferences && models[0] && !models.some((model) => model.id === saved?.model)) {
          setBbAgentPreferences({
            ...preferences,
            defaults: {
              ...preferences.defaults,
              [provider]: { model: models[0].id, reasoningLevel: defaultReasoningFor(models[0]) },
            },
          });
        }
      })
      .catch((failure: Error) => {
        if (active) setState({ provider, models: [], error: failure.message });
      });

    return () => {
      active = false;
    };
  }, [provider]);

  const current = state.provider === provider;

  return {
    models: current ? state.models : [],
    error: current ? state.error : "",
    loading: !!provider && !current,
  };
}
