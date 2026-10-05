import type { MeetingAudioLayout } from "./meetingAudioMixer.js";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { app } from "electron";
import {
  meetingRecordingIdSchema,
  meetingRunArtifactSchema,
  meetingSourceSchema,
  meetingSummaryArtifactSchema,
  meetingTranscriptArtifactSchema,
  type MeetingDeletionIntentDto,
  type MeetingRecordingDto,
  type MeetingRecordingEpochDto,
  type MeetingRunArtifact,
  type MeetingSource,
} from "../contracts/meetingRecording.js";

import { MeetingOpusWriter, inspectMeetingOpus } from "./meetingOpus.js";

const BYTES_PER_FRAME = 2;

type WriteSync = (
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number | null
) => number;

export interface MeetingRecordingPersistence {
  listMeetingDeletionIntents(): MeetingDeletionIntentDto[];
  getMeetingNoteStorageIds(noteId: number): { recordingIds: string[]; runIds: string[] };
  completeMeetingAudioDeletion(intentId: string): { success: boolean };
  completeMeetingNoteDeletion(intentId: string): { success: boolean };
  failMeetingDeletion(intentId: string, errorCode: string): { success: boolean };
  listOpenMeetingRecordings(): MeetingRecordingDto[];
  listAllMeetingProcessingRuns(): Array<{
    id: string;
    hasRawProviderResponse: boolean;
    hasTranscript: boolean;
    hasSummary: boolean;
  }>;
  reconcileMeetingRunArtifact(id: string, artifact: MeetingRunArtifact): { success: boolean };
  listMeetingRecordingEpochs(recordingId: string): MeetingRecordingEpochDto[];
  updateMeetingRecordingEpochRecovery(
    recordingId: string,
    source: MeetingSource,
    epochIndex: number,
    result: { frameCount: number; ignoredTrailingBytes: number; errorCode?: string | null }
  ): MeetingRecordingEpochDto;
  finalizeMeetingRecording(
    id: string,
    input: {
      captureState: "ready" | "incomplete";
      endedAt: string;
      sourceMetadata?: Record<string, unknown>;
      errorCode?: string | null;
    }
  ): unknown;
}

export interface MeetingRecordingStorageOptions {
  userDataPath?: string;
  writeSync?: WriteSync;
}

export interface RecoveredEpoch {
  recordingId: string;
  source: MeetingSource;
  epochIndex: number;
  timelineStartFrame: number | null;
  frameCount: number;
  ignoredTrailingBytes: number;
  errorCode: string | null;
}

type StoredMeetingArtifact =
  | MeetingRunArtifact
  | "provider-response-mic"
  | "provider-response-system";

export class MeetingRecordingStorage {
  readonly userDataPath: string;
  readonly recordingsRoot: string;
  readonly resultsRoot: string;
  private readonly writeSync: WriteSync;
  private readonly openWriters = new Map<
    string,
    { encoder: MeetingOpusWriter; recordingId: string }
  >();

  constructor(options: MeetingRecordingStorageOptions = {}) {
    this.userDataPath = path.resolve(options.userDataPath ?? app.getPath("userData"));
    this.recordingsRoot = path.join(this.userDataPath, "audio", "meetings");
    this.resultsRoot = path.join(this.userDataPath, "meeting-results");
    this.writeSync = options.writeSync ?? fs.writeSync;
  }

  createRecordingDirectory(recordingId: string): string {
    meetingRecordingIdSchema.parse(recordingId);
    const directory = path.join(this.recordingsRoot, recordingId);
    this.ensureManagedDirectory(directory);

    return directory;
  }

  createRunDirectory(runId: string): string {
    meetingRecordingIdSchema.parse(runId);
    const directory = path.join(this.resultsRoot, runId);
    this.ensureManagedDirectory(directory);

    return directory;
  }

