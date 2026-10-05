// On-demand models are invoked by their bare foundation-model ID;
// INFERENCE_PROFILE-only models must go through the geo-scoped cross-region
// profile (us./eu./apac.) that the target region actually serves.
// SDK list responses arrive as unknown and are narrowed here.

export interface BedrockCatalogModel {
  value: string;
  label: string;
  vendor: string;
}

interface InferenceProfileSummary {
  inferenceProfileId?: string;
  models?: Array<{ modelArn?: string }>;
}

interface ModelSummary {
  modelId?: string;
  outputModalities?: string[];
  modelLifecycle?: { status?: string };
  inferenceTypesSupported?: string[];
  modelName?: string;
  providerName?: string;
}

function profileIdByModelId(
  inferenceProfileSummaries: InferenceProfileSummary[] | undefined | null
): Map<string, string> {
  const map = new Map();

  for (const profile of inferenceProfileSummaries || []) {
    if (!profile?.inferenceProfileId) continue;

    for (const model of profile.models || []) {
      const modelId = model?.modelArn?.split("/").pop();

      if (modelId && !map.has(modelId)) map.set(modelId, profile.inferenceProfileId);
    }
  }

  return map;
}

export function normalizeBedrockCatalog(
  modelSummaries: ModelSummary[] | undefined | null,
  inferenceProfileSummaries: InferenceProfileSummary[] | undefined | null
): BedrockCatalogModel[] {
  const profiles = profileIdByModelId(inferenceProfileSummaries);
  const seen = new Set<string>();
  const models: BedrockCatalogModel[] = [];

  for (const summary of modelSummaries || []) {
    if (!summary?.modelId) continue;

    if (!(summary.outputModalities || []).includes("TEXT")) continue;
    const status = summary.modelLifecycle?.status;

    if (status && status !== "ACTIVE") continue;

    const types = summary.inferenceTypesSupported || [];
    const value = types.includes("ON_DEMAND") ? summary.modelId : profiles.get(summary.modelId);

    if (!value || seen.has(value)) continue;
    seen.add(value);

    models.push({
      value,
      label: summary.modelName || summary.modelId,
      vendor: summary.providerName || "",
    });
  }

  models.sort((a, b) => a.vendor.localeCompare(b.vendor) || a.label.localeCompare(b.label));

  return models;
}
