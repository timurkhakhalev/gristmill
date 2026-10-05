// Renderer-facing chat persistence bridge. Moved out of preload.js so the
// thirteen conversation operations have one typed implementation backed by
// the shared contract. The sandboxed preload can't require local modules,
// so build-main.js bundles the final preload with esbuild before packaging.
// None of these channels carry events, so there are no subscriptions here.
import {
  chatPersistenceChannels,
  containerConversationListResultSchema,
  conversationCreateResultSchema,
  conversationDetailResultSchema,
  conversationRowListResultSchema,
  messageRowListResultSchema,
  messageRowResultSchema,
  previewConversationListResultSchema,
  successResultSchema,
  type ChatPersistenceApi,
  type MessageRole,
} from "../contracts/chatPersistence.js";
import type { ZodType } from "zod";

interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

function parseResult<T>(schema: ZodType<T>, raw: unknown, channel: string): T {
  const result = schema.safeParse(raw);

  if (!result.success) {
    throw new Error(`Unexpected response shape from ${channel}`);
  }

  return result.data;
}

// The return type is the shared ChatPersistenceApi, so any drift between
// this implementation and the contract fails compilation instead of review.
export function createChatPersistenceBridge(ipcRenderer: IpcRendererLike): ChatPersistenceApi {
  return {
    createAgentConversation: (
      title?: string,
      noteId?: number | null,
      spaceId?: number | null,
      folderId?: number | null
    ) =>
      ipcRenderer
        .invoke(chatPersistenceChannels.createAgentConversation, title, noteId, spaceId, folderId)
        .then((raw) =>
          parseResult(
            conversationCreateResultSchema,
            raw,
            chatPersistenceChannels.createAgentConversation
          )
        ),
    getConversationsForNote: (noteId: number, limit?: number) =>
      ipcRenderer
        .invoke(chatPersistenceChannels.getConversationsForNote, noteId, limit)
        .then((raw) =>
          parseResult(
            conversationRowListResultSchema,
            raw,
            chatPersistenceChannels.getConversationsForNote
          )
        ),
    getConversationsForContainer: (spaceId: number, folderId?: number | null, limit?: number) =>
      ipcRenderer
        .invoke(chatPersistenceChannels.getConversationsForContainer, spaceId, folderId, limit)
        .then((raw) =>
          parseResult(
            containerConversationListResultSchema,
            raw,
            chatPersistenceChannels.getConversationsForContainer
          )
        ),
    getAgentConversations: (limit?: number) =>
      ipcRenderer
        .invoke(chatPersistenceChannels.getAgentConversations, limit)
        .then((raw) =>
          parseResult(
            conversationRowListResultSchema,
            raw,
            chatPersistenceChannels.getAgentConversations
          )
        ),
    getAgentConversation: (id: number) =>
      ipcRenderer
        .invoke(chatPersistenceChannels.getAgentConversation, id)
        .then((raw) =>
          parseResult(
            conversationDetailResultSchema,
            raw,
            chatPersistenceChannels.getAgentConversation
          )
        ),
    deleteAgentConversation: (id: number) =>
      ipcRenderer
        .invoke(chatPersistenceChannels.deleteAgentConversation, id)
        .then((raw) =>
          parseResult(successResultSchema, raw, chatPersistenceChannels.deleteAgentConversation)
        ),
    updateAgentConversationTitle: (id: number, title: string) =>
      ipcRenderer
        .invoke(chatPersistenceChannels.updateAgentConversationTitle, id, title)
        .then((raw) =>
          parseResult(
            successResultSchema,
            raw,
            chatPersistenceChannels.updateAgentConversationTitle
          )
        ),
    addAgentMessage: (
      conversationId: number,
      role: MessageRole,
      content: string,
      metadata?: Record<string, unknown>
    ) =>
      ipcRenderer
        .invoke(chatPersistenceChannels.addAgentMessage, conversationId, role, content, metadata)
        .then((raw) =>
          parseResult(messageRowResultSchema, raw, chatPersistenceChannels.addAgentMessage)
        ),
    getAgentMessages: (conversationId: number) =>
      ipcRenderer
        .invoke(chatPersistenceChannels.getAgentMessages, conversationId)
        .then((raw) =>
          parseResult(messageRowListResultSchema, raw, chatPersistenceChannels.getAgentMessages)
        ),
    getAgentConversationsWithPreview: (
      limit?: number,
      offset?: number,
      includeArchived?: boolean
    ) =>
      ipcRenderer
        .invoke(
          chatPersistenceChannels.getAgentConversationsWithPreview,
          limit,
          offset,
          includeArchived
        )
        .then((raw) =>
          parseResult(
            previewConversationListResultSchema,
            raw,
            chatPersistenceChannels.getAgentConversationsWithPreview
          )
        ),
    searchAgentConversations: (query: string, limit?: number) =>
      ipcRenderer
        .invoke(chatPersistenceChannels.searchAgentConversations, query, limit)
        .then((raw) =>
          parseResult(
            conversationRowListResultSchema,
            raw,
            chatPersistenceChannels.searchAgentConversations
          )
        ),
    archiveAgentConversation: (id: number) =>
      ipcRenderer
        .invoke(chatPersistenceChannels.archiveAgentConversation, id)
        .then((raw) =>
          parseResult(successResultSchema, raw, chatPersistenceChannels.archiveAgentConversation)
        ),
    unarchiveAgentConversation: (id: number) =>
      ipcRenderer
        .invoke(chatPersistenceChannels.unarchiveAgentConversation, id)
        .then((raw) =>
          parseResult(successResultSchema, raw, chatPersistenceChannels.unarchiveAgentConversation)
        ),
  };
}
