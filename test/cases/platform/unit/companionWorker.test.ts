import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startCompanionWorker } from "../../../../extension/src/worker.ts";
import type { ChromeApi, ChromePort, ChromeSender } from "../../../../extension/src/chrome.ts";
import { popupStatusSchema } from "../../../../extension/src/popupState.ts";

function workerEvent<F>() { const listeners: F[] = []; return { listeners, addListener: (listener: F) => { listeners.push(listener); } }; }
function harness(hostName = "com.khakhalev.gristmill.companion.dev") {
  const connectedHosts: string[] = [];
  const incoming = workerEvent<(value: unknown, sender: ChromeSender, respond: (value: unknown) => void) => boolean | void>();
  const update = workerEvent<() => void>();
  const alarm = workerEvent<(value: { name: string }) => void>();
  const ports: Array<{ port: ChromePort; messages: unknown[]; receive(value: unknown): void; disconnect(): void }> = [];
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  let reloads = 0;
  let connected!: () => void;
  const ready = new Promise<void>((resolve) => { connected = resolve; });
  const api: ChromeApi = {
    runtime: { id: "test-extension", onMessage: incoming, onUpdateAvailable: update,
      connectNative: (name) => {
        connectedHosts.push(name);
        const onMessage = workerEvent<(value: unknown) => void>();
        const onDisconnect = workerEvent<() => void>();
        const messages: unknown[] = [];
        const disconnect = () => { for (const listener of onDisconnect.listeners) listener(); };
        const port = { postMessage: (message: unknown) => { messages.push(message); }, disconnect, onMessage, onDisconnect };
        ports.push({ port, messages, disconnect, receive: (message) => { for (const listener of onMessage.listeners) listener(message); } });
        connected(); return port;
      },
      reload: () => { reloads++; }, sendMessage: async () => null, getURL: (file) => `chrome-extension://test-extension/${file}`,
    },
    storage: { local: { get: async () => local, set: async (value) => { Object.assign(local, value); } },
      session: { get: async () => session, set: async (value) => { Object.assign(session, value); } } },
    alarms: { create: async () => {}, onAlarm: alarm }, tabs: { query: async () => [{ id: 7 }], sendMessage: async () => null },
  };
  const request = (value: unknown, sender: ChromeSender) => {
    let response: unknown;
    incoming.listeners[0](value, sender, (result) => { response = result; });
    return response;
  };
  startCompanionWorker(api, hostName);
  return { api, ports, ready, request, update, alarm, connectedHosts, reloads: () => reloads };
}

const snapshot = (recordingState: "idle" | "recording") => ({ version: 1, type: "snapshot", connectionId: randomUUID(), recordingState,
  recordingId: recordingState === "recording" ? randomUUID() : null, binding: null, contextState: "unbound", manualMuted: false, platformMuted: false });

test("worker trusts validated main state and top-frame Meet senders only; updates wait for Stop", async () => {
  const h = harness(); await h.ready;
  const popup = { id: h.api.runtime.id, url: h.api.runtime.getURL("popup.html") };
  assert.deepEqual(h.request({ type: "status" }, popup), { connected: false, snapshot: null, error: "disconnected", contexts: [], contextErrors: [], canControlMic: false });
  const first = h.ports[0];
  assert.equal(first.messages.length, 1, "only hello is sent before main acknowledges");
  first.receive(snapshot("recording"));
  const sender = { id: h.api.runtime.id, frameId: 0, documentId: randomUUID().replaceAll("-", "").toUpperCase(), tab: { id: 7 }, url: "https://meet.google.com/abc-defg-hij" };
  const context = { type: "context", context: { sourceNs: "100", presence: "in-call", health: "recognized", reason: null,
    micMuted: true, mode: "standard", participants: [], activeParticipantIds: [], rosterComplete: false, confirmedLeave: false } };
  for (const bad of [{ ...sender, frameId: 1 }, { ...sender, url: "https://evil.example/abc-defg-hij" }, { ...sender, id: "other-extension" },
    { ...sender, documentId: randomUUID() }, { ...sender, documentId: "0".repeat(32) }]) {
    assert.deepEqual(h.request(context, bad), { accepted: false });
  }
  assert.deepEqual(h.request({ ...context, ref: { tabId: 999 } }, sender), { accepted: false });
  const rejectedStatus = h.request({ type: "status" }, popup) as { contextErrors: Array<{tabId: number; reason: string}> };
  assert.match(rejectedStatus.contextErrors.find(value => value.tabId === 7)!.reason, /Invalid context/);
  assert.deepEqual(h.request(context, sender), { accepted: true });
  assert.deepEqual((h.request({ type: "status" }, popup) as { contextErrors: unknown[] }).contextErrors, []);
  assert.equal(first.messages.length, 2);
  const sent = first.messages[1] as { ref: { tabId: number; documentId: string }; sequence: number };
  assert.equal(sent.ref.tabId, 7); assert.equal(sent.ref.documentId, sender.documentId); assert.equal(sent.sequence, 0);
  const visible = popupStatusSchema.parse(h.request({ type: "status" }, popup));
  assert.equal(visible.contexts.length, 1);
  assert.equal(visible.contexts[0].ref.documentId, sender.documentId);
  assert.equal(visible.contexts[0].context.micMuted, true);
  first.disconnect();
  const replacement = { ...sender, documentId: randomUUID().replaceAll("-", "").toUpperCase() };
  assert.deepEqual(h.request(context, replacement), { accepted: false });
  const disconnected = popupStatusSchema.parse(h.request({ type: "status" }, popup));
  assert.equal(disconnected.connected, false);
  assert.equal(disconnected.contexts.length, 1);
  assert.equal(disconnected.contexts[0].ref.documentId, replacement.documentId);
  // Reconnect for the update lifecycle assertions below.
  h.alarm.listeners[0]({ name: "gristmill-connect" });
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
  h.ports[1].receive(snapshot("recording"));
  h.update.listeners[0](); assert.equal(h.reloads(), 0);
  h.ports[1].receive(snapshot("idle")); assert.equal(h.reloads(), 1);
  assert.deepEqual(h.request(context, sender), { accepted: false });
});

