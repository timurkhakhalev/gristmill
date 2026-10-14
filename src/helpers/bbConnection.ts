import http from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { z } from "zod";

// The bb CLI reads its server only from BB_SERVER_URL; otherwise it uses the local
// bb server. A bb that moved its server to another machine keeps the remote URL and
// the machine credential in <dataDir>/config.json, and only its own threads get a
// loopback proxy that adds the credential. Gristmill starts from Finder, so it
// resolves the connection itself and gives the CLI an equivalent loopback proxy.

const bbConfigSchema = z.object({
  serverUrl: z.url({ protocol: /^https?$/ }).optional(),
  serverHeaders: z.record(z.string(), z.string()).optional(),
});

export interface BbCliEnvironment {
  BB_SERVER_URL?: string;
  BB_HOST_DAEMON_PORT?: string;
}

const LOOPBACK = "127.0.0.1";

// Hop-by-hop headers belong to one connection; the proxy never forwards them.
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

interface BbProxy {
  url: string;
  server: http.Server;
  sockets: Set<Socket>;
}

let proxy: { key: string; pending: Promise<BbProxy> } | null = null;

function bbDataDir(): string {
  return process.env.BB_DATA_DIR?.trim() || join(homedir(), ".bb");
}

function readOptional(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;

    throw error;
  }
}

function hostDaemonPort(dataDir: string): string | undefined {
  const value = readOptional(join(dataDir, "host-daemon-port"))?.trim();

  return value && /^\d{1,5}$/.test(value) && Number(value) <= 65_535 ? value : undefined;
}

function upstreamHeaders(
  headers: http.IncomingHttpHeaders,
  target: URL,
  serverHeaders: Record<string, string>,
  keepUpgrade: boolean
): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = {};

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name === "host" || HOP_HEADERS.has(name)) continue;
    result[name] = value;
  }

  if (keepUpgrade) {
    result.connection = "Upgrade";

    if (headers.upgrade) result.upgrade = headers.upgrade;
  }

  result.host = target.host;

  return { ...result, ...serverHeaders };
}

function downstreamHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  return Object.fromEntries(
    Object.entries(headers).filter(([name, value]) => value !== undefined && !HOP_HEADERS.has(name))
  );
}

/** Only the local bb CLI may use the credential: no browser origin, no rebound host name. */
function isLocalCliRequest(request: http.IncomingMessage, port: number): boolean {
  if (request.headers.origin !== undefined || request.headers["sec-fetch-site"] !== undefined)
    return false;

  return [`${LOOPBACK}:${port}`, `localhost:${port}`].includes(request.headers.host ?? "");
}

/**
 * The upstream URL for a request target, or null when the target could leave the
 * configured server: an absolute or scheme-relative URL would carry the credential
 * to a different host.
 */
function upstreamUrl(requestTarget: string | undefined, target: URL): URL | null {
  if (!requestTarget?.startsWith("/") || requestTarget.startsWith("//")) return null;

  try {
    const url = new URL(requestTarget, target.origin);

    return url.origin === target.origin ? url : null;
  } catch {
    return null;
  }
}

