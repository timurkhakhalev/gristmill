import { createContext, useContext } from "react";

export type LocalModelKind = "whisper" | "parakeet" | "llm";

export interface LocalModelEntry {
  id: string;
  kind: LocalModelKind;
  /** Display organization (Oruk, OpenAI, Qwen…), which is also the icon key. */
  organization: string;
  name: string;
  size: string;
  recommended: boolean;
  downloaded: boolean;
  modelCardUrl?: string;
  /** Set when the runtime cannot run this model on this Mac. */
  unavailableReason?: string;
}

export interface LocalDownloadState {
  progress: number;
  installing: boolean;
  cancelling: boolean;
}

export interface LocalModelInventory {
  speech: LocalModelEntry[];
  language: LocalModelEntry[];
  /** False when this macOS cannot run the sherpa runtime (Oruk, NVIDIA, Cohere). */
  sherpaSupported: boolean;
  find(kind: "speech" | "language", id: string): LocalModelEntry | undefined;
  downloadState(entry: LocalModelEntry): LocalDownloadState | null;
  download(entry: LocalModelEntry, onDownloaded?: (id: string) => void): void;
  cancel(entry: LocalModelEntry): void;
  remove(entry: LocalModelEntry): void;
}

export const InventoryContext = createContext<LocalModelInventory | null>(null);

export function useLocalModelInventory(): LocalModelInventory {
  const inventory = useContext(InventoryContext);
  if (!inventory) throw new Error("useLocalModelInventory must be used inside LocalModelInventoryProvider");
  return inventory;
}

