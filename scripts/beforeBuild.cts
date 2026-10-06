// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const { rebuild } = require("@electron/rebuild") as typeof import("@electron/rebuild");

// SAFETY: electron ships package.json with a string version; the same field
// drives electron-builder, and this is the installed version the rebuild needs.
const installedElectronVersion: string = (require("electron/package.json") as { version: string })
  .version;

// Node tests and Electron use different SQLite ABIs. A Node prebuild replaces
// the binary without invalidating electron-rebuild's .forge-meta marker.
// Force the supported rebuild path so packaging never trusts that stale marker.
module.exports = async function beforeBuild({
  appDir,
  electronVersion,
  platform,
  arch,
}: import("electron-builder").BeforeBuildContext) {
  await rebuild({
    buildPath: appDir,
    electronVersion: electronVersion || installedElectronVersion,
    platform: platform.nodeName,
    arch,
    force: true,
    useCache: false,
    mode: "sequential",
  });

  // Keep electron-builder's pnpm dependency collection enabled. Its subsequent
  // cached rebuild check now sees metadata for the binary we actually installed.
  return true;
};

export type {};
