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

// The database dependency accepts the parsed tuple element types and returns
// an opaque row/result; parseResult validates every return before it crosses
// back to the renderer, so the DB return stays a raw object.
type RawDatabaseResult = object | null;

type CreateConversationArgs = ReturnType<typeof createConversationArgsSchema.parse>;

type GetConversationsForNoteArgs = ReturnType<typeof getConversationsForNoteArgsSchema.parse>;

type GetConversationsForContainerArgs = ReturnType<
  typeof getConversationsForContainerArgsSchema.parse
>;

type GetConversationsArgs = ReturnType<typeof getConversationsArgsSchema.parse>;

type GetConversationArgs = ReturnType<typeof getConversationArgsSchema.parse>;

type UpdateConversationTitleArgs = ReturnType<typeof updateConversationTitleArgsSchema.parse>;

type AddMessageArgs = ReturnType<typeof addMessageArgsSchema.parse>;

type GetMessagesArgs = ReturnType<typeof getMessagesArgsSchema.parse>;

type GetConversationsWithPreviewArgs = ReturnType<
  typeof getConversationsWithPreviewArgsSchema.parse
>;

type SearchConversationsArgs = ReturnType<typeof searchConversationsArgsSchema.parse>;

export interface ChatPersistenceHandlerDeps {
  database: {
    createAgentConversation(
      title: CreateConversationArgs[0],
      noteId: CreateConversationArgs[1],
      spaceId: CreateConversationArgs[2],
      folderId: CreateConversationArgs[3]
    ): RawDatabaseResult;
    getConversationsForNote(
      noteId: GetConversationsForNoteArgs[0],
      limit: GetConversationsForNoteArgs[1]
    ): RawDatabaseResult;
    getConversationsForContainer(
      spaceId: GetConversationsForContainerArgs[0],
      folderId: GetConversationsForContainerArgs[1],
      limit: GetConversationsForContainerArgs[2]
    ): RawDatabaseResult;
    getAgentConversations(limit: GetConversationsArgs[0]): RawDatabaseResult;
    getAgentConversation(id: GetConversationArgs[0]): RawDatabaseResult;
    deleteAgentConversation(id: GetConversationArgs[0]): RawDatabaseResult;
    updateAgentConversationTitle(
      id: UpdateConversationTitleArgs[0],
      title: UpdateConversationTitleArgs[1]
    ): RawDatabaseResult;
    addAgentMessage(
      conversationId: AddMessageArgs[0],
      role: AddMessageArgs[1],
      content: AddMessageArgs[2],
      metadata: AddMessageArgs[3]
    ): RawDatabaseResult;
    getAgentMessages(conversationId: GetMessagesArgs[0]): RawDatabaseResult;
    getAgentConversationsWithPreview(
      limit: GetConversationsWithPreviewArgs[0],
      offset: GetConversationsWithPreviewArgs[1],
      includeArchived: GetConversationsWithPreviewArgs[2]
    ): RawDatabaseResult;
    searchAgentConversations(
      query: SearchConversationsArgs[0],
      limit: SearchConversationsArgs[1]
    ): RawDatabaseResult;
    archiveAgentConversation(id: GetConversationArgs[0]): RawDatabaseResult;
    unarchiveAgentConversation(id: GetConversationArgs[0]): RawDatabaseResult;
  };
}

// Method-syntax and a generic result: the test doubles and the type probes
// declare `(event: unknown, ...args: unknown[]) => unknown` listeners, which a
// narrower named `event` type would reject. The listener still receives the
// Electron event as its first argument; the handlers do not read it.
interface IpcMainLike {
  handle<Result>(channel: string, listener: (...args: unknown[]) => Result): void;
}

// Throw before the DB is touched when the renderer sent a wrong-shaped call.
function parseArgs<T>(schema: ZodType<T>, args: readonly unknown[]): T {
  const result = schema.safeParse(args);

  if (!result.success) {
    throw new Error("Invalid arguments for a chat persistence IPC call");
  }

  return result.data;
}

function parseResult<T, Raw>(schema: ZodType<T>, raw: Raw, what: string): T {
  const result = schema.safeParse(raw);

  if (!result.success) {
    throw new Error(`DatabaseManager returned an unexpected ${what}`);
  }

  return result.data;
}

export function registerChatPersistenceHandlers(
  ipcMain: IpcMainLike,
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
