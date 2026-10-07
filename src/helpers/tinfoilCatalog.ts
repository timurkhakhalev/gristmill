// Tinfoil's model list comes from the attested endpoint.
// Fetching from the main process rather than the renderer lets every window share one request.
// SAFETY: lazy CommonJS seam; debugLogger's default export is the singleton.
const debugLogger = require("./debugLogger") as typeof import("./debugLogger.js").default;

import { z } from "zod";

import { tinfoilSecureFetch } from "./tinfoilSecureClient.js";

const TINFOIL_MODELS_PATH = "/v1/models";

const RETRY_AFTER_FAILURE_MS = 60 * 1000;

const REQUEST_TIMEOUT_MS = 10_000;

export interface TinfoilCatalogModel {
  id: string;
  name: string;
  description: string;
  supportsThinking: boolean;
}

const tinfoilModelSchema = z.looseObject({
  id: z.string(),
  name: z.unknown().optional(),
  description: z.unknown().optional(),
  reasoning: z.unknown().optional(),
  type: z.unknown().optional(),
  endpoints: z.unknown().optional(),
});

type TinfoilModelEntry = z.infer<typeof tinfoilModelSchema>;

const tinfoilModelsPayloadSchema = z.looseObject({
  data: z.array(z.unknown()).optional(),
});

let lastFailureAt = 0;

let inFlight: Promise<TinfoilCatalogModel[]> | null = null;

function isString<T>(value: T): value is T & string {
  return typeof value === "string";
}

/**
 * The list mixes chat, audio, tts, embedding and tool models, so narrow it to
 * the ones we can send a chat completion to.
 */
function isChatModel(model: TinfoilModelEntry): boolean {
  return (
    model.type === "chat" &&
    Array.isArray(model.endpoints) &&
    model.endpoints.includes("/v1/chat/completions")
  );
}

function toCatalogModel(model: TinfoilModelEntry): TinfoilCatalogModel {
  return {
    id: model.id,
    name: isString(model.name) && model.name ? model.name : model.id,
    description: isString(model.description) ? model.description : "",
    supportsThinking: model.reasoning === true,
  };
}

function parseModels<T>(payload: T): TinfoilCatalogModel[] {
  const parsed = tinfoilModelsPayloadSchema.safeParse(payload);

  if (!parsed.success || !parsed.data.data) {
    throw new Error("Malformed models list");
  }

  return parsed.data.data.flatMap((model) => {
    const entry = tinfoilModelSchema.safeParse(model);

    return entry.success && isChatModel(entry.data) ? [toCatalogModel(entry.data)] : [];
  });
}

async function fetchModels(): Promise<TinfoilCatalogModel[]> {
  // The first call also attests the enclave, so allow for more than a plain GET.
  const response = await tinfoilSecureFetch(TINFOIL_MODELS_PATH, {
    method: "GET",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Tinfoil models request failed: ${response.status}`);
  }

  const payload: unknown = await response.json();

  return parseModels(payload);
}

/**
 * Resolves to Tinfoil's chat models. Rejects when
 * the fetch fails so callers can tell "Tinfoil says this model is gone" apart
 * from "we couldn't ask".
 */
export async function getTinfoilChatModels(): Promise<TinfoilCatalogModel[]> {
  if (Date.now() - lastFailureAt < RETRY_AFTER_FAILURE_MS) {
    throw new Error("Tinfoil models unavailable");
  }

  if (!inFlight) {
    inFlight = fetchModels()
      .then((models) => {
        lastFailureAt = 0;

        return models;
      })
      .catch((error: Error) => {
        lastFailureAt = Date.now();
        debugLogger.warn("Failed to fetch Tinfoil models", { error: error.message });
        throw error;
      })
      .finally(() => {
        inFlight = null;
      });
  }

  return inFlight;
}
