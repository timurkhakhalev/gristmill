import { getModelFamilyConstraints } from "./modelFamilyConstraints";
import { matchesHost } from "../../utils/urlUtils";

/**
 * Per-provider dialects for turning a model's thinking off. Model-family
 * constraints (which reasoning_effort values a family accepts) come from
 * modelFamilyConstraints; this module only knows how each provider wants the
 * suppression expressed. Kept free of heavier runtime imports so the dialect
 * table stays unit-testable on its own.
 */
export interface EndpointDialect {
  key: "mistral" | "deepseek" | "cerebras";
  tokenParam: "max_tokens" | "max_completion_tokens";
  supportsTemperature: boolean;
}

// Nested JSON value inside a provider request param (e.g. `reasoning` or a
// content-part array). The recursive object arm keeps arbitrary provider
// extensions typed without falling back to `unknown`.
interface ProviderRequestObject {
  [key: string]: ProviderRequestValue;
}

type ProviderRequestValue =
  | string
  | number
  | boolean
  | null
  | ProviderRequestObject
  | ProviderRequestValue[];

/**
 * Owner contract for an OpenAI-compatible chat/responses request body: the
 * fixed keys this shaping layer reads or writes, plus each provider's native
 * suppression params. Named-interface fields whose value the layer passes
 * through unread stay `unknown`; the object-shaped suppression params carry the
 * recursive JSON value type.
 */
export interface ProviderRequestBody {
  model?: string;
  messages?: unknown;
  input?: unknown;
  store?: boolean;
  stream?: boolean;
  max_output_tokens?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  reasoning_effort?: string;
  reasoning?: ProviderRequestValue;
  thinking?: ProviderRequestValue;
  think?: boolean;
  chat_template_kwargs?: ProviderRequestValue;
}

/** Custom endpoints that need their own request shape, recognised by host. */
export function detectEndpointDialect(baseUrl: string | null | undefined): EndpointDialect | null {
  if (matchesHost(baseUrl, "mistral.ai")) {
    return { key: "mistral", tokenParam: "max_tokens", supportsTemperature: true };
  }

  if (matchesHost(baseUrl, "deepseek.com")) {
    return { key: "deepseek", tokenParam: "max_tokens", supportsTemperature: true };
  }

  if (matchesHost(baseUrl, "cerebras.ai")) {
    return { key: "cerebras", tokenParam: "max_tokens", supportsTemperature: true };
  }

  return null;
}

export function suppressThinking(
  requestBody: ProviderRequestBody,
  providerKey: string,
  model: string
): void {
  const family = getModelFamilyConstraints(model);

  if (providerKey === "gemini") {
    requestBody.reasoning_effort = "minimal";

    return;
  }

  // OpenRouter forwards unknown params to upstream backends, which may reject
  // them — use its native reasoning control instead.
  if (providerKey === "openrouter") {
    requestBody.reasoning = { enabled: false };

    return;
  }

  // Groq and Cerebras reject unknown fields outright (Cerebras 400s on
  // chat_template_kwargs, #831) and take a per-family reasoning_effort enum,
  // so send nothing unless the family is known.
  if (providerKey === "groq" || providerKey === "cerebras") {
    if (family?.reasoningEffort) {
      requestBody.reasoning_effort = family.reasoningEffort.suppressValue;
    }

    return;
  }

  // DeepSeek's API rejects reasoning_effort "none" (its enum has no off value,
  // #1260); thinking: {type} is its native switch. Family facts don't apply —
  // deepseek models on other hosts (e.g. Tinfoil) accept the generic shape.
  if (providerKey === "deepseek") {
    requestBody.thinking = { type: "disabled" };

    return;
  }

  // Mistral rejects unknown fields with a 422; reasoning_effort is its native switch.
  if (providerKey === "mistral") {
    if (family?.omitReasoningParams) return;
    requestBody.reasoning_effort = "none";

    return;
  }

  if (providerKey === "local") {
    requestBody.think = false;
  } else if (providerKey === "lan") {
    // `lan` always talks to an OpenAI-compat /v1 endpoint: the `reasoning` object
    // disables Ollama thinking; other backends drop it (flat reasoning_effort trips vLLM).
    // The effort value is the family's — gpt-oss has no off switch, so "none" would
    // contradict the "low" cleanup pin the same body carries.
    requestBody.reasoning = { effort: family?.reasoningEffort?.suppressValue ?? "none" };
  } else {
    requestBody.reasoning_effort = family?.reasoningEffort?.suppressValue ?? "none";
  }

  requestBody.chat_template_kwargs = { enable_thinking: false };
}
