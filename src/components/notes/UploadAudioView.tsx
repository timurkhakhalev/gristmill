import React, { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Upload,
  FileAudio,
  X,
  AlertCircle,
  ChevronRight,
  FolderOpen,
  Plus,
  Settings,
  Link2,
} from "../icons";
import { useShallow } from "zustand/react/shallow";
import { Button } from "../ui/button";
import { cn } from "../lib/utils";
import { SelectField } from "../ui/SelectField";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../ui/dialog";
import { Input } from "../ui/input";
import type { FolderItem } from "../../contracts/containers";
import { findDefaultFolder, DOWNLOAD_ERROR_KEYS, transcriptionErrorKey } from "./shared";
import { useSettings } from "../../hooks/useSettings";
import {
  getAllReasoningModels,
  getBatchTranscriptionModel,
  getParakeetModelInfo,
  getTranscriptionProviders,
  isSherpaLocalProvider,
} from "../../models/ModelRegistry";
import { useSettingsStore, getSettings } from "../../stores/settingsStore";
import { selectResolvedUploadTranscription } from "../../config/settingsSelectors";
import { useBatchQueue } from "../../stores/batchQueueStore";
import type { TranscribeOptions } from "../../stores/batchQueueStore";
import {
  transcribeFileWithSpeakers,
  resolveDiarizationSettings,
  shouldUseByokDiarize,
  getTranscriptionApiKey,
} from "../../services/fileTranscription";
import type {
  FileTranscriptionConfig,
  FileTranscriptionResult,
  DiarizationSettings,
} from "../../services/fileTranscription";
import EmptyStateCard from "../ui/EmptyStateCard";
import { Toggle } from "../ui/toggle";
import { MAX_SPEAKER_COUNT } from "../../constants/speakerDetection.json";
import BatchQueueView from "./BatchQueueView";
import { generateNoteTitle } from "../../utils/generateTitle";
import { getBaseLanguageCode } from "../../utils/languageSupport";
import { resolveTranscriptionRoute } from "../../helpers/transcriptionRoute";
import { saveUploadNote, uploadTitleFallback } from "../../services/uploadNotes";
import { UploadCompleteWarnings, UploadModelSettingsButton } from "./UploadAudioFeedback";

type UploadState = "idle" | "selected" | "downloading" | "transcribing" | "complete" | "error";

const SUPPORTED_EXTENSIONS = ["mp3", "wav", "m4a", "webm", "ogg", "oga", "flac", "aac", "opus"];

const UNSUPPORTED_IMPORT_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

const MAX_BATCH_URLS = 50;

const uploadFieldClass = cn(
  "rounded-lg text-xs",
  "bg-surface-1/40 dark:bg-white/[0.03] backdrop-blur-sm",
  "border border-foreground/6 dark:border-white/10",
  "text-foreground/70 placeholder:text-muted",
  "focus:outline-none focus:border-foreground/12 dark:focus:border-white/10",
  "transition-colors"
);

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;

  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parseBatchUrls(text: string): { valid: string[]; skipped: number } {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const seen = new Set<string>();
  const valid: string[] = [];

  for (const line of lines) {
    try {
      const parsed = new URL(line);
      const httpsOk = parsed.protocol === "https:";
      const supportedHost = !UNSUPPORTED_IMPORT_HOSTS.has(parsed.hostname.toLowerCase());

      if (httpsOk && supportedHost && !seen.has(line)) {
        seen.add(line);
        valid.push(line);
      }
    } catch {
      // invalid line, counted as skipped
    }
  }

  const capped = valid.slice(0, MAX_BATCH_URLS);

  return { valid: capped, skipped: lines.length - capped.length };
}

interface UploadAudioViewProps {
  onNoteCreated?: (noteId: number, folderId: number | null) => void;
  onOpenSettings?: (section: string) => void;
}

