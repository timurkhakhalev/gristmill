// Pure bb harness preference logic shared by the settings selectors and the UI.
import type { BbAgentPreferences } from "../contracts/inferenceSettings";

export interface BbResolvedSelection {
  provider: string;
  model: string;
  reasoningLevel: string;
}

export function seedBbAgentPreferences(host: { providerOrder: string[]; defaultProviderId: string | null }): BbAgentPreferences {
  return { order: [...host.providerOrder], disabled: [], defaultProvider: host.defaultProviderId ?? host.providerOrder[0] ?? "", defaults: {} };
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Validates persisted preferences; anything malformed is treated as unseeded. */
export function parseBbAgentPreferences(raw: string | null): BbAgentPreferences | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const { order, disabled, defaultProvider, defaults } = value as Record<string, unknown>;
    if (!isStringArray(order) || !isStringArray(disabled) || typeof defaultProvider !== "string") return null;
    if (!defaults || typeof defaults !== "object") return null;
    const entries = Object.entries(defaults).filter((entry): entry is [string, { model: string; reasoningLevel: string }] => {
      const item = entry[1] as Record<string, unknown> | null;
      return !!item && typeof item.model === "string" && typeof item.reasoningLevel === "string";
    });
    return {
      order,
      disabled,
      defaultProvider,
      defaults: Object.fromEntries(entries.map(([id, item]) => [id, { model: item.model, reasoningLevel: item.reasoningLevel }])),
    };
  } catch {
    return null;
  }
}

/** Sorts harnesses by the saved order; harnesses bb added later go last in bb's order. */
export function orderBbHarnesses<T extends { id: string }>(items: T[], prefs: BbAgentPreferences | null): T[] {
  const order = prefs?.order ?? [];
  const rank = (id: string) => {
    const index = order.indexOf(id);
    return index === -1 ? order.length : index;
  };
  return items.map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item.id) - rank(b.item.id) || a.index - b.index)
    .map(({ item }) => item);
}

export function moveBbHarness(order: string[], id: string, toIndex: number): string[] {
  const next = order.filter((item) => item !== id);
  next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, id);
  return next;
}

export function isBbHarnessEnabled(prefs: BbAgentPreferences | null | undefined, provider: string): boolean {
  return !!provider && !prefs?.disabled.includes(provider);
}

/**
 * A scope override (chat or summary) wins; otherwise the default harness and its
 * default model apply. A disabled harness resolves to an empty selection so the
 * caller reports it instead of silently switching to another harness.
 */
export function resolveBbSelection(
  prefs: BbAgentPreferences | null | undefined,
  override: Partial<BbResolvedSelection>
): BbResolvedSelection {
  const provider = override.provider || prefs?.defaultProvider || "";
  if (!isBbHarnessEnabled(prefs, provider)) return { provider: "", model: "", reasoningLevel: "" };
  const saved = prefs?.defaults[provider];
  const explicit = !!override.provider && !!override.model;
  return {
    provider,
    model: explicit ? override.model || "" : saved?.model || "",
    reasoningLevel: explicit ? override.reasoningLevel || "" : saved?.reasoningLevel || "",
  };
}
