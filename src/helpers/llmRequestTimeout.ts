export const LLM_REQUEST_TIMEOUT_SECONDS = 30;

export const LLM_STREAMING_TIMEOUT_SECONDS = 60;

export function getLlmRequestTimeoutSeconds({
  streaming = false,
}: { streaming?: boolean } = {}): number {
  return streaming ? LLM_STREAMING_TIMEOUT_SECONDS : LLM_REQUEST_TIMEOUT_SECONDS;
}
