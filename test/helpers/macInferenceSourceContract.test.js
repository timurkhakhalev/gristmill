const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("macOS inference has no CUDA or Vulkan control plane", () => {
  const sources = [
    read("src/helpers/whisperServer.ts"),
    read("src/helpers/ipcHandlers.js"),
    read("preload.js"),
    read("src/types/electron.ts"),
  ].join("\n");

  assert.doesNotMatch(sources, /whisperCudaManager|whisperVulkanManager|llamaVulkanManager/);
  assert.doesNotMatch(sources, /(?:cuda|vulkan)-(?:whisper|gpu|download)/i);
  assert.doesNotMatch(sources, /(?:detect|list|set|get)-gpu|gpu-device-index/i);
  for (const file of [
    "src/helpers/whisperCudaManager.js",
    "src/helpers/whisperVulkanManager.js",
    "src/helpers/llamaVulkanManager.js",
    "src/utils/gpuDetection.js",
    "src/utils/vulkanDetection.js",
  ]) {
    assert.equal(fs.existsSync(path.join(root, file)), false, file);
  }
});

test("whisper server argv keeps local Metal/CPU inference options", () => {
  const WhisperServerManager = require("../../src/helpers/whisperServer");
  const args = WhisperServerManager.buildWhisperServerArgs({
    modelPath: "/tmp/model.bin",
    port: 8178,
    language: "auto",
  });

  assert.equal(args.includes("--device"), false);
  assert.equal(args.includes("--gpu-layers"), false);
  assert.equal(args.includes("--model"), true);
});
