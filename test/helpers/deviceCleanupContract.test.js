const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// The cleanup-app handler lives in the typed desktop settings module; the
// manager-owned steps it drives are wired as narrow callbacks in
// ipcHandlers.js. Both sides are pinned at the source level.
const desktopSettingsSource = fs.readFileSync(
  path.join(__dirname, "../../src/helpers/desktopSettingsIpcHandlers.ts"),
  "utf8"
);
const ipcHandlersSource = fs.readFileSync(
  path.join(__dirname, "../../src/helpers/ipcHandlers.ts"),
  "utf8"
);

const cleanupHandler = desktopSettingsSource.match(
  /ipcMain\.handle\(\s*desktopSettingsChannels\.cleanupApp, async \(event\) => \{([\s\S]*?)\n {2}\}\);/
);

test("explicit device cleanup covers models, credentials, caches, and browser settings", () => {
  assert.ok(cleanupHandler, "cleanup-app handler is present");
  const source = cleanupHandler[1];

  for (const operation of [
    "deleteParakeetModels",
    "deleteDiarizationModels",
    "deleteLlmModels",
    "clearAllPersistedData",
    "clearStorageData",
    "clearCache",
    "setAutoStartEnabled(false)",
  ]) {
    assert.ok(source.includes(operation), `device cleanup includes ${operation}`);
  }
});

test("the cleanup seams wire every manager-owned step from the composition root", () => {
  for (const seam of [
    "deleteAllParakeetModels",
    "diarizationManager.deleteModels",
    "modelManagerBridge\").default.deleteAllModels",
    "environmentManager.clearAllPersistedData",
    "googleCalendarManager.revokeAllTokens",
    "databaseManager.db.close",
  ]) {
    assert.ok(
      ipcHandlersSource.includes(seam),
      `cleanup seam wired: ${seam}`
    );
  }
});
