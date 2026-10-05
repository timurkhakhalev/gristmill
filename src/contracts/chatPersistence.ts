// Single source of truth for the chat persistence vertical: local
// conversation/message row shapes, the thirteen DB IPC channels and their
// results. Everything is derived from Zod schemas so main, preload and
// renderer share one description.
//
// The schemas mirror the local SQLite `agent_conversations`/`agent_messages`
// tables and the DatabaseManager return shapes (src/helpers/database.js).
// Cloud-era fields (cloud_id, client_conversation_id, sync_status,
// deleted_at) are not part of the local rows and stay out of the contract.
import { z } from "zod";

const nonNegativeInt = z.number().int();

const idArg = nonNegativeInt;

const optionalId = nonNegativeInt.nullable().optional();

const optionalLimit = nonNegativeInt.optional();

// SELECT * rows: note-scoped and plain lists carry no computed columns.
export const conversationRowSchema = z.object({
  id: nonNegativeInt,
  title: z.string(),
  note_id: nonNegativeInt.nullable(),
  space_id: nonNegativeInt.nullable(),
  folder_id: nonNegativeInt.nullable(),
  archived_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type ConversationRow = z.infer<typeof conversationRowSchema>;

export const messageRoleSchema = z.enum(["user", "assistant", "system"]);

export type MessageRole = z.infer<typeof messageRoleSchema>;

// Metadata is stored as the serialized JSON string on read; on write the
// renderer sends the structured payload and the DB layer serializes it
// (`metadata ? JSON.stringify(metadata) : null`). Main and preload never
// parse or re-wrap it — the renderer owns the toolCalls interpretation.
export const messageRowSchema = z.object({
  id: nonNegativeInt,
  conversation_id: nonNegativeInt,
  role: messageRoleSchema,
  content: z.string(),
  metadata: z.string().nullable(),
  created_at: z.string(),
});

export type MessageRow = z.infer<typeof messageRowSchema>;

// getAgentConversation: the row plus its messages, null when missing.
export const conversationDetailSchema = conversationRowSchema.extend({
  messages: z.array(messageRowSchema),
});

export type ConversationDetail = z.infer<typeof conversationDetailSchema>;

// getConversationsForContainer: the row plus a message count.
export const containerConversationSchema = conversationRowSchema.extend({
  message_count: nonNegativeInt,
});

export type ContainerConversation = z.infer<typeof containerConversationSchema>;

// getAgentConversationsWithPreview: the row plus the last message content,
// null for chats without messages.
export const previewConversationSchema = conversationRowSchema.extend({
  preview: z.string().nullable(),
});

export type PreviewConversation = z.infer<typeof previewConversationSchema>;

// Positional arguments are frozen API: renderer preload and main handlers
// both bind to them. Ids stay strict; limits and scope ids keep the
// documented omitted/null defaults; titles and content stay tolerant (the
// DB layer owns trimming and title fallbacks).
export const createConversationArgsSchema = z.tuple([
  z.unknown().optional(),
  optionalId,
  optionalId,
  optionalId,
]);

export const getConversationsForNoteArgsSchema = z.tuple([idArg, optionalLimit]);

export const getConversationsForContainerArgsSchema = z.tuple([idArg, optionalId, optionalLimit]);

export const getConversationsArgsSchema = z.tuple([optionalLimit]);

export const getConversationArgsSchema = z.tuple([idArg]);

export const deleteConversationArgsSchema = z.tuple([idArg]);

export const updateConversationTitleArgsSchema = z.tuple([idArg, z.unknown()]);

export const addMessageArgsSchema = z.tuple([
  idArg,
  messageRoleSchema,
  z.unknown(),
  z.unknown().optional(),
]);

export const getMessagesArgsSchema = z.tuple([idArg]);

export const getConversationsWithPreviewArgsSchema = z.tuple([
  optionalLimit,
  nonNegativeInt.optional(),
  z.boolean().optional(),
]);

export const searchConversationsArgsSchema = z.tuple([z.unknown(), optionalLimit]);

export const archiveUnarchiveArgsSchema = z.tuple([idArg]);

export const conversationDetailResultSchema = conversationDetailSchema.nullable();

export const conversationRowListResultSchema = z.array(conversationRowSchema);

export const containerConversationListResultSchema = z.array(containerConversationSchema);

export const previewConversationListResultSchema = z.array(previewConversationSchema);

export const messageRowListResultSchema = z.array(messageRowSchema);

export const messageRowResultSchema = messageRowSchema.nullable();

export const successResultSchema = z.object({ success: z.boolean() });

// createAgentConversation delegates to getAgentConversation: null when the
// insert fails (e.g. a dangling scope id), the full detail on success.
export const conversationCreateResultSchema = conversationDetailSchema.nullable();

// The renderer-facing surface: thirteen operations, no subscriptions —
// none of these handlers broadcast events.
export interface ChatPersistenceApi {
  createAgentConversation(
    title?: string,
    noteId?: number | null,
    spaceId?: number | null,
    folderId?: number | null
  ): Promise<ConversationDetail | null>;
  getConversationsForNote(noteId: number, limit?: number): Promise<ConversationRow[]>;
  getConversationsForContainer(
    spaceId: number,
    folderId?: number | null,
    limit?: number
  ): Promise<ContainerConversation[]>;
  getAgentConversations(limit?: number): Promise<ConversationRow[]>;
  getAgentConversation(id: number): Promise<ConversationDetail | null>;
  deleteAgentConversation(id: number): Promise<{ success: boolean }>;
  updateAgentConversationTitle(id: number, title: string): Promise<{ success: boolean }>;
  addAgentMessage(
    conversationId: number,
    role: MessageRole,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<MessageRow | null>;
  getAgentMessages(conversationId: number): Promise<MessageRow[]>;
  getAgentConversationsWithPreview(
    limit?: number,
    offset?: number,
    includeArchived?: boolean
  ): Promise<PreviewConversation[]>;
  searchAgentConversations(query: string, limit?: number): Promise<ConversationRow[]>;
  archiveAgentConversation(id: number): Promise<{ success: boolean }>;
  unarchiveAgentConversation(id: number): Promise<{ success: boolean }>;
}

export const chatPersistenceChannels = {
  createAgentConversation: "db-create-agent-conversation",
  getConversationsForNote: "db-get-conversations-for-note",
  getConversationsForContainer: "db-get-conversations-for-container",
  getAgentConversations: "db-get-agent-conversations",
  getAgentConversation: "db-get-agent-conversation",
  deleteAgentConversation: "db-delete-agent-conversation",
  updateAgentConversationTitle: "db-update-agent-conversation-title",
  addAgentMessage: "db-add-agent-message",
  getAgentMessages: "db-get-agent-messages",
  getAgentConversationsWithPreview: "db-get-agent-conversations-with-preview",
  searchAgentConversations: "db-search-agent-conversations",
  archiveAgentConversation: "db-archive-agent-conversation",
  unarchiveAgentConversation: "db-unarchive-agent-conversation",
} as const;
