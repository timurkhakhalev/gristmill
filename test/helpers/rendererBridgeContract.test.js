const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");
const bundledPreload = path.join(root, "dist-main", "preload.js");
function loadBridge() {
  let api;
  vm.runInNewContext(fs.readFileSync(bundledPreload, "utf8"), {
    require(name) {
      assert.equal(name, "electron");
      return {
        contextBridge: {
          exposeInMainWorld: (_name, value) => {
            api = value;
          },
        },
        ipcRenderer: { on() {}, send() {}, invoke: async () => {}, removeListener() {} },
        webUtils: { getPathForFile: () => "" },
      };
    },
    process: { platform: "darwin", versions: {} },
  });
  return api;
}

test("the bundled preload is committed to the build output", () => {
  assert.ok(fs.existsSync(bundledPreload), "Run pnpm run build:main first");
});

test("every renderer Electron API reference is exposed by the packaged preload", () => {
  const api = loadBridge();
  const missing = [];
  function walk(dir) {
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
