// Shared typed transport seam for the sandboxed preload bridges. The preload
// cannot require local modules (build-main.js bundles the final preload), so
// every bridge binds to this same minimal Electron ipcRenderer shape.
//
// The event/invocation payloads are structurally unknown at this seam: Electron
// structured-clone deserialization happens below it. Each bridge parses the
// payload right here with its contract schema before any callback runs — the
// parser is the boundary, and these helpers are its only honest spelling:
// parameters carry `unknown` because that is what the transport hands over,
// and results are returned only after a schema or explicit check has run.
export interface Subscription {
  (): void;
}

export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

// SAFETY: subscribeValidated only delivers after the parse succeeds, so the
// callback receives the parsed contract type, not the raw wire value.
export function subscribeValidated<T>(
  ipcRenderer: IpcRendererLike,
  channel: string,
  parse: (raw: unknown) => T | undefined,
  callback: (payload: T) => void
): Subscription {
  // SAFETY: the callback arrives typed from each bridge; the runtime guard
  // only defends against dynamic dispatch, never against the static type.
  if (typeof callback !== "function") {
    return () => {};
  }

  const listener = (_event: unknown, raw: unknown) => {
    const parsed = parse(raw);

    if (parsed !== undefined) {
      callback(parsed);
    }
  };

  // SAFETY: the listener matches the declared two-argument shape; the cast
  // only re-voices it against Electron's wider IpcRendererEvent overload.
  ipcRenderer.on(channel, listener as (event: unknown, ...args: unknown[]) => void);

  return () => {
    // SAFETY: same listener object as the registration above; the cast only
    // re-voices its declared shape for the removal overload.
    ipcRenderer.removeListener(channel, listener as (event: unknown, ...args: unknown[]) => void);
  };
}

// Bridges that log malformed events name the drop through this wrapper.
export function subscribeDropped<T>(
  ipcRenderer: IpcRendererLike,
  channel: string,
  parse: (raw: unknown) => T | undefined,
  callback: (payload: T) => void
): Subscription {
  return subscribeValidated(ipcRenderer, channel, parse, callback);
}
