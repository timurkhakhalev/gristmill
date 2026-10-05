// @probe-name "a wrong bridge-level call fails compilation"
// @probe-codes [2554]
// @probe-origin test/scripts/actionsTypeProbe.test.js
import { createActionsBridge } from "./src/preload/actionsBridge.js";

declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
};
const bridge = createActionsBridge(ipcRendererLike);

// createAction requires name, description and prompt; two of three is a
// compile-time error, not a silent empty action.
bridge.createAction("Only a name", "and a description");
