const base = require("./electron-builder.json");

module.exports = {
  ...base,
  appId: "com.openhercules.desktop.dev",
  productName: "OpenHercules Dev",
  directories: { ...base.directories, output: "dist-dev" },
  protocols: { name: "OpenHercules Dev Protocol", schemes: ["openhercules-dev"] },
  extraMetadata: { openherculesChannel: "development" },
  extraResources: [
    { ...base.extraResources[0], filter: ["**/*"] },
    ...base.extraResources.slice(1),
  ],
  mac: {
    ...base.mac,
    icon: "src/assets/iconDev.icns",
    extraResources: [],
    extendInfo: { ...base.mac.extendInfo, CFBundleIconName: "icon" },
  },
  dmg: { ...base.dmg, title: "OpenHercules Dev", icon: "src/assets/iconDev.icns" },
};
