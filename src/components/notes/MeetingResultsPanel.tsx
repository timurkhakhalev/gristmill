import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { Button, Dropdown, Label, ListBox, Modal, Popover, Select } from "@heroui/react";
import { useTranslation } from "react-i18next";
import { AlignLeft, AudioLines, MessageSquareText, MoreHorizontal, Play, RotateCcw, Sparkles, Trash2 } from "../icons";
import { Pause } from "../icons/primitives";
import type { MeetingProcessingRecordingResult } from "../../contracts/meetingProcessing";
import type { MeetingProcessingConfig, MeetingProcessingResultDto } from "../../contracts/meetingRecording";
import { builtinMeetingSummaryInstruction, snapshotMeetingRecordingConfig } from "../../helpers/meetingRecordingConfigSnapshot";
import { getMeetingFileTranscriptionProviders, getAllReasoningModels, getProviderDisplayName, modelRegistry } from "../../models/ModelRegistry";
import { BYOK_API_KEYS } from "../../config/secretKeys";
import { ConfirmDialog } from "../ui/dialog";
import { useDialogs } from "../../hooks/useDialogs";
import { openSettings } from "../../utils/openSettings";
import { NoteNotice } from "./NoteNotices";
import { ToastContext } from "../ui/useToast";
import NoteViewSwitch from "./NoteViewSwitch";
import { IconTooltip } from "../ui/IconTooltip";

type ViewMode = "raw" | "enhanced" | "transcript";
type RunChoice = { kind: "reprocess" | "summary"; partId?: string };

function Choice({ label, value, options, onChange }: {
  label: string; value: string; options: Array<{ id: string; label: string }>; onChange: (value: string) => void;
}) {
  return <Select aria-label={label} value={value} onChange={(key) => onChange(String(key))} className="min-w-0 flex-1">
    <Label>{label}</Label>
    <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
    <Select.Popover><ListBox>{options.map((option) =>
      <ListBox.Item key={option.id} id={option.id} textValue={option.label}><Label>{option.label}</Label><ListBox.ItemIndicator /></ListBox.Item>
    )}</ListBox></Select.Popover>
  </Select>;
}

function dateLabel(value: string, locale: string, options: Intl.DateTimeFormatOptions) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(locale, options).format(date);
}

