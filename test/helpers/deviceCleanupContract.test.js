const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ipcHandlersSource = fs.readFileSync(
  path.join(__dirname, "../../src/helpers/ipcHandlers.js"),
  "utf8"
);

const cleanupHandler = ipcHandlersSource.match(
  /ipcMain\.handle\("cleanup-app", async \(event\) => \{([\s\S]*?)ipcMain\.handle\("set-hotkey-listening-mode"/
);

test("explicit device cleanup covers models, credentials, caches, and browser settings", () => {
  assert.ok(cleanupHandler, "cleanup-app handler is present");
  const source = cleanupHandler[1];

  for (const operation of [
    "deleteAllParakeetModels",
    "diarizationManager?.deleteModels",
    "modelManager.deleteAllModels",
    "environmentManager?.clearAllPersistedData",
    "clearStorageData",
    "clearCache",
    "setAutoStartEnabled(false)",
  ]) {
    assert.ok(source.includes(operation), `device cleanup includes ${operation}`);
  }


});
