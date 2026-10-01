import fs from "node:fs";
import path from "node:path";
import identity from "../../extension/identity.json";

const MARKER = "# Gristmill Google Meet native host (development)";
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
export interface CompanionHostInstallation {
  chromeRoot: string;
  profilePath: string;
  runtimePath: string;
  hostScriptPath: string;
}
function files(options: CompanionHostInstallation) {
  for (const value of Object.values(options)) if (!path.isAbsolute(value)) throw new Error("Companion installation requires absolute paths");
  const launcher = path.join(options.profilePath, "companion", "native-host.sh");
  const manifest = path.join(options.chromeRoot, "NativeMessagingHosts", `${identity.hostName}.json`);
  const content = `#!/bin/sh\n${MARKER}\nELECTRON_RUN_AS_NODE=1 exec ${quote(options.runtimePath)} ${quote(options.hostScriptPath)} ${quote(options.profilePath)} "$@"\n`;
  const registration = { name: identity.hostName, description: "Gristmill Google Meet integration (development)", path: launcher,
    type: "stdio", allowed_origins: [`chrome-extension://${identity.extensionId}/`] };
  return { launcher, manifest, content, registration };
}
function assertOwned(filename: string, owned: (contents: string) => boolean): void {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(filename); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || !owned(fs.readFileSync(filename, "utf8"))) throw new Error("Companion installation would replace an unmanaged file");
}
function ownsManifest(contents: string): boolean {
  try {
    const value = JSON.parse(contents);
    return value.name === identity.hostName && value.description === "Gristmill Google Meet integration (development)" &&
      value.type === "stdio" && JSON.stringify(value.allowed_origins) === JSON.stringify([`chrome-extension://${identity.extensionId}/`]);
  } catch { return false; }
}
function atomicWrite(filename: string, contents: string, mode: number): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.tmp`;
  try { fs.writeFileSync(temporary, contents, { mode, flag: "wx" }); fs.renameSync(temporary, filename); }
  finally { fs.rmSync(temporary, { force: true }); }
}
export function installCompanionHost(options: CompanionHostInstallation): string {
  const target = files(options);
  if (!fs.existsSync(options.runtimePath) || !fs.existsSync(options.hostScriptPath)) throw new Error("Companion runtime is unavailable");
  assertOwned(target.launcher, (value) => value.includes(MARKER));
  assertOwned(target.manifest, ownsManifest);
  atomicWrite(target.launcher, target.content, 0o700);
  atomicWrite(target.manifest, JSON.stringify(target.registration, null, 2) + "\n", 0o600);
  return target.manifest;
}
export function companionHostInstalled(options: CompanionHostInstallation): boolean {
  const target = files(options);
  try {
    assertOwned(target.launcher, (value) => value.includes(MARKER));
    assertOwned(target.manifest, ownsManifest);
    return fs.existsSync(options.runtimePath) && fs.existsSync(options.hostScriptPath) &&
    (fs.statSync(target.launcher).mode & 0o100) !== 0 && fs.readFileSync(target.launcher, "utf8") === target.content &&
    fs.readFileSync(target.manifest, "utf8") === JSON.stringify(target.registration, null, 2) + "\n"; } catch { return false; }
}
export function uninstallCompanionHost(options: CompanionHostInstallation): void {
  const target = files(options);
  assertOwned(target.launcher, (value) => value.includes(MARKER));
  assertOwned(target.manifest, (contents) => ownsManifest(contents) && JSON.parse(contents).path === target.launcher);
  fs.rmSync(target.manifest, { force: true });
  fs.rmSync(target.launcher, { force: true });
}
