import type { TFunction } from "i18next";
import {
  getMeetingFileTranscriptionProviders,
  getTranscriptionProviders,
  modelRegistry,
  type CloudModelDefinition,
} from "../../../models/ModelRegistry";
import { STREAMING_ONLY_PROVIDERS } from "../../../config/transcriptionCapabilities";
import { LOCAL_ASR_ORGANIZATIONS } from "../../../helpers/localASROrganization";
import type { LocalModelEntry } from "./inventoryContext";
import { isSpeechTask, type ModelTask } from "./taskModels";

export interface CatalogModel {
  id: string;
  name: string;
  description?: string;
}

export interface CatalogGroup {
  providerId: string;
  name: string;
  models: CatalogModel[];
  /** Free-form providers open an endpoint form instead of listing models. */
  form?: "openrouter" | "custom";
}

const LANGUAGE_PROVIDER_ORDER = ["openai", "anthropic", "gemini", "groq", "tinfoil", "corti"];

const describe = (t: TFunction, model: { description: string; descriptionKey?: string }) =>
  model.descriptionKey ? t(model.descriptionKey, { defaultValue: model.description }) : model.description;

/**
 * Cloud models a task may use. Meetings only offer post-Stop file models, uploads
 * exclude realtime-only providers, and language tasks list the chat providers.
 */
export function cloudGroups(task: ModelTask, t: TFunction, tinfoilModels: CloudModelDefinition[]): CatalogGroup[] {
  if (isSpeechTask(task)) {
    const providers = task === "meeting"
      ? getMeetingFileTranscriptionProviders()
      : getTranscriptionProviders().filter((provider) => !STREAMING_ONLY_PROVIDERS.has(provider.id));
    const groups: CatalogGroup[] = providers.map((provider) => ({
      providerId: provider.id,
      name: provider.name,
      models: provider.models.map((model) => ({ id: model.id, name: model.name, description: describe(t, model) })),
    }));
    if (task === "upload") {
      groups.push({ providerId: "custom", name: t("modelsSettings.picker.customEndpoint"), models: [], form: "custom" });
    }
    return groups;
  }
  const cloud = modelRegistry.getCloudProviders();
  const groups: CatalogGroup[] = LANGUAGE_PROVIDER_ORDER.flatMap((id) => {
    const provider = cloud.find((entry) => entry.id === id);
    if (!provider) return [];
    const models = id === "tinfoil" ? tinfoilModels : provider.models;
    return [{
      providerId: id,
      name: provider.name,
      models: models.map((model) => ({ id: model.id, name: model.name, description: describe(t, model) })),
    }];
  });
  groups.push(
    { providerId: "openrouter", name: "OpenRouter", models: [], form: "openrouter" },
    { providerId: "custom", name: t("modelsSettings.picker.customEndpoint"), models: [], form: "custom" }
  );
  return groups;
}

/** Name of a cloud model for trigger labels; free-form ids show as typed. */
export function cloudModelName(task: ModelTask, providerId: string, modelId: string): string {
  const providers = isSpeechTask(task) ? getTranscriptionProviders() : modelRegistry.getCloudProviders();
  return providers.find((provider) => provider.id === providerId)?.models.find((model) => model.id === modelId)?.name ?? modelId;
}

export function cloudProviderName(task: ModelTask, providerId: string, t: TFunction): string {
  if (providerId === "custom") return t("modelsSettings.picker.customEndpoint");
  if (providerId === "openrouter") return "OpenRouter";
  const providers = isSpeechTask(task) ? getTranscriptionProviders() : modelRegistry.getCloudProviders();
  return providers.find((provider) => provider.id === providerId)?.name ?? providerId;
}

export function matchesQuery(query: string, ...values: Array<string | undefined>): boolean {
  const normalized = query.trim().toLowerCase();
  return !normalized || values.some((value) => value?.toLowerCase().includes(normalized));
}

/** Local models grouped by organization, in the order pickers show them. */
export function localGroups(kind: "speech" | "language", entries: LocalModelEntry[]) {
  const organizations = kind === "speech"
    ? LOCAL_ASR_ORGANIZATIONS
    : modelRegistry.getAllProviders().map((provider) => ({ id: provider.id, name: provider.name }));
  return organizations
    .map((organization) => ({ ...organization, entries: entries.filter((entry) => entry.organization === organization.id) }))
    .filter((group) => group.entries.length > 0);
}
