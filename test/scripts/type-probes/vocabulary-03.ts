// @probe-name "the preload transport seam parses event payloads before delivery"
// @probe-codes []
// @probe-origin issue-281 IPC/DTO boundary package
import { subscribeValidated, type IpcRendererLike } from "./src/preload/ipcTransport.js";

declare const ipcRenderer: IpcRendererLike;

// A number-producing parser: the callback receives exactly that type.
const dispose = subscribeValidated<number>(
  ipcRenderer,
  "probe-channel",
  (raw) => (typeof raw === "number" ? raw : undefined),
  (value) => {
    const doubled: number = value * 2;
    void doubled;
  }
);

void dispose();
