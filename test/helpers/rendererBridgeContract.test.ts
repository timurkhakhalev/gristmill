const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const path: typeof import("node:path") = require("node:path");

const vm: typeof import("node:vm") = require("node:vm");

const root = path.resolve(__dirname, "../..");

const bundledPreload = path.join(root, "dist-main", "preload.js");

function loadBridge() {
  let api: Record<string, unknown> | undefined;
  vm.runInNewContext(fs.readFileSync(bundledPreload, "utf8"), {
    // The bundle keeps CJS interop for hybrid manifest modules, so the
    // sandbox needs the same bindings Node's CJS loader provides.
    module: { exports: {} },
    exports: {},
    require(name: string) {
      assert.equal(name, "electron");

      return {
        contextBridge: {
          exposeInMainWorld: (_name: string, value: unknown) => {
            if (typeof value === "object" && value !== null) api = value as Record<string, unknown>;
          },
        },
        ipcRenderer: { on() {}, send() {}, invoke: async () => {}, removeListener() {} },
        webUtils: { getPathForFile: () => "" },
      };
    },
    process: { platform: "darwin", versions: {} },
  });
  const exposedApi = () => api;
  const result = exposedApi();
  assert.ok(result, "preload must expose the renderer API");

  return result;
}

test("the bundled preload is committed to the build output", () => {
});

test("every renderer Electron API reference is exposed by the packaged preload", () => {
  const api = loadBridge();
  const missing: unknown[] = [];

  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!["locales", "dist", "node_modules"].includes(entry.name)) walk(file);
        continue;
      }

      if (!/\.[jt]sx?$/.test(file) || file.endsWith("types/electron.ts")) continue;
      const source = fs.readFileSync(file, "utf8");

      for (const match of source.matchAll(/electronAPI\??\.(\w+)/g)) {
        if (!(match[1] in api)) missing.push(`${path.relative(root, file)}: ${match[1]}`);
      }
    }
  }

  walk(path.join(root, "src"));
  assert.deepEqual(missing, []);
});

test("meeting capture and full embedded chat retain their native bridge", () => {
  const api = loadBridge();

  for (const key of [
    "meetingTranscriptionPrepare",
    "meetingTranscriptionStart",
    "meetingTranscriptionSend",
    "meetingTranscriptionStop",
    "meetingTranscriptionCancel",
    "onMeetingTranscriptionSegment",
    "onMeetingSpeakerIdentified",
    "onMeetingSpeakersMerged",
    "readClipboard",
    "writeClipboard",
  ]) {
    assert.equal(typeof api[key], "function", key);
  }

  for (const key of [
    "pasteText",
    "captureSelectedText",
    "replaceSelectedText",
    "pasteAtCapturedTarget",
    "onOnboardingDemoEvent",
  ]) {
    assert.equal(api[key], undefined, key);
  }
});
