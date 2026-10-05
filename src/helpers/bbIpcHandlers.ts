import { bbChannels, bbSelectionSchema, bbStreamStartSchema } from "../contracts/bb.js";
import { AgentStreamRequestRegistry } from "./agentStreamRequestRegistry.js";
import { ensureBbWorkspace } from "./bbWorkspace.js";
import {
  assertBbVersion,
  BbCliError,
  getBbHostPreferences,
  getBbThreadHistory,
  getBbThreadOutput,
  getBbThreadTitle,
  listBbHarnesses,
  listBbModels,
  spawnBbThread,
  stopBbThread,
  tellBbThread,
  watchBbThread,
} from "./bbCli.js";
import type { DatabaseManager } from "./database.js";

interface Sender {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
  once(event: string, callback: () => void): void;
}

interface IpcEvent {
  sender: Sender;
}

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

export function registerBbHandlers(
  ipcMain: IpcMain,
  userData: string,
  database: Pick<DatabaseManager, "getAgentConversation" | "getAgentBbThread" | "saveAgentBbThread">
): void {
  const requests = new AgentStreamRequestRegistry();
  const turnTails = new Map<number, Promise<void>>();
  const observedSenders = new Set<number>();
  const workspace = () => ensureBbWorkspace(userData);

  ipcMain.handle(bbChannels.catalog, () => listBbHarnesses());
  ipcMain.handle(bbChannels.hostPreferences, () => getBbHostPreferences());
  ipcMain.handle(bbChannels.models, (_event, provider: unknown) => {
    if (typeof provider !== "string" || !provider.trim())
      throw new Error("bb provider is required");

    return listBbModels(provider);
  });
  ipcMain.handle(bbChannels.generate, async (_event, prompt: unknown, selection: unknown) => {
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("bb prompt is required");
    const config = bbSelectionSchema.parse(selection);
    const id = await spawnBbThread(prompt, config, workspace());

    for await (const _text of watchBbThread(id)) {
      /* wait for the final output */
    }

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
      });
    }

    // bb tell steers a live turn. Keep the lock through completion and Stop.
    const previous = turnTails.get(request.conversationId) ?? Promise.resolve();

    const turn = previous.then(async () => {
      let id: string | undefined;
      let dispatching = false;
      let stopping: Promise<void> | undefined;

      const stopOnAbort = () => {
        if (id && !dispatching && !stopping) stopping = stopBbThread(id).catch(() => {});
      };

      controller.signal.addEventListener("abort", stopOnAbort, { once: true });

      try {
        if (controller.signal.aborted) return;

        if (!database.getAgentConversation(request.conversationId))
          throw new Error("Chat conversation no longer exists");
        await assertBbVersion();

        if (controller.signal.aborted) return;
        const saved = database.getAgentBbThread(request.conversationId);
        let afterSeq = 0;

        if (saved) {
          if (saved.provider !== request.selection.provider) {
            throw new Error("Start a new Chat to use another bb harness");
          }

          id = saved.thread_id;
          let history = await getBbThreadHistory(id);

          // A prior turn can still be running after an application restart.
          if (!history.completed && !history.failed && !controller.signal.aborted) {
            try {
              for await (const _text of watchBbThread(id, controller.signal, history.sequence)) {
                /* wait for the prior turn */
              }
            } catch (error) {
              if (!(error instanceof BbCliError) || error.code !== "bb-turn-failed") throw error;
            }

            history = await getBbThreadHistory(id);
          }

          if (controller.signal.aborted) return;
          afterSeq = history.sequence;
        }

        // Let dispatch return the thread ID even if cancelled, then save and Stop it.
        // Aborting the CLI process here can lose an already-created BB thread.
        dispatching = true;

        try {
          if (id) {
            await tellBbThread(id, request.prompt, undefined, request.selection);
          } else {
            id = await spawnBbThread(request.initialPrompt, request.selection, workspace());

            try {
              database.saveAgentBbThread(request.conversationId, id, request.selection.provider);
            } catch (error) {
              stopping = stopBbThread(id).catch(() => {});
              throw error;
            }
          }
        } finally {
          dispatching = false;

          if (controller.signal.aborted) stopOnAbort();
        }

        if (controller.signal.aborted) return;

        for await (const text of watchBbThread(id, controller.signal, afterSeq)) {
          if (requests.isActive(sender.id, request.streamId, controller) && !sender.isDestroyed()) {
            sender.send(bbChannels.streamPart, { streamId: request.streamId, text });
          }
        }

        if (requests.isActive(sender.id, request.streamId, controller) && !sender.isDestroyed()) {
          sender.send(bbChannels.streamPart, { streamId: request.streamId, done: true });
          void sendThreadTitle(sender, request.streamId, id).catch(() => {});
        }
      } catch (error) {
        if (!controller.signal.aborted && !sender.isDestroyed()) {
          sender.send(bbChannels.streamPart, {
            streamId: request.streamId,
            error: (error as Error).message,
          });
        }
      } finally {
        controller.signal.removeEventListener("abort", stopOnAbort);
        await stopping;
        requests.complete(sender.id, request.streamId, controller);
      }
    });

    turnTails.set(request.conversationId, turn);
    void turn.finally(() => {
      if (turnTails.get(request.conversationId) === turn) turnTails.delete(request.conversationId);
    });
  });
  ipcMain.handle(bbChannels.streamCancel, async (event, raw: unknown) => {
    if (typeof raw !== "string" || !/^[0-9a-f-]{36}$/i.test(raw)) return;
    requests.cancel(event.sender.id, raw);
  });
}
