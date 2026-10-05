// The thirteen agent-conversation DB channels, moved out of ipcHandlers.js.
// Registration order, positional arguments, return shapes and null semantics
// match the previous JS implementations; SQL stays in DatabaseManager.
// Arguments are accepted as unknown, validated with the shared tuple schemas,
// and only validated results reach the wire. None of these channels
// broadcast events.
import type { ZodType } from "zod";
import {
  addMessageArgsSchema,
  archiveUnarchiveArgsSchema,
  containerConversationListResultSchema,
  conversationCreateResultSchema,
  conversationDetailResultSchema,
  conversationRowListResultSchema,
  createConversationArgsSchema,
  deleteConversationArgsSchema,
  getConversationArgsSchema,
  getConversationsArgsSchema,
  getConversationsForContainerArgsSchema,
  getConversationsForNoteArgsSchema,
  getConversationsWithPreviewArgsSchema,
  getMessagesArgsSchema,
  messageRowListResultSchema,
  messageRowResultSchema,
  previewConversationListResultSchema,
  searchConversationsArgsSchema,
  successResultSchema,
  updateConversationTitleArgsSchema,
} from "../contracts/chatPersistence.js";

export interface ChatPersistenceHandlerDeps {
  database: {
    createAgentConversation(
      title: unknown,
      noteId: unknown,
      spaceId: unknown,
      folderId: unknown
    ): unknown;
    getConversationsForNote(noteId: unknown, limit: unknown): unknown;
    getConversationsForContainer(spaceId: unknown, folderId: unknown, limit: unknown): unknown;
    getAgentConversations(limit: unknown): unknown;
    getAgentConversation(id: unknown): unknown;
    deleteAgentConversation(id: unknown): unknown;
    updateAgentConversationTitle(id: unknown, title: unknown): unknown;
    addAgentMessage(
      conversationId: unknown,
      role: unknown,
      content: unknown,
      metadata: unknown
    ): unknown;
    getAgentMessages(conversationId: unknown): unknown;
    getAgentConversationsWithPreview(
      limit: unknown,
      offset: unknown,
      includeArchived: unknown
    ): unknown;
    searchAgentConversations(query: unknown, limit: unknown): unknown;
    archiveAgentConversation(id: unknown): unknown;
    unarchiveAgentConversation(id: unknown): unknown;
  };
}

type IpcEventListener = (event: unknown, ...args: unknown[]) => unknown;

// Throw before the DB is touched when the renderer sent a wrong-shaped call.
function parseArgs<T>(schema: ZodType<T>, args: unknown): T {
  const result = schema.safeParse(args);

  if (!result.success) {
    throw new Error("Invalid arguments for a chat persistence IPC call");
  }

  return result.data;
}

function parseResult<T>(schema: ZodType<T>, raw: unknown, what: string): T {
  const result = schema.safeParse(raw);

  if (!result.success) {
    throw new Error(`DatabaseManager returned an unexpected ${what}`);
  }

  return result.data;
}

