const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const path: typeof import("node:path") = require("node:path");

const test: typeof import("node:test") = require("node:test");

const {
  runElectronFixture,
}: typeof import("../lib/runElectronFixture.ts") = require("../lib/runElectronFixture.ts");

test("Electron uploads raw and multipart audio files", async (t) => {
  const { stdout } = await runElectronFixture(
    t,
    path.join(__dirname, "audioFileUploadElectron.ts")
  );

  assert.match(stdout, /audio file upload smoke passed/);
});
