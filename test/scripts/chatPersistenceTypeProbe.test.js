const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "../..");
const configPath = path.join(root, "tsconfig.main.json");

// Compiles a probe source under the strict main settings and returns all
// program diagnostics. Negative probes expect specific codes; positive
// probes expect none.
function probeDiagnostics(source) {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.equal(parsed.options.strict, true);
  const probe = path.join(root, "chat-persistence-type-probe.ts");
  const host = ts.createCompilerHost(parsed.options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, ...args) =>
    file === probe
      ? ts.createSourceFile(file, source, languageVersion, true)
      : readSource(file, languageVersion, ...args);
  const program = ts.createProgram([probe], { ...parsed.options, noEmit: true }, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  return {
    codes: diagnostics.map((d) => d.code).sort((a, b) => a - b),
    cleanup: () => {
      if (fs.existsSync(probe)) fs.rmSync(probe, { force: true });
    },
  };
}

const IPC_MAIN = `declare const ipcMain: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void };`;

test("an incomplete database dependency fails compilation", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { registerChatPersistenceHandlers } from "./src/helpers/chatPersistenceIpcHandlers.js";

${IPC_MAIN}

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
`);
  try {
    assert.deepEqual(codes, [2741]);
  } finally {
    cleanup();
  }
});

test("a wrong bridge-level call fails compilation", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { createChatPersistenceBridge } from "./src/preload/chatBridge.js";

declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
};
const bridge = createChatPersistenceBridge(ipcRendererLike);

// addAgentMessage's role is the contract union; "admin" is not a role.
bridge.addAgentMessage(1, "admin", "x");
`);
  try {
    assert.deepEqual(codes, [2345]);
  } finally {
    cleanup();
  }
});

test("the full contract registration and bridge compile under strict settings", () => {
  const { codes, cleanup } = probeDiagnostics(`
import { registerChatPersistenceHandlers } from "./src/helpers/chatPersistenceIpcHandlers.js";
import { createChatPersistenceBridge } from "./src/preload/chatBridge.js";

${IPC_MAIN}

registerChatPersistenceHandlers(ipcMain, {
  database: {
    createAgentConversation: (title, noteId, spaceId, folderId) => {
      void title; void noteId; void spaceId; void folderId;
      return null;
    },
    getConversationsForNote: (noteId: unknown, limit: unknown) => {
      void limit;
      return Number(noteId) > 0
        ? [{ id: 1, title: "t", note_id: null, space_id: null, folder_id: null, archived_at: null, created_at: "c", updated_at: "u" }]
        : [];
    },
    getConversationsForContainer: (spaceId, folderId, limit) => {
      void folderId; void limit;
      return [{ id: 1, title: "t", note_id: null, space_id: spaceId, folder_id: null, archived_at: null, created_at: "c", updated_at: "u", message_count: 0 }];
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
      void id; void title;
      return { success: true };
    },
    addAgentMessage: (conversationId: unknown, role: unknown, content: unknown, metadata: unknown) => {
      void role; void content; void metadata;
      return Number(conversationId) > 0
        ? { id: 2, conversation_id: conversationId, role: "user", content: "x", metadata: null, created_at: "c" }
        : null;
    },
    getAgentMessages: (conversationId) => {
      void conversationId;
      return [];
    },
    getAgentConversationsWithPreview: (limit, offset, includeArchived) => {
      void limit; void offset; void includeArchived;
      return [];
    },
    searchAgentConversations: (query, limit) => {
      void query; void limit;
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
};
const bridge = createChatPersistenceBridge(ipcRendererLike);
const titles: Promise<string[]> = bridge.getAgentConversations(10).then((rows) => rows.map((r) => r.title));
void titles;
`);
  try {
    assert.deepEqual(codes, []);
  } finally {
    cleanup();
  }
});