function rejectSocket(socket: Socket, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Loopback proxy that adds the bb machine credential to each request to the remote server. */
async function startBbProxy(
  serverUrl: string,
  serverHeaders: Record<string, string>
): Promise<BbProxy> {
  const target = new URL(serverUrl);
  const transport = target.protocol === "https:" ? https : http;
  const sockets = new Set<Socket>();
  let port = 0;

  const server = http.createServer((request, response) => {
    if (!isLocalCliRequest(request, port)) {
      response.writeHead(403).end();

      return;
    }

    const url = upstreamUrl(request.url, target);

    if (!url) {
      response.writeHead(400).end();

      return;
    }

    const upstream = transport.request(url, {
      method: request.method,
      headers: upstreamHeaders(request.headers, target, serverHeaders, false),
    });

    upstream.on("response", (reply) => {
      response.writeHead(reply.statusCode ?? 502, downstreamHeaders(reply.headers));
      reply.pipe(response);
    });
    upstream.on("error", () => {
      if (response.headersSent) response.destroy();
      else response.writeHead(502).end();
    });
    request.pipe(upstream);
  });

  server.on("upgrade", (request: http.IncomingMessage, client: Socket, head: Buffer) => {
    if (!isLocalCliRequest(request, port)) {
      rejectSocket(client, 403, "Forbidden");

      return;
    }

    const url = upstreamUrl(request.url, target);

    if (!url) {
      rejectSocket(client, 400, "Bad Request");

      return;
    }

    const upstream = transport.request(url, {
      method: request.method,
      headers: upstreamHeaders(request.headers, target, serverHeaders, true),
    });

    upstream.on("upgrade", (reply, remote: Socket, remoteHead: Buffer) => {
      const lines = [`HTTP/1.1 ${reply.statusCode ?? 101} ${reply.statusMessage ?? ""}`];

      for (let index = 0; index < reply.rawHeaders.length; index += 2)
        lines.push(`${reply.rawHeaders[index]}: ${reply.rawHeaders[index + 1]}`);

      client.write(`${lines.join("\r\n")}\r\n\r\n`);

      if (remoteHead.length) client.write(remoteHead);

      if (head.length) remote.write(head);

      remote.pipe(client).pipe(remote);
      remote.on("error", () => client.destroy());
      client.on("error", () => remote.destroy());
      remote.on("close", () => client.destroy());
      client.on("close", () => remote.destroy());
    });
    upstream.on("response", (reply) => {
      rejectSocket(client, reply.statusCode ?? 502, reply.statusMessage ?? "");
      reply.resume();
    });
    upstream.on("error", () => rejectSocket(client, 502, "Bad Gateway"));
    upstream.end();
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK, () => {
      server.off("error", reject);
      resolve();
    });
  });

  // The proxy must not keep the app alive at quit.
  server.unref();
  port = z.object({ port: z.number().int().positive() }).parse(server.address()).port;

  return { url: `http://${LOOPBACK}:${port}`, server, sockets };
}

function closeProxy(pending: Promise<BbProxy>): void {
  pending.then(
    ({ server, sockets }) => {
      server.close();

      for (const socket of sockets) socket.destroy();
    },
    () => {}
  );
}

async function proxyUrl(serverUrl: string, serverHeaders: Record<string, string>): Promise<string> {
  const key = JSON.stringify([serverUrl, serverHeaders]);

  if (proxy?.key !== key) {
    if (proxy) closeProxy(proxy.pending);
    const pending = startBbProxy(serverUrl, serverHeaders);
    const entry = { key, pending };
    proxy = entry;
    pending.catch(() => {
      if (proxy === entry) proxy = null;
    });
  }

  return (await proxy.pending).url;
}

/**
 * Environment for one bb CLI call. An explicit BB_SERVER_URL (a bb thread or a
 * development shell) wins. The config is read again on each call, so a later bb
 * server move takes effect without an app restart.
 */
export async function resolveBbCliEnvironment(): Promise<BbCliEnvironment> {
  if (process.env.BB_SERVER_URL?.trim()) return {};

  const dataDir = bbDataDir();
  const port = process.env.BB_HOST_DAEMON_PORT?.trim() ? undefined : hostDaemonPort(dataDir);
  const environment: BbCliEnvironment = port ? { BB_HOST_DAEMON_PORT: port } : {};
  const raw = readOptional(join(dataDir, "config.json"));

  if (raw === null) return environment;

  let config: z.infer<typeof bbConfigSchema>;

  try {
    config = bbConfigSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error(`bb config at ${join(dataDir, "config.json")} is invalid`);
  }

  if (!config.serverUrl) return environment;

  const headers = config.serverHeaders ?? {};

  return {
    ...environment,
    BB_SERVER_URL: Object.keys(headers).length
      ? await proxyUrl(config.serverUrl, headers)
      : config.serverUrl,
  };
}

/** Stops the credential proxy. bb CLI calls after this start a new one. */
export function closeBbConnection(): void {
  if (proxy) closeProxy(proxy.pending);
  proxy = null;
}
