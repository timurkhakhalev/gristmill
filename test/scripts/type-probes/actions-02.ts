// @probe-name "a wrong bridge-level call fails compilation"
// @probe-codes [2345,2554]
// @probe-origin test/scripts/actionsTypeProbe.test.js
import { createActionsBridge } from "./src/preload/actionsBridge.js";

declare const ipcRendererLike: {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
};
const bridge = createActionsBridge(ipcRendererLike);

// createAction requires name, description and prompt; two of three is a
// compile-time error, not a silent empty action.
bridge.createAction("Only a name", "and a description");
