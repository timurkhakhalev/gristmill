const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("M1 build identity belongs to OpenHercules and has no publish destination", () => {
  const builder = JSON.parse(read("electron-builder.json"));

  assert.equal(builder.appId, "com.openhercules.desktop");
  assert.equal(builder.productName, "OpenHercules");
  assert.deepEqual(builder.protocols, {
    name: "OpenHercules Protocol",
    schemes: ["openhercules"],
  });
  assert.equal("publish" in builder, false);
  assert.equal("win" in builder, false);
  assert.equal("identity" in builder.mac, false);
  assert.equal("notarize" in builder.mac, false);
});

test("M1 main process selects an OpenHercules-only profile and protocol", () => {
  const source = read("main.js");

  assert.match(source, /OPENHERCULES_CHANNEL/);
  assert.match(source, /openhercules-dev/);
  assert.match(source, /production: "openhercules"/);
  assert.match(source, /path\.join\(app\.getPath\("appData"\), profileName\)/);
  assert.doesNotMatch(source, /setDesktopName|setAppUserModelId/);
  assert.doesNotMatch(source, /registerOpenWhisprProtocol|OPENWHISPR_PROTOCOL/);
  assert.doesNotMatch(
    source,
    /migrateCookieToBearerToken\(\)|applyOpenWhisprOriginHeader|startAuthBridgeServer|exchangeSignedTokenForRawBearer/
  );
});

test("M1 secrets, local storage, and renderer sessions use OpenHercules namespaces", () => {
  assert.match(read("src/helpers/secretCrypto.ts"), /const SERVICE = "OpenHercules"/);
  assert.match(read("src/lib/authAccountScope.ts"), /openhercules:accountScope/);
  assert.match(read("src/helpers/modelDirUtils.ts"), /\.cache", "openhercules/);
  assert.match(read("src/helpers/cliBridge.ts"), /"\.openhercules"/);
  assert.match(read("src/helpers/windowConfig.ts"), /persist:openhercules/);
  assert.match(read("src/helpers/windowConfig.ts"), /partition: OPENHERCULES_SESSION_PARTITION/);
});

test("M1 removes updater and old-bundle migration runtime", () => {
  assert.equal(fs.existsSync(path.join(root, "src/updater.js")), false);
  assert.equal(fs.existsSync(path.join(root, "src/hooks/useUpdater.ts")), false);
  assert.equal(fs.existsSync(path.join(root, "src/helpers/postMigrationDetector.js")), false);
  assert.equal(fs.existsSync(path.join(root, "src/components/PostMigrationOnboarding.tsx")), false);
  assert.doesNotMatch(read("main.js"), /electron-updater|checkForUpdatesOnStartup|UpdateManager/);
  assert.doesNotMatch(read("preload.js"), /checkForUpdates|downloadUpdate|installUpdate|onUpdateAvailable/);
  assert.doesNotMatch(read("src/helpers/ipcHandlers.js"), /check-for-updates|download-update|install-update/);
});
