export interface ChromeEvent<Listener> { addListener(listener: Listener): void }
export interface ChromePort {
  postMessage(value: unknown): void;
  disconnect(): void;
  onMessage: ChromeEvent<(value: unknown) => void>;
  onDisconnect: ChromeEvent<() => void>;
}
export interface ChromeSender { id?: string; url?: string; frameId?: number; documentId?: string; tab?: { id?: number; url?: string } }
export interface ChromeApi {
  runtime: {
    id: string;
    lastError?: { message?: string };
    connectNative(name: string): ChromePort;
    onMessage: ChromeEvent<(value: unknown, sender: ChromeSender, respond: (value: unknown) => void) => boolean | void>;
    onUpdateAvailable: ChromeEvent<() => void>;
    reload(): void;
    sendMessage(value: unknown): Promise<unknown>;
    getURL(path: string): string;
  };
  storage: {
    local: { get(key: string): Promise<Record<string, unknown>>; set(value: Record<string, unknown>): Promise<void> };
    session: { get(key: string): Promise<Record<string, unknown>>; set(value: Record<string, unknown>): Promise<void> };
  };
  alarms: { create(name: string, options: { periodInMinutes: number }): Promise<void>; onAlarm: ChromeEvent<(alarm: { name: string }) => void> };
  tabs: { query(options: { active: boolean; currentWindow: boolean }): Promise<Array<{ id?: number }>>; sendMessage(tabId: number, value: unknown, options: { documentId: string }): Promise<unknown> };
}
