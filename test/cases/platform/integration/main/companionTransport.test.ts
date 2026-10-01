import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import identity from "../../../../../extension/identity.json";
import { CompanionServer } from "../../../../../src/helpers/companionServer.ts";
import { CompanionFrameDecoder, writeCompanionFrame } from "../../../../../src/helpers/companionFrames.ts";
import type { CompanionDesktopMessage } from "../../../../../src/contracts/companion.ts";

const entry = path.resolve(__dirname, "../../../../../dist-main/src/helpers/companionNativeHost.js");
const extensionOriginValue = `chrome-extension://${identity.extensionId}/`;
function client(profile: string, extensionOrigin = extensionOriginValue) {
  const child = spawn(process.execPath, [entry, profile, extensionOrigin], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "pipe" });
  const exited = once(child, "exit");
  const waiting: Array<(value: CompanionDesktopMessage) => void> = [];
  const messages: CompanionDesktopMessage[] = [];
  const decoder = new CompanionFrameDecoder((value) => {
    const message = value as CompanionDesktopMessage;
    const receiver = waiting.shift();
    if (receiver) receiver(message); else messages.push(message);
  });
  child.stdout.on("data", (chunk: Buffer) => decoder.push(chunk));
  const installationId = randomUUID();
  const sessionId = randomUUID();
  writeCompanionFrame(child.stdin, { version: 1, type: "hello", installationId, sessionId });
  return { child, exited, installationId, sessionId,
    next: () => messages.length ? Promise.resolve(messages.shift()!) : new Promise<CompanionDesktopMessage>((resolve) => waiting.push(resolve)),
  };
}

test("real native hosts isolate Chrome connections and invalidate identity on EOF and replay", async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-companion-test-"));
  const received: string[] = [];
  const disconnected: string[] = [];
  const server = new CompanionServer({ profilePath: profile,
    snapshot: () => ({ recordingState: "idle", recordingId: null, binding: null, manualMuted: false, platformMuted: false }),
    onMessage: (connection) => { received.push(connection.id); },
    onDisconnect: (connection) => { disconnected.push(connection.id); },
  });
  t.after(async () => { await server.stop(); fs.rmSync(profile, { recursive: true, force: true }); });
  await server.start();
  assert.equal(fs.statSync(path.dirname(server.connectionFile)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(server.connectionFile).mode & 0o777, 0o600);
  const first = client(profile);
  const second = client(profile);
  t.after(() => { first.child.kill(); second.child.kill(); });
  const a = await first.next();
  const b = await second.next();
  assert.equal(a.type, "snapshot"); assert.equal(b.type, "snapshot");
  if (a.type !== "snapshot" || b.type !== "snapshot") throw new Error("Missing snapshot");
  assert.notEqual(a.connectionId, b.connectionId);
  const ref = { platform: "google-meet", installationId: first.installationId, sessionId: first.sessionId,
    tabId: 1, documentId: randomUUID(), callId: "abc-defg-hij" };
  const message = { version: 1, type: "context", sequence: 0, ref,
    context: { sourceNs: "1000000000", presence: "in-call", health: "recognized", reason: null, micMuted: false,
      mode: "standard", participants: [], activeParticipantIds: [], rosterComplete: false, confirmedLeave: false } };
  // Split header and body across writes to exercise native framing, not a mock parser.
  const payload = Buffer.from(JSON.stringify(message));
  const frame = Buffer.alloc(payload.length + 4); frame.writeUInt32LE(payload.length); payload.copy(frame, 4);
  first.child.stdin.write(frame.subarray(0, 2)); first.child.stdin.write(frame.subarray(2, 9)); first.child.stdin.write(frame.subarray(9));
  writeCompanionFrame(first.child.stdin, message); // Replay closes only this authenticated connection.
  await first.exited;
  assert.deepEqual(received, [a.connectionId]);
  assert.deepEqual(disconnected, [a.connectionId]);
  server.broadcastSnapshot();
  assert.equal((await second.next()).type, "snapshot");
  second.child.stdin.end(); await second.exited;
  assert.equal(disconnected.length, 2);
});

test("native host rejects wrong origin and unavailable profiles without leaking credentials", async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-companion-absent-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const wrong = client(profile, "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/");
  assert.equal((await wrong.exited)[0], 1);
  const absent = client(profile);
  assert.deepEqual(await absent.next(), { version: 1, type: "unavailable", reason: "app-unavailable" });
  await absent.exited;
});

test("app socket rejects wrong credentials, versions and oversized frames without dispatch", async (t) => {
  const net: typeof import("node:net") = require("node:net");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-companion-auth-"));
  const server = new CompanionServer({ profilePath: profile,
    snapshot: () => ({ recordingState: "idle", recordingId: null, binding: null, manualMuted: false, platformMuted: false }),
    onMessage: () => assert.fail("invalid connection must never dispatch"),
  });
  t.after(async () => { await server.stop(); fs.rmSync(profile, { recursive: true, force: true }); });
  await server.start();
  const saved = JSON.parse(fs.readFileSync(server.connectionFile, "utf8")) as { credential: string };
  for (const scenario of ["credential", "version", "oversize"] as const) {
    const socket = net.connect(server.socketPath);
    const closed = once(socket, "close");
    socket.on("error", () => {});
    await once(socket, "connect");
    if (scenario === "oversize") { const frame = Buffer.alloc(4); frame.writeUInt32LE(65537); socket.write(frame); }
    else writeCompanionFrame(socket, { version: scenario === "version" ? 2 : 1, type: "authenticate", origin: extensionOriginValue,
      credential: scenario === "credential" ? "0".repeat(64) : saved.credential });
    await closed;
  }
});
