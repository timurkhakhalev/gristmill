// @probe-name "the full contract registration and bridge compile under strict settings"
// @probe-codes []
// @probe-origin test/scripts/chatPersistenceTypeProbe.test.js
import { registerChatPersistenceHandlers } from "./src/helpers/chatPersistenceIpcHandlers.js";
import { createChatPersistenceBridge } from "./src/preload/chatBridge.js";

declare const ipcMain: {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
};

registerChatPersistenceHandlers(ipcMain, {
  database: {
    createAgentConversation: (title, noteId, folderId) => {
      void title;
      void noteId;
      void folderId;
      return null;
    },
    getConversationsForNote: (noteId: unknown, limit: unknown) => {
      void limit;
      return Number(noteId) > 0
        ? [
            {
              id: 1,
              title: "t",
              note_id: null,
              folder_id: null,
              archived_at: null,
              created_at: "c",
              updated_at: "u",
            },
          ]
        : [];
    },
    getConversationsForContainer: (folderId, limit) => {
      void folderId;
      void limit;
      return [
        {
          id: 1,
          title: "t",
          note_id: null,
          folder_id: null,
          archived_at: null,
          created_at: "c",
          updated_at: "u",
          message_count: 0,
        },
      ];
    },
    getAgentConversations: (limit) => {
      void limit;
      return [];
    },
    getAgentConversation: (id) => {
      void id;
      return null;
    },
    deleteAgentConversation: (id) => {
      void id;
      return { success: true };
    },
    updateAgentConversationTitle: (id, title) => {
      void id;
      void title;
      return { success: true };
    },
    addAgentMessage: (
      conversationId: unknown,
      role: unknown,
      content: unknown,
      metadata: unknown
    ) => {
      void role;
      void content;
      void metadata;
      return Number(conversationId) > 0
        ? {
            id: 2,
            conversation_id: conversationId,
            role: "user",
            content: "x",
            metadata: null,
            created_at: "c",
          }
        : null;
    },
    getAgentMessages: (conversationId) => {
      void conversationId;
      return [];
    },
    getAgentConversationsWithPreview: (limit, offset, includeArchived) => {
      void limit;
      void offset;
      void includeArchived;
      return [];
    },
    searchAgentConversations: (query, limit) => {
      void query;
      void limit;
      return [];
    },
    archiveAgentConversation: (id) => {
      void id;
      return { success: true };
    },
    unarchiveAgentConversation: (id) => {
      void id;
      return { success: true };
    },
  },
});

declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
};
const bridge = createChatPersistenceBridge(ipcRendererLike);
const titles: Promise<string[]> = bridge
  .getAgentConversations(10)
  .then((rows) => rows.map((r) => r.title));
void titles;