function formatDuration(duration: number | null) {
  if (duration === null) return "—";
  const seconds = Math.max(0, Math.round(duration));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export default function MeetingResultsPanel({ noteId, locale, previewRecordings, viewMode, onViewModeChange, manualContent, fallbackTranscript, fallbackSummary, actions, notice }: {
  actions?: ReactNode;
  /** Live capture notice rendered under the toolbar, above processing status. */
  notice?: ReactNode;
  noteId: number;
  locale: string;
  previewRecordings?: MeetingProcessingRecordingResult[];
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  manualContent: ReactNode;
  fallbackTranscript: ReactNode;
  fallbackSummary: ReactNode;
}) {
  const { t } = useTranslation();
  const tr = (key: string, fallback: string) => t(`meetingResults.${key}`, { defaultValue: fallback });
  const [recordings, setRecordings] = useState(previewRecordings ?? []);
  const [groupId, setGroupId] = useState("");
  const [runId, setRunId] = useState("");
  const [audioOpen, setAudioOpen] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState("");
  const [message, setMessage] = useState("");
  const toastApi = useContext(ToastContext);
  // Outcomes of one-off actions go to a toast; the inline line is only a fallback outside ToastProvider.
  const notify = useCallback((text: string, variant: "default" | "destructive" | "success" = "default") => {
    if (!text) return setMessage("");
    if (toastApi) toastApi.toast({ title: text, variant });
    else setMessage(text);
  }, [toastApi]);
  const [busy, setBusy] = useState(false);
  const [runChoice, setRunChoice] = useState<RunChoice | null>(null);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [sourceRunId, setSourceRunId] = useState("");
  const [speakerId, setSpeakerId] = useState<string | null>(null);
  const [speakerName, setSpeakerName] = useState("");
  const [speakerProfileId, setSpeakerProfileId] = useState("none");
  const [profiles, setProfiles] = useState<Array<{ id: number; display_name: string }>>([]);
  const audioRef = useRef<HTMLAudioElement>(null);
  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();

  const refresh = useCallback(async () => {
    if (previewRecordings) return;
    const result = await window.electronAPI.meetingProcessingListForNote(noteId);
    if (result.success) setRecordings(result.recordings ?? []);
    else notify(result.error || t("meetingResults.loadError"), "destructive");
  }, [noteId, previewRecordings, t]);
  useEffect(() => {
    if (previewRecordings) { setRecordings(previewRecordings); return; }
    void refresh();
    const unsubscribe = window.electronAPI.onMeetingProcessingUpdated(() => void refresh());
    return unsubscribe;
  }, [previewRecordings, refresh]);
  useEffect(() => {
    if (previewRecordings) return;
    void window.electronAPI.getSpeakerProfiles?.().then((items) => setProfiles((items ?? []).map((item) => ({ id: item.id, display_name: item.display_name }))));
  }, [previewRecordings]);

  const groups = useMemo(() => [...new Map([...recordings].reverse().map((item) => [item.recording.groupId, item])).values()].reverse(), [recordings]);
  const currentGroup = groupId && groups.some((item) => item.recording.groupId === groupId) ? groupId : groups[groups.length - 1]?.recording.groupId;
  const parts = useMemo(() => recordings.filter((item) => item.recording.groupId === currentGroup).sort((a, b) => a.recording.startedAt.localeCompare(b.recording.startedAt)), [recordings, currentGroup]);
  const versions = useMemo(() => parts.flatMap((part) => part.runs).filter((item) => item.transcript).sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt)), [parts]);
  const selected = versions.find((item) => item.run.id === runId) ?? versions.find((item) => parts.some((part) => part.recording.currentRunId === item.run.id)) ?? versions[0];
  const speakerLabel = (id: string) => t("meetingResults.speakerNumber", { defaultValue: "Speaker {{number}}", number: [...new Set(selected?.transcript?.segments?.map((segment) => segment.speaker).filter(Boolean))].indexOf(id) + 1 });
  const selectedId = selected?.run.id ?? "";

  const allRuns = parts.flatMap((part) => part.runs);
  const combinedCurrent = allRuns.find((item) => item.run.kind === "reprocess" && item.run.sourceRecordingIds.length > 1 &&
    parts.some((part) => part.recording.currentRunId === item.run.id));
  const latestRun = allRuns.find((item) => item.run.id === runId)
    ?? combinedCurrent
    ?? [...allRuns].reverse().find((item) => parts.some((part) => part.recording.currentRunId === item.run.id));
  const availableParts = parts.filter((part) => part.recording.audioState === "available");
  const currentConfig = snapshotMeetingRecordingConfig().config;
  const localTranscriptionConfig = currentConfig?.transcription ?? versions.find((item) => item.run.config?.transcription.mode === "local")?.run.config?.transcription;
  const localTranscription = localTranscriptionConfig?.mode === "local" ? localTranscriptionConfig.local : null;
  const asrProviders = [
    ...getMeetingFileTranscriptionProviders().map((item) => ({ id: item.id, label: item.name, models: item.models.map((model) => ({ id: model.id, label: model.name })) })),
    ...(localTranscription ? [{ id: "local", label: tr("localProvider", "Local"), models: [{ id: localTranscription.model, label: localTranscription.model }] }] : []),
  ];
  const llmModels = getAllReasoningModels();
  const summaryConfig = currentConfig?.summary;
  const llmProviders = [...new Set(llmModels.map((item) => item.provider))]
    .filter((id) => !["bedrock", "azure", "vertex"].includes(id) || (summaryConfig?.reasoningMode === "enterprise" && summaryConfig.provider === id))
    .map((id) => ({ id, label: getProviderDisplayName(id) }));
  if (summaryConfig?.reasoningMode === "self-hosted") llmProviders.push({ id: "self-hosted", label: tr("selfHostedProvider", "Self-hosted") });
  const isSummaryChoice = runChoice?.kind === "summary";
  const modelOptions = isSummaryChoice
    ? provider === "self-hosted" ? [{ id: summaryConfig?.model ?? "", label: summaryConfig?.model ?? "" }]
      : llmModels.filter((item) => item.provider === provider).map((item) => ({ id: item.value, label: item.label }))
    : asrProviders.find((item) => item.id === provider)?.models ?? [];

  const runTask = async (task: () => Promise<void>) => {
    setBusy(true);
    try { await task(); await refresh(); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), "destructive"); }
    finally { setBusy(false); }
  };

  const startAudio = async (id: string, seek = 0) => {
    if (playingId === id && audioRef.current && seek === 0) { audioRef.current.pause(); setPlayingId(null); return; }
    if (previewRecordings) { notify(tr("previewAudio", "Preview audio is unavailable.")); return; }
    if (!parts.some((item) => item.recording.id === id)) return;
    const path = await window.electronAPI.meetingRecordingGetPlaybackPath(id);
    if (!path.success || !path.path) { notify(path.error || t("meetingResults.playbackError"), "destructive"); return; }
    const url = new URL(path.path, "file://").href;
    if (audioRef.current) {
      if (audioUrl !== url) {
        audioRef.current.src = url;
        audioRef.current.load();
      }
      if (audioRef.current.readyState < HTMLMediaElement.HAVE_METADATA) {
        await new Promise<void>((resolve) => {
          audioRef.current?.addEventListener("loadedmetadata", () => resolve(), { once: true });
          audioRef.current?.addEventListener("error", () => resolve(), { once: true });
        });
      }
      audioRef.current.currentTime = seek;
      await audioRef.current.play().catch(() => notify(t("meetingResults.playbackError"), "destructive"));
      setPlayingId(id); setAudioUrl(url);
    }
  };

  const openRun = (kind: "reprocess" | "summary", partId?: string) => {
    const snapshot = snapshotMeetingRecordingConfig();
    const config = snapshot.config;
    const initialProvider = kind === "summary"
      ? config?.summary?.reasoningMode === "local" ? "local" : config?.summary?.reasoningMode === "self-hosted" ? "self-hosted" : config?.summary?.provider ?? ""
      : config?.transcription.mode === "local" ? "local" : config?.transcription.provider ?? "";
    const initialModel = kind === "summary" ? config?.summary?.model ?? "" : config?.transcription.mode === "local" ? config.transcription.local?.model ?? "" : config?.transcription.model ?? "";
    setProvider(initialProvider || (kind === "summary" ? llmProviders[0]?.id : asrProviders[0]?.id) || "");
    setModel(initialModel || (kind === "summary" ? llmModels[0]?.value : asrProviders[0]?.models[0]?.id) || "");
    setSourceRunId(selected?.run.kind === "summary" ? selected.run.sourceRunId ?? "" : selectedId);
    setRunChoice({ kind, partId }); setAudioOpen(false);
  };

  const createRun = () => runTask(async () => {
    if (!runChoice || !parts.length) return;
    if (previewRecordings) { notify("Mock processing queued in memory"); setRunChoice(null); return; }
    const snapshot = snapshotMeetingRecordingConfig();
    const savedConfig = (runChoice.kind === "summary" ? versions.find((item) => item.run.id === sourceRunId) : selected)?.run.config;
    const baseConfig = snapshot.config ?? savedConfig;
    if (!baseConfig) throw new Error(snapshot.configError?.code || "processing-config-missing");
    const config: MeetingProcessingConfig = { ...baseConfig };
    const ids = runChoice.partId ? [runChoice.partId] : availableParts.map((part) => part.recording.id);
    if (runChoice.kind === "reprocess") {
      if (!ids.length) throw new Error("meeting-audio-unavailable");
      if (provider === "local") {
        if (!localTranscription || localTranscription.model !== model) throw new Error("local-transcription-route-unavailable");
        config.transcription = { ...config.transcription, mode: "local", provider: undefined, model: undefined, baseUrl: undefined, credentialRef: undefined, local: localTranscription };
      } else {
        config.transcription = { ...config.transcription, mode: "providers", provider, model,
          baseUrl: provider === "custom" ? config.transcription.baseUrl : undefined,
          local: undefined, credentialRef: provider === "custom" ? "CUSTOM_TRANSCRIPTION_API_KEY" : BYOK_API_KEYS.find((item) => item.base === provider)?.env };
      }
    } else {
      if (!sourceRunId) throw new Error("summary-transcript-missing");
      const source = versions.find((item) => item.run.id === sourceRunId);
      if (!source) throw new Error("summary-transcript-missing");
      config.transcription = source.run.config?.transcription ?? config.transcription;
      if (!config.summary) config.summary = { instruction: builtinMeetingSummaryInstruction(), reasoningMode: "providers" };
      if (provider === "local") {
        const localProvider = modelRegistry.getModel(model)?.provider.id;
        if (!localProvider) throw new Error("local-summary-model-unavailable");
        config.summary = { ...config.summary, reasoningMode: "local", provider: localProvider, model, cloudBaseUrl: undefined, remoteUrl: undefined, credentialRef: undefined, enterprise: undefined };
      } else if (provider === "self-hosted") {
        if (summaryConfig?.reasoningMode !== "self-hosted" || !summaryConfig.remoteUrl) throw new Error("self-hosted-route-unavailable");
        config.summary = { ...config.summary, ...summaryConfig, model };
      } else if (["bedrock", "azure", "vertex"].includes(provider)) {
        if (summaryConfig?.reasoningMode !== "enterprise" || summaryConfig.provider !== provider) throw new Error("enterprise-route-unavailable");
        config.summary = { ...config.summary, ...summaryConfig, model };
      } else {
        config.summary = { ...config.summary, reasoningMode: "providers", provider, model,
          cloudBaseUrl: provider === "custom" ? summaryConfig?.cloudBaseUrl : undefined, remoteUrl: undefined,
          enterprise: undefined, credentialRef: provider === "custom" ? "CUSTOM_CLEANUP_API_KEY" : BYOK_API_KEYS.find((item) => item.base === provider)?.env };
      }
    }
    const source = runChoice.kind === "summary" ? versions.find((item) => item.run.id === sourceRunId) : null;
    const result = await window.electronAPI.meetingProcessingCreateRun({
      recordingId: source?.run.recordingId ?? ids[0],
      sourceRecordingIds: runChoice.kind === "reprocess" ? ids : undefined,
      kind: runChoice.kind,
      config,
      configError: null,
      sourceRunId: runChoice.kind === "summary" ? sourceRunId : undefined,
    });
    if (!result.success || !result.result) throw new Error(result.error || t("meetingResults.createError"));
    setRunId(result.result.run.id); setRunChoice(null);
    onViewModeChange(runChoice.kind === "summary" ? "enhanced" : "transcript");
  });

  const selectRun = (id: string) => runTask(async () => {
    const run = versions.find((item) => item.run.id === id);
    if (!run) return;
    if (!previewRecordings) {
      const result = await window.electronAPI.meetingProcessingSelectRun(run.run.recordingId, id);
      if (!result.success) throw new Error(result.error || t("meetingResults.selectError"));
    }
    setRunId(id);
  });

  const deletePart = (id: string) => {
    setAudioOpen(false);
    showConfirmDialog({
      title: t("meetingResults.deleteAudioTitle"), description: t("meetingResults.deleteAudioDescription"),
      confirmText: t("meetingResults.deleteAudioConfirm"), variant: "destructive",
      onConfirm: () => void runTask(async () => {
        audioRef.current?.pause(); setPlayingId(null);
        if (previewRecordings) { setRecordings((items) => items.map((item) => item.recording.id === id ? { ...item, recording: { ...item.recording, audioState: "deleted" } } : item)); return; }
        const result = await window.electronAPI.meetingRecordingDeleteAudio(id);
        if (!result.success) throw new Error(result.error || t("meetingResults.deleteError"));
      }),
    });
  };

  const correctSpeaker = () => runTask(async () => {
    if (!speakerId || !selected || !speakerName.trim()) return;
    if (previewRecordings) {
      setRecordings((items) => items.map((item) => ({ ...item, runs: item.runs.map((run) => run.run.id === selected.run.id ? { ...run, speakerCorrections: [...run.speakerCorrections.filter((correction) => correction.speakerId !== speakerId), { speakerId, displayName: speakerName.trim(), profileId: speakerProfileId === "none" ? null : Number(speakerProfileId) }] } : run) })));
      setSpeakerId(null); return;
    }
    const result = await window.electronAPI.meetingProcessingSetSpeakerCorrection({
      runId: selected.run.kind === "summary" ? selected.run.sourceRunId ?? selected.run.id : selected.run.id,
      speakerId, displayName: speakerName.trim(), profileId: speakerProfileId === "none" ? null : Number(speakerProfileId),
    });
    if (!result.success) throw new Error(result.error || t("meetingResults.speakerError"));
    setSpeakerId(null);
  });

  const exportPart = (id: string, source: "mic" | "system") => runTask(async () => {
    if (previewRecordings) { notify(tr("previewAudio", "Preview audio is unavailable.")); return; }
    const result = await window.electronAPI.meetingRecordingExportAudio({ recordingId: id, source });
    if (!result.success) throw new Error(result.error || t("meetingResults.exportError"));
    notify(t("meetingResults.exported"), "success");
  });

  return <div className="@container mx-auto w-full max-w-[880px] px-[clamp(20px,5vw,54px)] max-[720px]:px-5 pt-4 pb-8 max-[720px]:pb-16">
    <div className="sticky top-0 z-10 -mt-4 mb-3 flex items-center justify-between gap-2 bg-background pt-4 pb-3 max-[720px]:flex-wrap">
      <NoteViewSwitch
        value={viewMode}
        onChange={onViewModeChange}
        ariaLabel={tr("contentTabs", "Meeting content")}
        options={[
          { id: "raw", label: t("notes.editor.notes"), icon: AlignLeft },
          { id: "enhanced", label: tr("summaryTab", "Summary"), icon: Sparkles },
          { id: "transcript", label: t("notes.editor.transcript"), icon: MessageSquareText },
        ]}
        versionMenu={viewMode === "raw" ? undefined : {
          label: t("meetingResults.version"),
          selectedId,
          onSelect: (id) => void selectRun(id),
          items: versions.map((item, index) => ({
            id: item.run.id,
            label: `${index + 1} · ${item.run.kind === "summary" ? item.run.config?.summary?.provider || item.run.config?.summary?.reasoningMode : item.run.provider || "local"} / ${(item.run.kind === "summary" ? item.run.config?.summary?.model : item.run.model) || "—"}`,
            detail: dateLabel(item.run.createdAt, locale, { dateStyle: "short", timeStyle: "short" }),
          })),
        }}
      />
      <div className="ms-auto flex flex-wrap items-center gap-1.5">
      <Popover isOpen={audioOpen} onOpenChange={setAudioOpen}>
        <IconTooltip label={tr("audioParts", "Audio")}><Button size="sm" variant="tertiary" isIconOnly className="relative overflow-visible" aria-label={`${tr("audioParts", "Audio")} ${parts.length}`}><AudioLines size={16}/>{parts.length > 0 && <span key={parts.length} className="absolute -end-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-3xs font-semibold text-accent-foreground motion-safe:animate-in motion-safe:zoom-in-50 motion-safe:duration-200">{parts.length}</span>}</Button></IconTooltip>
        <Popover.Content placement="bottom end" className="w-[355px] max-w-[calc(100vw-24px)]"><Popover.Dialog className="p-4">
          <Popover.Heading className="text-base font-semibold">{tr("audioParts", "Audio")}</Popover.Heading>
          {groups.length > 1 && <Choice label={t("meetingResults.recording")} value={currentGroup ?? ""} options={groups.map((group) => ({ id: group.recording.groupId, label: dateLabel(group.recording.startedAt, locale, { dateStyle: "medium", timeStyle: "short" }) }))} onChange={setGroupId} />}
          {!parts.length && <p className="text-muted">{tr("noAudioParts", "Audio parts appear here after recording.")}</p>}
          {parts.map((part, index) => <div className="flex items-center gap-2.5 border-b border-border py-3.5" key={part.recording.id}>
            <Button isIconOnly size="sm" variant="ghost" isDisabled={part.recording.audioState !== "available"} aria-label={playingId === part.recording.id ? tr("pauseAudio", "Pause audio") : tr("playAudio", "Play audio")} onPress={() => void startAudio(part.recording.id)}>{playingId === part.recording.id ? <Pause size={16}/> : <Play size={16}/>}</Button>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5"><strong className="text-sm font-medium">{dateLabel(part.recording.startedAt, locale, { timeStyle: "short" })}</strong><span className="text-xs text-muted">{formatDuration(part.recording.durationSeconds)} · {tr("part", "Part")} {index + 1}</span></div>
            <Dropdown><Button isIconOnly size="sm" variant="ghost" aria-label={tr("partActions", "Audio part actions")}><MoreHorizontal size={17}/></Button><Dropdown.Popover><Dropdown.Menu aria-label={tr("partActions", "Audio part actions")} onAction={(key) => {
              if (key === "asr") openRun("reprocess", part.recording.id);
              if (key === "mic" || key === "system") void exportPart(part.recording.id, key);
              if (key === "delete") deletePart(part.recording.id);
            }}>
              <Dropdown.Item id="asr" isDisabled={busy || part.recording.audioState !== "available"} textValue={t("meetingResults.newAsr")}>{t("meetingResults.newAsr")}</Dropdown.Item>
              <Dropdown.Item id="mic" isDisabled={busy || part.recording.audioState !== "available"} textValue={t("meetingResults.exportMic")}>{t("meetingResults.exportMic")}</Dropdown.Item>
              <Dropdown.Item id="system" isDisabled={busy || part.recording.audioState !== "available"} textValue={t("meetingResults.exportSystem")}>{t("meetingResults.exportSystem")}</Dropdown.Item>
              <Dropdown.Item id="delete" isDisabled={busy || part.recording.audioState === "deleted"} variant="danger" textValue={t(part.recording.audioErrorCode ? "meetingResults.retryDelete" : "meetingResults.deleteAudio")}><Trash2 size={14}/>{t(part.recording.audioErrorCode ? "meetingResults.retryDelete" : "meetingResults.deleteAudio")}</Dropdown.Item>
            </Dropdown.Menu></Dropdown.Popover></Dropdown>
          </div>)}
          {availableParts.length > 0 && <Button size="sm" variant="ghost" onPress={() => openRun("reprocess")}>{tr("processWholeMeeting", "Transcribe whole meeting")}<RotateCcw size={14}/></Button>}
          <p className="mt-3.5 text-xs leading-normal text-muted">{tr("originalsPreserved", "Original microphone and system tracks are saved separately.")}</p>
        </Popover.Dialog></Popover.Content>
      </Popover>
      {actions}
      </div>
    </div>

    {notice}
    {parts.some((part) => part.recording.captureState === "incomplete" || part.recording.captureErrorCode) && <NoteNotice
      status="warning"
      title={t("notes.editor.capture.incomplete")}
      description={t("meetingResults.captureIncomplete")}
    />}
    {latestRun && !["complete", "cancelled"].includes(latestRun.run.status) && (() => {
      const { status, stage, errorCode } = latestRun.run;
      const stageKey = stage === "asr" || stage === "summary" ? stage : "other";
      const needsConfig = status === "blocked" && Boolean(latestRun.run.configError || !latestRun.run.config || errorCode === "missing-summary-config");
      const settingsSection = stage === "summary" || errorCode === "missing-summary-config" ? "models#summary" : "models#meeting";
      const actions = <>
        {needsConfig && <Button size="sm" onPress={() => openSettings(settingsSection)}>{t("meetingResults.openSettings")}</Button>}
        {needsConfig && <Button size="sm" variant="tertiary" isPending={busy} onPress={() => void runTask(async () => {
          if (previewRecordings) { notify("Mock settings updated in memory"); return; }
          const snapshot = snapshotMeetingRecordingConfig(latestRun.run.stage === "summary" && latestRun.transcript ? latestRun.run.config?.transcription : undefined);
          const result = await window.electronAPI.meetingProcessingUpdateBlockedRunConfig({ runId: latestRun.run.id, config: snapshot.config, configError: snapshot.configError });
          if (!result.success) throw new Error(result.error || t("meetingResults.updateConfigError"));
        })}>{t("meetingResults.updateRunSettings")}</Button>}
        {(status === "failed" || (status === "blocked" && !needsConfig)) && <Button size="sm" variant="secondary" isPending={busy} onPress={() => void runTask(async () => {
          if (previewRecordings) { notify("Mock retry queued in memory"); return; }
          const result = await window.electronAPI.meetingProcessingRetryRun(latestRun.run.id);
          if (!result.success) throw new Error(result.error || t("meetingResults.retryError"));
        })}>{t("meetingResults.retry")}</Button>}
      </>;
      if (status === "blocked") return <NoteNotice status="warning" title={t(`meetingResults.blocked.${stageKey}`)}
        description={t(errorCode === "missing-transcription-config" || errorCode === "missing-summary-config" ? `meetingResults.blockedReason.${errorCode}` : "meetingResults.blockedReason.other")} actions={actions} />;
      if (status === "failed") return <NoteNotice status="danger" title={t(`meetingResults.failed.${stageKey}`)} description={t("meetingResults.failedReason")} actions={actions} />;
      return <NoteNotice status="accent" busy title={`${t(`meetingResults.stage.${stage}`)}…`} description={t(status === "pending" ? "meetingResults.progress.pending" : "meetingResults.progress.running")} />;
    })()}

    <div key={viewMode} className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200 motion-safe:slide-in-from-bottom-1">
    {viewMode === "raw" ? manualContent : <div>
      {selected && (viewMode !== "enhanced" || selected.summary?.text) && <div className="flex items-center gap-1.5 text-xs text-muted"><span className="min-w-0 flex-1 truncate">{viewMode === "enhanced" ? selected.run.config?.summary?.provider : selected.run.provider} · {viewMode === "enhanced" ? selected.run.config?.summary?.model : selected.run.model}</span>
        <Dropdown><IconTooltip label={tr("resultActions", "Result actions")}><Button size="sm" variant="ghost" isIconOnly className="size-7 min-h-7" aria-label={tr("resultActions", "Result actions")}><MoreHorizontal size={17}/></Button></IconTooltip><Dropdown.Popover><Dropdown.Menu aria-label={tr("resultActions", "Result actions")} onAction={(key) => {
          if (key === "asr") openRun("reprocess");
          if (key === "summary") openRun("summary");
          if (key === "copy") void navigator.clipboard.writeText(viewMode === "enhanced" ? selected.summary?.text ?? "" : selected.transcript?.text ?? "");
          if (key === "export") void runTask(async () => { if (previewRecordings) { notify(tr("previewAudio", "Preview audio is unavailable.")); return; } const result = await window.electronAPI.meetingRecordingExportAudio({ recordingId: selected.run.recordingId, runId: selected.run.kind === "summary" ? selected.run.sourceRunId ?? undefined : selected.run.id, source: "mixed" }); if (!result.success) throw new Error(result.error || t("meetingResults.exportError")); });
        }}>
          <Dropdown.Item id="asr" isDisabled={!availableParts.length} textValue={t("meetingResults.newAsr")}>{t("meetingResults.newAsr")}</Dropdown.Item>
          <Dropdown.Item id="summary" textValue={t("meetingResults.newSummary")}>{t("meetingResults.newSummary")}</Dropdown.Item>
          <Dropdown.Item id="copy" textValue={tr("copyResult", "Copy text")}>{tr("copyResult", "Copy text")}</Dropdown.Item>
          <Dropdown.Item id="export" isDisabled={!availableParts.length} textValue={t("meetingResults.exportMixed")}>{t("meetingResults.exportMixed")}</Dropdown.Item>
        </Dropdown.Menu></Dropdown.Popover></Dropdown>
      </div>}
      {viewMode === "enhanced" ? selected?.summary?.text ? <article className="note-prose"><ReactMarkdown>{selected.summary.text}</ReactMarkdown></article> : fallbackSummary : selected?.transcript ? <div>
        {selected.transcript.segments?.length ? selected.transcript.segments.map((segment, index) => <div className="mt-6 grid grid-cols-[52px_minmax(0,1fr)] items-baseline gap-x-3.5" key={`${index}-${segment.start}`}>
          <button className="rounded py-1.5 text-start font-mono text-xs tabular-nums text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus" onClick={() => {
            let remaining = segment.start;
            for (const id of selected.run.sourceRecordingIds) {
              const part = parts.find((item) => item.recording.id === id);
              if (!part) continue;
              const duration = part.recording.durationSeconds ?? 0;
              if (remaining <= duration) { void startAudio(id, remaining); break; }
              remaining -= duration;
            }
          }}>{Math.floor(segment.start / 60)}:{String(Math.floor(segment.start % 60)).padStart(2, "0")}</button>
          <div>{segment.speaker && <button className="rounded text-xs font-semibold hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus" onClick={() => {
            const correction = selected.speakerCorrections.find((item) => item.speakerId === segment.speaker);
            setSpeakerId(segment.speaker ?? null); setSpeakerName(correction?.displayName ?? (segment.speaker ? speakerLabel(segment.speaker) : "")); setSpeakerProfileId(String(correction?.profileId ?? "none"));
          }}>{selected.speakerCorrections.find((item) => item.speakerId === segment.speaker)?.displayName ?? speakerLabel(segment.speaker)}</button>}<p className="mt-0.5 whitespace-pre-wrap text-sm leading-[1.8] text-muted">{segment.text}</p></div>
        </div>) : <p className="whitespace-pre-wrap text-sm leading-[1.8] text-muted">{selected.transcript.text}</p>}

      </div> : fallbackTranscript}
    </div>}
    </div>
    {message && <NoteNotice status="default" title={message} />}
    <audio ref={audioRef} preload="metadata" onEnded={() => setPlayingId(null)} />

    <Modal isOpen={runChoice !== null} onOpenChange={(open) => { if (!open) setRunChoice(null); }}><Modal.Backdrop><Modal.Container size="md"><Modal.Dialog><Modal.CloseTrigger/><Modal.Header><Modal.Heading>{isSummaryChoice ? t("meetingResults.newSummary") : t("meetingResults.newAsr")}</Modal.Heading></Modal.Header><Modal.Body>
      <p className="text-muted">{isSummaryChoice ? tr("summaryFromSaved", "Create a summary from a saved transcript without another transcription request.") : runChoice?.partId ? tr("transcribePart", "Transcribe this audio part.") : tr("transcribeWhole", "Transcribe all saved parts as one meeting.")}</p>
      <div className="my-5 flex gap-3.5 max-[720px]:flex-col"><Choice label={tr("provider", "Provider")} value={provider} options={isSummaryChoice ? llmProviders : asrProviders} onChange={(value) => { setProvider(value); setModel(isSummaryChoice ? llmModels.find((item) => item.provider === value)?.value ?? "" : asrProviders.find((item) => item.id === value)?.models[0]?.id ?? ""); }}/><Choice label={tr("model", "Model")} value={model} options={modelOptions} onChange={setModel}/></div>
      {isSummaryChoice && <Choice label={tr("sourceTranscript", "Source transcript")} value={sourceRunId} options={versions.filter((item) => item.run.kind !== "summary").map((item) => ({ id: item.run.id, label: `${item.run.provider || "local"} / ${item.run.model || "—"} · ${dateLabel(item.run.createdAt, locale, { dateStyle: "short", timeStyle: "short" })}` }))} onChange={setSourceRunId} />}
      <p className="text-xs text-muted">{tr("oneRunOnly", "This choice applies to this run. Global defaults stay the same.")}</p>
    </Modal.Body><Modal.Footer><Button variant="tertiary" onPress={() => setRunChoice(null)}>{tr("cancel", "Cancel")}</Button><Button isDisabled={busy || !provider || !model} onPress={() => void createRun()}>{tr("createVersion", "Create version")}</Button></Modal.Footer></Modal.Dialog></Modal.Container></Modal.Backdrop></Modal>

    <Modal isOpen={speakerId !== null} onOpenChange={(open) => { if (!open) setSpeakerId(null); }}><Modal.Backdrop><Modal.Container size="sm"><Modal.Dialog><Modal.CloseTrigger/><Modal.Header><Modal.Heading>{t("meetingResults.saveSpeaker")}</Modal.Heading></Modal.Header><Modal.Body className="flex flex-col gap-4">
      <label className="flex flex-col gap-2 text-xs">{tr("speakerName", "Speaker name")}<input dir="auto" className="h-9 rounded-lg px-3 text-sm" value={speakerName} onChange={(event) => setSpeakerName(event.target.value)} /></label>
      <Choice label={t("meetingResults.speakerProfile")} value={speakerProfileId} options={[{ id: "none", label: t("meetingResults.noSpeakerProfile") }, ...profiles.map((item) => ({ id: String(item.id), label: item.display_name }))]} onChange={setSpeakerProfileId}/>
    </Modal.Body><Modal.Footer><Button variant="tertiary" onPress={() => setSpeakerId(null)}>{tr("cancel", "Cancel")}</Button><Button isDisabled={!speakerName.trim() || busy} onPress={() => void correctSpeaker()}>{t("meetingResults.saveSpeaker")}</Button></Modal.Footer></Modal.Dialog></Modal.Container></Modal.Backdrop></Modal>
    <ConfirmDialog open={confirmDialog.open} onOpenChange={(open) => !open && hideConfirmDialog()} title={confirmDialog.title} description={confirmDialog.description} confirmText={confirmDialog.confirmText} cancelText={confirmDialog.cancelText} onConfirm={confirmDialog.onConfirm} variant={confirmDialog.variant} />
  </div>;
}
