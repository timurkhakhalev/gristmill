import type { MeetingRecordingStorage as MeetingRecordingStorageType } from "./meetingRecordingStorage.js";

import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

import debugLogger from "./debugLogger.js";
import { parseDbTimestamp } from "./dbTimestamp.js";
import { MeetingRecordingStorage } from "./meetingRecordingStorage.js";

export interface AudioCleanupDatabase {
  clearAudioFlags(ids: string[]): void;
}

export interface AudioDeleteResult {
  success: boolean;
}

export interface AudioSaveResult {
  success: boolean;
  path?: string;
}

export interface AudioCleanupResult {
  deleted: number;
  kept: number;
}

export interface AudioDeleteAllResult {
  deleted: number;
  failed: number;
}

export interface AudioStorageUsage {
  fileCount: number;
  totalBytes: number;
}

export class AudioStorageManager {
  readonly audioDir: string;
  readonly meetingRecordings: MeetingRecordingStorageType;

  constructor() {
    this.audioDir = path.join(app.getPath("userData"), "audio");
    this.meetingRecordings = new MeetingRecordingStorage({ userDataPath: app.getPath("userData") });
    this.ensureAudioDir();
  }

  ensureAudioDir(): void {
    try {
      fs.mkdirSync(this.audioDir, { recursive: true });
    } catch (error) {
      debugLogger.error(
        "Failed to create audio directory",
        { error: error instanceof Error ? error.message : String(error) },
        "audio-storage"
      );
    }
  }

  _buildFilename(transcriptionId: number, timestamp: string | null | undefined): string {
    if (timestamp) {
      // Named in the user's own wall clock, so the stored instant has to be
      // resolved before it is read -- a bare SQLite timestamp is UTC, not local.
      const d = parseDbTimestamp(timestamp);

      if (d) {
        const pad = (n: number) => String(n).padStart(2, "0");
        const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;

        return `Gristmill-${date}-${time}-${transcriptionId}.webm`;
      }
    }

    return `Gristmill-${transcriptionId}.webm`;
  }

  saveAudio(
    transcriptionId: number,
    audioBuffer: Buffer,
    timestamp?: string | null
  ): AudioSaveResult {
    try {
      const filename = this._buildFilename(transcriptionId, timestamp);
      const filePath = path.join(this.audioDir, filename);
      fs.writeFileSync(filePath, audioBuffer);
      debugLogger.debug(
        "Audio saved",
        { transcriptionId, filename, size: audioBuffer.length },
        "audio-storage"
      );

      return { success: true, path: filePath };
    } catch (error) {
      debugLogger.error(
        "Failed to save audio",
        { transcriptionId, error: error instanceof Error ? error.message : String(error) },
        "audio-storage"
      );

      return { success: false };
    }
  }

  getAudioPath(transcriptionId: number): string | null {
    try {
      const files: string[] = fs.readdirSync(this.audioDir);

      const match = files.find(
        (f) => f.endsWith(`-${transcriptionId}.webm`) || f === `${transcriptionId}.webm`
      );

      if (match) return path.join(this.audioDir, match);
    } catch {
      /* unreadable audio directory globs to no path */
    }

    return null;
  }

  getAudioBuffer(transcriptionId: number): Buffer | null {
    const filePath = this.getAudioPath(transcriptionId);

    if (!filePath) return null;

    try {
      return fs.readFileSync(filePath);
    } catch (error) {
      debugLogger.error(
        "Failed to read audio",
        { transcriptionId, error: error instanceof Error ? error.message : String(error) },
        "audio-storage"
      );

      return null;
    }
  }

  deleteAudio(transcriptionId: number): AudioDeleteResult {
    try {
      const filePath = this.getAudioPath(transcriptionId);

      if (filePath) {
        fs.unlinkSync(filePath);
        debugLogger.debug("Audio deleted", { transcriptionId }, "audio-storage");
      }

      return { success: true };
    } catch (error) {
      debugLogger.error(
        "Failed to delete audio",
        { transcriptionId, error: error instanceof Error ? error.message : String(error) },
        "audio-storage"
      );

      return { success: false };
    }
  }

  cleanupExpiredAudio(
    retentionDays: number,
    databaseManager?: AudioCleanupDatabase | null
  ): AudioCleanupResult {
    try {
      const cutoffMs = Date.now() - retentionDays * 86400000;
      const files = fs.readdirSync(this.audioDir).filter((f: string) => f.endsWith(".webm"));
      const expiredIds = [];
      let kept = 0;

      for (const file of files) {
        const filePath = path.join(this.audioDir, file);

        try {
          const stats = fs.statSync(filePath);

          if (stats.mtimeMs < cutoffMs) {
            fs.unlinkSync(filePath);
            // Extract ID from the app-prefixed filename or legacy "{id}.webm"
            const basename = path.basename(file, ".webm");
            const lastDash = basename.lastIndexOf("-");
            const id = lastDash !== -1 ? basename.slice(lastDash + 1) : basename;
            expiredIds.push(id);
          } else {
            kept++;
          }
        } catch (error) {
          debugLogger.error(
            "Failed to process audio file during cleanup",
            { file, error: error instanceof Error ? error.message : String(error) },
            "audio-storage"
          );
        }
      }

      if (expiredIds.length > 0 && databaseManager) {
        databaseManager.clearAudioFlags(expiredIds);
      }

      debugLogger.info(
        "Audio cleanup complete",
        { deleted: expiredIds.length, kept, retentionDays },
        "audio-storage"
      );

      return { deleted: expiredIds.length, kept };
    } catch (error) {
      debugLogger.error(
        "Audio cleanup failed",
        { error: error instanceof Error ? error.message : String(error) },
        "audio-storage"
      );

      return { deleted: 0, kept: 0 };
    }
  }

  deleteAllAudio(): AudioDeleteAllResult {
    try {
      const files = fs.readdirSync(this.audioDir).filter((f: string) => f.endsWith(".webm"));
      let deleted = 0;
      let failed = 0;

      for (const file of files) {
        try {
          fs.unlinkSync(path.join(this.audioDir, file));
          deleted += 1;
        } catch (error) {
          failed += 1;
          debugLogger.error(
            "Failed to delete audio file",
            { file, error: error instanceof Error ? error.message : String(error) },
            "audio-storage"
          );
        }
      }

      debugLogger.info("All audio deletion finished", { deleted, failed }, "audio-storage");

      return { deleted, failed };
    } catch (error) {
      debugLogger.error(
        "Failed to delete all audio",
        { error: error instanceof Error ? error.message : String(error) },
        "audio-storage"
      );

      return { deleted: 0, failed: 1 };
    }
  }

  getStorageUsage(): AudioStorageUsage {
    try {
      const files = fs.readdirSync(this.audioDir).filter((f: string) => f.endsWith(".webm"));
      let totalBytes = 0;

      for (const file of files) {
        try {
          const stats = fs.statSync(path.join(this.audioDir, file));
          totalBytes += stats.size;
        } catch {
          // Skip files that can't be stat'd.
        }
      }

      return { fileCount: files.length, totalBytes };
    } catch (error) {
      debugLogger.error(
        "Failed to get storage usage",
        { error: error instanceof Error ? error.message : String(error) },
        "audio-storage"
      );

      return { fileCount: 0, totalBytes: 0 };
    }
  }
}

// CommonJS passthrough: the original module exported the class itself and
// every require site (ipcHandlers.js, main.js, tests) invokes it directly.
module.exports = AudioStorageManager;

// CommonJS contract for legacy destructuring requires.
Object.assign(module.exports, { AudioStorageManager });
