// @probe-name "agent message metadata carries only the schema-shaped toolCalls"
// @probe-codes [2353]
// @probe-origin issue-281 IPC/DTO boundary package
import type { ChatPersistenceApi } from "./src/contracts/chatPersistence.js";

declare const api: ChatPersistenceApi;

async function main() {
  // The wire metadata accepts the agent toolCalls; an untracked top-level key
  // must not compile.
  await api.addAgentMessage(1, "user", "hi", { toolCalls: [], junk: true });
}
void main();