export default function UploadAudioView({ onNoteCreated, onOpenSettings }: UploadAudioViewProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<UploadState>("idle");

  const [file, setFile] = useState<{
    name: string;
    path: string;
    size: string;
    sizeBytes: number;
    fromUrl?: boolean;
    durationSeconds?: number | null;
  } | null>(null);

  const [result, setResult] = useState<string | null>(null);

  const [partialWarning, setPartialWarning] = useState<{ failed: number; total: number } | null>(
    null
  );

  const [diarizationWarning, setDiarizationWarning] = useState(false);
  const [noteId, setNoteId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [progress, setProgress] = useState(0);
  const progressRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const progressCleanupRef = useRef<(() => void) | null>(null);
  const runIdRef = useRef(0);
  const mountedRef = useRef(true);
  const urlDownloadActiveRef = useRef(false);
  // The requestId of the in-flight single upload, so Stop hard-cancels the
  // exact execution (transport + diarization) before the UI resets.
  const singleRequestIdRef = useRef<string | null>(null);
  // The downloaded temp owned by the in-flight execution while its readers
  // run: reset() and unmount must not delete the file under them, and the
  // execution deletes it exactly once at settlement.
  const executionTempRef = useRef<string | null>(null);
  // A transcription whose Note save failed: kept so Retry re-saves the ASR
  // result without re-transcribing (#145).
  const pendingSaveRef = useRef<Parameters<typeof saveUploadNote>[0] | null>(null);

  const [urlInput, setUrlInput] = useState("");

  const [downloadProgress, setDownloadProgress] = useState<{
    stage: string;
    percent: number;
    title?: string;
  } | null>(null);

  const [downloadedTempPath, setDownloadedTempPath] = useState<string | null>(null);
  const downloadedTempPathRef = useRef(downloadedTempPath);
  useEffect(() => {
    downloadedTempPathRef.current = downloadedTempPath;
  }, [downloadedTempPath]);
  const [urlExpanded, setUrlExpanded] = useState(false);
  const [batchUrlNotice, setBatchUrlNotice] = useState<string | null>(null);
  const singleDownloadIdRef = useRef<string | null>(null);

  const batch = useBatchQueue();

  const [diarizationEnabled, setDiarizationEnabled] = useState(
    () => localStorage.getItem("uploadDiarizationEnabled") === "true"
  );

  const [diarizationNumSpeakers, setDiarizationNumSpeakers] = useState<string>(
    () => localStorage.getItem("uploadDiarizationNumSpeakers") || ""
  );

  const [diarizationModelsReady, setDiarizationModelsReady] = useState<boolean | null>(null);
  const [diarizationDownloading, setDiarizationDownloading] = useState(false);

  useEffect(() => {
    localStorage.setItem("uploadDiarizationEnabled", String(diarizationEnabled));
  }, [diarizationEnabled]);

  useEffect(() => {
    localStorage.setItem("uploadDiarizationNumSpeakers", diarizationNumSpeakers);
  }, [diarizationNumSpeakers]);

  const diarizationDownloadRef = useRef<Promise<boolean> | null>(null);

  // Callers share one in-flight download: a transcribe started while the
  // mount-time heal is still fetching has to wait for it, not give up and
  // report that speaker detection couldn't be applied.
  const ensureDiarizationModels = (): Promise<boolean> => {
    if (diarizationDownloadRef.current) return diarizationDownloadRef.current;
    setDiarizationDownloading(true);

    const pending = (async () => {
      try {
        await window.electronAPI.downloadDiarizationModels?.();
        const status = await window.electronAPI.getDiarizationModelStatus?.();
        const ready = status?.modelsDownloaded ?? false;
        setDiarizationModelsReady(ready);

        return ready;
      } finally {
        diarizationDownloadRef.current = null;
        setDiarizationDownloading(false);
      }
    })();

    diarizationDownloadRef.current = pending;

    return pending;
  };

  const buildDiarizationSettings = (): Promise<DiarizationSettings> =>
    resolveDiarizationSettings({
      enabled: diarizationEnabled,
      modelsReady: !!diarizationModelsReady,
      numSpeakers: diarizationNumSpeakers ? Number(diarizationNumSpeakers) : null,
      config: buildTranscriptionConfig(),
      ensureModels: ensureDiarizationModels,
    });

  useEffect(() => {
    window.electronAPI.getDiarizationModelStatus?.().then((status) => {
      const ready = status?.modelsDownloaded ?? false;
      setDiarizationModelsReady(ready);

      // Heal a persisted-on toggle whose models were removed since; roll it back
      // if the download fails so it can't sit ON while doing nothing.
      if (!ready && localStorage.getItem("uploadDiarizationEnabled") === "true") {
        if (shouldUseByokDiarize(buildTranscriptionConfig(), true)) return;
        ensureDiarizationModels().then((ok) => {
          if (!ok) setDiarizationEnabled(false);
        });
      }
    });
    // Mount-only by design: heals persisted state against the models on disk.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string>("");
  const [folderMoveError, setFolderMoveError] = useState<string | null>(null);
  // Batch destination folder, deliberately separate from the single-flow one:
  // handleFolderChange moves the already-saved note when noteId is set.
  const [batchFolderId, setBatchFolderId] = useState<string>("");
  const [showNewFolderDialog, setShowNewFolderDialog] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  const [providerReady, setProviderReady] = useState<boolean | null>(null);

  const apiKeys = useSettings();

  const {
    openaiApiKey,
    groqApiKey,
    xaiApiKey,
    mistralApiKey,
    geminiApiKey,
    tinfoilApiKey,
    deepgramApiKey,
    elevenLabsApiKey,
    assemblyaiApiKey,
    customTranscriptionApiKey,
  } = apiKeys;

  const {
    useLocalWhisper,
    whisperModel,
    localTranscriptionProvider,
    parakeetModel,
    cohereModel,
    cloudTranscriptionProvider,
    cloudTranscriptionModel,
    cloudTranscriptionBaseUrl,
    transcriptionMode,
  } = useSettingsStore(useShallow((settings) => selectResolvedUploadTranscription(settings)));

  const remoteTranscriptionUrl = useSettingsStore((s) => s.remoteTranscriptionUrl);
  const remoteTranscriptionModel = useSettingsStore((s) => s.remoteTranscriptionModel);

  const cortiClientId = useSettingsStore((s) => s.cortiClientId);
  const cortiClientSecret = useSettingsStore((s) => s.cortiClientSecret);
  const cortiEnvironment = useSettingsStore((s) => s.cortiEnvironment);
  const cortiTenant = useSettingsStore((s) => s.cortiTenant);
  const preferredLanguage = useSettingsStore((s) => s.preferredLanguage);
  const effectiveCleanupModel = useSettingsStore((settings) => settings.cleanupModel);
  const useCleanupModel = useSettingsStore((s) => s.useCleanupModel);

  // Mode detection
  const isSelfHosted = transcriptionMode === "self-hosted" && !useLocalWhisper;

  const uploadRoute = resolveTranscriptionRoute({
    settings: {
      useLocalWhisper,
      transcriptionMode,
      remoteTranscriptionUrl,
      remoteTranscriptionModel,
      cloudTranscriptionProvider,
      cloudTranscriptionModel,
      cloudTranscriptionBaseUrl,
      cortiEnvironment,
      cortiTenant,
      preferredLanguage,
    },
    providers: getTranscriptionProviders(),
  });

  const sizeCapBytes = "sizeCapBytes" in uploadRoute ? uploadRoute.sizeCapBytes : null;
  const byokMaxFileSizeMb = sizeCapBytes === null ? 0 : Math.floor(sizeCapBytes / (1024 * 1024));
  const byokTooLarge = !!file && sizeCapBytes !== null && file.sizeBytes > sizeCapBytes;

  useEffect(() => {
    return () => {
      if (progressRef.current) clearInterval(progressRef.current);
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;

      if (urlDownloadActiveRef.current) {
        window.electronAPI.cancelUrlDownload();
      }

      if (downloadedTempPathRef.current) {
        window.electronAPI.deleteTempFile(downloadedTempPathRef.current);
      }
    };
  }, []);

  useEffect(() => {
    // Keep upload destinations scoped to the private space.
    let cancelled = false;

    const loadFolders = async () => {
      try {
        const spaces = (await window.electronAPI.getSpaces?.()) ?? [];
        const privateSpace = spaces.find((space) => space.kind === "private");
        const items = (await window.electronAPI.getFolders?.(privateSpace?.id ?? null)) ?? [];

        if (cancelled) return;
        setFolders(items);
        const personal = findDefaultFolder(items);

        if (personal) {
          setSelectedFolderId(String(personal.id));
          setBatchFolderId(String(personal.id));
        }
      } catch (error) {
        if (!cancelled) console.error("Failed to load upload folders:", error);
      }
    };

    void loadFolders();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const checkProviderReady = async () => {
      if (!useLocalWhisper) {
        if (isSelfHosted) {
          if (!cancelled) setProviderReady(!!remoteTranscriptionUrl?.trim());
        } else if (cloudTranscriptionProvider === "custom") {
          const route = resolveTranscriptionRoute({
            settings: { cloudTranscriptionProvider, cloudTranscriptionBaseUrl },
            providers: getTranscriptionProviders(),
          });

          if (!cancelled) setProviderReady(route.transport !== "error");
        } else if (cloudTranscriptionProvider === "corti") {
          if (!cancelled) setProviderReady(!!(cortiClientId && cortiClientSecret));
        } else {
          if (!cancelled)
            setProviderReady(
              !!getTranscriptionApiKey(cloudTranscriptionProvider, {
                openaiApiKey,
                groqApiKey,
                xaiApiKey,
                mistralApiKey,
                geminiApiKey,
                tinfoilApiKey,
                deepgramApiKey,
                elevenLabsApiKey,
                assemblyaiApiKey,
                customTranscriptionApiKey,
              })
            );
        }

        return;
      }

      if (isSherpaLocalProvider(localTranscriptionProvider)) {
        const r = await window.electronAPI.listParakeetModels?.();

        if (!cancelled)
          setProviderReady(
            !!(r?.success && r.models.some((m: { downloaded?: boolean }) => m.downloaded))
          );
      } else {
        const r = await window.electronAPI.listWhisperModels?.();

        if (!cancelled)
          setProviderReady(
            !!(r?.success && r.models.some((m: { downloaded?: boolean }) => m.downloaded))
          );
      }
    };

    checkProviderReady();

    return () => {
      cancelled = true;
    };
  }, [
    isSelfHosted,
    remoteTranscriptionUrl,
    useLocalWhisper,
    localTranscriptionProvider,
    cloudTranscriptionProvider,
    cloudTranscriptionBaseUrl,
    openaiApiKey,
    groqApiKey,
    xaiApiKey,
    mistralApiKey,
    geminiApiKey,
    tinfoilApiKey,
    deepgramApiKey,
    elevenLabsApiKey,
    assemblyaiApiKey,
    customTranscriptionApiKey,
    cortiClientId,
    cortiClientSecret,
  ]);

  const getActiveModelLabel = (): string => {
    if (useLocalWhisper) {
      if (localTranscriptionProvider === "nvidia")
        return getParakeetModelInfo(parakeetModel)?.name ?? parakeetModel;

      if (localTranscriptionProvider === "cohere") return `Cohere · ${cohereModel || "default"}`;

      return `Whisper · ${whisperModel || "base"}`;
    }

    if (isSelfHosted) {
      const name = t("settingsPage.transcription.modes.selfHosted");

      return remoteTranscriptionModel ? `${name} · ${remoteTranscriptionModel}` : name;
    }

    const name =
      cloudTranscriptionProvider === "custom"
        ? t("notes.upload.custom")
        : cloudTranscriptionProvider.charAt(0).toUpperCase() + cloudTranscriptionProvider.slice(1);

    const model = getBatchTranscriptionModel(cloudTranscriptionProvider) ?? cloudTranscriptionModel;

    return `${name} · ${model}`;
  };

  const buildTranscriptionConfig = (): FileTranscriptionConfig => ({
    useLocalWhisper,
    localTranscriptionProvider: localTranscriptionProvider as string,
    whisperModel,
    parakeetModel,
    cohereModel,
    getApiKey: () => getTranscriptionApiKey(cloudTranscriptionProvider, apiKeys),
    cloudTranscriptionProvider: cloudTranscriptionProvider as string,
    cloudTranscriptionBaseUrl: cloudTranscriptionBaseUrl || "",
    cloudTranscriptionModel,
    // Empty = auto-detect; the resolver supplies a default where one is required.
    language: getBaseLanguageCode(preferredLanguage) || "",
    cortiEnvironment,
    cortiTenant,
    transcriptionMode,
    remoteTranscriptionUrl,
    remoteTranscriptionModel,
  });

  // Batch counterpart of the single-file size gating above; returns keys under notes.upload.*.
  const getBatchSizeErrorKey = (sizeBytes: number): string | null => {
    return sizeCapBytes !== null && sizeBytes > sizeCapBytes ? "byokTooLarge" : null;
  };

  const generateTitle = async (text: string): Promise<string> => {
    if (!useCleanupModel) return "";

    if (!getSettings().autoGenerateNoteTitle) return "";
    const model = effectiveCleanupModel || getAllReasoningModels()[0]?.value;

    if (!model) return "";

    return generateNoteTitle(text, model);
  };

  const handleBrowse = async () => {
    const res = await window.electronAPI.selectAudioFile({ multiple: true });

    if (res.canceled) return;

    const filePaths: string[] = res.filePaths || (res.filePath ? [res.filePath] : []);

    if (filePaths.length === 0) return;

    // While a batch runs (or a queue exists), new files join the queue.
    if (filePaths.length === 1 && !batch.isProcessing && !batch.hasQueue) {
      const fp = filePaths[0];
      const name = fp.split(/[/\\]/).pop() || "audio";
      const sizeBytes = (await window.electronAPI.getFileSize?.(fp)) ?? 0;
      setFile({ name, path: fp, size: sizeBytes ? formatFileSize(sizeBytes) : "", sizeBytes });
      setState("selected");
      setError(null);

      return;
    }

    const items: Array<{ name: string; path: string; sizeBytes: number }> = [];

    for (const fp of filePaths) {
      const name = fp.split(/[/\\]/).pop() || "audio";
      const sizeBytes = (await window.electronAPI.getFileSize?.(fp)) ?? 0;
      items.push({ name, path: fp, sizeBytes });
    }

    batch.addFiles(items);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = e.dataTransfer.files;

    if (!files || files.length === 0) return;

    const validFiles: Array<{ name: string; path: string; sizeBytes: number }> = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const ext = f.name.split(".").pop()?.toLowerCase() || "";

      if (SUPPORTED_EXTENSIONS.includes(ext)) {
        const filePath = window.electronAPI.getPathForFile(f);

        if (filePath) {
          validFiles.push({ name: f.name, path: filePath, sizeBytes: f.size });
        }
      }
    }

    if (validFiles.length === 0) return;

    if (validFiles.length === 1 && !batch.isProcessing && !batch.hasQueue) {
      const f = validFiles[0];
      setFile({
        name: f.name,
        path: f.path,
        size: formatFileSize(f.sizeBytes),
        sizeBytes: f.sizeBytes,
      });
      setState("selected");
      setError(null);
    } else {
      batch.addFiles(validFiles);
    }
  };

  // Settlement of the execution that owned the downloaded temp: the cancel
  // RPC only confirms the abort signal was sent, not that the readers
  // finished, so the file is deleted here — after they settled. User-picked
  // source files are never deleted, only the downloaded temp copy.
  const releaseExecutionTemp = (executionTemp: string | null) => {
    if (!executionTemp) return;
    window.electronAPI.deleteTempFile(executionTemp);

    // CAS: an older execution may settle after a newer upload claimed the ref.
    // Clear only its own claim so the newer execution remains the owner.
    if (executionTempRef.current !== executionTemp) return;
    executionTempRef.current = null;

    if (downloadedTempPathRef.current === executionTemp) {
      downloadedTempPathRef.current = null;
      setDownloadedTempPath(null);
    }
  };

  // A settled error keeps the temp for Retry: hand it back to the view
  // state, which deletes it on reset or unmount as before. A view that
  // unmounted mid-run has no Retry to offer and its cleanup already ran
  // before the temp was view-owned — the settling execution (readers are
  // done by now) deletes the file instead, exactly once, or it leaks.
  const keepExecutionTempForRetry = (executionTemp: string | null) => {
    if (!executionTemp || executionTempRef.current !== executionTemp) return;
    executionTempRef.current = null;

    if (!mountedRef.current) {
      window.electronAPI.deleteTempFile(executionTemp);

      return;
    }

    downloadedTempPathRef.current = executionTemp;
    setDownloadedTempPath(executionTemp);
  };

  const reset = () => {
    if (progressRef.current) clearInterval(progressRef.current);

    if (progressCleanupRef.current) progressCleanupRef.current();
    progressCleanupRef.current = null;

    if (downloadedTempPath) {
      window.electronAPI.deleteTempFile(downloadedTempPath);
      setDownloadedTempPath(null);
    }

    setState("idle");
    setFile(null);
    setResult(null);
    setPartialWarning(null);
    setDiarizationWarning(false);
    setNoteId(null);
    setError(null);
    pendingSaveRef.current = null;
    setProgress(0);
    setUrlInput("");
    setDownloadProgress(null);
    setBatchUrlNotice(null);
    setFolderMoveError(null);
    const personal = findDefaultFolder(folders);

    if (personal) setSelectedFolderId(String(personal.id));
  };

  const cancelTranscription = async () => {
    // Hard cancel first: the typed cancel op aborts the transport, decode and
    // diarization of this request. The acknowledgement only confirms the
    // signal was sent, so the UI may reset here while the downloaded temp is
    // still owned by the execution — it is deleted when that execution
    // settles, not by reset(). The run-id bump keeps any late result from
    // touching the reset UI.
    const requestId = singleRequestIdRef.current;
    runIdRef.current++;
    singleRequestIdRef.current = null;

    if (requestId) {
      try {
        await window.electronAPI.cancelUploadTranscription({ requestId });
      } catch {
        // A late or repeated cancel is a safe no-op; resetting the UI must
        // not depend on it.
      }
    }

    reset();
  };

  const handleTranscribe = async () => {
    if (!file || batch.isProcessing) return;
    const currentFile = file;
    const currentTempPath = downloadedTempPath;
    const executionTemp = currentTempPath;
    const runId = ++runIdRef.current;
    const requestId = crypto.randomUUID();
    singleRequestIdRef.current = requestId;
    // This execution now owns the downloaded temp: reset()/unmount see no
    // temp until it settles, so a Stop cannot delete it under open readers.
    executionTempRef.current = executionTemp;

    if (currentTempPath) {
      downloadedTempPathRef.current = null;
      setDownloadedTempPath(null);
    }

    setState("transcribing");
    setError(null);
    setProgress(0);
    setDiarizationWarning(false);
    progressRef.current = setInterval(() => {
      setProgress((prev) => {
        if (prev >= 90) {
          if (progressRef.current) clearInterval(progressRef.current);

          return prev;
        }

        return prev + Math.random() * 6;
      });
    }, 500);

    try {
      const diarization = await buildDiarizationSettings();

      // The settings preparation is async (lazy model download); a Stop that
      // landed meanwhile must not start the IPC work at all.
      if (runId !== runIdRef.current) {
        // Cancelled before any reader started — the temp is free to delete.
        releaseExecutionTemp(executionTemp);

        return;
      }

      const res: FileTranscriptionResult = await transcribeFileWithSpeakers(
        currentFile.path,
        buildTranscriptionConfig(),
        diarization,
        currentFile.durationSeconds,
        { requestId, timestamps: true }
      );

      if (runId !== runIdRef.current) {
        // Readers settled after a Stop: only now is the temp deleted.
        releaseExecutionTemp(executionTemp);

        return;
      }

      singleRequestIdRef.current = null;

      if (progressRef.current) clearInterval(progressRef.current);

      if (progressCleanupRef.current) progressCleanupRef.current();
      progressCleanupRef.current = null;

      if (res.success && res.text) {
        setProgress(100);
        setResult(res.text);
        setPartialWarning(
          res.failedChunks && res.totalChunks
            ? { failed: res.failedChunks, total: res.totalChunks }
            : null
        );
        setDiarizationWarning(!!res.diarizationWarning);

        let title: string;

        if (currentFile.fromUrl) {
          title = currentFile.name;
        } else {
          const aiTitle = await generateTitle(res.text);

          if (runId !== runIdRef.current) {
            releaseExecutionTemp(executionTemp);

            return;
          }

          title = aiTitle || uploadTitleFallback(res.text, currentFile.name);
        }

        const pendingSave = {
          title,
          text: res.text,
          sourceName: currentFile.name,
          folderId: selectedFolderId ? Number(selectedFolderId) : null,
          diarization,
          durationSeconds: res.durationSeconds,
          segments: res.segments,
        };

        pendingSaveRef.current = pendingSave;
        const noteRes = await saveUploadNote(pendingSave);

        if (runId !== runIdRef.current) {
          releaseExecutionTemp(executionTemp);

          return;
        }

        if (noteRes.success && noteRes.note) {
          pendingSaveRef.current = null;
          setNoteId(noteRes.note.id);
          releaseExecutionTemp(executionTemp);
          setState("complete");
        } else {
          // The transcription succeeded, only the save failed: keep the ASR
          // result so Retry re-saves it without re-transcribing. The temp is
          // kept for Retry exactly like a transcription failure; Start Over
          // clears the pending re-save.
          keepExecutionTempForRetry(executionTemp);
          setProgress(0);
          setError(t("notes.upload.noteSaveFailed"));
          setState("error");
        }
      } else {
        keepExecutionTempForRetry(executionTemp);
        setProgress(0);
        const errorKey = transcriptionErrorKey(res);
        setError(
          errorKey
            ? t(`notes.upload.${errorKey}`)
            : res.messageKey
              ? t(res.messageKey)
              : res.error || t("notes.upload.transcriptionFailed")
        );
        setState("error");
      }
    } catch (err) {
      if (runId !== runIdRef.current) {
        // A thrown settlement after a Stop: readers are done, delete the temp.
        releaseExecutionTemp(executionTemp);

        return;
      }

      keepExecutionTempForRetry(executionTemp);
      singleRequestIdRef.current = null;

      if (progressRef.current) clearInterval(progressRef.current);

      if (progressCleanupRef.current) progressCleanupRef.current();
      progressCleanupRef.current = null;
      setProgress(0);
      const errorKey = transcriptionErrorKey(err);

      if (pendingSaveRef.current) {
        setError(t("notes.upload.noteSaveFailed"));
      } else if (errorKey) {
        setError(t(`notes.upload.${errorKey}`));
      } else {
        setError(err instanceof Error ? err.message : t("notes.upload.errorOccurred"));
      }

      setState("error");
    }
  };

  const handleUrlSubmit = async () => {
    const trimmed = urlInput.trim();

    if (!trimmed) return;

    // While a batch runs (or a queue exists), submitted URLs join the queue.
    if (batch.isProcessing || batch.hasQueue) {
      handleBatchUrlSubmit();

      return;
    }

    let parsed: URL;

    try {
      parsed = new URL(trimmed);
    } catch {
      setError(t("notes.upload.urlInvalid"));
      setState("error");

      return;
    }

    // Direct media imports require HTTPS, including redirects handled by main.
    if (parsed.protocol !== "https:") {
      setError(t("notes.upload.urlInvalid"));
      setState("error");

      return;
    }

    setState("downloading");
    setError(null);
    setDownloadProgress({ stage: "resolving", percent: 0 });

    const downloadId = crypto.randomUUID();
    singleDownloadIdRef.current = downloadId;

    const cleanupProgress = window.electronAPI.onUrlDownloadProgress?.((data) => {
      if (data.downloadId && data.downloadId !== downloadId) return;
      setDownloadProgress(data);
    });

    urlDownloadActiveRef.current = true;

    try {
      const res = await window.electronAPI.downloadUrlAudio(trimmed, downloadId);

      if (!mountedRef.current) {
        // Unmounted mid-download: nothing owns the temp file anymore, delete it.
        if (res.success) window.electronAPI.deleteTempFile(res.tempPath);

        return;
      }

      if (!res.success) {
        const fail = res as { success: false; error: string; code?: string };

        if (fail.code === "DOWNLOAD_CANCELLED") {
          setState("idle");

          return;
        }

        const key = DOWNLOAD_ERROR_KEYS[fail.code || ""];
        setError(
          key ? t(`notes.upload.${key}`) : fail.error || t("notes.upload.urlDownloadFailed")
        );
        setState("error");

        return;
      }

      setDownloadedTempPath(res.tempPath);
      setFile({
        name: res.title,
        path: res.tempPath,
        size: formatFileSize(res.sizeBytes),
        sizeBytes: res.sizeBytes,
        fromUrl: true,
        durationSeconds: res.durationSeconds,
      });
      setState("selected");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("notes.upload.urlDownloadFailed"));
      setState("error");
    } finally {
      urlDownloadActiveRef.current = false;
      singleDownloadIdRef.current = null;
      cleanupProgress?.();
      setDownloadProgress(null);
    }
  };

  // Retry re-runs whatever failed: a pending Note re-save after a failed
  // save, a selected file's transcription, or the URL download.
  const handleRetry = async () => {
    const pending = pendingSaveRef.current;

    if (pending) {
      const runId = ++runIdRef.current;
      setState("transcribing");
      setError(null);
      let noteRes: Awaited<ReturnType<typeof saveUploadNote>>;

      try {
        noteRes = await saveUploadNote(pending);
      } catch {
        noteRes = { success: false } as Awaited<ReturnType<typeof saveUploadNote>>;
      }

      if (runId !== runIdRef.current) return;

      if (noteRes.success && noteRes.note) {
        pendingSaveRef.current = null;
        setNoteId(noteRes.note.id);
        // The temp is view-owned again (kept for Retry); hand it back to the
        // execution-owner path so it is still deleted exactly once.
        const temp = downloadedTempPathRef.current;

        if (temp) {
          downloadedTempPathRef.current = null;
          setDownloadedTempPath(null);
          executionTempRef.current = temp;
          releaseExecutionTemp(temp);
        }

        setState("complete");
      } else {
        setError(t("notes.upload.noteSaveFailed"));
        setState("error");
      }

      return;
    }

    if (file) {
      handleTranscribe();
    } else if (urlInput.trim()) {
      handleUrlSubmit();
    } else {
      reset();
    }
  };

  const handleCancelDownload = () => {
    window.electronAPI.cancelUrlDownload(singleDownloadIdRef.current ?? undefined);
  };

  const handleBatchUrlSubmit = () => {
    const { valid, skipped } = parseBatchUrls(urlInput);

    if (valid.length > 0) {
      batch.addUrls(valid);
      setUrlInput("");
      setUrlExpanded(false);
    }

    setBatchUrlNotice(skipped > 0 ? t("notes.upload.urlsSkipped", { n: skipped }) : null);
  };

  const startBatchProcessing = async () => {
    if (state === "downloading" || state === "transcribing") return;
    setBatchUrlNotice(null);

    const transcribeOpts: TranscribeOptions = {
      transcription: buildTranscriptionConfig(),
      folderId: batchFolderId ? Number(batchFolderId) : null,
      validateSize: getBatchSizeErrorKey,
      generateTitle: async (text) => (await generateTitle(text)) || null,
    };

    batch.processQueue(transcribeOpts, await buildDiarizationSettings());
  };

  const handleCreateFolder = async () => {
    const trimmed = newFolderName.trim();

    if (!trimmed) return;
    const res = await window.electronAPI.createFolder(trimmed);

    if (res.success && res.folder) {
      setFolders((prev) => [...prev, res.folder!]);
      const newId = String(res.folder.id);
      setSelectedFolderId(newId);

      if (noteId != null) {
        try {
          const moved = await window.electronAPI.updateNote(noteId, { folder_id: res.folder.id });

          if (!moved.success) {
            showFolderMoveFailure(moved.error, newId);
          }
        } catch {
          showFolderMoveFailure(undefined, newId);
        }
      }
    }

    setNewFolderName("");
    setShowNewFolderDialog(false);
  };

  const showFolderMoveFailure = (error: string | undefined, fallbackSelection: string) => {
    setFolderMoveError(
      error === "Folder not found"
        ? t("notes.mutationErrors.folderNotFound")
        : t("notes.mutationErrors.generic")
    );
    setSelectedFolderId(fallbackSelection);
  };

  const handleFolderChange = (val: string) => {
    if (val === "__create_new__") {
      setShowNewFolderDialog(true);

      return;
    }

    const previous = selectedFolderId;
    setSelectedFolderId(val);
    setFolderMoveError(null);

    if (noteId != null) {
      // Root is a null folder in the DB, not 0 — Number("") would fail there.
      void window.electronAPI
        .updateNote(noteId, { folder_id: val ? Number(val) : null })
        .then((moved) => {
          if (!moved.success) showFolderMoveFailure(moved.error, previous);
        })
        .catch(() => showFolderMoveFailure(undefined, previous));
    }
  };

  const getTranscribingLabel = (): string => {
    if (useLocalWhisper) return t("notes.upload.transcribingLocal");

    if (isSelfHosted) {
      return t("notes.upload.transcribingProvider", {
        provider: t("settingsPage.transcription.modes.selfHosted"),
      });
    }

    return t("notes.upload.transcribingProvider", { provider: cloudTranscriptionProvider });
  };

  return (
    <div className="flex flex-col items-center h-full overflow-y-auto px-6">
      <div
        className="w-full max-w-md shrink-0 my-auto"
        style={{ animation: "float-up 0.4s ease-out" }}
      >
        <div className="max-w-[320px] mx-auto">
          {state === "idle" && providerReady === false && (
            <NoProviderView t={t} onOpenSettings={() => onOpenSettings?.("uploadTranscription")} />
          )}

          {state === "idle" && providerReady !== false && (
            <>
              <IdleView
                t={t}
                getActiveModelLabel={getActiveModelLabel}
                handleDrop={handleDrop}
                handleBrowse={handleBrowse}
                isDragOver={isDragOver}
                setIsDragOver={setIsDragOver}
                onOpenSettings={onOpenSettings}
              />

              <div className="flex items-center gap-3 my-3">
                <div className="h-px flex-1 bg-default dark:bg-white/5" />
                <span className="text-2xs text-muted uppercase tracking-wider">
                  {t("notes.upload.orDivider")}
                </span>
                <div className="h-px flex-1 bg-default dark:bg-white/5" />
              </div>

              {urlExpanded ? (
                <div>
                  <textarea
                    dir="ltr"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    placeholder={t("notes.upload.pasteUrls")}
                    rows={4}
                    className={cn(uploadFieldClass, "w-full px-3 py-2 resize-none")}
                    autoFocus
                  />
                  <div className="flex items-center gap-2 mt-2 justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setUrlExpanded(false);
                        setUrlInput("");
                      }}
                      className="h-7 text-xs text-muted"
                    >
                      {t("notes.upload.cancel")}
                    </Button>
                    <Button
                      variant="default"
                      size="sm"
                      onClick={handleBatchUrlSubmit}
                      disabled={!urlInput.trim()}
                      className="h-7 text-xs"
                    >
                      {t("notes.upload.addToQueue")}
                    </Button>
                  </div>
                </div>
              ) : (
                <div dir="ltr" className="relative">
                  {/\.(mp3|wav|m4a|ogg|flac|aac|webm|opus)(\?|$)/i.test(urlInput) ? (
                    <FileAudio
                      size={13}
                      className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted z-10 pointer-events-none"
                    />
                  ) : (
                    <Link2
                      size={13}
                      className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted z-10 pointer-events-none"
                    />
                  )}
                  <input
                    dir="ltr"
                    type="url"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleUrlSubmit();
                      }
                    }}
                    onFocus={() => {
                      if (urlInput.includes("\n")) setUrlExpanded(true);
                    }}
                    onPaste={(e) => {
                      const pasted = e.clipboardData.getData("text");

                      if (pasted.includes("\n")) {
                        e.preventDefault();
                        setUrlInput(pasted);
                        setUrlExpanded(true);
                      }
                    }}
                    placeholder={t("notes.upload.urlPlaceholder")}
                    className={cn(uploadFieldClass, "w-full h-8 pl-8 pr-9")}
                  />
                  <button
                    onClick={handleUrlSubmit}
                    disabled={!urlInput.trim()}
                    aria-label={t("notes.upload.urlSubmit")}
                    className={cn(
                      "absolute right-px top-px bottom-px w-7 rounded-r-[7px] flex items-center justify-center transition-colors",
                      "border-l border-foreground/6 dark:border-white/10",
                      urlInput.trim()
                        ? "text-muted hover:text-muted hover:bg-foreground/[0.03] dark:hover:bg-white/[0.03]"
                        : "text-muted"
                    )}
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              )}
            </>
          )}

          {batchUrlNotice && (
            <p className="text-2xs text-warning/60 mt-2 text-center">{batchUrlNotice}</p>
          )}

          {batch.hasQueue && (
            <div className="mt-3">
              <BatchQueueView
                queue={batch.queue}
                byokMaxFileSizeMb={byokMaxFileSizeMb}
                completedCount={batch.completedCount}
                failedCount={batch.failedCount}
                totalCount={batch.totalCount}
                isProcessing={batch.isProcessing}
                onRemoveItem={batch.removeItem}
                onCancelAll={batch.cancelAll}
                onClearQueue={() => {
                  setBatchUrlNotice(null);
                  batch.clearQueue();
                }}
                onOpenNote={(noteId) =>
                  onNoteCreated?.(noteId, batchFolderId ? Number(batchFolderId) : null)
                }
              />

              {!batch.isProcessing && batch.queue.some((i) => i.status === "queued") && (
                <div className="mt-3 space-y-2">
                  {folders.length > 0 && (
                    <FolderSelect
                      t={t}
                      folders={folders}
                      value={batchFolderId}
                      onChange={setBatchFolderId}
                    />
                  )}
                  <div className="flex justify-center">
                    <Button
                      variant="default"
                      size="sm"
                      onClick={startBatchProcessing}
                      disabled={state === "downloading" || state === "transcribing"}
                      className="h-8 text-xs px-5"
                    >
                      {t("notes.upload.transcribe")}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {state === "selected" && file && (
            <SelectedView
              t={t}
              file={file}
              getActiveModelLabel={getActiveModelLabel}
              reset={reset}
              handleTranscribe={handleTranscribe}
              transcribeDisabled={batch.isProcessing}
              byokTooLarge={byokTooLarge}
              byokMaxFileSizeMb={byokMaxFileSizeMb}
              onOpenSettings={onOpenSettings}
            />
          )}

          {state === "downloading" && downloadProgress && (
            <div
              className="flex flex-col items-center"
              style={{ animation: "float-up 0.3s ease-out" }}
            >
              <div className="flex items-end justify-center gap-[3px] h-10 mb-5">
                {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                  <div
                    key={i}
                    className="w-[3px] rounded-full bg-primary/40 dark:bg-primary/50 origin-bottom"
                    style={{
                      height: "100%",
                      animation: `waveform-bar ${0.8 + i * 0.12}s ease-in-out infinite`,
                      animationDelay: `${i * 0.08}s`,
                    }}
                  />
                ))}
              </div>

              <div className="w-full max-w-[200px] h-[3px] rounded-full bg-default dark:bg-white/5 overflow-hidden mb-3">
                <div
                  className={cn(
                    "h-full rounded-full bg-primary/50 transition-[width] duration-500 ease-out",
                    // Percent 0 = size unknown (no content-length): pulse instead
                    // of sitting on an empty bar.
                    (downloadProgress.stage !== "downloading" || !downloadProgress.percent) &&
                      "animate-pulse"
                  )}
                  style={{
                    width:
                      downloadProgress.stage === "downloading" && downloadProgress.percent
                        ? `${Math.min(downloadProgress.percent, 100)}%`
                        : "100%",
                  }}
                />
              </div>

              <p className="text-xs text-muted font-medium">
                {downloadProgress.stage === "resolving"
                  ? t("notes.upload.urlResolving")
                  : t("notes.upload.urlDownloading")}
              </p>

              {downloadProgress.title && (
                <p dir="auto" className="text-xs text-muted mt-1 truncate max-w-50">
                  {downloadProgress.title}
                </p>
              )}

              <Button
                variant="ghost"
                size="sm"
                onClick={handleCancelDownload}
                className="mt-3 h-7 text-xs text-muted"
              >
                {t("notes.upload.urlCancelDownload")}
              </Button>
            </div>
          )}

          {state === "transcribing" && (
            <TranscribingView
              t={t}
              progress={progress}
              getTranscribingLabel={getTranscribingLabel}
              file={file}
              onCancel={cancelTranscription}
            />
          )}

          {state === "complete" && result && (
            <CompleteView
              t={t}
              result={result}
              partialWarning={partialWarning}
              diarizationWarning={diarizationWarning}
              folders={folders}
              selectedFolderId={selectedFolderId}
              folderMoveError={folderMoveError}
              handleFolderChange={handleFolderChange}
              noteId={noteId}
              onNoteCreated={onNoteCreated}
              reset={reset}
            />
          )}

          {state === "error" && error && (
            <ErrorView t={t} error={error} reset={reset} onRetry={handleRetry} />
          )}
        </div>

        {(state === "idle" || state === "selected") && providerReady !== false && (
          <div className="max-w-[320px] mx-auto mt-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t("notes.upload.speakerDetection")}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t("notes.upload.speakerDetectionDescription")}
                </p>
              </div>
              <Toggle
                checked={diarizationEnabled}
                disabled={diarizationDownloading}
                ariaLabel={t("notes.upload.speakerDetection")}
                onChange={async (next) => {
                  if (diarizationDownloading) return;
                  setDiarizationEnabled(next);

                  // BYOK-native diarization needs no local models — don't download them.
                  if (
                    next &&
                    !diarizationModelsReady &&
                    !shouldUseByokDiarize(buildTranscriptionConfig(), true)
                  ) {
                    const ready = await ensureDiarizationModels();

                    if (!ready) setDiarizationEnabled(false);
                  }
                }}
              />
            </div>

            {diarizationEnabled &&
              !useLocalWhisper &&
              !isSelfHosted &&
              cloudTranscriptionProvider === "openai" && (
                <p className="text-2xs text-muted mt-1.5">{t("notes.upload.openaiDiarizeNote")}</p>
              )}
            {diarizationEnabled &&
              !useLocalWhisper &&
              !isSelfHosted &&
              cloudTranscriptionProvider === "mistral" && (
                <p className="text-2xs text-muted mt-1.5">{t("notes.upload.mistralDiarizeNote")}</p>
              )}
            {diarizationEnabled &&
              !useLocalWhisper &&
              !isSelfHosted &&
              cloudTranscriptionProvider === "groq" && (
                <p className="text-2xs text-warning/60 mt-1.5">
                  {t("notes.upload.groqDiarizeNote")}
                </p>
              )}

            {diarizationDownloading && (
              <p className="text-2xs text-primary/50 mt-1.5">
                {t("notes.upload.downloadingModels")}
              </p>
            )}

            {diarizationEnabled && diarizationModelsReady && (
              <div className="mt-2">
                <label
                  htmlFor="upload-num-speakers"
                  className="block text-xs font-medium text-muted"
                >
                  {t("notes.upload.numSpeakersLabel")}
                </label>
                <input
                  id="upload-num-speakers"
                  type="number"
                  min="2"
                  max={MAX_SPEAKER_COUNT}
                  value={diarizationNumSpeakers}
                  onChange={(e) => {
                    const raw = e.target.value;

                    if (raw === "") {
                      setDiarizationNumSpeakers("");

                      return;
                    }

                    const n = Math.max(2, Math.min(MAX_SPEAKER_COUNT, Number(raw)));
                    setDiarizationNumSpeakers(String(isNaN(n) ? "" : n));
                  }}
                  placeholder={t("notes.upload.numSpeakersPlaceholder")}
                  className={cn(
                    uploadFieldClass,
                    "mt-1 w-full h-8 px-2.5 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  )}
                />
                <p className="text-2xs text-muted mt-1.5">{t("notes.upload.numSpeakersHint")}</p>
              </div>
            )}
          </div>
        )}
      </div>

      <Dialog open={showNewFolderDialog} onOpenChange={setShowNewFolderDialog}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t("notes.upload.newFolder")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted">{t("notes.upload.folderName")}</label>
            <Input
              dir="auto"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder={t("notes.folders.folderName")}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateFolder();
              }}
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setShowNewFolderDialog(false);
                setNewFolderName("");
              }}
            >
              {t("notes.upload.cancel")}
            </Button>
            <Button onClick={handleCreateFolder} disabled={!newFolderName.trim()}>
              {t("notes.upload.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface NoProviderViewProps {
  t: (key: string, options?: Record<string, unknown>) => string;
  onOpenSettings: () => void;
}

function NoProviderView({ t, onOpenSettings }: NoProviderViewProps) {
  return (
    <EmptyStateCard
      icon={Settings}
      title={t("notes.upload.noProviderTitle")}
      description={t("notes.upload.noProviderDescription")}
    >
      <Button size="sm" onClick={onOpenSettings}>
        {t("notes.upload.noProviderAction")}
      </Button>
    </EmptyStateCard>
  );
}

interface IdleViewProps {
  t: (key: string, options?: Record<string, unknown>) => string;
  getActiveModelLabel: () => string;
  handleDrop: (e: React.DragEvent) => void;
  handleBrowse: () => void;
  isDragOver: boolean;
  setIsDragOver: (v: boolean) => void;
  onOpenSettings?: (section: string) => void;
}

function IdleView({
  t,
  getActiveModelLabel,
  handleDrop,
  handleBrowse,
  isDragOver,
  setIsDragOver,
  onOpenSettings,
}: IdleViewProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];

    if (!f) return;
    // Delegate to handleBrowse which uses Electron's file dialog;
    // the hidden input is for keyboard-triggered file selection only.
    handleBrowse();

    // Reset input so the same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleBrowse();
    }
  };

  return (
    <>
      <div className="flex flex-col items-center mb-5">
        <div className="w-10 h-10 rounded-xl bg-linear-to-b from-foreground/5 to-foreground/[0.02] dark:from-white/8 dark:to-white/3 border border-foreground/8 dark:border-white/10 flex items-center justify-center mb-4">
          <Upload size={17} strokeWidth={1.5} className="text-muted" />
        </div>
        <h2 className="text-xs font-semibold text-foreground mb-1">{t("notes.upload.title")}</h2>
        <UploadModelSettingsButton
          label={t("notes.upload.using", { model: getActiveModelLabel() })}
          actionLabel={t("notes.upload.noProviderAction")}
          onOpenSettings={onOpenSettings}
          className="text-xs text-foreground/70"
        />
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".mp3,.wav,.m4a,.webm,.ogg,.oga,.flac,.aac,.opus"
        onChange={handleFileInputChange}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
      />

      <div
        role="button"
        tabIndex={0}
        aria-label={t("notes.upload.dropOrBrowse")}
        onDrop={handleDrop}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setIsDragOver(false);
        }}
        onClick={handleBrowse}
        onKeyDown={handleKeyDown}
        className={cn(
          "relative rounded-lg p-8 text-center cursor-pointer transition-[background-color,border-color,transform] duration-300 group",
          "bg-surface-1/40 dark:bg-white/[0.03] backdrop-blur-sm",
          "border border-foreground/6 dark:border-white/10",
          "hover:bg-surface-1/60 dark:hover:bg-white/[0.05] hover:border-foreground/12 dark:hover:border-white/10",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30",
          isDragOver && "border-primary/30 bg-primary/[0.04] dark:bg-primary/[0.06] scale-[1.01]"
        )}
        style={isDragOver ? { animation: "drag-pulse 1.5s ease-in-out infinite" } : undefined}
      >
        <div className="absolute inset-0 rounded-lg overflow-hidden pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-500">
          <div
            className="absolute inset-0 bg-gradient-to-r from-transparent via-foreground/[0.02] dark:via-white/[0.03] to-transparent"
            style={{ animation: "shimmer-slide 3s ease-in-out infinite" }}
          />
        </div>

        {!isDragOver ? (
          <div className="flex flex-col items-center gap-2 relative">
            <div className="w-8 h-8 rounded-full bg-foreground/[0.03] dark:bg-white/[0.04] flex items-center justify-center mb-1">
              <Upload size={14} className="text-muted transition-colors" />
            </div>
            <p className="text-xs text-muted group-hover:text-muted transition-colors">
              {t("notes.upload.dropOrBrowse")}
            </p>
            <p className="text-xs text-muted tracking-wide">{t("notes.upload.supportedFormats")}</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 relative">
            <Upload size={18} className="text-primary/60" />
            <p className="text-xs text-primary/60 font-medium">{t("notes.upload.dropToUpload")}</p>
          </div>
        )}
      </div>
    </>
  );
}

