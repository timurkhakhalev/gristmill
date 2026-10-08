import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import identities from "../../extension/identity.json";
import {
  companionBrowserMessageSchema,
  companionDesktopMessageSchema,
} from "../contracts/companion.js";
import { CompanionFrameDecoder, writeCompanionFrame } from "./companionFrames.js";

interface CompanionConnectionFile {
  socketPath: string;
  credential: string;
}

function isCompanionConnection(value: unknown): value is CompanionConnectionFile {
  return (
    typeof value === "object" &&
    value !== null &&
    "socketPath" in value &&
    typeof value.socketPath === "string" &&
    "credential" in value &&
    typeof value.credential === "string"
  );
}

/** Chrome launches this entry with Electron's bundled Node runtime. Stdout is protocol-only. */
export function runCompanionNativeHost(args: string[]): void {
  const [profilePath, channel, origin] = args;

  if (
    args.length !== 3 ||
    !path.isAbsolute(profilePath) ||
    (channel !== "development" && channel !== "production") ||
    origin !== `chrome-extension://${identities[channel].extensionId}/`
  ) {
    process.exitCode = 1;

    return;
  }

  let connection: { socketPath: string; credential: string };

  try {
    const directory = path.join(profilePath, "companion");
    const directoryStat = fs.lstatSync(directory);
    const filename = path.join(directory, "connection.json");
    const stat = fs.lstatSync(filename);

    if (
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      directoryStat.mode & 0o077 ||
      directoryStat.uid !== process.getuid?.() ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 4096 ||
      stat.mode & 0o077 ||
      stat.uid !== process.getuid?.()
    )
      throw new Error("Invalid companion connection file");
    const decoded: unknown = JSON.parse(fs.readFileSync(filename, "utf8"));

    if (
      !isCompanionConnection(decoded) ||
      !path.isAbsolute(decoded.socketPath) ||
      !/^[a-f0-9]{64}$/.test(decoded.credential)
    )
      throw new Error("Invalid companion connection");
    connection = decoded;
  } catch {
    writeCompanionFrame(process.stdout, {
      version: 1,
      type: "unavailable",
      reason: "app-unavailable",
    });

    return;
  }

  const socket = net.connect(connection.socketPath);

  const stop = () => {
    socket.destroy();
    process.stdin.pause();
    process.stdin.destroy();
  };

  const browser = new CompanionFrameDecoder((value) =>
    writeCompanionFrame(socket, companionBrowserMessageSchema.parse(value))
  );

  const desktop = new CompanionFrameDecoder((value) =>
    writeCompanionFrame(process.stdout, companionDesktopMessageSchema.parse(value))
  );

  process.stdin.pause();
  socket.setTimeout(10_000, stop);
  socket.once("connect", () => {
    socket.setTimeout(0);
    writeCompanionFrame(socket, {
      version: 1,
      type: "authenticate",
      credential: connection.credential,
      origin,
    });
    process.stdin.resume();
  });
  process.stdin.on("data", (chunk: Buffer) => {
    try {
      browser.push(chunk);
    } catch {
      stop();
    }
  });
  process.stdin.once("end", () => {
    try {
      browser.finish();
    } catch {
      process.exitCode = 1;
    }

    stop();
  });
  process.stdin.once("error", stop);
  process.stdout.once("error", stop);
  socket.on("data", (chunk) => {
    try {
      desktop.push(chunk);
    } catch {
      stop();
    }
  });
  socket.once("error", () => {
    try {
      writeCompanionFrame(process.stdout, {
        version: 1,
        type: "unavailable",
        reason: "app-unavailable",
      });
    } catch {
      /* Chrome already disconnected. */
    }

    stop();
  });
  socket.once("end", stop);
  socket.once("close", stop);
}

if (require.main === module) runCompanionNativeHost(process.argv.slice(2));
