const { shell } = require("electron");

async function openExternalUrl(url) {
  const parsed = new URL(url);
  return shell.openExternal(parsed.href);
}

module.exports = { openExternalUrl };
