import { z } from "zod";
import { COMPANION_MAX_MESSAGE_BYTES, companionContextSchema, companionDesktopMessageSchema, companionDocumentIdSchema, type CompanionCallRef, type CompanionDesktopMessage, type CompanionContext } from "../../src/contracts/companion.js";
import type { ChromeApi, ChromePort, ChromeSender } from "./chrome.js";

const uuid = z.string().uuid();
const contentMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("context"), context: companionContextSchema }).strict(),
  z.object({ type: z.literal("clock-probe"), nonce: uuid, sourceSendNs: z.string().regex(/^\d{1,20}$/) }).strict(),
  z.object({ type: z.literal("clock-confirm"), nonce: uuid, sourceReceiveNs: z.string().regex(/^\d{1,20}$/) }).strict(),
]);

/** Native connection and main snapshots are authoritative; storage carries identifiers only. */
export function startCompanionWorker(api: ChromeApi, hostName: string): void {
  let port: ChromePort | null = null;
  let connecting = false;
  let sequence = 0;
  let installationId: string;
  let sessionId: string;
  let snapshot: Extract<CompanionDesktopMessage, { type: "snapshot" }> | null = null;
  let error = "disconnected";
  let updatePending = false;
  const contexts = new Map<number, { ref: CompanionCallRef; context: CompanionContext; receivedAt: number }>();
  const probes = new Map<string, { tabId: number; documentId: string }>();
  const refFor = (sender: ChromeSender): CompanionCallRef | null => {
    if (sender.id !== api.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || !companionDocumentIdSchema.safeParse(sender.documentId).success) return null;
    try {
      const url = new URL(sender.url ?? "");
      const match = url.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/);
      if (url.origin !== "https://meet.google.com" || !match) return null;
      return { platform: "google-meet", installationId, sessionId, tabId: sender.tab!.id!, documentId: sender.documentId!, callId: match[1] };
    } catch { return null; }
  };
  const connect = async () => {
    if (port || connecting) return;
    connecting = true;
    try {
      const savedInstallation = (await api.storage.local.get("installationId")).installationId;
      installationId = uuid.safeParse(savedInstallation).success ? String(savedInstallation) : crypto.randomUUID();
      await api.storage.local.set({ installationId });
      const savedSession = (await api.storage.session.get("sessionId")).sessionId;
      sessionId = uuid.safeParse(savedSession).success ? String(savedSession) : crypto.randomUUID();
      await api.storage.session.set({ sessionId });
      const current = api.runtime.connectNative(hostName);
      port = current;
      sequence = 0;
      current.onMessage.addListener((value) => {
        if (port !== current) return;
        const parsed = companionDesktopMessageSchema.safeParse(value);
        if (!parsed.success) { error = "version-mismatch"; current.disconnect(); return; }
        const message = parsed.data;
        if (message.type === "snapshot") {
          snapshot = message;
          error = "";
          if (updatePending && message.recordingState === "idle") { current.disconnect(); api.runtime.reload(); }
        } else if (message.type === "unavailable") {
          if (message.reason !== "clock-unavailable") { snapshot = null; error = message.reason; }
        } else {
          const target = probes.get(message.nonce);
          probes.delete(message.nonce);
          if (target) void api.tabs.sendMessage(target.tabId, message, { documentId: target.documentId }).catch(() => {});
        }
      });
      current.onDisconnect.addListener(() => {
        void api.runtime.lastError;
        if (port !== current) return;
        port = null; snapshot = null; probes.clear(); error ||= "app-unavailable";
      });
      current.postMessage({ version: 1, type: "hello", installationId, sessionId });
    } catch { port = null; snapshot = null; error = "app-unavailable"; }
    finally { connecting = false; }
  };
  api.runtime.onMessage.addListener((value, sender, respond) => {
    if (sender.id === api.runtime.id && !sender.tab && sender.url === api.runtime.getURL("popup.html") &&
        value && typeof value === "object" && "type" in value && value.type === "status") {
      respond({ connected: snapshot !== null, snapshot, error, contexts: [...contexts.values()],
        canControlMic: !!snapshot?.binding && snapshot.recordingState === "recording" && snapshot.contextState !== "disabled" &&
          snapshot.binding.installationId === installationId && snapshot.binding.sessionId === sessionId });
      return;
    }
    if (sender.id === api.runtime.id && !sender.tab && sender.url === api.runtime.getURL("popup.html")) {
      const command = z.object({ type: z.literal("manual-mute"), recordingId: uuid, muted: z.boolean() }).strict().safeParse(value);
      if (!command.success || !port || !snapshot?.binding || snapshot.recordingState !== "recording" ||
          snapshot.recordingId !== command.data.recordingId || snapshot.binding.installationId !== installationId ||
          snapshot.binding.sessionId !== sessionId || snapshot.contextState === "disabled") {
        respond({ accepted: false }); return;
      }
      try {
        port.postMessage({ version: 1, sequence, ref: snapshot.binding, ...command.data });
        sequence++; respond({ accepted: true });
      } catch { port.disconnect(); respond({ accepted: false }); }
      return;
    }
    const parsed = contentMessage.safeParse(value);
    if (!parsed.success || !installationId || !sessionId) { respond({ accepted: false }); return; }
    const ref = refFor(sender);
    if (!ref) { respond({ accepted: false }); return; }
    const message = parsed.data;
    if (message.type === "context") {
      if (contexts.size >= 32 && !contexts.has(ref.tabId)) contexts.delete(contexts.keys().next().value!);
      contexts.set(ref.tabId, { ref, context: message.context, receivedAt: Date.now() });
    }
    if (!port || !snapshot) { respond({ accepted: false }); return; }
    if (message.type === "clock-probe") {
      if (probes.size >= 16) probes.delete(probes.keys().next().value!);
      probes.set(message.nonce, { tabId: ref.tabId, documentId: ref.documentId });
    }
    try {
      const outgoing = { version: 1, sequence, ref, ...message };
      if (new TextEncoder().encode(JSON.stringify(outgoing)).length > COMPANION_MAX_MESSAGE_BYTES) { respond({ accepted: false }); return; }
      port.postMessage(outgoing);
      sequence++;
      respond({ accepted: true });
    } catch { port.disconnect(); respond({ accepted: false }); }
  });
  api.runtime.onUpdateAvailable.addListener(() => {
    updatePending = true;
    if (snapshot?.recordingState === "idle") { port?.disconnect(); api.runtime.reload(); }
  });
  api.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "gristmill-connect") void connect(); });
  void api.alarms.create("gristmill-connect", { periodInMinutes: 0.5 });
  void connect();
}

declare const chrome: ChromeApi;
declare const COMPANION_HOST_NAME: string;
if (typeof chrome !== "undefined") startCompanionWorker(chrome, COMPANION_HOST_NAME);