interface SelectedViewProps {
  t: (key: string, options?: Record<string, unknown>) => string;
  file: { name: string; path: string; size: string; sizeBytes: number };
  getActiveModelLabel: () => string;
  reset: () => void;
  handleTranscribe: () => void;
  transcribeDisabled: boolean;
  byokTooLarge: boolean;
  byokMaxFileSizeMb: number;
  onOpenSettings?: (section: string) => void;
}

function SelectedView({
  t,
  file,
  getActiveModelLabel,
  reset,
  handleTranscribe,
  transcribeDisabled,
  byokTooLarge,
  byokMaxFileSizeMb,
  onOpenSettings,
}: SelectedViewProps) {
  const canTranscribe = !byokTooLarge;

  return (
    <div style={{ animation: "float-up 0.3s ease-out" }}>
      <div className="rounded-lg border border-foreground/8 dark:border-white/10 bg-surface-1/40 dark:bg-white/[0.03] backdrop-blur-sm p-4 mb-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/8 dark:bg-primary/12 border border-primary/10 dark:border-primary/15 flex items-center justify-center shrink-0">
            <FileAudio size={15} className="text-primary/60" />
          </div>
          <div className="min-w-0 flex-1">
            <p dir="ltr" className="text-xs text-foreground/70 truncate font-medium">
              {file.name}
            </p>
            {file.size && <p className="text-xs text-muted mt-0.5">{file.size}</p>}
            <UploadModelSettingsButton
              label={getActiveModelLabel()}
              actionLabel={t("notes.upload.noProviderAction")}
              onOpenSettings={onOpenSettings}
              className="block max-w-full truncate text-start text-xs text-foreground/70 mt-0.5"
            />
          </div>
          <button onClick={reset} className="text-muted transition-colors p-1 rounded">
            <X size={12} />
          </button>
        </div>
      </div>

      {byokTooLarge && (
        <div className="rounded-lg border border-primary/12 dark:border-primary/15 bg-primary/[0.03] px-3 py-2.5 mb-3">
          <p className="text-xs text-muted leading-relaxed">
            {t("notes.upload.byokTooLarge", { size: byokMaxFileSizeMb })}
          </p>
          <p className="text-xs text-muted leading-relaxed mt-1.5">
            {t("notes.upload.byokTooLargeDetail", { size: byokMaxFileSizeMb })}
          </p>
        </div>
      )}

      <div className="flex items-center gap-2 justify-center flex-wrap">
        {canTranscribe && (
          <Button
            variant="default"
            size="sm"
            onClick={handleTranscribe}
            disabled={transcribeDisabled}
            className="h-8 text-xs px-5"
          >
            {t("notes.upload.transcribe")}
          </Button>
        )}

        {/* Cancel button — always shown */}
        <Button variant="ghost" size="sm" onClick={reset} className="h-8 text-xs text-muted">
          {t("notes.upload.cancel")}
        </Button>
      </div>
    </div>
  );
}

