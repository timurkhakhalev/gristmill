// @probe-name "a wrong bridge-level call fails compilation"
// @probe-codes [2345]
// @probe-origin test/scripts/chatPersistenceTypeProbe.test.js
import { createChatPersistenceBridge } from "./src/preload/chatBridge.js";

declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
};
const bridge = createChatPersistenceBridge(ipcRendererLike);

// addAgentMessage's role is the contract union; "admin" is not a role.
bridge.addAgentMessage(1, "admin", "x");
