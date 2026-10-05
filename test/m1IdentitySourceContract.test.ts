const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const path: typeof import("node:path") = require("node:path");

const test: typeof import("node:test") = require("node:test");

const root = path.join(__dirname, "..");

const read = (file: string): string => fs.readFileSync(path.join(root, file), "utf8");

test("M1 build identity belongs to Gristmill and has no publish destination", () => {
  const builder = JSON.parse(read("electron-builder.json"));

  assert.equal(builder.appId, "com.khakhalev.gristmill");
  assert.equal(builder.productName, "Gristmill");
  assert.deepEqual(builder.protocols, {
    name: "Gristmill Protocol",
    schemes: ["gristmill"],
  });
  assert.equal("publish" in builder, false);
  assert.equal("win" in builder, false);
  assert.equal("identity" in builder.mac, false);
  assert.equal("notarize" in builder.mac, false);
});

test("M1 main process selects an Gristmill-only profile and protocol", () => {
  const source = read("main.ts");

  assert.match(source, /GRISTMILL_CHANNEL/);
  assert.match(source, /gristmill-dev/);
  assert.match(source, /production: "gristmill"/);
  assert.match(source, /path\.join\(app\.getPath\("appData"\), profileName\)/);
  assert.doesNotMatch(source, /setDesktopName|setAppUserModelId/);
  assert.doesNotMatch(source, /registerOpenWhisprProtocol|OPENWHISPR_PROTOCOL/);
  assert.doesNotMatch(
    source,
    /migrateCookieToBearerToken\(\)|applyOpenWhisprOriginHeader|startAuthBridgeServer|exchangeSignedTokenForRawBearer/
  );
});

test("M1 secrets, local storage, and renderer sessions use Gristmill namespaces", () => {
  assert.match(read("src/helpers/secretCrypto.ts"), /const SERVICE = "Gristmill"/);
  assert.match(read("src/helpers/modelDirUtils.ts"), /\.cache", "gristmill/);
  assert.match(read("src/helpers/cliBridge.ts"), /"\.cli-read-connection\.json"/);
  assert.match(read("src/helpers/windowConfig.ts"), /persist:gristmill/);
  assert.match(read("src/helpers/windowConfig.ts"), /partition: GRISTMILL_SESSION_PARTITION/);
});

test("M1 removes updater and old-bundle migration runtime", () => {
  assert.equal(fs.existsSync(path.join(root, "src/updater.js")), false);
  assert.equal(fs.existsSync(path.join(root, "src/hooks/useUpdater.ts")), false);
  assert.equal(fs.existsSync(path.join(root, "src/helpers/postMigrationDetector.js")), false);
  assert.equal(fs.existsSync(path.join(root, "src/components/PostMigrationOnboarding.tsx")), false);
  assert.doesNotMatch(read("main.ts"), /electron-updater|checkForUpdatesOnStartup|UpdateManager/);
  assert.doesNotMatch(
    read("preload.ts"),
    /checkForUpdates|downloadUpdate|installUpdate|onUpdateAvailable/
  );
  assert.doesNotMatch(
    read("src/helpers/ipcHandlers.ts"),
    /check-for-updates|download-update|install-update/
  );
});
