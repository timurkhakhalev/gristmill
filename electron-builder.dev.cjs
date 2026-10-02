const base = require("./electron-builder.json");

module.exports = {
  ...base,
  appId: "com.khakhalev.gristmill.dev",
  productName: "Gristmill Dev",
  directories: { ...base.directories, output: "dist-dev" },
  protocols: { name: "Gristmill Dev Protocol", schemes: ["gristmill-dev"] },
  extraMetadata: { gristmillChannel: "development" },
  extraResources: [
    { ...base.extraResources[0], filter: ["**/*"] },
    ...base.extraResources.slice(1).map(resource => resource.to === "companion"
      ? { ...resource, from: "build/companion-dev", to: "companion-dev" }
      : resource),
  ],
  mac: {
    ...base.mac,
    icon: "src/assets/iconDev.icns",
    extraResources: [],
    extendInfo: { ...base.mac.extendInfo, CFBundleIconName: "icon" },
  },
  dmg: { ...base.dmg, title: "Gristmill Dev", icon: "src/assets/iconDev.icns" },
};