export function registerChatPersistenceHandlers(
  ipcMain: { handle(channel: string, listener: IpcEventListener): void },
  deps: ChatPersistenceHandlerDeps
): void {
  const { database } = deps;

  ipcMain.handle("db-create-agent-conversation", async (_event, ...args: unknown[]) => {
    const [title, noteId, spaceId, folderId] = parseArgs(createConversationArgsSchema, args);

    // Title passes through untouched: the DB default (only for undefined)
    // yields "Untitled", while an explicit null violates NOT NULL and the
    // invoke rejects without creating a row — the pre-cutover behavior.
    return parseResult(
      conversationCreateResultSchema,
      database.createAgentConversation(title, noteId ?? null, spaceId ?? null, folderId ?? null),
      "conversation detail"
    );
  });

  ipcMain.handle("db-get-conversations-for-note", async (_event, ...args: unknown[]) => {
    const [noteId, limit] = parseArgs(getConversationsForNoteArgsSchema, args);

    return parseResult(
      conversationRowListResultSchema,
      database.getConversationsForNote(noteId, limit ?? 20),
      "conversation list shape"
    );
  });

  ipcMain.handle("db-get-conversations-for-container", async (_event, ...args: unknown[]) => {
    const [spaceId, folderId, limit] = parseArgs(getConversationsForContainerArgsSchema, args);

    return parseResult(
      containerConversationListResultSchema,
      database.getConversationsForContainer(spaceId, folderId ?? null, limit ?? 20),
      "container conversation list shape"
    );
  });

  ipcMain.handle("db-get-agent-conversations", async (_event, ...args: unknown[]) => {
    const [limit] = parseArgs(getConversationsArgsSchema, args);

    return parseResult(
      conversationRowListResultSchema,
      database.getAgentConversations(limit ?? 50),
      "conversation list shape"
    );
  });

  ipcMain.handle("db-get-agent-conversation", async (_event, ...args: unknown[]) => {
    const [id] = parseArgs(getConversationArgsSchema, args);

    return parseResult(
      conversationDetailResultSchema,
      database.getAgentConversation(id),
      "conversation detail"
    );
  });

  ipcMain.handle("db-delete-agent-conversation", async (_event, ...args: unknown[]) => {
    const [id] = parseArgs(deleteConversationArgsSchema, args);

    return parseResult(successResultSchema, database.deleteAgentConversation(id), "delete result");
  });

  ipcMain.handle("db-update-agent-conversation-title", async (_event, ...args: unknown[]) => {
    const [id, title] = parseArgs(updateConversationTitleArgsSchema, args);

    return parseResult(
      successResultSchema,
      database.updateAgentConversationTitle(id, title),
      "title update result"
    );
  });

  ipcMain.handle("db-add-agent-message", async (_event, ...args: unknown[]) => {
    const [conversationId, role, content, metadata] = parseArgs(addMessageArgsSchema, args);

    // Metadata crosses as the renderer's structured payload; the DB layer
    // serializes it (metadata ? JSON.stringify(metadata) : null).
    return parseResult(
      messageRowResultSchema,
      database.addAgentMessage(conversationId, role, content, metadata),
      "message row"
    );
  });

  ipcMain.handle("db-get-agent-messages", async (_event, ...args: unknown[]) => {
    const [conversationId] = parseArgs(getMessagesArgsSchema, args);

    return parseResult(
      messageRowListResultSchema,
      database.getAgentMessages(conversationId),
      "message list shape"
    );
  });

  ipcMain.handle("db-get-agent-conversations-with-preview", async (_event, ...args: unknown[]) => {
    const [limit, offset, includeArchived] = parseArgs(getConversationsWithPreviewArgsSchema, args);

    return parseResult(
      previewConversationListResultSchema,
      database.getAgentConversationsWithPreview(limit ?? 50, offset ?? 0, includeArchived ?? false),
      "preview list shape"
    );
  });

  ipcMain.handle("db-search-agent-conversations", async (_event, ...args: unknown[]) => {
    const [query, limit] = parseArgs(searchConversationsArgsSchema, args);

    return parseResult(
      conversationRowListResultSchema,
      database.searchAgentConversations(query, limit ?? 20),
      "conversation list shape"
    );
  });

  ipcMain.handle("db-archive-agent-conversation", async (_event, ...args: unknown[]) => {
    const [id] = parseArgs(archiveUnarchiveArgsSchema, args);

    return parseResult(
      successResultSchema,
      database.archiveAgentConversation(id),
      "archive result"
    );
  });

  ipcMain.handle("db-unarchive-agent-conversation", async (_event, ...args: unknown[]) => {
    const [id] = parseArgs(archiveUnarchiveArgsSchema, args);

    return parseResult(
      successResultSchema,
      database.unarchiveAgentConversation(id),
      "unarchive result"
    );
  });
}
