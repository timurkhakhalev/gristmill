// Main-owned local (llama.cpp) one-shot reasoning. Preserves the JS service's
// one-active-request policy, config defaults, complete-output behavior and
// thinking cleanup; the model manager keeps owning llama-server lifecycle.
import modelManagerBundle from "../helpers/modelManagerBridge.js";
import debugLogger from "../helpers/debugLogger.js";
import type { RunInferenceOptions } from "../helpers/modelManagerBridge.js";
import type { ModelManager } from "../helpers/modelManagerBridge.js";
import type { LocalReasoningConfig } from "../contracts/reasoning.js";

// The bundle's `default` is the singleton under every loader: the tsx ESM
// graph resolves the default import to module.exports itself, the CJS graphs
// interop to the same object. A real ESM loader instead resolves it to the
// `export default` singleton. Accept both: the wrapper carries `default`.
interface ModelManagerWrapper {
  default: ModelManager;
}

function isModelManagerWrapper(value: ModelManager): value is ModelManager & ModelManagerWrapper {
  return "default" in value;
}

const modelManager: ModelManager = isModelManagerWrapper(modelManagerBundle)
  ? modelManagerBundle.default
  : modelManagerBundle;

// The sampling fields ride along in the debug log only; runInference reads the
// budget fields and ignores the rest. Keep them so the logged config is the
// same object the pre-cutover JS bridge produced.
interface LocalInferenceOptions extends RunInferenceOptions {
  topK: number;
  topP: number;
  repeatPenalty: number;
}

export class LocalReasoningService {
  private isProcessing = false;

  async isAvailable(): Promise<boolean> {
    try {
      const models = await modelManager.getAllModels();

      return models.some((model) => model.isDownloaded);
    } catch {
      return false;
    }
  }

  async processText(
    text: string,
    modelId: string,
    config: LocalReasoningConfig = {},
    signal?: AbortSignal
  ): Promise<string> {
    debugLogger.logReasoning("LOCAL_BRIDGE_START", {
      modelId,
      textLength: text.length,
      hasConfig: Object.keys(config).length > 0,
    });

    if (this.isProcessing) {
      throw new Error("Already processing a request");
    }

    this.isProcessing = true;
    const startTime = Date.now();

    try {
      const inferenceConfig: LocalInferenceOptions = {
        maxTokens: config.maxTokens ?? this.calculateMaxTokens(text.length),
        temperature: config.temperature ?? 0.7,
        topK: config.topK ?? 40,
        topP: config.topP ?? 0.9,
        repeatPenalty: config.repeatPenalty ?? 1.1,
        systemPrompt: config.systemPrompt || "",
        disableThinking: config.disableThinking !== false,
        requireCompleteOutput: config.requireCompleteOutput,
        // A minimum context window for this request. Rebuilding this object
        // field-by-field is what silently orphaned it before #2142: it was
        // declared, written by selection editing, and never forwarded.
        contextSize: config.contextSize,
        signal,
      };

      debugLogger.logReasoning("LOCAL_BRIDGE_INFERENCE", {
        modelId,
        config: inferenceConfig,
      });

      const result = await modelManager.runInference(modelId, text, inferenceConfig);
      const stripThinking = config.disableThinking !== false;

      const stripped: string = stripThinking
        ? (await import("../helpers/stripThinking.js")).stripThinkingTags(result)
        : result.trim();

      const cleanResult = stripped;

      const processingTime = Date.now() - startTime;

      debugLogger.logReasoning("LOCAL_BRIDGE_SUCCESS", {
        modelId,
        processingTimeMs: processingTime,
        resultLength: cleanResult.length,
        resultPreview: cleanResult.substring(0, 100) + (cleanResult.length > 100 ? "..." : ""),
      });

      return cleanResult;
    } catch (error) {
      const processingTime = Date.now() - startTime;

      debugLogger.logReasoning("LOCAL_BRIDGE_ERROR", {
        modelId,
        processingTimeMs: processingTime,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      throw error;
    } finally {
      this.isProcessing = false;
    }
  }

  calculateMaxTokens(
    textLength: number,
    minTokens = 512,
    maxTokens = 2048,
    multiplier = 2
  ): number {
    return Math.max(minTokens, Math.min(textLength * multiplier, maxTokens));
  }
}

export default new LocalReasoningService();
