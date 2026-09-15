export interface LocalModelDownloadState {
  modelType: string;
  modelId: string;
  phase: "downloading" | "installing";
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  sequence: number;
}

export class LocalModelDownloadStatus {
  private downloads = new Map<string, LocalModelDownloadState>();
  private sequence = 0;

  _key(modelType: string, modelId: string): string {
    return `${modelType}:${modelId}`;
  }

  start(modelType: string, modelId: string): LocalModelDownloadState {
    const key = this._key(modelType, modelId);
    const existing = this.downloads.get(key);
    if (existing) return existing;

    const status = {
      modelType,
      modelId,
      phase: "downloading" as const,
      progress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      sequence: ++this.sequence,
    };
    this.downloads.set(key, status);
    return status;
  }

  has(modelType: string, modelId: string): boolean {
    return this.downloads.has(this._key(modelType, modelId));
  }

  update(
    modelType: string,
    modelId: string,
    updates: Partial<Omit<LocalModelDownloadState, "modelType" | "modelId" | "sequence">>
  ): LocalModelDownloadState {
    const key = this._key(modelType, modelId);
    const current = this.downloads.get(key) || this.start(modelType, modelId);
    const status = {
      ...current,
      ...updates,
      modelType,
      modelId,
      sequence: ++this.sequence,
    };
    this.downloads.set(key, status);
    return status;
  }

  finish(modelType: string, modelId: string): LocalModelDownloadState | null {
    const key = this._key(modelType, modelId);
    const current = this.downloads.get(key);
    this.downloads.delete(key);
    return current ? { ...current, sequence: ++this.sequence } : null;
  }

  getActiveDownloads(): LocalModelDownloadState[] {
    return Array.from(this.downloads.values());
  }
}



// Dual export: ipcHandlers.js requires this module as the class itself,
// while the TS graph imports the named export.
module.exports = LocalModelDownloadStatus;
module.exports.LocalModelDownloadStatus = LocalModelDownloadStatus;
