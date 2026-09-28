import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { Button, Dropdown, Label, ListBox, Modal, Popover, Select } from "@heroui/react";
import { useTranslation } from "react-i18next";
import { AlignLeft, AudioLines, Check, Copy, Download, FileText, MessageSquareText, MoreHorizontal, Play, Sparkles, Trash2 } from "../icons";
import { Pause } from "../icons/primitives";
import type { MeetingProcessingRecordingResult } from "../../contracts/meetingProcessing";
import type { MeetingProcessingConfig, MeetingProcessingResultDto } from "../../contracts/meetingRecording";
import { builtinMeetingSummaryInstruction, snapshotMeetingRecordingConfig } from "../../helpers/meetingRecordingConfigSnapshot";
import { ConfirmDialog } from "../ui/dialog";
import { useDialogs } from "../../hooks/useDialogs";
import { openSettings } from "../../utils/openSettings";
import { NoteNotice } from "./NoteNotices";
import { ToastContext } from "../ui/useToast";
import NoteViewSwitch from "./NoteViewSwitch";
import { IconTooltip } from "../ui/IconTooltip";
import { formatDate, formatTime, type DateFormat, type TimeFormat } from "../../utils/dateFormatting";
import { useDateTimePreferences } from "../../hooks/useDateTimePreferences";

type ViewMode = "raw" | "enhanced" | "transcript";
type RunChoice = { kind: "reprocess" | "summary"; partId?: string; groupId?: string };

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

function dateLabel(value: string, locale: string, options: Intl.DateTimeFormatOptions, dateFormat: DateFormat, timeFormat: TimeFormat) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  if (dateFormat === "locale" && timeFormat === "locale") return new Intl.DateTimeFormat(locale, options).format(date);
  if (options.dateStyle && options.timeStyle) {
    return `${formatDate(date, locale, { dateStyle: options.dateStyle }, dateFormat)} · ${formatTime(date, locale, { timeStyle: options.timeStyle }, timeFormat)}`;
  }
  return options.dateStyle
    ? formatDate(date, locale, { dateStyle: options.dateStyle }, dateFormat)
    : formatTime(date, locale, { timeStyle: options.timeStyle }, timeFormat);
}

