const { rebuild } = require("@electron/rebuild");
const installedElectronVersion = require("electron/package.json").version;

// Node tests and Electron use different SQLite ABIs. A Node prebuild replaces
// the binary without invalidating electron-rebuild's .forge-meta marker.
// Force the supported rebuild path so packaging never trusts that stale marker.
module.exports = async function beforeBuild({ appDir, electronVersion, platform, arch }) {
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
