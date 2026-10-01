import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import identity from "../../extension/identity.json";
import { companionAuthenticationSchema, companionBrowserMessageSchema, companionDesktopMessageSchema,
  type CompanionBrowserMessage, type CompanionDesktopMessage } from "../contracts/companion.js";
import { CompanionFrameDecoder, writeCompanionFrame } from "./companionFrames.js";

export interface CompanionConnectionFile { socketPath: string; credential: string }
export interface CompanionConnection { id: string; installationId: string; sessionId: string }
type Snapshot = Omit<Extract<CompanionDesktopMessage, { type: "snapshot" }>, "version" | "type" | "connectionId">;
export interface CompanionServerOptions {
  profilePath: string;
  snapshot(): Snapshot;
  onMessage(connection: CompanionConnection, message: Exclude<CompanionBrowserMessage, { type: "hello" }>, send: (message: CompanionDesktopMessage) => void): void;
  onDisconnect?(connection: CompanionConnection): void;
}

export function assertPrivateCompanionDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
    throw new Error("Companion directory is not private");
  }
}

/** Profile-owned server; Chrome profiles get distinct server-assigned connection identities. */
export class CompanionServer {
  private readonly server = net.createServer((socket) => this.accept(socket));
  private readonly sockets = new Map<net.Socket, CompanionConnection | null>();
  private readonly credential = randomBytes(32).toString("hex");
  private readonly directory: string;
  private readonly socketDirectory: string;
  readonly connectionFile: string;
  readonly socketPath: string;
  constructor(private readonly options: CompanionServerOptions) {
    this.directory = path.join(options.profilePath, "companion");
    this.connectionFile = path.join(this.directory, "connection.json");
    const profileHash = createHash("sha256").update(path.resolve(options.profilePath)).digest("hex").slice(0, 16);
    this.socketDirectory = path.join("/tmp", `gristmill-companion-${process.getuid?.()}-${profileHash}`);
    this.socketPath = path.join(this.socketDirectory, "host.sock");
    this.server.on("error", () => { for (const socket of this.sockets.keys()) socket.destroy(); });
  }
  async start(): Promise<void> {
    assertPrivateCompanionDirectory(this.directory);
    assertPrivateCompanionDirectory(this.socketDirectory);
    if (fs.existsSync(this.socketPath)) {
      const active = await new Promise<boolean>((resolve, reject) => {
        const probe = net.connect(this.socketPath);
        probe.once("connect", () => { probe.destroy(); resolve(true); });
        probe.once("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
          else reject(error);
        });
      });
      if (active) throw new Error("Companion profile is already served");
      fs.unlinkSync(this.socketPath);
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => { this.server.removeListener("error", reject); resolve(); });
    });
    fs.chmodSync(this.socketPath, 0o600);
    const temporary = `${this.connectionFile}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ socketPath: this.socketPath, credential: this.credential }), { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, this.connectionFile);
    } catch (error) { await this.stop(); throw error; }
    finally { fs.rmSync(temporary, { force: true }); }
  }
  broadcastSnapshot(): void {
    for (const [socket, connection] of this.sockets) if (connection) this.send(socket, {
      version: 1, type: "snapshot", connectionId: connection.id, ...this.options.snapshot(),
    });
  }
  async stop(): Promise<void> {
    for (const socket of this.sockets.keys()) socket.destroy();
    if (this.server.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()));
    try {
      const saved = JSON.parse(fs.readFileSync(this.connectionFile, "utf8")) as CompanionConnectionFile;
      if (saved.credential === this.credential) fs.unlinkSync(this.connectionFile);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { fs.rmdirSync(this.socketDirectory); } catch (error) {
      if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  private send(socket: net.Socket, message: CompanionDesktopMessage): void {
    try { writeCompanionFrame(socket, companionDesktopMessageSchema.parse(message)); }
    catch { socket.destroy(); }
  }
  private accept(socket: net.Socket): void {
    if (this.sockets.size >= 32) { socket.destroy(); return; }
    this.sockets.set(socket, null);
    let authenticated = false;
    let connection: CompanionConnection | null = null;
    let sequence = -1;
    socket.setTimeout(10_000, () => socket.destroy());
    const decoder = new CompanionFrameDecoder((value) => {
      if (!authenticated) {
        const auth = companionAuthenticationSchema.parse(value);
        if (auth.origin !== `chrome-extension://${identity.extensionId}/` || !timingSafeEqual(Buffer.from(auth.credential), Buffer.from(this.credential))) throw new Error("Companion authentication rejected");
        authenticated = true;
        return;
      }
      const message = companionBrowserMessageSchema.parse(value);
      if (!connection) {
        if (message.type !== "hello") throw new Error("Companion hello required");
        connection = { id: randomUUID(), installationId: message.installationId, sessionId: message.sessionId };
        this.sockets.set(socket, connection);
        socket.setTimeout(0);
        this.send(socket, { version: 1, type: "snapshot", connectionId: connection.id, ...this.options.snapshot() });
        return;
      }
      if (message.type === "hello" || message.sequence !== sequence + 1 || message.ref.installationId !== connection.installationId || message.ref.sessionId !== connection.sessionId) throw new Error("Stale companion message");
      sequence = message.sequence;
      this.options.onMessage(connection, message, (reply) => this.send(socket, reply));
    });
    socket.on("data", (chunk) => { try { decoder.push(chunk); } catch { socket.destroy(); } });
    socket.once("error", () => socket.destroy());
    socket.once("end", () => socket.destroy());
    socket.once("close", () => { this.sockets.delete(socket); if (connection) this.options.onDisconnect?.(connection); });
  }
}
