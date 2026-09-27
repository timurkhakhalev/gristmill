// @probe-name "wrong request payloads and failure-arm usage fail compilation"
// @probe-codes [2322,2339,2345,2345,2345]
// @probe-origin test/scripts/reasoningTypeProbe.test.js
import { createReasoningBridge } from "./src/preload/reasoningBridge.js";
import { enterpriseStreamEnvelopeSchema } from "./src/contracts/reasoning.js";

declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
};
const bridge = createReasoningBridge(ipcRendererLike);

// text must be a string; the enterprise config requires a provider.
bridge.processLocalReasoning(12, "m", null, {});
bridge.processEnterpriseReasoning("t", "m", null, { systemPrompt: "s" });

// The stream start request requires streamId, provider, modelId and options.
bridge.enterpriseStreamStart({ provider: "bedrock", modelId: "m", options: {} });

async function failureArm(): Promise<string> {
  const result = await bridge.processEnterpriseReasoning("t", "m", null, { provider: "azure" });
  if (!result.success) {
    // text does not exist on the failure arm.
    return result.text;
  }
  return result.text ?? "";
}
void failureArm;

// Envelope parsing yields the discriminated envelope, not an arbitrary object.
const envelope = enterpriseStreamEnvelopeSchema.parse({ streamId: "s", done: true });
const done: boolean = envelope.part;
void done;