test("worker reconnect does not reuse cached Connected or stale port authority", async () => {
  const h = harness(); await h.ready;
  const old = h.ports[0]; old.receive(snapshot("recording")); old.disconnect();
  const popup = { id: h.api.runtime.id, url: h.api.runtime.getURL("popup.html") };
  assert.equal((h.request({ type: "status" }, popup) as { connected: boolean }).connected, false);
  h.alarm.listeners[0]({ name: "gristmill-connect" });
  // Storage reads resolve as microtasks; no clock or browser sleep is required.
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
  assert.equal(h.ports.length, 2);
  old.receive(snapshot("idle"));
  assert.equal((h.request({ type: "status" }, popup) as { connected: boolean }).connected, false);
  h.ports[1].receive(snapshot("idle"));
  assert.equal((h.request({ type: "status" }, popup) as { connected: boolean }).connected, true);
});

test("popup mute is scoped to its own bound recording and cannot be sent by page content", async () => {
  const h = harness(); await h.ready;
  const port = h.ports[0];
  const hello = port.messages[0] as { installationId: string; sessionId: string };
  const ref = { platform: "google-meet", ...hello, tabId: 7, documentId: randomUUID().replaceAll("-", "").toUpperCase(), callId: "abc-defg-hij" };
  const binding = { platform: ref.platform, installationId: hello.installationId, sessionId: hello.sessionId,
    tabId: ref.tabId, documentId: ref.documentId, callId: ref.callId };
  const state = { ...snapshot("recording"), binding, contextState: "recognized" };
  port.receive(state);
  const popup = { id: h.api.runtime.id, url: h.api.runtime.getURL("popup.html") };
  const command = { type: "manual-mute", recordingId: state.recordingId, muted: true };
  const page = { id: h.api.runtime.id, frameId: 0, tab: { id: 7 }, documentId: ref.documentId, url: "https://meet.google.com/abc-defg-hij" };
  assert.deepEqual(h.request(command, page), { accepted: false });
  assert.deepEqual(h.request({ ...command, recordingId: randomUUID() }, popup), { accepted: false });
  assert.deepEqual(h.request(command, popup), { accepted: true });
  assert.deepEqual(port.messages[1], { version: 1, sequence: 0, ref: binding, ...command });
  port.receive({ ...state, binding: { ...binding, installationId: randomUUID() } });
  assert.deepEqual(h.request(command, popup), { accepted: false });
  port.disconnect();
  assert.deepEqual(h.request(command, popup), { accepted: false });
});

test("each build connects only to its selected native host, including reconnect", async () => {
  for (const hostName of ["com.khakhalev.gristmill.companion.dev", "com.khakhalev.gristmill.companion"]) {
    const h = harness(hostName); await h.ready;
    assert.deepEqual(h.connectedHosts, [hostName]);
    h.ports[0].disconnect(); h.alarm.listeners[0]({ name: "gristmill-connect" });
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    assert.deepEqual(h.connectedHosts, [hostName, hostName]);
  }
});


test("Telemost identity is top-document scoped and home cannot invent a previous room", async () => {
  const h = harness(); await h.ready; h.ports[0].receive(snapshot("idle"));
  const sender = { id: h.api.runtime.id, frameId: 0, documentId: randomUUID().replaceAll("-", ""),
    tab: { id: 7 }, url: "https://telemost.yandex.ru/j/12345678901234" };
  const context = { type: "context", context: { sourceNs: "100", presence: "unknown", health: "unrecognized", reason: "telemost-ui-unrecognized",
    micMuted: null, mode: "unknown", participants: [], activeParticipantIds: [], rosterComplete: false, confirmedLeave: false } };
  assert.deepEqual(h.request(context, { ...sender, url: "https://telemost.yandex.ru/" }), { accepted: false });
  assert.deepEqual(h.request(context, { ...sender, frameId: 1 }), { accepted: false });
  assert.deepEqual(h.request(context, { ...sender, url: "https://telemost.yandex.ru.evil.test/j/12345678901234" }), { accepted: false });
  assert.deepEqual(h.request(context, sender), { accepted: true });
  const outgoing = h.ports[0].messages.at(-1) as { ref: { platform: string; callId: string } };
  assert.equal(outgoing.ref.platform, "telemost"); assert.equal(outgoing.ref.callId, "12345678901234");
  assert.deepEqual(h.request(context, { ...sender, url: "https://telemost.yandex.ru/" }), { accepted: true });
  assert.deepEqual(h.request(context, { ...sender, url: "https://telemost.yandex.ru/chats" }), { accepted: true });
  assert.deepEqual(h.request(context, { ...sender, url: "https://telemost.yandex.ru/@/j/12345678901234" }), { accepted: true });
  assert.deepEqual(h.request(context, { ...sender, documentId: randomUUID().replaceAll("-", ""), url: "https://telemost.yandex.ru/" }), { accepted: false });
});
