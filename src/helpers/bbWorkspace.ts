import fs from "node:fs";
import path from "node:path";

const TOOL_SCRIPT = `import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const { port, token } = JSON.parse(fs.readFileSync(path.join(directory, "..", ".bb-connection.json"), "utf8"));
const [method, route, body] = process.argv.slice(2);
const allowed = new Set([
  "GET /v1/notes", "GET /v1/notes/search", "GET /v1/notes/", "GET /v1/notes/content", "GET /v1/notes/summary", "GET /v1/notes/transcript",
  "POST /v1/notes/create", "PATCH /v1/notes/",
  "GET /v1/folders/list", "POST /v1/folders/create",
  "GET /v1/dictionary/list", "POST /v1/dictionary/update",
  "GET /v1/snippets/list", "POST /v1/snippets/update",
]);
if (!route?.startsWith("/") || route.startsWith("//")) throw new Error("Invalid Gristmill tool route");
const url = new URL(route, "http://127.0.0.1");
const pathname = url.pathname;
const key = method + " " + (pathname.replace(/^\\/v1\\/notes\\/\\d+(?=\\/|$)/, "/v1/notes/").replace("//", "/"));
if (!allowed.has(key)) throw new Error("Unsupported Gristmill tool route");
const response = await fetch("http://127.0.0.1:" + port + pathname + url.search, {
  method,
  headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
  ...(body ? { body } : {}),
});
const result = await response.text();
if (!response.ok) throw new Error(result || "Gristmill tool failed: " + response.status);
process.stdout.write(result || "{}");
`;

export function bbWorkspacePath(userData: string): string {
  return path.join(userData, "bb-agent");
}

export function ensureBbWorkspace(userData: string): string {
  const directory = bbWorkspacePath(userData);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const instructions = path.join(directory, "AGENTS.md");
  if (fs.existsSync(instructions) && fs.readFileSync(instructions, "utf8").startsWith("# Gristmill agent\n")) {
    fs.rmSync(instructions);
  }
  const target = path.join(directory, "gristmill-tools.mjs");
  if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== TOOL_SCRIPT) {
    fs.writeFileSync(target, TOOL_SCRIPT, { mode: 0o600 });
  }
  return directory;
}

export function writeBbConnection(userData: string, port: number, token: string): void {
  ensureBbWorkspace(userData);
  const filePath = path.join(userData, ".bb-connection.json");
  fs.writeFileSync(filePath, JSON.stringify({ port, token }), { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

export function removeBbConnection(userData: string): void {
  fs.rmSync(path.join(userData, ".bb-connection.json"), { force: true });
}