interface TranscribingViewProps {
  t: (key: string, options?: Record<string, unknown>) => string;
  progress: number;
  getTranscribingLabel: () => string;
  file: { name: string; path: string; size: string; sizeBytes: number } | null;
  onCancel: () => void;
}

function TranscribingView({
  t,
  progress,
  getTranscribingLabel,
  file,
  onCancel,
}: TranscribingViewProps) {
  return (
    <div className="flex flex-col items-center" style={{ animation: "float-up 0.3s ease-out" }}>
      <div className="flex items-end justify-center gap-[3px] h-10 mb-5">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <div
            key={i}
            className="w-[3px] rounded-full bg-primary/40 dark:bg-primary/50 origin-bottom"
            style={{
              height: "100%",
              animation: `waveform-bar ${0.8 + i * 0.12}s ease-in-out infinite`,
              animationDelay: `${i * 0.08}s`,
            }}
          />
        ))}
      </div>

      <div className="w-full max-w-[200px] h-[3px] rounded-full bg-default dark:bg-white/5 overflow-hidden mb-3">
        <div
          className="h-full rounded-full bg-primary/50 transition-[width] duration-500 ease-out"
          style={{ width: `${Math.min(progress, 100)}%` }}
        />
      </div>

      <p className="text-xs text-muted font-medium">{getTranscribingLabel()}</p>
      {file ? (
        <p dir="ltr" className="text-xs text-muted mt-1 truncate max-w-50">
          {file.name}
        </p>
      ) : null}
      <Button variant="ghost" size="sm" onClick={onCancel} className="h-7 text-xs text-muted mt-4">
        {t("notes.upload.cancelTranscription")}
      </Button>
    </div>
  );
}

