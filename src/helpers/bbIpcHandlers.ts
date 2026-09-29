import { bbChannels, bbSelectionSchema, bbStreamStartSchema } from "../contracts/bb.js";
import { AgentStreamRequestRegistry } from "./agentStreamRequestRegistry.js";
import { ensureBbWorkspace } from "./bbWorkspace.js";
import { getBbHostPreferences, getBbThreadOutput, getBbThreadTitle, listBbHarnesses, listBbModels, spawnBbThread, stopBbThread, watchBbThread } from "./bbCli.js";

interface Sender {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
  once(event: string, callback: () => void): void;
}
interface IpcEvent { sender: Sender }
interface IpcMain {
  handle(channel: string, handler: (event: IpcEvent, ...args: unknown[]) => unknown): void;
}

// bb names a thread asynchronously after its first turn, so poll briefly.
async function sendThreadTitle(sender: Sender, streamId: string, threadId: string): Promise<void> {
  for (let attempt = 0; attempt < 5 && !sender.isDestroyed(); attempt++) {
    const title = await getBbThreadTitle(threadId).catch(() => null);
    if (sender.isDestroyed()) return;
    if (title) {
      sender.send(bbChannels.streamPart, { streamId, title });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

export function registerBbHandlers(ipcMain: IpcMain, userData: string): void {
  const requests = new AgentStreamRequestRegistry();
  const threads = new Map<string, string>();
  const observedSenders = new Set<number>();
  const workspace = () => ensureBbWorkspace(userData);

  ipcMain.handle(bbChannels.catalog, () => listBbHarnesses());
  ipcMain.handle(bbChannels.hostPreferences, () => getBbHostPreferences());
  ipcMain.handle(bbChannels.models, (_event, provider: unknown) => {
    if (typeof provider !== "string" || !provider.trim()) throw new Error("bb provider is required");
    return listBbModels(provider);
  });
  ipcMain.handle(bbChannels.generate, async (_event, prompt: unknown, selection: unknown) => {
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("bb prompt is required");
    const config = bbSelectionSchema.parse(selection);
    const id = await spawnBbThread(prompt, config, workspace());
    for await (const _text of watchBbThread(id)) { /* wait for the final output */ }
    return getBbThreadOutput(id);
  });
  ipcMain.handle(bbChannels.streamStart, async (event, raw: unknown) => {
    const request = bbStreamStartSchema.parse(raw);
    const sender = event.sender;
    const controller = requests.begin(sender.id, request.streamId);
    if (!observedSenders.has(sender.id)) {
      observedSenders.add(sender.id);
      sender.once("destroyed", () => {
        requests.cancelSender(sender.id);
        observedSenders.delete(sender.id);
        for (const [key, id] of threads) {
          if (key.startsWith(`${sender.id}:`)) {
            threads.delete(key);
            void stopBbThread(id).catch(() => {});
          }
        }
      });
    }
    let id: string;
    try {
      id = await spawnBbThread(request.prompt, request.selection, workspace(), controller.signal);
    } catch (error) {
      requests.complete(sender.id, request.streamId, controller);
      throw error;
    }
    if (controller.signal.aborted) {
      requests.complete(sender.id, request.streamId, controller);
      void stopBbThread(id).catch(() => {});
      return;
    }
    threads.set(`${sender.id}:${request.streamId}`, id);
    void (async () => {
      try {
        for await (const text of watchBbThread(id, controller.signal)) {
          if (requests.isActive(sender.id, request.streamId, controller) && !sender.isDestroyed()) {
            sender.send(bbChannels.streamPart, { streamId: request.streamId, text });
          }
        }
        if (requests.isActive(sender.id, request.streamId, controller) && !sender.isDestroyed()) {
          sender.send(bbChannels.streamPart, { streamId: request.streamId, done: true });
          void sendThreadTitle(sender, request.streamId, id);
        }
      } catch (error) {
        if (!controller.signal.aborted && !sender.isDestroyed()) {
          sender.send(bbChannels.streamPart, { streamId: request.streamId, error: (error as Error).message });
        }
      } finally {
        requests.complete(sender.id, request.streamId, controller);
        threads.delete(`${sender.id}:${request.streamId}`);
      }
    })();
  });
  ipcMain.handle(bbChannels.streamCancel, async (event, raw: unknown) => {
    if (typeof raw !== "string" || !/^[0-9a-f-]{36}$/i.test(raw)) return;
    requests.cancel(event.sender.id, raw);
    const key = `${event.sender.id}:${raw}`;
    const id = threads.get(key);
    threads.delete(key);
    if (id) await stopBbThread(id).catch(() => {});
  });
}
