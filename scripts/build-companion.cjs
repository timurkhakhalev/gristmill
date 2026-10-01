const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const identities = require("../extension/identity.json");
const version = "0.2.0";
execFileSync(path.join(root, "node_modules", ".bin", "tsc"), ["-p", "extension/tsconfig.json"], { cwd: root, stdio: "inherit" });
for (const [channel, identity] of Object.entries(identities)) {
  const dev = channel === "development";
  const output = path.join(root, "build", dev ? "companion-dev" : "companion");
  fs.mkdirSync(output, { recursive: true });
  for (const entry of ["worker", "popup", "content"]) {
    execFileSync(path.join(root, "node_modules", ".bin", "esbuild"), [path.join(root, "extension", "src", `${entry}.ts`),
      `--outfile=${path.join(output, `${entry}.js`)}`, "--bundle", "--platform=browser", "--target=chrome121", "--format=iife", "--minify-syntax",
      `--define:COMPANION_DEV=${dev}`, `--define:COMPANION_HOST_NAME=${JSON.stringify(identity.hostName)}`,
      `--define:COMPANION_VERSION=${JSON.stringify(version)}`], { cwd: root, stdio: "inherit" });
  }
  const html = fs.readFileSync(path.join(root, "extension", "popup.html"), "utf8");
  fs.writeFileSync(path.join(output, "popup.html"), dev ? html : html.replace(/<!-- DEV-ONLY-START -->[\s\S]*?<!-- DEV-ONLY-END -->/, ""));
  fs.cpSync(path.join(root, "extension", "icons", channel), path.join(output, "icons"), { recursive: true });
  const icons = Object.fromEntries([16, 32, 48, 128].map(size => [size, `icons/${size}.png`]));
  fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify({
    manifest_version: 3, name: dev ? "Gristmill Companion (Dev)" : "Gristmill Companion", version, minimum_chrome_version: "121",
    description: "Speaker name suggestions and call controls for your local Gristmill recordings. Currently supports Google Meet.", key: identity.publicKey, icons,
    permissions: ["nativeMessaging", "storage", "alarms"], host_permissions: ["https://meet.google.com/*"],
    content_scripts: [{ matches: ["https://meet.google.com/*"], js: ["content.js"], run_at: "document_idle" }],
    background: { service_worker: "worker.js" }, action: { default_popup: "popup.html", default_title: dev ? "Gristmill Companion (Dev)" : "Gristmill Companion", default_icon: icons },
  }, null, 2) + "\n");
}
