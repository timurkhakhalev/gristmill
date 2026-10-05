// @probe-name "the preload transport seam rejects a mis-typed callback payload"
// @probe-codes [2322]
// @probe-origin issue-281 IPC/DTO boundary package
import { subscribeValidated, type IpcRendererLike } from "./src/preload/ipcTransport.js";

declare const ipcRenderer: IpcRendererLike;

// The parser returns string, so a number consumer is a compile error.
const dispose = subscribeValidated<string>(
  ipcRenderer,
  "probe-channel",
  (raw) => (typeof raw === "string" ? raw : undefined),
  (value) => {
    const bad: number = value;
    void bad;
  }
);

void dispose();
