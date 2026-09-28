import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import ReactMarkdown from "react-markdown";
import { Button, Dropdown, Label, ListBox, Modal, Popover, Select } from "@heroui/react";
import { useTranslation } from "react-i18next";
import { AlignLeft, ArrowLeft, ArrowRight, AudioLines, Check, ChevronDown, Copy, Download, FileText, MessageSquareText, MoreHorizontal, Play, Sparkles, Trash2, WandSparkles } from "../icons";
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
import { ProviderIcon } from "../ui/ProviderIcon";
import { IconTooltip } from "../ui/IconTooltip";
import { cn } from "../lib/utils";
import { formatDate, formatTime, type DateFormat, type TimeFormat } from "../../utils/dateFormatting";
import { useDateTimePreferences } from "../../hooks/useDateTimePreferences";
import { composeMockSummary, type MockPipeline } from "./meetingMock";

type ViewMode = "raw" | "enhanced";
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

/** "42 s", "8 min 56 s", "1 h 5 min": readable at a glance, unlike mm:ss. */
function formatDuration(duration: number, tr: (key: string, fallback: string, values?: Record<string, number>) => string) {
  const total = Math.max(0, Math.round(duration));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return tr("durationHours", "{{hours}} h {{minutes}} min", { hours, minutes });
  if (minutes > 0 && seconds === 0) return tr("durationWholeMinutes", "{{minutes}} min", { minutes });
  if (minutes > 0) return tr("durationMinutes", "{{minutes}} min {{seconds}} s", { minutes, seconds });
  return tr("durationSeconds", "{{seconds}} s", { seconds });
}

