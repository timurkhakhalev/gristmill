// Main-owned local (llama.cpp) one-shot reasoning. Preserves the JS service's
// one-active-request policy, config defaults, complete-output behavior and
// thinking cleanup; the model manager keeps owning llama-server lifecycle.
import modelManagerBundle from "../helpers/modelManagerBridge.js";
import debugLogger from "../helpers/debugLogger.js";
import type { LocalReasoningConfig } from "../contracts/reasoning.js";

interface LocalModelManager {
  ensureLlamaCpp(): Promise<unknown>;
  getAllModels(): Promise<Array<{ isDownloaded?: boolean }>>;
  runInference(modelId: string, prompt: string, options: Record<string, unknown>): Promise<string>;
}

// The bundle's `default` is the singleton under every loader: the tsx ESM
// graph resolves the default import to module.exports itself, the CJS graphs
// interop to the same object. Drill in once, here.
const modelManager: LocalModelManager = (modelManagerBundle as unknown as {
  default: LocalModelManager;
}).default;

export class LocalReasoningService {
  private isProcessing = false;

  async isAvailable(): Promise<boolean> {
    try {
      await modelManager.ensureLlamaCpp();
      const models = await modelManager.getAllModels();
      return models.some((model) => model.isDownloaded);
    } catch {
      return false;
    }
  }

  async processText(text: string, modelId: string, config: LocalReasoningConfig = {}): Promise<string> {
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
      const inferenceConfig = {
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
      };

      debugLogger.logReasoning("LOCAL_BRIDGE_INFERENCE", {
        modelId,
        config: inferenceConfig,
      });

      const result = await modelManager.runInference(modelId, text, inferenceConfig);
      const stripThinking = config.disableThinking !== false;
      const stripped: unknown = stripThinking
        ? (await import("../helpers/stripThinking.js")).stripThinkingTags(result)
        : result.trim();
      // runInference returns text; the guard only keeps the historical
      // pass-through from producing a non-string return type.
      const cleanResult = typeof stripped === "string" ? stripped : result.trim();

      const processingTime = Date.now() - startTime;

      debugLogger.logReasoning("LOCAL_BRIDGE_SUCCESS", {
        modelId,
        processingTimeMs: processingTime,
        resultLength: cleanResult.length,
        resultPreview: cleanResult.substring(0, 100) + (cleanResult.length > 100 ? "..." : ""),
      });

      return cleanResult;
    } catch (error) {
      const err = error as { message?: string; stack?: string };
      const processingTime = Date.now() - startTime;

      debugLogger.logReasoning("LOCAL_BRIDGE_ERROR", {
        modelId,
        processingTimeMs: processingTime,
        error: err.message,
        stack: err.stack,
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
