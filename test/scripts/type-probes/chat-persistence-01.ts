// @probe-name "an incomplete database dependency fails compilation"
// @probe-codes [2741]
// @probe-origin test/scripts/chatPersistenceTypeProbe.test.js
import { registerChatPersistenceHandlers } from "./src/helpers/chatPersistenceIpcHandlers.js";

declare const ipcMain: {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
};

// A database missing getAgentConversationsWithPreview would leave the
// preview channel dead; the compiler must reject the registration.
registerChatPersistenceHandlers(ipcMain, {
  database: {
    createAgentConversation: () => null,
    getConversationsForNote: () => [],
    getConversationsForContainer: () => [],
    getAgentConversations: () => [],
    getAgentConversation: () => null,
    deleteAgentConversation: () => ({ success: true }),
    updateAgentConversationTitle: () => ({ success: true }),
    addAgentMessage: () => null,
    getAgentMessages: () => [],
    searchAgentConversations: () => [],
    archiveAgentConversation: () => ({ success: true }),
    unarchiveAgentConversation: () => ({ success: true }),
  },
});