/** Time range plus what the part is: live, saving, its length, and where it sits in the session. */
function AudioPartSummary({ part, index, count, timeLabel, tr }: {
  part: MeetingProcessingRecordingResult["recording"];
  index: number;
  count: number;
  timeLabel: (value: string) => string;
  tr: (key: string, fallback: string, values?: Record<string, number>) => string;
}) {
  const live = part.captureState === "recording";
  const ended = part.endedAt && part.endedAt >= part.startedAt ? part.endedAt : null;
  const range = ended ? `${timeLabel(part.startedAt)} – ${timeLabel(ended)}` : timeLabel(part.startedAt);
  const details = [
    live
      ? tr("recordingNow", "Recording now")
      : part.captureState === "finalizing"
        ? tr("savingAudio", "Saving…")
        : part.durationSeconds !== null ? formatDuration(part.durationSeconds, tr) : null,
    part.captureState === "incomplete" ? tr("endedEarly", "Ended early") : null,
    count > 1 ? tr("partOf", "Part {{index}} of {{count}}", { index: index + 1, count }) : null,
  ].filter(Boolean);
  return <div className="flex min-w-0 flex-1 flex-col gap-0.5">
    <strong className="truncate text-sm font-medium tabular-nums">{range}</strong>
    <span className={cn("flex min-w-0 items-center gap-1.5 text-xs", live ? "text-danger" : "text-muted")}>
      {live && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-danger motion-safe:animate-pulse" />}
      <span className="truncate">{details.join(" · ")}</span>
    </span>
  </div>;
}

export default function MeetingResultsPanel({ noteId, locale, previewRecordings, viewMode, onViewModeChange, manualContent, renderFallbackTranscript, fallbackSummary, fallbackText, actions, notice, capturePhase, mockPipeline }: {
  /** Debug preview only: in-memory stand-in for the delayed-ASR, naming, tasks and Recap pipeline. */
  mockPipeline?: MockPipeline;
  actions?: ReactNode;
  /** Plain text of each view's fallback content, copied when no processing run provides it. */
  fallbackText: Record<ViewMode | "transcript", string>;
  /** Live capture notice rendered under the toolbar, above processing status. */
  notice?: ReactNode;
  noteId: number;
  capturePhase?: "idle" | "preparing" | "recording" | "paused" | "saving" | "saved" | "incomplete" | "failed";
  locale: string;
  previewRecordings?: MeetingProcessingRecordingResult[];
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  manualContent: ReactNode;
  renderFallbackTranscript: (scrollRef: RefObject<HTMLDivElement | null>) => ReactNode;
  fallbackSummary: ReactNode;
}) {
  const { t } = useTranslation();
  const { dateFormat, timeFormat } = useDateTimePreferences();
  const tr = (key: string, fallback: string, values?: Record<string, number>) => t(`meetingResults.${key}`, { defaultValue: fallback, ...values });
  const [recordings, setRecordings] = useState(previewRecordings ?? []);
  const [runId, setRunId] = useState("");
  const [audioOpen, setAudioOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [popoverTab, setPopoverTab] = useState<"transcript" | "audio">("transcript");
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
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
  const [mock, setMock] = useState(mockPipeline);
  useEffect(() => setMock(mockPipeline), [mockPipeline]);
  const patchMock = useCallback((patch: Partial<MockPipeline>) => setMock((current) => current && { ...current, ...patch }), []);
  const mockTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(mockTimer.current), []);
  const mockGateActive = mock?.waitingSeconds !== undefined && mock.waitingSeconds > 0;
  useEffect(() => {
    if (!mockGateActive) return;
    const id = window.setInterval(() => setMock((current) => {
      if (!current?.waitingSeconds) return current;
      const left = current.waitingSeconds - 1;
      return left > 0 ? { ...current, waitingSeconds: left } : { ...current, waitingSeconds: undefined, asrRunning: true };
    }), 1000);
    return () => window.clearInterval(id);
  }, [mockGateActive]);
  useEffect(() => {
    if (!mock?.asrRunning) return;
    const id = window.setTimeout(() => setMock((current) => current?.asrRunning
      ? { ...current, asrRunning: false, namingRunning: true }
      : current), 1500);
    return () => window.clearTimeout(id);
  }, [mock?.asrRunning]);
  const mockAfter = (ms: number, patch: Partial<MockPipeline>) => {
    window.clearTimeout(mockTimer.current);
    mockTimer.current = window.setTimeout(() => patchMock(patch), ms);
  };
  const [speakerId, setSpeakerId] = useState<string | null>(null);
  const [speakerName, setSpeakerName] = useState("");
  const [speakerProfileId, setSpeakerProfileId] = useState("none");
  const [profiles, setProfiles] = useState<Array<{ id: number; display_name: string }>>([]);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [playbackDuration, setPlaybackDuration] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);
  const seekBarRef = useRef<HTMLDivElement>(null);
  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => { if (!isSeeking) setPlaybackTime(audio.currentTime); };
    const onMeta = () => setPlaybackDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    const onEnd = () => { setPlaybackTime(0); setPlayingId(null); };
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("durationchange", onMeta);
    audio.addEventListener("ended", onEnd);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("durationchange", onMeta);
      audio.removeEventListener("ended", onEnd);
    };
  }, [isSeeking]);

  const playingRecording = useMemo(
    () => recordings.find((item) => item.recording.id === playingId) ?? null,
    [recordings, playingId]
  );

  const seekTo = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const clamped = Math.max(0, Math.min(seconds, Number.isFinite(audio.duration) ? audio.duration : seconds));
    audio.currentTime = clamped;
    setPlaybackTime(clamped);
  };
  const skip = (delta: number) => seekTo(playbackTime + delta);

  const onSeekBarPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const bar = seekBarRef.current;
    const audio = audioRef.current;
    if (!bar || !audio) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    setIsSeeking(true);
    seekTo(ratio * (Number.isFinite(audio.duration) ? audio.duration : 0));
    bar.setPointerCapture(event.pointerId);
  };
  const onSeekBarPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isSeeking) return;
    const bar = seekBarRef.current;
    const audio = audioRef.current;
    if (!bar || !audio) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    seekTo(ratio * (Number.isFinite(audio.duration) ? audio.duration : 0));
  };
  const onSeekBarPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    setIsSeeking(false);
    seekBarRef.current?.releasePointerCapture(event.pointerId);
  };
  const togglePlay = () => {
    if (!audioRef.current || !playingId) return;
    if (audioRef.current.paused) {
      void audioRef.current.play().catch(() => notify(t("meetingResults.playbackError"), "destructive"));
    } else {
      audioRef.current.pause();
    }
  };

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
  const latestGroup = groups[groups.length - 1];
  const recordedRuns = recordings.flatMap((part) => part.runs);
  const versions = useMemo(() => recordings.flatMap((part) => part.runs).filter((item) => item.transcript).sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt)), [recordings]);
  const selected = versions.find((item) => item.run.id === runId)
    ?? versions.find((item) => recordings.some((part) => part.recording.currentRunId === item.run.id))
    ?? versions[0];
  const displayedRun = recordedRuns.find((item) => item.run.id === runId)?.run ?? selected?.run;
  const currentGroup = recordings.find((item) => item.recording.id === displayedRun?.recordingId)?.recording.groupId ?? latestGroup?.id;
  const selectedSourceIds = displayedRun?.sourceRecordingIds ?? [];
  const parts = selectedSourceIds.length > 1
    ? recordings.filter((item) => selectedSourceIds.includes(item.recording.id)).sort((a, b) => a.recording.startedAt.localeCompare(b.recording.startedAt))
    : groups.find((group) => group.id === currentGroup)?.parts ?? [];
  const speakerLabel = (id: string) => t("meetingResults.speakerNumber", { defaultValue: "Speaker {{number}}", number: [...new Set(selected?.transcript?.segments?.map((segment) => segment.speaker).filter(Boolean))].indexOf(id) + 1 });
  const selectedId = selected?.run.id ?? "";
  const savedSummary = selected?.summary?.text;
  const summaryText = savedSummary && mock ? composeMockSummary(savedSummary, mock.tasks, mock.recap) : savedSummary;
  const copyText = viewMode === "enhanced" ? summaryText || fallbackText.enhanced : fallbackText.raw;
  const transcriptCopyText = selected?.transcript?.text || fallbackText.transcript;
  const [copied, setCopied] = useState(false);
  const [transcriptCopied, setTranscriptCopied] = useState(false);
  const copyTranscript = async () => {
    try {
      await navigator.clipboard.writeText(transcriptCopyText);
      setTranscriptCopied(true);
      window.setTimeout(() => setTranscriptCopied(false), 1500);
    } catch {
      notify(t("meetingResults.copyError", { defaultValue: "Couldn't copy to the clipboard." }), "destructive");
    }
  };
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
  const [countdownNow, setCountdownNow] = useState(Date.now());
  const gateDeadline = !previewRecordings && latestRun?.run.status === "pending" &&
    (latestRun.run.kind === "initial" || latestRun.run.kind === "reprocess") &&
    latestRun.run.stage === "prepare" && latestRun.run.retryCount === 0 &&
    latestRun.run.errorCode === null && latestRun.run.retryAt
    ? Date.parse(latestRun.run.retryAt)
    : null;
  useEffect(() => {
    if (gateDeadline === null) return;
    setCountdownNow(Date.now());
    const id = window.setInterval(() => setCountdownNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [gateDeadline]);
  const liveWaitingSeconds = gateDeadline === null ? 0 : Math.max(0, Math.ceil((gateDeadline - countdownNow) / 1000));
  const gateSeconds = mockGateActive ? mock?.waitingSeconds ?? 0 : liveWaitingSeconds;
  const gateActive = gateSeconds > 0;

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
  const openRun = (kind: "reprocess" | "summary", target: { partId?: string } = {}) => {
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
    const ids = choice.partId ? [choice.partId] : recordings
      .filter((part) => part.recording.audioState === "available" && ["ready", "incomplete"].includes(part.recording.captureState))
      .sort((a, b) => a.recording.startedAt.localeCompare(b.recording.startedAt))
      .map((part) => part.recording.id);
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
    if (choice.kind === "summary") onViewModeChange("enhanced");
    else { setPopoverTab("transcript"); setAudioOpen(true); }
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
      setSpeakerId(null);
      setMock((current) => current && { ...current, modelSpeakerIds: current.modelSpeakerIds?.filter((id) => id !== speakerId), summaryStale: Boolean(summaryText) });
      return;
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

  const transcriptContent = selected?.transcript ? <div>
        {selected.transcript.segments?.length ? (() => {
          // Cumulative offsets per recording part so we can drop a header in
          // front of the first segment of each part beyond the first one.
          const partBoundaries: number[] = [];
          let cumulative = 0;
          for (let i = 0; i < selected.run.sourceRecordingIds.length; i++) {
            if (i > 0) partBoundaries.push(cumulative);
            const id = selected.run.sourceRecordingIds[i];
            const part = parts.find((item) => item.recording.id === id);
            cumulative += part?.recording.durationSeconds ?? 0;
          }
          return selected.transcript.segments!.map((segment, index) => {
            const isPartStart = partBoundaries.includes(segment.start);
            const partIndex = isPartStart ? partBoundaries.indexOf(segment.start) : -1;
            const partId = isPartStart ? selected.run.sourceRecordingIds[partIndex + 1] : null;
            const partRecord = partId ? parts.find((item) => item.recording.id === partId)?.recording : null;
            return <div key={`${index}-${segment.start}`}>
              {isPartStart && partRecord && (
                <div className="mt-6 flex items-center gap-3 border-t border-border pt-3 text-xs text-muted">
                  <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-primary" />
                  <span className="font-medium text-foreground">
                    {tr("partHeader", "Part {{index}}", { index: partIndex + 2 })}
                  </span>
                  <span className="tabular-nums">
                    {dateLabel(partRecord.startedAt, locale, { timeStyle: "short" }, dateFormat, timeFormat)}
                  </span>
                  {partRecord.durationSeconds != null && (
                    <span className="text-2xs">· {formatDuration(partRecord.durationSeconds, tr)}</span>
                  )}
                </div>
              )}
              <div className={`${index === 0 || isPartStart ? "mt-2" : "mt-3"} grid grid-cols-[44px_minmax(0,1fr)] items-baseline gap-x-3`}>
                <button className="rounded py-1 text-start font-mono text-xs tabular-nums text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus" onClick={() => {
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
                }}>{selected.speakerCorrections.find((item) => item.speakerId === segment.speaker)?.displayName ?? speakerLabel(segment.speaker)}</button>}{segment.speaker && mock?.modelSpeakerIds?.includes(segment.speaker) && <span className="ms-1.5 rounded bg-accent-soft px-1 py-px align-middle text-3xs font-medium text-primary" title={tr("autoNameHint", "Suggested from the conversation. Click the name to change it.")}>{tr("autoName", "auto")}</span>}<p className="mt-0.5 whitespace-pre-wrap text-sm leading-relaxed text-muted">{segment.text}</p></div>
              </div>
            </div>;
          });
        })() : <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted">{selected.transcript.text}</p>}

  </div> : renderFallbackTranscript(transcriptScrollRef);

  return <div className="@container mx-auto w-full max-w-[880px] px-[clamp(20px,5vw,54px)] max-[720px]:px-5 pt-4 pb-8 max-[720px]:pb-16">    <div className="sticky top-0 z-10 -mt-4 mb-3 flex items-center justify-between gap-2 bg-background pt-4 pb-3 max-[720px]:flex-wrap">
      <NoteViewSwitch
        value={viewMode}
        onChange={onViewModeChange}
        ariaLabel={tr("contentTabs", "Meeting content")}
        options={[
          { id: "raw", label: t("notes.editor.notes"), icon: AlignLeft },
          { id: "enhanced", label: tr("summaryTab", "Summary"), icon: Sparkles },
        ]}
      />
      <div className="ms-auto flex flex-wrap items-center gap-1.5">
      <Popover isOpen={audioOpen} onOpenChange={setAudioOpen}>
        <IconTooltip label={tr("transcriptAndAudio", "Transcript and audio")}><Button size="sm" variant="tertiary" isIconOnly className="relative overflow-visible" aria-label={`${tr("transcriptAndAudio", "Transcript and audio")} ${audioCount}`}><AudioLines size={16}/>{audioCount > 0 && <span key={audioCount} className="absolute -end-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-3xs font-semibold text-accent-foreground motion-safe:animate-in motion-safe:zoom-in-50 motion-safe:duration-200">{audioCount}</span>}</Button></IconTooltip>
        <Popover.Content placement="bottom end" className="w-[440px] max-w-[calc(100vw-24px)]"><Popover.Dialog className="flex max-h-[min(520px,calc(100vh-160px))] flex-col p-3">
          <div className="mb-2 flex items-center gap-2">
            <Popover.Heading className="sr-only">{tr("transcriptAndAudio", "Transcript and audio")}</Popover.Heading>
            <NoteViewSwitch
              value={popoverTab}
              onChange={setPopoverTab}
              ariaLabel={tr("transcriptAndAudio", "Transcript and audio")}
              options={[
                { id: "transcript", label: t("notes.editor.transcript"), icon: MessageSquareText },
                { id: "audio", label: tr("audioParts", "Audio"), icon: AudioLines },
              ]}
            />
            {popoverTab === "transcript" && <IconTooltip label={transcriptCopied ? tr("copied", "Copied") : tr("copyView", "Copy")}>
              <Button size="sm" variant="ghost" isIconOnly className="ms-auto size-7 min-h-7 text-muted hover:text-foreground" isDisabled={!transcriptCopyText.trim()} aria-label={tr("copyView", "Copy")} onPress={() => void copyTranscript()}>
                {transcriptCopied ? <Check size={15}/> : <Copy size={15}/>}
              </Button>
            </IconTooltip>}
          </div>
          {popoverTab === "transcript" && <div ref={transcriptScrollRef} className="min-h-0 flex-1 overflow-y-auto">{transcriptContent}</div>}
          {popoverTab === "audio" && <>
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
            <AudioPartSummary part={part.recording} index={index} count={group.parts.length} timeLabel={(value) => dateLabel(value, locale, { timeStyle: "short" }, dateFormat, timeFormat)} tr={tr} />
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
          {audioGroups.some((group) => group.parts.some((part) => part.recording.audioState === "available" && ["ready", "incomplete"].includes(part.recording.captureState))) && <Button size="sm" variant="secondary" className="mt-2 w-full shrink-0 gap-1.5" isDisabled={busy} onPress={() => openRun("reprocess")}><MessageSquareText size={13}/>{tr("processWholeMeeting", "Transcribe")}</Button>}
          </>}
        </Popover.Dialog></Popover.Content>
      </Popover>
      {actions}
      </div>
    </div>

    {notice}
    {gateActive && <NoteNotice
      status="accent"
      busy
      title={tr("gateWaiting", "Transcription starts in {{seconds}} s", { seconds: gateSeconds })}
      description={tr("gateWaitingReason", "The recording is saved. Resume it to continue the meeting; transcription starts automatically when the wait ends.")}
      actions={mock ? <Button size="sm" variant="secondary" onPress={() => { patchMock({ waitingSeconds: undefined }); notify("Mock: recording resumed, pending transcription cancelled"); }}>{tr("resumeRecording", "Resume recording")}</Button> : undefined}
    />}
    {mock?.asrRunning && !gateActive && <NoteNotice status="accent" busy title={`${tr("transcribing", "Transcribing audio")}…`} description={tr("transcribingReason", "The finalized recording is being transcribed.")} />}
    {mock?.namingRunning && !gateActive && <NoteNotice status="accent" busy title={`${tr("namingSpeakers", "Identifying speakers")}…`} description={tr("namingSpeakersReason", "Speaker names are proposed from the conversation. You can correct them afterwards.")} />}
    {latestRun?.run.status === "cancelled" && latestRun.run.errorCode === "meeting-resumed" && <NoteNotice status="default" title={tr("gateCancelled", "Transcription delayed again")} description={tr("gateCancelledReason", "The meeting resumed. Transcription will start 15 seconds after its next successful Stop.")} />}
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
      const startedAt = latestRun.run.createdAt ? Date.parse(latestRun.run.createdAt) : undefined;
      return <NoteNotice status="accent" busy progressStartedAt={startedAt} title={`${t(`meetingResults.stage.${stage}`)}…`} description={t(status === "pending" ? "meetingResults.progress.pending" : "meetingResults.progress.running")} />;
    })()}

    <div key={viewMode} className="[&_.rich-text-editor-content]:pb-2! motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200 motion-safe:slide-in-from-bottom-1">
    {viewMode === "raw" ? <div>
      {manualContent}
      {copyText.trim() && <div className="mt-3 flex justify-start">
        <IconTooltip label={copied ? tr("copied", "Copied") : tr("copyView", "Copy")}>
          <Button size="sm" variant="ghost" isIconOnly className="size-7 min-h-7 text-muted hover:text-foreground" isDisabled={!copyText.trim()} aria-label={copied ? tr("copied", "Copied") : tr("copyView", "Copy")} onPress={() => void copyView()}>
            {copied ? <Check size={15}/> : <Copy size={15}/>}
          </Button>
        </IconTooltip>
      </div>}
    </div> : <div>
      {selected && (viewMode !== "enhanced" || summaryText) && <div className="flex items-center">
        <Popover isOpen={modelOpen} onOpenChange={setModelOpen}>
          <Button size="sm" variant="ghost" className="-ms-2 h-7 min-h-7 max-w-full gap-1.5 px-2 text-xs text-muted hover:text-foreground" aria-label={tr("resultActions", "Result actions")}>
            <ProviderIcon provider={selected.run.config?.summary?.provider ?? ""} className="size-3.5 shrink-0" />
            <span className="truncate">{selected.run.config?.summary?.provider} · {selected.run.config?.summary?.model}</span>
            <ChevronDown size={13} className="shrink-0"/>
          </Button>
          <Popover.Content placement="bottom start" className="w-fit min-w-0 max-w-[calc(100vw-24px)]"><Popover.Dialog className="p-1">
            <div className="flex flex-col gap-1">
              <Button size="sm" variant="ghost" className="justify-start gap-2" onPress={() => { setModelOpen(false); openRun("summary"); }}><WandSparkles size={14}/>{t("meetingResults.newSummary")}</Button>
              <Button size="sm" variant="ghost" className="justify-start gap-2" isDisabled={!availableParts.length} onPress={() => { setModelOpen(false); openRun("reprocess"); }}><FileText size={14}/>{t("meetingResults.newAsr")}</Button>
              {mock && <Button size="sm" variant="ghost" className="justify-start gap-2" isDisabled={mock.recap === "running" || !summaryText} onPress={() => { setModelOpen(false); patchMock({ recap: "running" }); mockAfter(1500, { recap: "ok" }); }}><AlignLeft size={14}/>{mock.recap === "ok" ? tr("updateRecap", "Update recap") : tr("newRecap", "New recap")}</Button>}
            </div>
          </Popover.Dialog></Popover.Content>
        </Popover>
      </div>}
      {mock && summaryText && <MockSummaryNotices mock={mock} onRegenerate={() => { notify("Mock: Summary regenerated with the new names"); patchMock({ summaryStale: false }); }} />}
      {summaryText ? <article className="note-prose"><ReactMarkdown>{summaryText}</ReactMarkdown></article> : <>
        {mock?.autoSummarySkipped && <NoteNotice status="accent" title={tr("autoSummarySkipped", "Automatic Summary skipped")} description={tr("autoSummarySkippedReason", "This meeting is short ({{seconds}} s, {{chars}} characters). Automatic Summary starts after 180 s and 2500 characters. You can create one now.", mock.autoSummarySkipped)} />}
        {fallbackSummary}
      </>}
      {mock && summaryText && <MockTaskNotices tasks={mock.tasks} notify={notify} onRetry={() => { patchMock({ tasks: "loading" }); mockAfter(1500, { tasks: "ok" }); }} />}
      {copyText.trim() && <div className="mt-3 flex justify-start">
        <IconTooltip label={copied ? tr("copied", "Copied") : tr("copyView", "Copy")}>
          <Button size="sm" variant="ghost" isIconOnly className="size-7 min-h-7 text-muted hover:text-foreground" isDisabled={!copyText.trim()} aria-label={copied ? tr("copied", "Copied") : tr("copyView", "Copy")} onPress={() => void copyView()}>
            {copied ? <Check size={15}/> : <Copy size={15}/>}
          </Button>
        </IconTooltip>
      </div>}
    </div>}
    </div>
    {message && <NoteNotice status="default" title={message} />}
    {playingRecording && (
      <AudioPlayer
        audioRef={audioRef}
        recording={playingRecording.recording}
        currentTime={playbackTime}
        duration={playbackDuration}
        seekBarRef={seekBarRef}
        onTogglePlay={togglePlay}
        onSkip={skip}
        onSeekBarPointerDown={onSeekBarPointerDown}
        onSeekBarPointerMove={onSeekBarPointerMove}
        onSeekBarPointerUp={onSeekBarPointerUp}
        tr={tr}
        t={t}
        locale={locale}
        dateFormat={dateFormat}
        timeFormat={timeFormat}
      />
    )}
    <audio ref={audioRef} preload="metadata" onEnded={() => { setPlayingId(null); setPlaybackTime(0); }} />

    <Modal isOpen={speakerId !== null} onOpenChange={(open) => { if (!open) setSpeakerId(null); }}><Modal.Backdrop><Modal.Container size="sm"><Modal.Dialog><Modal.CloseTrigger/><Modal.Header><Modal.Heading>{t("meetingResults.saveSpeaker")}</Modal.Heading></Modal.Header><Modal.Body className="flex flex-col gap-4">
      <label className="flex flex-col gap-2 text-xs">{tr("speakerName", "Speaker name")}<input dir="auto" className="h-9 rounded-lg px-3 text-sm" value={speakerName} onChange={(event) => setSpeakerName(event.target.value)} /></label>
      <Choice label={t("meetingResults.speakerProfile")} value={speakerProfileId} options={[{ id: "none", label: t("meetingResults.noSpeakerProfile") }, ...profiles.map((item) => ({ id: String(item.id), label: item.display_name }))]} onChange={setSpeakerProfileId}/>
    </Modal.Body><Modal.Footer><Button variant="tertiary" onPress={() => setSpeakerId(null)}>{tr("cancel", "Cancel")}</Button><Button isDisabled={!speakerName.trim() || busy} onPress={() => void correctSpeaker()}>{t("meetingResults.saveSpeaker")}</Button></Modal.Footer></Modal.Dialog></Modal.Container></Modal.Backdrop></Modal>
    <ConfirmDialog open={confirmDialog.open} onOpenChange={(open) => !open && hideConfirmDialog()} title={confirmDialog.title} description={confirmDialog.description} confirmText={confirmDialog.confirmText} cancelText={confirmDialog.cancelText} onConfirm={confirmDialog.onConfirm} variant={confirmDialog.variant} />
  </div>;
}