interface FolderSelectProps {
  t: (key: string) => string;
  folders: FolderItem[];
  value: string;
  onChange: (val: string) => void;
  includeCreateNew?: boolean;
  className?: string;
}

function FolderSelect({
  t,
  folders,
  value,
  onChange,
  includeCreateNew,
  className,
}: FolderSelectProps) {
  return (
    <div className={cn("flex items-center justify-center gap-2", className)}>
      <FolderOpen size={12} className="text-muted shrink-0" />
      <SelectField
        value={value || "__root__"}
        onChange={(id) => onChange(id === "__root__" ? "" : id)}
        ariaLabel={t("notes.upload.selectFolder")}
        placeholder={t("notes.upload.selectFolder")}
        size="sm"
        options={[
          { id: "__root__", label: t("notes.editor.noFolder") },
          ...folders.map((f) => ({ id: String(f.id), label: f.name })),
          ...(includeCreateNew
            ? [
                {
                  id: "__create_new__",
                  label: t("notes.upload.newFolder"),
                  icon: <Plus size={12} className="text-primary" />,
                  separated: true,
                },
              ]
            : []),
        ]}
      />
    </div>
  );
}

interface CompleteViewProps {
  t: (key: string, options?: Record<string, unknown>) => string;
  result: string;
  partialWarning: { failed: number; total: number } | null;
  diarizationWarning: boolean;
  folders: FolderItem[];
  selectedFolderId: string;
  folderMoveError: string | null;
  handleFolderChange: (val: string) => void;
  noteId: number | null;
  onNoteCreated?: (noteId: number, folderId: number | null) => void;
  reset: () => void;
}