function formatDuration(duration: number | null) {
  if (duration === null) return "—";
  const seconds = Math.max(0, Math.round(duration));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export default function MeetingResultsPanel({ noteId, locale, previewRecordings, viewMode, onViewModeChange, manualContent, fallbackTranscript, fallbackSummary, fallbackText, actions, notice, capturePhase }: {
  actions?: ReactNode;
  /** Plain text of each view's fallback content, copied when no processing run provides it. */
  fallbackText: Record<ViewMode, string>;
  /** Live capture notice rendered under the toolbar, above processing status. */
  notice?: ReactNode;
  noteId: number;
  capturePhase?: "idle" | "preparing" | "recording" | "paused" | "saving" | "saved" | "incomplete" | "failed";
  locale: string;
  previewRecordings?: MeetingProcessingRecordingResult[];
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  manualContent: ReactNode;
  fallbackTranscript: ReactNode;
  fallbackSummary: ReactNode;
}) {
  const { t } = useTranslation();
  const { dateFormat, timeFormat } = useDateTimePreferences();
  const tr = (key: string, fallback: string) => t(`meetingResults.${key}`, { defaultValue: fallback });
  const [recordings, setRecordings] = useState(previewRecordings ?? []);
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
  }, [noteId, previewRecordings, t, notify]);
  useEffect(() => {
    if (previewRecordings) { setRecordings(previewRecordings); return; }
    void refresh();
    const unsubscribe = window.electronAPI.onMeetingProcessingUpdated(() => void refresh());
    return unsubscribe;
  }, [previewRecordings, refresh]);
  useEffect(() => {
    if (capturePhase === "saved" || capturePhase === "incomplete") void refresh();
  }, [capturePhase, refresh]);
  useEffect(() => {
    if (previewRecordings) return;
    void window.electronAPI.getSpeakerProfiles?.().then((items) => setProfiles((items ?? []).map((item) => ({ id: item.id, display_name: item.display_name }))));
  }, [previewRecordings]);

  // One group per recording session (start/stop), each split into parts by pauses.
  const groups = useMemo(() => {
    const byGroup = new Map<string, MeetingProcessingRecordingResult[]>();
    for (const item of recordings) byGroup.set(item.recording.groupId, [...(byGroup.get(item.recording.groupId) ?? []), item]);
    return [...byGroup.entries()]
      .map(([id, items]) => ({ id, parts: items.sort((a, b) => a.recording.startedAt.localeCompare(b.recording.startedAt)) }))
      .sort((a, b) => a.parts[0].recording.startedAt.localeCompare(b.parts[0].recording.startedAt));
  }, [recordings]);
  const audioGroups = groups.map((group) => ({
    ...group,
    parts: group.parts.filter((part) => part.recording.audioState !== "deleted"),
  })).filter((group) => group.parts.length > 0);
  const displayedGroups = [...audioGroups].reverse();
  const audioCount = audioGroups.reduce((count, group) => count + group.parts.length, 0);
  const latestAudioGroup = audioGroups[audioGroups.length - 1];
  const latestGroup = groups[groups.length - 1];
  const versions = useMemo(() => recordings.flatMap((part) => part.runs).filter((item) => item.transcript).sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt)), [recordings]);
  const selected = versions.find((item) => item.run.id === runId)
    ?? versions.find((item) => latestGroup?.parts.some((part) => part.recording.currentRunId === item.run.id))
    ?? versions[0];
  // The session shown is the one the selected version came from.
  const currentGroup = recordings.find((item) => item.recording.id === selected?.run.recordingId)?.recording.groupId ?? latestGroup?.id;
  const parts = groups.find((group) => group.id === currentGroup)?.parts ?? [];
  const speakerLabel = (id: string) => t("meetingResults.speakerNumber", { defaultValue: "Speaker {{number}}", number: [...new Set(selected?.transcript?.segments?.map((segment) => segment.speaker).filter(Boolean))].indexOf(id) + 1 });
  const selectedId = selected?.run.id ?? "";
  const copyText = viewMode === "enhanced" ? selected?.summary?.text || fallbackText.enhanced
    : viewMode === "transcript" ? selected?.transcript?.text || fallbackText.transcript
    : fallbackText.raw;
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [viewMode]);
  const copyView = async () => {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      notify(t("meetingResults.copyError", { defaultValue: "Couldn't copy to the clipboard." }), "destructive");
    }
  };

  const allRuns = parts.flatMap((part) => part.runs);
  const combinedCurrent = allRuns.find((item) => item.run.kind === "reprocess" && item.run.sourceRecordingIds.length > 1 &&
    parts.some((part) => part.recording.currentRunId === item.run.id));
  const latestRun = allRuns.find((item) => item.run.id === runId)
    ?? combinedCurrent
    ?? [...allRuns].reverse().find((item) => parts.some((part) => part.recording.currentRunId === item.run.id));
  const availableParts = parts.filter((part) => part.recording.audioState === "available");

  const runTask = async (task: () => Promise<void>) => {
    setBusy(true);
    try { await task(); await refresh(); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), "destructive"); }
    finally { setBusy(false); }
  };

  const startAudio = async (id: string, seek = 0) => {
    if (playingId === id && audioRef.current && seek === 0) { audioRef.current.pause(); setPlayingId(null); return; }
    if (previewRecordings) { notify(tr("previewAudio", "Preview audio is unavailable.")); return; }
    if (!recordings.some((item) => item.recording.id === id && item.recording.audioState === "available")) return;
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

  /** Starts a run with the settings-selected providers; no per-run picker. */
  const openRun = (kind: "reprocess" | "summary", target: { partId?: string; groupId?: string } = {}) => {
    setAudioOpen(false);
    void createRun({ kind, ...target });
  };

  const createRun = (choice: RunChoice) => runTask(async () => {
    if (previewRecordings) { notify("Mock processing queued in memory"); return; }
    const snapshot = snapshotMeetingRecordingConfig();
    const sourceRunIdForKind = choice.kind === "summary"
      ? (selected?.run.kind === "summary" ? selected.run.sourceRunId ?? "" : selectedId)
      : "";
    const savedConfig = (choice.kind === "summary" ? versions.find((item) => item.run.id === sourceRunIdForKind) : selected)?.run.config;
    const baseConfig = snapshot.config ?? savedConfig;
    if (!baseConfig) throw new Error(snapshot.configError?.code || "processing-config-missing");
    const config: MeetingProcessingConfig = { ...baseConfig };
    const groupParts = choice.groupId ? groups.find((group) => group.id === choice.groupId)?.parts ?? [] : parts;
    const ids = choice.partId ? [choice.partId] : groupParts.filter((part) => part.recording.audioState === "available").map((part) => part.recording.id);
    if (choice.kind === "reprocess") {
      if (!ids.length) throw new Error("meeting-audio-unavailable");
    } else {
      if (!sourceRunIdForKind) throw new Error("summary-transcript-missing");
      const source = versions.find((item) => item.run.id === sourceRunIdForKind);
      if (!source) throw new Error("summary-transcript-missing");
      config.transcription = source.run.config?.transcription ?? config.transcription;
      if (!config.summary) config.summary = { instruction: builtinMeetingSummaryInstruction(), reasoningMode: "providers" };
    }
    const source = choice.kind === "summary" ? versions.find((item) => item.run.id === sourceRunIdForKind) : null;
    const result = await window.electronAPI.meetingProcessingCreateRun({
      recordingId: source?.run.recordingId ?? ids[0],
      sourceRecordingIds: choice.kind === "reprocess" ? ids : undefined,
      kind: choice.kind,
      config,
      configError: null,
      sourceRunId: choice.kind === "summary" ? sourceRunIdForKind : undefined,
    });
    if (!result.success || !result.result) throw new Error(result.error || t("meetingResults.createError"));
    setRunId(result.result.run.id);
    onViewModeChange(choice.kind === "summary" ? "enhanced" : "transcript");
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

  const exportPart = (id: string) => runTask(async () => {
    if (previewRecordings) { notify(tr("previewAudio", "Preview audio is unavailable.")); return; }
    const result = await window.electronAPI.meetingRecordingExportAudio({ recordingId: id, source: "mixed" });
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
            detail: dateLabel(item.run.createdAt, locale, { dateStyle: "short", timeStyle: "short" }, dateFormat, timeFormat),
          })),
        }}
      />
      <IconTooltip label={copied ? tr("copied", "Copied") : tr("copyView", "Copy")}>
        <Button size="sm" variant="ghost" isIconOnly className="size-7 min-h-7 text-muted hover:text-foreground" isDisabled={!copyText.trim()} aria-label={copied ? tr("copied", "Copied") : tr("copyView", "Copy")} onPress={() => void copyView()}>
          {copied ? <Check size={15}/> : <Copy size={15}/>}
        </Button>
      </IconTooltip>
      <div className="ms-auto flex flex-wrap items-center gap-1.5">
      <Popover isOpen={audioOpen} onOpenChange={setAudioOpen}>
        <IconTooltip label={tr("audioParts", "Audio")}><Button size="sm" variant="tertiary" isIconOnly className="relative overflow-visible" aria-label={`${tr("audioParts", "Audio")} ${audioCount}`}><AudioLines size={16}/>{audioCount > 0 && <span key={audioCount} className="absolute -end-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-3xs font-semibold text-accent-foreground motion-safe:animate-in motion-safe:zoom-in-50 motion-safe:duration-200">{audioCount}</span>}</Button></IconTooltip>
        <Popover.Content placement="bottom end" className="w-[320px] max-w-[calc(100vw-24px)]"><Popover.Dialog className="flex max-h-[min(420px,70vh)] flex-col p-3">
          <Popover.Heading className="text-sm font-semibold">{tr("audioParts", "Audio")}</Popover.Heading>
          <div className="min-h-0 flex-1 overflow-y-auto">
          {!audioGroups.length && <p className="mt-2 text-muted">{tr("noAudioParts", "Audio parts appear here after recording.")}</p>}
          {displayedGroups.map((group, groupIndex) => {
            const date = dateLabel(group.parts[0].recording.startedAt, locale, { dateStyle: "medium" }, dateFormat, timeFormat);
            const previousDate = groupIndex > 0
              ? dateLabel(displayedGroups[groupIndex - 1].parts[0].recording.startedAt, locale, { dateStyle: "medium" }, dateFormat, timeFormat)
              : null;
            return <section key={group.id} className="mt-2">
            {date !== previousDate && <span className="text-xs font-medium text-muted">{date}</span>}
          {group.parts.map((part, index) => <div className="flex items-center gap-2 border-b border-border py-1.5 last:border-0" key={part.recording.id}>
            <Button isIconOnly size="sm" variant="ghost" isDisabled={part.recording.audioState !== "available"} aria-label={playingId === part.recording.id ? tr("pauseAudio", "Pause audio") : tr("playAudio", "Play audio")} onPress={() => void startAudio(part.recording.id)}>{playingId === part.recording.id ? <Pause size={16}/> : <Play size={16}/>}</Button>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5"><strong className="text-sm font-medium">{dateLabel(part.recording.startedAt, locale, { timeStyle: "short" }, dateFormat, timeFormat)}</strong><span className="text-xs text-muted">{formatDuration(part.recording.durationSeconds)}{group.parts.length > 1 && ` · ${tr("part", "Part")} ${index + 1}`}</span></div>
            <Dropdown><Button isIconOnly size="sm" variant="ghost" aria-label={tr("partActions", "Audio part actions")}><MoreHorizontal size={17}/></Button><Dropdown.Popover><Dropdown.Menu aria-label={tr("partActions", "Audio part actions")} onAction={(key) => {
              if (key === "asr") openRun("reprocess", { partId: part.recording.id });
              if (key === "export") void exportPart(part.recording.id);
              if (key === "delete") deletePart(part.recording.id);
            }}>
              <Dropdown.Item id="asr" isDisabled={busy || part.recording.audioState !== "available"} textValue={t("meetingResults.newAsr")}><FileText size={14}/>{t("meetingResults.newAsr")}</Dropdown.Item>
              <Dropdown.Item id="export" isDisabled={busy || part.recording.audioState !== "available"} textValue={t("meetingResults.exportMixed")}><Download size={14}/>{t("meetingResults.exportMixed")}</Dropdown.Item>
              <Dropdown.Item id="delete" isDisabled={busy || part.recording.audioState === "deleted"} variant="danger" textValue={t(part.recording.audioErrorCode ? "meetingResults.retryDelete" : "meetingResults.deleteAudio")}><Trash2 size={14}/>{t(part.recording.audioErrorCode ? "meetingResults.retryDelete" : "meetingResults.deleteAudio")}</Dropdown.Item>
            </Dropdown.Menu></Dropdown.Popover></Dropdown>
          </div>)}
          </section>})}
          </div>
          {latestAudioGroup?.parts.some((part) => part.recording.audioState === "available") && <Button size="sm" variant="secondary" className="mt-2 w-full gap-1.5" isDisabled={busy} onPress={() => openRun("reprocess", { groupId: latestAudioGroup.id })}><MessageSquareText size={13}/>{tr("processWholeMeeting", "Transcribe")}</Button>}
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
          if (key === "export") void runTask(async () => { if (previewRecordings) { notify(tr("previewAudio", "Preview audio is unavailable.")); return; } const result = await window.electronAPI.meetingRecordingExportAudio({ recordingId: selected.run.recordingId, runId: selected.run.kind === "summary" ? selected.run.sourceRunId ?? undefined : selected.run.id, source: "mixed" }); if (!result.success) throw new Error(result.error || t("meetingResults.exportError")); });
        }}>
          <Dropdown.Item id="asr" isDisabled={!availableParts.length} textValue={t("meetingResults.newAsr")}>{t("meetingResults.newAsr")}</Dropdown.Item>
          <Dropdown.Item id="summary" textValue={t("meetingResults.newSummary")}>{t("meetingResults.newSummary")}</Dropdown.Item>
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

    <Modal isOpen={speakerId !== null} onOpenChange={(open) => { if (!open) setSpeakerId(null); }}><Modal.Backdrop><Modal.Container size="sm"><Modal.Dialog><Modal.CloseTrigger/><Modal.Header><Modal.Heading>{t("meetingResults.saveSpeaker")}</Modal.Heading></Modal.Header><Modal.Body className="flex flex-col gap-4">
      <label className="flex flex-col gap-2 text-xs">{tr("speakerName", "Speaker name")}<input dir="auto" className="h-9 rounded-lg px-3 text-sm" value={speakerName} onChange={(event) => setSpeakerName(event.target.value)} /></label>
      <Choice label={t("meetingResults.speakerProfile")} value={speakerProfileId} options={[{ id: "none", label: t("meetingResults.noSpeakerProfile") }, ...profiles.map((item) => ({ id: String(item.id), label: item.display_name }))]} onChange={setSpeakerProfileId}/>
    </Modal.Body><Modal.Footer><Button variant="tertiary" onPress={() => setSpeakerId(null)}>{tr("cancel", "Cancel")}</Button><Button isDisabled={!speakerName.trim() || busy} onPress={() => void correctSpeaker()}>{t("meetingResults.saveSpeaker")}</Button></Modal.Footer></Modal.Dialog></Modal.Container></Modal.Backdrop></Modal>
    <ConfirmDialog open={confirmDialog.open} onOpenChange={(open) => !open && hideConfirmDialog()} title={confirmDialog.title} description={confirmDialog.description} confirmText={confirmDialog.confirmText} cancelText={confirmDialog.cancelText} onConfirm={confirmDialog.onConfirm} variant={confirmDialog.variant} />
  </div>;
}