function MockSummaryNotices({ mock, onRegenerate }: { mock: MockPipeline; onRegenerate: () => void }) {
  const { t } = useTranslation();
  if (!mock.summaryStale) return null;
  return <NoteNotice
    status="warning"
    title={t("meetingResults.summaryStale", { defaultValue: "Speaker names changed" })}
    description={t("meetingResults.summaryStaleReason", { defaultValue: "This Summary was written with the earlier names and is unchanged." })}
    actions={<Button size="sm" variant="secondary" onPress={onRegenerate}>{t("meetingResults.regenerateSummary", { defaultValue: "Regenerate Summary" })}</Button>}
  />;
}

function MockTaskNotices({ tasks, notify, onRetry }: { tasks: MockPipeline["tasks"]; notify: (text: string) => void; onRetry: () => void }) {
  const { t } = useTranslation();
  const tr = (key: string, fallback: string) => t(`meetingResults.${key}`, { defaultValue: fallback });
  const retry = <Button size="sm" variant="secondary" onPress={onRetry}>{tr("retryTasks", "Retry tasks")}</Button>;
  if (tasks === "loading") return <NoteNotice status="accent" busy title={`${tr("tasksRunning", "Prioritizing action items")}…`} description={tr("tasksRunningReason", "The Summary above is ready. Tasks will be sorted by priority.")} />;
  if (tasks === "error") return <NoteNotice status="danger" title={tr("tasksFailed", "Couldn't extract action items")} description={tr("tasksFailedReason", "The model reply didn't match the expected format. The Summary is unchanged.")} actions={retry} />;
  if (tasks === "format") return <NoteNotice status="warning" title={tr("tasksFormat", "Action items were found but not added")} description={tr("tasksFormatReason", "This Summary has no single “## Action Items” section, likely because of a custom prompt. The text is unchanged.")} actions={<>
    <Button size="sm" variant="secondary" onPress={() => notify("Mock: opens the Detailed Notes prompt")}>{tr("editPrompt", "Edit prompt")}</Button>{retry}</>} />;
  if (tasks === "conflict") return <NoteNotice status="warning" title={tr("tasksConflict", "Action items weren't applied")} description={tr("tasksConflictReason", "You edited this section while tasks were being prepared, so your text was kept.")} actions={retry} />;
  return null;
}