  createEpochFile(recordingId: string, source: MeetingSource, epochIndex: number): string {
    meetingRecordingIdSchema.parse(recordingId);
    meetingSourceSchema.parse(source);
    this.validateEpochIndex(epochIndex);
    const filePath = this.epochFilePath(recordingId, source, epochIndex);
    this.ensureManagedDirectory(path.dirname(filePath));

    const flags =
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | this.noFollowFlag();

    const fd = fs.openSync(filePath, flags, 0o600);
    fs.closeSync(fd);

    return filePath;
  }

  openEpochWriter(recordingId: string, source: MeetingSource, epochIndex: number): void {
    meetingRecordingIdSchema.parse(recordingId);
    meetingSourceSchema.parse(source);
    this.validateEpochIndex(epochIndex);
    const filePath = this.epochFilePath(recordingId, source, epochIndex);
    this.ensureManagedDirectory(path.dirname(filePath));
    this.assertSafeFile(filePath);
    const key = `${recordingId}/${source}/${epochIndex}`;

    if (this.openWriters.has(key))
      throw new Error("Meeting recording epoch already has an open writer");
    let fd: number;

    try {
      const info = fs.lstatSync(filePath);

      if (!info.isFile() || info.size !== 0)
        throw new Error("Meeting recording epoch file already has data");
      fd = fs.openSync(
        filePath,
        fs.constants.O_WRONLY | fs.constants.O_APPEND | this.noFollowFlag()
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

      const flags =
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        fs.constants.O_APPEND |
        this.noFollowFlag();

      fd = fs.openSync(filePath, flags, 0o600);
    }

    try {
      const encoder = new MeetingOpusWriter(fd, (descriptor, page) =>
        writeAllSync(descriptor, page, this.writeSync)
      );

      this.openWriters.set(key, { encoder, recordingId });
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }

  appendEpochSamples(
    recordingId: string,
    source: MeetingSource,
    epochIndex: number,
    samples: Buffer
  ): void {
    meetingRecordingIdSchema.parse(recordingId);
    meetingSourceSchema.parse(source);
    this.validateEpochIndex(epochIndex);

    if (samples.length % BYTES_PER_FRAME !== 0)
      throw new Error("PCM16LE samples must contain whole frames");
    const key = `${recordingId}/${source}/${epochIndex}`;
    const writer = this.openWriters.get(key);

    if (!writer) throw new Error("Meeting recording epoch writer is not open");
    writer.encoder.append(Buffer.from(samples));
  }

  async closeEpochWriter(
    recordingId: string,
    source: MeetingSource,
    epochIndex: number
  ): Promise<void> {
    const key = `${recordingId}/${source}/${epochIndex}`;
    const writer = this.openWriters.get(key);

    if (!writer) return;

    try {
      await writer.encoder.close();
    } finally {
      this.openWriters.delete(key);
    }
  }

  async closeRecordingWriters(recordingId: string): Promise<void> {
    meetingRecordingIdSchema.parse(recordingId);

    const outcomes = await Promise.allSettled(
      [...this.openWriters]
        .filter(([, writer]) => writer.recordingId === recordingId)
        .map(([key]) => {
          const [, source, epochIndex] = key.split("/");

          return this.closeEpochWriter(
            recordingId,
            meetingSourceSchema.parse(source),
            Number(epochIndex)
          );
        })
    );

    const failed = outcomes.find((result) => result.status === "rejected");

    if (failed?.status === "rejected") throw failed.reason;
  }

  private assertNoWriters(recordingId: string): void {
    if ([...this.openWriters.values()].some((writer) => writer.recordingId === recordingId)) {
      throw new Error("Meeting recording still has active audio writers");
    }
  }

  recoverEpoch(
    recordingId: string,
    source: MeetingSource,
    epochIndex: number
  ): Omit<RecoveredEpoch, "recordingId" | "source" | "epochIndex" | "timelineStartFrame"> {
    meetingRecordingIdSchema.parse(recordingId);
    meetingSourceSchema.parse(source);
    this.validateEpochIndex(epochIndex);
    const filePath = this.epochFilePath(recordingId, source, epochIndex);

    try {
      this.assertSafeFile(filePath);

      return inspectMeetingOpus(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { frameCount: 0, ignoredTrailingBytes: 0, errorCode: "missing-epoch" };
      }

      return { frameCount: 0, ignoredTrailingBytes: 0, errorCode: safeErrorCode(error) };
    }
  }

  writeRunArtifact(runId: string, artifact: StoredMeetingArtifact, value: unknown): string {
    meetingRecordingIdSchema.parse(runId);

    if (artifact !== "provider-response-mic" && artifact !== "provider-response-system")
      meetingRunArtifactSchema.parse(artifact);

    const normalizedValue =
      artifact === "transcript"
        ? meetingTranscriptArtifactSchema.parse(value)
        : artifact === "summary"
          ? meetingSummaryArtifactSchema.parse(value)
          : value;

    const fileName = artifactFileName(artifact);
    const directory = this.createRunDirectory(runId);
    const destination = path.join(directory, fileName);
    this.assertSafeFile(destination);

    if (artifact.startsWith("provider-response") && fs.existsSync(destination)) {
      throw new Error("Raw provider response is already stored for this run");
    }

    const serialized = JSON.stringify(normalizedValue);

    if (serialized === undefined) throw new Error("Meeting result is not JSON serializable");
    const bytes = Buffer.from(serialized, "utf8");
    const tempPath = path.join(directory, `.tmp-${randomUUID()}.json`);
    this.assertSafeFile(tempPath);

    const fd = fs.openSync(
      tempPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | this.noFollowFlag(),
      0o600
    );

    try {
      writeAllSync(fd, bytes, this.writeSync);
      fs.fsyncSync(fd);
    } catch (error) {
      fs.closeSync(fd);
      fs.rmSync(tempPath, { force: true });
      throw error;
    }

    fs.closeSync(fd);

    try {
      fs.renameSync(tempPath, destination);
    } catch (error) {
      fs.rmSync(tempPath, { force: true });
      throw error;
    }

    return destination;
  }

  readRunArtifact(runId: string, artifact: StoredMeetingArtifact): unknown | null {
    meetingRecordingIdSchema.parse(runId);

    if (artifact !== "provider-response-mic" && artifact !== "provider-response-system")
      meetingRunArtifactSchema.parse(artifact);
    const filePath = path.join(this.resultsRoot, runId, artifactFileName(artifact));

    try {
      this.assertSafeFile(filePath);
      const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));

      if (artifact === "transcript") return meetingTranscriptArtifactSchema.parse(value);

      if (artifact === "summary") return meetingSummaryArtifactSchema.parse(value);

      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  hasRunArtifact(runId: string, artifact: StoredMeetingArtifact): boolean {
    meetingRecordingIdSchema.parse(runId);

    if (artifact !== "provider-response-mic" && artifact !== "provider-response-system")
      meetingRunArtifactSchema.parse(artifact);
    const filePath = path.join(this.resultsRoot, runId, artifactFileName(artifact));
    this.assertSafeFile(filePath);

    try {
      fs.lstatSync(filePath);

      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  removeRunArtifact(runId: string, artifact: StoredMeetingArtifact): void {
    meetingRecordingIdSchema.parse(runId);

    if (artifact !== "provider-response-mic" && artifact !== "provider-response-system")
      meetingRunArtifactSchema.parse(artifact);
    const filePath = path.join(this.resultsRoot, runId, artifactFileName(artifact));
    this.assertSafeFile(filePath);
    fs.rmSync(filePath, { force: true });
  }

  getEpochFilePath(recordingId: string, source: MeetingSource, epochIndex: number): string {
    const filePath = this.epochFilePath(recordingId, source, epochIndex);
    this.assertSafeFile(filePath);

    return filePath;
  }

  getDerivedAudioPath(
    recordingId: string,
    runId: string,
    layout: MeetingAudioLayout = "mono"
  ): string {
    meetingRecordingIdSchema.parse(recordingId);
    meetingRecordingIdSchema.parse(runId);
    const directory = path.join(this.recordingsRoot, recordingId, "derived");
    this.ensureManagedDirectory(directory);
    const filePath = path.join(directory, `${runId}${layout === "mono" ? "" : `-${layout}`}.wav`);
    this.assertSafeFile(filePath);

    return filePath;
  }

  getDerivedAudioTempPath(
    recordingId: string,
    runId: string,
    layout: MeetingAudioLayout = "mono"
  ): string {
    meetingRecordingIdSchema.parse(recordingId);
    meetingRecordingIdSchema.parse(runId);
    const directory = path.join(this.recordingsRoot, recordingId, "derived");
    this.ensureManagedDirectory(directory);
    const filePath = path.join(directory, `.tmp-${runId}-${layout}-${randomUUID()}.wav`);
    this.assertSafeFile(filePath);

    return filePath;
  }

  removeRecordingAudio(recordingId: string): void {
    meetingRecordingIdSchema.parse(recordingId);
    this.assertNoWriters(recordingId);
    this.removeManagedTree(path.join(this.recordingsRoot, recordingId));
  }

  removeDerivedAudio(recordingId: string, runId: string): void {
    for (const layout of ["mono", "stereo", "mic", "system"] as const) {
      meetingRecordingIdSchema.parse(recordingId);
      meetingRecordingIdSchema.parse(runId);

      const filePath = path.join(
        this.recordingsRoot,
        recordingId,
        "derived",
        `${runId}${layout === "mono" ? "" : `-${layout}`}.wav`
      );

      this.assertSafeFile(filePath);
      fs.rmSync(filePath, { force: true });
    }
  }

  clearDerivedAudio(): Array<{ id: string; code: string }> {
    const errors: Array<{ id: string; code: string }> = [];

    if (!fs.existsSync(this.recordingsRoot)) return errors;

    for (const id of fs.readdirSync(this.recordingsRoot)) {
      if (
        !meetingRecordingIdSchema.safeParse(id).success ||
        !fs.lstatSync(path.join(this.recordingsRoot, id)).isDirectory() ||
        fs.lstatSync(path.join(this.recordingsRoot, id)).isSymbolicLink()
      )
        continue;

      try {
        this.removeManagedTree(path.join(this.recordingsRoot, id, "derived"));
      } catch {
        errors.push({ id, code: "derived-cleanup-failed" });
      }
    }

    return errors;
  }

  removeRunFiles(recordingId: string, runId: string): void {
    meetingRecordingIdSchema.parse(recordingId);
    meetingRecordingIdSchema.parse(runId);
    this.removeManagedTree(path.join(this.resultsRoot, runId));

    for (const layout of ["mono", "stereo", "mic", "system"] as const) {
      const derived = path.join(
        this.recordingsRoot,
        recordingId,
        "derived",
        `${runId}${layout === "mono" ? "" : `-${layout}`}.wav`
      );

      this.assertSafeFile(derived);
      fs.rmSync(derived, { force: true });
    }
  }

  removeNoteFiles(recordingIds: string[], runIds: string[]): void {
    for (const recordingId of recordingIds) {
      meetingRecordingIdSchema.parse(recordingId);
      this.assertNoWriters(recordingId);
      this.removeManagedTree(path.join(this.recordingsRoot, recordingId));
    }

    for (const runId of runIds) {
      meetingRecordingIdSchema.parse(runId);
      this.removeManagedTree(path.join(this.resultsRoot, runId));
    }
  }

  recover(database: MeetingRecordingPersistence): {
    recovered: RecoveredEpoch[];
    finalized: string[];
    deleted: string[];
    errors: Array<{ id: string; code: string }>;
  } {
    const result = {
      recovered: [] as RecoveredEpoch[],
      finalized: [] as string[],
      deleted: [] as string[],
      errors: [] as Array<{ id: string; code: string }>,
    };

    result.errors.push(...this.clearDerivedAudio());
    this.processDeletionIntents(database, result.deleted, result.errors);
    this.reconcileRunArtifacts(database, result.errors);

    for (const recording of database.listOpenMeetingRecordings()) {
      if (recording.audioState !== "available") continue;
      this.assertNoWriters(recording.id);
      const epochs = database.listMeetingRecordingEpochs(recording.id);
      const recovered: RecoveredEpoch[] = [];

      for (const epoch of epochs) {
        const recoveredEpoch = this.recoverEpoch(recording.id, epoch.source, epoch.epochIndex);
        database.updateMeetingRecordingEpochRecovery(
          recording.id,
          epoch.source,
          epoch.epochIndex,
          recoveredEpoch
        );
        recovered.push({
          recordingId: recording.id,
          source: epoch.source,
          epochIndex: epoch.epochIndex,
          timelineStartFrame: epoch.timelineStartFrame,
          ...recoveredEpoch,
        });
      }

      const totalFrames = recovered.reduce((total, epoch) => total + epoch.frameCount, 0);

      const latestEndFrame = recovered.reduce(
        (latest, epoch) =>
          epoch.timelineStartFrame === null
            ? latest
            : Math.max(latest, epoch.timelineStartFrame + epoch.frameCount),
        0
      );

      const startTime = Date.parse(recording.startedAt);
      const endedAt = new Date(startTime + (latestEndFrame / 24_000) * 1000).toISOString();

      const sourceMetadata = {
        ...recording.sourceMetadata,
        recovered: true,
        epochs: recovered.map(
          ({
            source,
            epochIndex,
            timelineStartFrame,
            frameCount,
            ignoredTrailingBytes,
            errorCode,
          }) => ({
            source,
            epochIndex,
            timelineStartFrame,
            frameCount,
            ignoredTrailingBytes,
            errorCode,
          })
        ),
      };

      database.finalizeMeetingRecording(recording.id, {
        // An open recording found at startup was interrupted, even if its
        // persisted bytes end on frame boundaries and every epoch is readable.
        captureState: "incomplete",
        endedAt,
        sourceMetadata,
        errorCode: totalFrames === 0 ? "recording-audio-unavailable" : null,
      });
      result.recovered.push(...recovered);
      result.finalized.push(recording.id);
    }

    return result;
  }

  private reconcileRunArtifacts(
    database: MeetingRecordingPersistence,
    errors: Array<{ id: string; code: string }>
  ): void {
    for (const run of database.listAllMeetingProcessingRuns()) {
      const artifacts: Array<{ name: MeetingRunArtifact; saved: boolean }> = [
        { name: "provider-response", saved: run.hasRawProviderResponse },
        { name: "transcript", saved: run.hasTranscript },
        { name: "summary", saved: run.hasSummary },
      ];

      for (const artifact of artifacts) {
        if (artifact.saved) continue;

        try {
          if (!this.hasRunArtifact(run.id, artifact.name)) continue;
          this.readRunArtifact(run.id, artifact.name);

          if (!database.reconcileMeetingRunArtifact(run.id, artifact.name).success) {
            errors.push({ id: run.id, code: "artifact-state-not-reconciled" });
          }
        } catch (error) {
          errors.push({ id: run.id, code: safeErrorCode(error) });
        }
      }
    }
  }

  private processDeletionIntents(
    database: MeetingRecordingPersistence,
    deleted: string[],
    errors: Array<{ id: string; code: string }>
  ): void {
    for (const intent of database.listMeetingDeletionIntents()) {
      try {
        if (intent.kind === "audio") {
          if (!intent.recordingId) throw new Error("invalid-deletion-intent");
          this.removeRecordingAudio(intent.recordingId);

          if (!database.completeMeetingAudioDeletion(intent.id).success)
            throw new Error("deletion-state-not-found");
        } else {
          const { recordingIds, runIds } = database.getMeetingNoteStorageIds(intent.noteId);
          this.removeNoteFiles(recordingIds, runIds);

          if (!database.completeMeetingNoteDeletion(intent.id).success)
            throw new Error("deletion-state-not-found");
        }

        deleted.push(intent.id);
      } catch (error) {
        const code = safeErrorCode(error);
        database.failMeetingDeletion(intent.id, code);
        errors.push({ id: intent.id, code });
      }
    }
  }

  private epochFilePath(recordingId: string, source: MeetingSource, epochIndex: number): string {
    const filePath = path.join(
      this.recordingsRoot,
      recordingId,
      source,
      `epoch-${String(epochIndex).padStart(6, "0")}.opus`
    );

    this.assertWithinUserData(filePath);

    return filePath;
  }

  private validateEpochIndex(epochIndex: number): void {
    if (!Number.isSafeInteger(epochIndex) || epochIndex < 0 || epochIndex > 999_999) {
      throw new RangeError("Invalid recording epoch index");
    }
  }

  private ensureManagedDirectory(directory: string): void {
    this.assertWithinUserData(directory);
    fs.mkdirSync(this.userDataPath, { recursive: true });
    const rootInfo = fs.lstatSync(this.userDataPath);

    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
      throw new Error("Unsafe user data directory");
    let current = this.userDataPath;
    const relative = path.relative(this.userDataPath, directory);

    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);

      try {
        fs.mkdirSync(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      const info = fs.lstatSync(current);

      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Unsafe managed storage directory");
    }
  }

  private assertSafeFile(filePath: string): void {
    this.assertWithinUserData(filePath);
    const relativeParent = path.dirname(filePath);
    this.assertSafeDirectoryChain(relativeParent);

    try {
      const info = fs.lstatSync(filePath);

      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe managed storage file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private assertWithinUserData(target: string): void {
    const resolved = path.resolve(target);
    const relative = path.relative(this.userDataPath, resolved);

    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Managed storage path escapes user data");
    }
  }

  private assertSafeDirectoryChain(directory: string): void {
    this.assertWithinUserData(directory);
    let current = this.userDataPath;
    const relative = path.relative(this.userDataPath, directory);

    if (!fs.existsSync(current)) return;
    const rootInfo = fs.lstatSync(current);

    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
      throw new Error("Unsafe user data directory");

    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);

      try {
        const info = fs.lstatSync(current);

        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error("Unsafe managed storage directory");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
  }

  private removeManagedTree(directory: string): void {
    this.assertWithinUserData(directory);
    const parent = path.dirname(directory);
    this.assertSafeDirectoryChain(parent);

    try {
      const info = fs.lstatSync(directory);

      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Unsafe managed storage directory");
      fs.rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private noFollowFlag(): number {
    return fs.constants.O_NOFOLLOW ?? 0;
  }
}

function writeAllSync(fd: number, buffer: Buffer, writeSync: WriteSync): void {
  let offset = 0;

  while (offset < buffer.length) {
    const bytesWritten = writeSync(fd, buffer, offset, buffer.length - offset, null);

    if (
      !Number.isInteger(bytesWritten) ||
      bytesWritten <= 0 ||
      bytesWritten > buffer.length - offset
    ) {
      throw new Error("Meeting recording write failed");
    }

    offset += bytesWritten;
  }
}

function artifactFileName(artifact: StoredMeetingArtifact): string {
  if (artifact.startsWith("provider-response")) return `raw-${artifact}.json`;

  return artifact === "transcript" ? "transcript.json" : "summary.json";
}

function safeErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;

  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)
    ? code
    : "file-operation-failed";
}

module.exports = MeetingRecordingStorage;

module.exports.MeetingRecordingStorage = MeetingRecordingStorage;
