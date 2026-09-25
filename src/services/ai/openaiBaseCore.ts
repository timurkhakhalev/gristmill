import { ensureV1Suffix } from "../../config/constants.mts";
import { isSecureHttpEndpoint } from "../../utils/urlUtils.js";

export function resolveSelfHostedOpenAIBase(configuredBaseUrl: string): string {
  const normalized = ensureV1Suffix(configuredBaseUrl.trim());
  if (!normalized || !isSecureHttpEndpoint(normalized)) {
    throw Object.assign(new Error("Invalid self-hosted endpoint"), {
      code: "SELF_HOSTED_ENDPOINT_INVALID",
    });
  }
  return normalized;
}