function CompleteView({
  t,
  result,
  partialWarning,
  diarizationWarning,
  folders,
  selectedFolderId,
  folderMoveError,
  handleFolderChange,
  noteId,
  onNoteCreated,
  reset,
}: CompleteViewProps) {
  return (
    <div className="flex flex-col items-center" style={{ animation: "float-up 0.3s ease-out" }}>
      <div className="relative w-12 h-12 mb-4">
        <svg className="w-12 h-12 -rotate-90" viewBox="0 0 36 36">
          <circle
            cx="18"
            cy="18"
            r="15"
            fill="none"
            strokeWidth="1.5"
            className="stroke-success/15"
          />
          <circle
            cx="18"
            cy="18"
            r="15"
            fill="none"
            strokeWidth="1.5"
            className="stroke-success/60"
            strokeDasharray="94.25"
            strokeLinecap="round"
            style={{ animation: "ring-fill 0.8s ease-out forwards" }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <svg className="w-5 h-5 text-success/70" viewBox="0 0 24 24" fill="none">
            <path
              d="M5 13l4 4L19 7"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray="24"
              strokeDashoffset="24"
              style={{ animation: "draw-check 0.4s ease-out 0.5s forwards" }}
            />
          </svg>
        </div>
      </div>

      <p className="text-xs text-muted font-medium mb-1">
        {t("notes.upload.transcriptionComplete")}
      </p>
      <p className="text-xs text-muted max-w-[240px] text-center line-clamp-2 mb-4">
        {result.slice(0, 150)}
      </p>

      <UploadCompleteWarnings
        partialWarning={partialWarning}
        diarizationWarning={diarizationWarning}
        t={t}
      />

      {folderMoveError && (
        <p className="text-xs text-danger/70 leading-relaxed mb-3" role="alert">
          {folderMoveError}
        </p>
      )}

      {folders.length > 0 && (
        <FolderSelect
          t={t}
          folders={folders}
          value={selectedFolderId}
          onChange={handleFolderChange}
          includeCreateNew
          className="mb-4"
        />
      )}

      <div className="flex items-center gap-2">
        {noteId != null && onNoteCreated && (
          <Button
            variant="default"
            size="sm"
            onClick={() =>
              onNoteCreated(noteId, selectedFolderId ? Number(selectedFolderId) : null)
            }
            className="h-8 text-xs"
          >
            {t("notes.upload.openNote")}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={reset} className="h-8 text-xs text-muted">
          {t("notes.upload.uploadAnother")}
        </Button>
      </div>
    </div>
  );
}

interface ErrorViewProps {
  t: (key: string) => string;
  error: string;
  reset: () => void;
  onRetry: () => void;
}

function ErrorView({ t, error, reset, onRetry }: ErrorViewProps) {
  return (
    <div style={{ animation: "float-up 0.3s ease-out" }}>
      <div className="rounded-lg border border-danger/15 dark:border-danger/20 bg-danger/[0.03] dark:bg-danger/[0.05] backdrop-blur-sm p-4 mb-4">
        <div className="flex items-start gap-2.5">
          <AlertCircle size={14} className="text-danger/50 shrink-0 mt-0.5" />
          <p className="flex-1 text-xs text-danger/70 leading-relaxed">{error}</p>
          <button onClick={reset} className="text-muted transition-colors shrink-0 p-0.5 rounded">
            <X size={11} />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 justify-center">
        <Button variant="ghost" size="sm" onClick={onRetry} className="h-7 text-xs text-muted">
          {t("notes.upload.retry")}
        </Button>
        <Button variant="ghost" size="sm" onClick={reset} className="h-7 text-xs text-muted">
          {t("notes.upload.startOver")}
        </Button>
      </div>
    </div>
  );
}