function AudioPlayer({
  audioRef,
  recording,
  currentTime,
  duration,
  seekBarRef,
  onTogglePlay,
  onSkip,
  onSeekBarPointerDown,
  onSeekBarPointerMove,
  onSeekBarPointerUp,
  tr,
  t,
  locale,
  dateFormat,
  timeFormat,
}: {
  audioRef: React.RefObject<HTMLAudioElement | null>;
  recording: { id: string; startedAt: string; endedAt: string | null; durationSeconds: number | null };
  currentTime: number;
  duration: number;
  seekBarRef: React.RefObject<HTMLDivElement | null>;
  onTogglePlay: () => void;
  onSkip: (delta: number) => void;
  onSeekBarPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onSeekBarPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onSeekBarPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
  tr: (key: string, fallback: string, values?: Record<string, number>) => string;
  t: (key: string, options?: { defaultValue?: string }) => string;
  locale: string;
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
}) {
  const effectiveDuration = duration > 0 ? duration : recording.durationSeconds ?? 0;
  const isPlaying = audioRef.current ? !audioRef.current.paused : false;
  const ratio = effectiveDuration > 0 ? Math.min(1, currentTime / effectiveDuration) : 0;
  const started = dateLabel(recording.startedAt, locale, { timeStyle: "short" }, dateFormat, timeFormat);
  return (
    <div className="sticky bottom-3 left-0 right-0 z-20 mx-auto mt-4 flex w-full max-w-[880px] flex-col gap-2 rounded-2xl border border-border bg-background/95 px-3 py-2 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="flex items-center gap-2">
        <IconTooltip label={tr("skipBack", "Back 15 seconds")}>
          <Button isIconOnly size="sm" variant="ghost" aria-label={tr("skipBack", "Back 15 seconds")} onPress={() => onSkip(-15)}>
            <span className="relative inline-flex items-center justify-center">
              <ArrowLeft size={14} />
              <span className="absolute -bottom-2 text-2xs font-semibold tabular-nums">15</span>
            </span>
          </Button>
        </IconTooltip>
        <IconTooltip label={isPlaying ? tr("pauseAudio", "Pause audio") : tr("playAudio", "Play audio")}>
          <Button isIconOnly size="sm" variant="secondary" aria-label={isPlaying ? tr("pauseAudio", "Pause audio") : tr("playAudio", "Play audio")} onPress={onTogglePlay}>
            {isPlaying ? <Pause size={16} /> : <Play size={16} />}
          </Button>
        </IconTooltip>
        <IconTooltip label={tr("skipForward", "Forward 15 seconds")}>
          <Button isIconOnly size="sm" variant="ghost" aria-label={tr("skipForward", "Forward 15 seconds")} onPress={() => onSkip(15)}>
            <span className="relative inline-flex items-center justify-center">
              <ArrowRight size={14} />
              <span className="absolute -bottom-2 text-2xs font-semibold tabular-nums">15</span>
            </span>
          </Button>
        </IconTooltip>
        <span className="tabular-nums text-xs text-muted">{formatClock(currentTime)}</span>
        <div
          ref={seekBarRef}
          role="slider"
          aria-label={t("meetingResults.seekAudio", { defaultValue: "Seek audio" })}
          aria-valuemin={0}
          aria-valuemax={Math.round(effectiveDuration)}
          aria-valuenow={Math.round(currentTime)}
          tabIndex={0}
          onPointerDown={onSeekBarPointerDown}
          onPointerMove={onSeekBarPointerMove}
          onPointerUp={onSeekBarPointerUp}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") { event.preventDefault(); onSkip(-5); }
            if (event.key === "ArrowRight") { event.preventDefault(); onSkip(5); }
          }}
          className="relative h-2 flex-1 cursor-pointer touch-none rounded-full bg-default"
        >
          <div className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${ratio * 100}%` }} />
          <div
            aria-hidden="true"
            className="absolute top-1/2 size-3 -translate-y-1/2 -translate-x-1/2 rounded-full border-2 border-primary bg-background shadow"
            style={{ left: `${ratio * 100}%` }}
          />
        </div>
        <span className="tabular-nums text-xs text-muted">{formatClock(effectiveDuration)}</span>
        <span className="hidden text-2xs text-muted @md:inline">· {started}</span>
      </div>
    </div>
  );
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}
