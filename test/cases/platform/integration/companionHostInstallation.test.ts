import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import identities from "../../../../extension/identity.json";
import { installCompanionHost, companionHostInstalled, uninstallCompanionHost, refreshCompanionHost } from "../../../../src/helpers/installCompanionHost.ts";
const identity = identities.development;


test("Dev registration uses one Chrome root and a quoted bundled-runtime launcher", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-host-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostScriptPath = path.join(root, "host's entry.cjs");
  fs.writeFileSync(hostScriptPath, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
  const options = { channel: "development" as const, chromeRoot: path.join(root, "Chrome User Data"), profilePath: path.join(root, "App's profile"), runtimePath: process.execPath, hostScriptPath };
  assert.equal(refreshCompanionHost(options), false);
  const manifestPath = installCompanionHost(options);
  assert.equal(path.relative(options.chromeRoot, manifestPath), `NativeMessagingHosts/${identity.hostName}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const origin = `chrome-extension://${identity.extensionId}/`;
  assert.deepEqual(manifest.allowed_origins, [origin]);
  const launched = spawnSync(manifest.path, [origin], { encoding: "utf8" });
  assert.equal(launched.status, 0, launched.stderr);
  assert.deepEqual(JSON.parse(launched.stdout), [options.profilePath, "development", origin]);
  assert.equal(companionHostInstalled(options), true);
  const relocated = { ...options, hostScriptPath: path.join(root, "relocated.cjs") };
  fs.copyFileSync(hostScriptPath, relocated.hostScriptPath);
  assert.equal(refreshCompanionHost({ ...relocated, profilePath: path.join(root, "other-profile") }), false);
  assert.equal(refreshCompanionHost(relocated), true);
  assert.equal(companionHostInstalled(relocated), true);
  assert.equal(companionHostInstalled(options), false);
  uninstallCompanionHost(relocated);
  assert.equal(fs.existsSync(manifestPath), false);
  assert.equal(fs.existsSync(manifest.path), false);
  const derivedId = createHash("sha256").update(Buffer.from(identity.publicKey, "base64")).digest("hex").slice(0, 32)
    .replace(/[0-9a-f]/g, (character) => String.fromCharCode(97 + parseInt(character, 16)));
  assert.equal(derivedId, identity.extensionId);
});

test("installer refuses foreign files and dangling symlinks", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-host-foreign-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { channel: "development" as const, chromeRoot: path.join(root, "Chrome"), profilePath: path.join(root, "App"), runtimePath: process.execPath, hostScriptPath: __filename };
  const directory = path.join(options.chromeRoot, "NativeMessagingHosts");
  fs.mkdirSync(directory, { recursive: true });
  const manifest = path.join(directory, `${identity.hostName}.json`);
  fs.writeFileSync(manifest, "foreign");
  assert.throws(() => installCompanionHost(options), /unmanaged/);
  assert.equal(fs.readFileSync(manifest, "utf8"), "foreign");
  fs.unlinkSync(manifest);
  fs.symlinkSync(path.join(root, "missing"), manifest);
  assert.throws(() => installCompanionHost(options), /unmanaged/);
  assert.equal(fs.lstatSync(manifest).isSymbolicLink(), true);
});


test("production and Dev registrations coexist and removal affects only the selected channel", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-host-channels-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installed = (["development", "production"] as const).map(channel => {
    const options = { channel, chromeRoot: path.join(root, "Chrome"), profilePath: path.join(root, channel), runtimePath: process.execPath, hostScriptPath: __filename };
    const filename = installCompanionHost(options);
    const manifest = JSON.parse(fs.readFileSync(filename, "utf8"));
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${identities[channel].extensionId}/`]);
    assert.equal(companionHostInstalled(options), true);
    const derivedId = createHash("sha256").update(Buffer.from(identities[channel].publicKey, "base64")).digest("hex").slice(0, 32)
      .replace(/[0-9a-f]/g, character => String.fromCharCode(97 + parseInt(character, 16)));
    assert.equal(derivedId, identities[channel].extensionId);
    return { options, filename };
  });
  assert.notEqual(identities.development.extensionId, identities.production.extensionId);
  uninstallCompanionHost(installed[0].options);
  assert.equal(fs.existsSync(installed[0].filename), false);
  assert.equal(companionHostInstalled(installed[1].options), true);
});
