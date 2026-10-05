const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const load = () => import("../../src/utils/version.ts");

test("recognizes only canonical three-part app versions", async () => {
  const { isCanonicalAppVersion } = await load();

  for (const version of ["0.0.0", "1.8.1", "24.10.300"]) {
    assert.equal(isCanonicalAppVersion(version), true, version);
  }

  for (const version of ["1.8", "1.8.1.0", "01.8.1", "1.8.1-beta.1", "required", "1.x.1"]) {
    assert.equal(isCanonicalAppVersion(version), false, version);
  }
});

test("an invalid installed version never satisfies a valid minimum", async () => {
  const { compareAppVersions } = await load();

  assert.equal(compareAppVersions("required", "1.8.1"), -1);
  assert.equal(compareAppVersions("1.8.1-beta.1", "1.8.1"), -1);
  assert.equal(compareAppVersions("1.9.0", "1.8.1"), 1);
});

test("keeps renderer and main-process validation behavior aligned", async () => {
  const { isCanonicalAppVersion } = await load();
  const mainVersion: typeof import("../../src/helpers/appVersion.ts") = require("../../src/helpers/appVersion.ts");

  const versions = [
    undefined,
    null,
    1,
    "",
    "0.0.0",
    "1.8.1",
    "24.10.300",
    "1.8",
    "1.8.1.0",
    "01.8.1",
    "1.8.1-beta.1",
    "required",
    "1.x.1",
  ];

  for (const version of versions) {
    assert.equal(
      isCanonicalAppVersion(version),
      mainVersion.isCanonicalAppVersion(version),
      String(version)
    );
  }
});
