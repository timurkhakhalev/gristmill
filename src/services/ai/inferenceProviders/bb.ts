import type { InferenceProvider } from "./types";

export const bbProvider: InferenceProvider = {
  id: "bb",
  async call({ text, config }) {
    if (!config.agentSelection) throw new Error("bb selection is missing");

    return window.electronAPI.bbGenerate(
      `${config.systemPrompt || ""}\n\n${text}`.trim(),
      config.agentSelection
    );
  },
};
