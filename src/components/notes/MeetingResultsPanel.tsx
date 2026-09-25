import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MeetingProcessingRecordingResult } from "../../contracts/meetingProcessing";
import type { MeetingProcessingResultDto } from "../../contracts/meetingRecording";
import { snapshotMeetingRecordingConfig } from "../../helpers/meetingRecordingConfigSnapshot";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/dialog";
import { useDialogs } from "../../hooks/useDialogs";

function formatVersionDate(value: string, locale: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(date);
}

function versionLabel(result: MeetingProcessingResultDto, locale: string): string {
  const { run } = result;
  const provider = run.provider || run.config?.transcription.local?.provider || "local";
  return `${provider} / ${run.model || run.config?.transcription.local?.model || "—"} · ${formatVersionDate(run.createdAt, locale)}`;
}

function newestRecording(recordings: MeetingProcessingRecordingResult[]): MeetingProcessingRecordingResult | null {
  return [...recordings].sort((a, b) =>
    b.recording.startedAt.localeCompare(a.recording.startedAt) || b.recording.id.localeCompare(a.recording.id)
  )[0] ?? null;
}

function latestTranscript(recording: MeetingProcessingRecordingResult): MeetingProcessingResultDto | null {
  return recording.runs.find((item) => item.run.id === recording.recording.currentRunId && item.transcript)
    ?? [...recording.runs]
      .filter((item) => item.transcript)
      .sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt))[0]
    ?? null;
}

export default function MeetingResultsPanel({
  noteId,
  locale,
  previewRecordings,
}: {
  noteId: number;
  locale: string;
  previewRecordings?: MeetingProcessingRecordingResult[];
}) {
  const { t } = useTranslation();
  const [recordings, setRecordings] = useState<MeetingProcessingRecordingResult[]>(previewRecordings ?? []);
  const [selectedRecordingId, setSelectedRecordingId] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<string>("");
  const [playbackUrl, setPlaybackUrl] = useState<string>("");
  const [message, setMessage] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
  const [speakerProfileIds, setSpeakerProfileIds] = useState<Record<string, number | null>>({});
  const [speakerProfiles, setSpeakerProfiles] = useState<Array<{ id: number; display_name: string }>>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const selectedRecordingIdRef = useRef("");
  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();

  const refresh = useCallback(async () => {
    if (previewRecordings) return;
    const result = await window.electronAPI.meetingProcessingListForNote(noteId);
    if (!result.success) {
      setMessage(result.error || t("meetingResults.loadError"));
      return;
    }
    const next = result.recordings ?? [];
    setRecordings(next);
    const selectedRecording = next.find((item) => item.recording.id === selectedRecordingIdRef.current)
      ?? newestRecording(next);
    selectedRecordingIdRef.current = selectedRecording?.recording.id ?? "";
    setSelectedRecordingId(selectedRecordingIdRef.current);
    if (!selectedRecording) {
      setSelectedRunId("");
      return;
    }
    const currentTranscript = selectedRecording.runs.find((item) =>
      item.run.id === selectedRecording.recording.currentRunId && item.transcript
    );
    const preferred = currentTranscript ?? latestTranscript(selectedRecording);
    setSelectedRunId((selected) =>
      currentTranscript?.run.id ?? (selectedRecording.runs.some((item) => item.run.id === selected && item.transcript)
        ? selected
        : preferred?.run.id ?? "")
    );
  }, [noteId, previewRecordings, t]);

  useEffect(() => {
    if (previewRecordings) return;
    void refresh();
    const unsubscribe = window.electronAPI.onMeetingProcessingUpdated(() => void refresh());
    return unsubscribe;
  }, [previewRecordings, refresh]);

  useEffect(() => {
    if (previewRecordings) return;
    void window.electronAPI.getSpeakerProfiles?.().then((profiles) => {
      setSpeakerProfiles((profiles ?? []).map((profile) => ({ id: profile.id, display_name: profile.display_name })));
    });
  }, [previewRecordings]);

  const currentRecording = useMemo(
    () => recordings.find((item) => item.recording.id === selectedRecordingId) ?? newestRecording(recordings),
    [recordings, selectedRecordingId]
  );
  const selected = useMemo(() => {
    if (!currentRecording) return null;
    const result = currentRecording.runs.find((item) => item.run.id === selectedRunId && item.transcript)
      ?? latestTranscript(currentRecording);
    return result ? { recording: currentRecording, result } : null;
  }, [currentRecording, selectedRunId]);

  useEffect(() => {
    let cancelled = false;
    setPlaybackUrl("");
    if (previewRecordings) return;
    if (!selected || selected.recording.recording.audioState !== "available" || !selected.result.run.hasTranscript) return;
    void window.electronAPI.meetingRecordingGetPlaybackPath(selected.recording.recording.id, selected.result.run.id)
      .then((result) => {
        if (!cancelled && result.success && result.path) {
          setPlaybackUrl(new URL(result.path, "file://").href);
        } else if (!cancelled) {
          setMessage(t("meetingResults.playbackError"));
        }
      })
      .catch(() => {
        if (!cancelled) setMessage(t("meetingResults.playbackError"));
      });
    return () => { cancelled = true; };
  }, [previewRecordings, selected, t]);

  useEffect(() => {
    const result = selected?.result;
    if (!result?.transcript?.segments) return;
    const initial: Record<string, string> = {};
    for (const segment of result.transcript.segments) {
      if (!segment.speaker) continue;
      const correction = result.speakerCorrections.find((item) => item.speakerId === segment.speaker);
      initial[segment.speaker] = correction?.displayName || segment.speaker;
      setSpeakerProfileIds((current) => ({ ...current, [segment.speaker as string]: correction?.profileId ?? null }));
    }
    setSpeakerNames(initial);
  }, [selectedRunId, selected?.result]);

  if (!recordings.length) {
    return message ? (
      <section className="m-4 rounded-xl border border-border bg-surface-2/70 p-4 dark:border-white/10" aria-label={t("meetingResults.title")}>
        <p role="alert" className="text-xs text-muted-foreground">{message}</p>
      </section>
    ) : null;
  }

  if (!currentRecording) return null;
  const run = selected?.result;
  const audioAvailable = currentRecording.recording.audioState === "available";
  const selectableRuns = currentRecording.runs.filter((result) => result.transcript);
  const latestRun = [...currentRecording.runs].sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt))[0];
  const speakers = [...new Set(run?.transcript?.segments?.flatMap((segment) => segment.speaker ? [segment.speaker] : []) ?? [])];

  const selectRun = async (runId: string, recordingId = currentRecording.recording.id) => {
    const recording = recordings.find((item) => item.recording.id === recordingId);
    const resultForRun = recording?.runs.find((result) => result.run.id === runId && result.transcript);
    if (!recording || !resultForRun) return;
    selectedRecordingIdRef.current = recordingId;
    setSelectedRecordingId(recordingId);
    setSelectedRunId(runId);
    setMessage("");
    if (previewRecordings) {
      setRecordings((current) => current.map((item) => item.recording.id === recordingId
        ? { ...item, recording: { ...item.recording, currentRunId: runId } }
        : item));
      return;
    }
    const result = await window.electronAPI.meetingProcessingSelectRun(recordingId, runId);
    if (!result.success) setMessage(result.error || t("meetingResults.selectError"));
    else void refresh();
  };

  const selectRecording = (recordingId: string) => {
    const recording = recordings.find((item) => item.recording.id === recordingId);
    if (!recording) return;
    selectedRecordingIdRef.current = recordingId;
    setSelectedRecordingId(recordingId);
    setMessage("");
    const preferred = latestTranscript(recording);
    setSelectedRunId(preferred?.run.id ?? "");
  };

  const makeRun = async (kind: "reprocess" | "summary") => {
    const sourceRecording = kind === "reprocess" ? selected?.recording ?? currentRecording : selected?.recording;
    if (!sourceRecording || (kind === "summary" && !selected)) return;
    const sourceRunId = selected
      ? selected.result.run.kind === "summary"
        ? selected.result.run.sourceRunId ?? selected.result.run.id
        : selected.result.run.id
      : undefined;
    if (previewRecordings) {
      const now = new Date().toISOString();
      const baseRun = sourceRecording.runs[0]?.run;
      const nextRun: MeetingProcessingResultDto = {
        run: {
          id: crypto.randomUUID(),
          recordingId: sourceRecording.recording.id,
          kind,
          sourceRunId: kind === "summary" ? sourceRunId ?? null : null,
          provider: baseRun?.provider ?? "deepgram",
          model: baseRun?.model ?? "nova-3",
          config: baseRun?.config ?? null,
          configError: null,
          stage: kind === "summary" ? "summary" : "prepare",
          status: "pending",
          errorCode: null,
          retryAt: null,
          retryCount: 0,
          hasRawProviderResponse: false,
          hasTranscript: false,
          hasSummary: false,
          createdAt: now,
          updatedAt: now,
        },
        transcript: null,
        summary: null,
        speakerCorrections: [],
      };
      setRecordings((current) => current.map((item) => item.recording.id === sourceRecording.recording.id
        ? { ...item, runs: [nextRun, ...item.runs] }
        : item));
      setMessage("Mock run queued in memory. No provider was called.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const snapshot = snapshotMeetingRecordingConfig();
      const created = await window.electronAPI.meetingProcessingCreateRun({
        recordingId: sourceRecording.recording.id,
        kind,
        config: snapshot.config,
        configError: snapshot.configError,
        ...(kind === "summary" && sourceRunId ? { sourceRunId } : {}),
      });
      if (!created.success || !created.result) throw new Error(created.error || t("meetingResults.createError"));
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const retryRun = async () => {
    if (!latestRun) return;
    if (previewRecordings) {
      setRecordings((current) => current.map((item) => ({
        ...item,
        runs: item.runs.map((result) => result.run.id === latestRun.run.id
          ? { ...result, run: { ...result.run, status: "pending", errorCode: null, retryCount: result.run.retryCount + 1 } }
          : result),
      })));
      setMessage("Mock retry queued in memory. No provider was called.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const result = await window.electronAPI.meetingProcessingRetryRun(latestRun.run.id);
      if (!result.success) throw new Error(result.error || t("meetingResults.retryError"));
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const exportAudio = async (source: "mixed" | "mic" | "system") => {
    if (source === "mixed" && !run) return;
    if (previewRecordings) {
      setMessage(`Mock ${source} audio has no file to export.`);
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const result = await window.electronAPI.meetingRecordingExportAudio({
        recordingId: currentRecording.recording.id,
        ...(source === "mixed" && run ? { runId: run.run.id } : {}),
        source,
      });
      if (!result.success) throw new Error(result.error || t("meetingResults.exportError"));
      setMessage(t("meetingResults.exported"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const updateBlockedRunConfig = async () => {
    if (!latestRun) return;
    if (previewRecordings) {
      setRecordings((current) => current.map((item) => ({
        ...item,
        runs: item.runs.map((result) => result.run.id === latestRun.run.id
          ? { ...result, run: { ...result.run, status: "pending", configError: null, errorCode: null } }
          : result),
      })));
      setMessage("Mock settings updated in memory. No provider was called.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const savedTranscription = latestRun.run.config?.transcription;
      const summaryOnlyCorrection = latestRun.run.kind !== "summary" &&
        Boolean(savedTranscription) &&
        latestRun.run.stage === "summary" &&
        latestRun.run.errorCode === "missing-summary-config" &&
        Boolean(latestRun.transcript) &&
        latestRun.summary === null;
      const snapshot = snapshotMeetingRecordingConfig(summaryOnlyCorrection ? savedTranscription : undefined);
      const updated = await window.electronAPI.meetingProcessingUpdateBlockedRunConfig({
        runId: latestRun.run.id,
        config: snapshot.config,
        configError: snapshot.configError,
      });
      if (!updated.success) throw new Error(updated.error || t("meetingResults.updateConfigError"));
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("meetingResults.updateConfigError"));
    } finally {
      setBusy(false);
    }
  };

  const persistSpeaker = async (speakerId: string) => {
    if (!run) return;
    const sourceRunId = run.run.kind === "summary" ? run.run.sourceRunId : run.run.id;
    const displayName = speakerNames[speakerId]?.trim();
    if (!sourceRunId || !displayName) return;
    if (previewRecordings) {
      setRecordings((current) => current.map((item) => ({
        ...item,
        runs: item.runs.map((result) => result.run.id === run.run.id
          ? {
              ...result,
              speakerCorrections: [
                ...result.speakerCorrections.filter((correction) => correction.speakerId !== speakerId),
                { speakerId, profileId: speakerProfileIds[speakerId] ?? null, displayName },
              ],
            }
          : result),
      })));
      return;
    }
    const result = await window.electronAPI.meetingProcessingSetSpeakerCorrection({
      runId: sourceRunId,
      speakerId,
      profileId: speakerProfileIds[speakerId] ?? null,
      displayName,
    });
    if (!result.success) setMessage(result.error || t("meetingResults.speakerError"));
    else await refresh();
  };

  const confirmDeleteAudio = () => {
    showConfirmDialog({
      title: t("meetingResults.deleteAudioTitle"),
      description: t("meetingResults.deleteAudioDescription"),
      confirmText: t("meetingResults.deleteAudioConfirm"),
      variant: "destructive",
      onConfirm: async () => {
        if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current.removeAttribute("src");
          audioRef.current.load();
        }
        setPlaybackUrl("");
        if (previewRecordings) {
          setRecordings((current) => current.map((item) => item.recording.id === currentRecording.recording.id
            ? { ...item, recording: { ...item.recording, audioState: "deleted" } }
            : item));
          setMessage("Mock audio marked deleted in memory.");
          return;
        }
        setBusy(true);
        const result = currentRecording.recording.audioState === "deleting"
          ? await window.electronAPI.meetingRecordingRetryAudioDeletion(currentRecording.recording.id)
          : await window.electronAPI.meetingRecordingDeleteAudio(currentRecording.recording.id);
        setBusy(false);
        setMessage(result.success ? "" : result.error || t("meetingResults.deleteError"));
        await refresh();
      },
    });
  };

  const runStatus = latestRun
    ? `${t(`meetingResults.stage.${latestRun.run.stage}`)} · ${t(`meetingResults.status.${latestRun.run.status}`)}`
    : "";
  const captureIncomplete = currentRecording.recording.captureState === "incomplete";
  const status = captureIncomplete
    ? [t("meetingResults.captureIncomplete"), runStatus].filter(Boolean).join(" · ")
    : runStatus || t(`meetingResults.capture.${currentRecording.recording.captureState}`);
  const sortedRecordings = [...recordings].sort((a, b) =>
    b.recording.startedAt.localeCompare(a.recording.startedAt) || b.recording.id.localeCompare(a.recording.id)
  );
  const summaryOnlyCorrection = latestRun?.run.stage === "summary" &&
    latestRun.run.status === "blocked" &&
    latestRun.run.kind !== "summary" &&
    Boolean(latestRun.run.config) &&
    latestRun.run.errorCode === "missing-summary-config" &&
    Boolean(latestRun.transcript) &&
    latestRun.summary === null;
  const initialSettingsCorrection = latestRun?.run.status === "blocked" &&
    latestRun.run.kind !== "summary" &&
    !latestRun.run.hasRawProviderResponse &&
    !latestRun.run.hasTranscript &&
    audioAvailable;

  return (
    <section className="m-4 rounded-xl border border-border bg-surface-2/70 p-4 dark:border-white/10" aria-label={t("meetingResults.title")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{t("meetingResults.title")}</h3>
          <p className="text-xs text-muted-foreground">{status}{latestRun?.run.errorCode ? ` · ${latestRun.run.errorCode}` : ""}{currentRecording.recording.captureErrorCode ? ` · ${currentRecording.recording.captureErrorCode}` : ""}{currentRecording.recording.audioErrorCode ? ` · ${currentRecording.recording.audioErrorCode}` : ""}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {audioAvailable && <Button size="sm" variant="outline" disabled={busy} onClick={() => void makeRun("reprocess")}>{t("meetingResults.newAsr")}</Button>}
          {run?.transcript && <Button size="sm" variant="outline" disabled={busy} onClick={() => void makeRun("summary")}>{t("meetingResults.newSummary")}</Button>}
          {latestRun && ["failed", "blocked", "cancelled"].includes(latestRun.run.status) && (
            <Button size="sm" variant="outline" disabled={busy || (!audioAvailable && !latestRun.run.hasRawProviderResponse && !latestRun.transcript)} onClick={() => void retryRun()}>{t("meetingResults.retry")}</Button>
          )}
          {(initialSettingsCorrection || summaryOnlyCorrection) && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void updateBlockedRunConfig()}>{t("meetingResults.updateRunSettings")}</Button>
          )}
          {audioAvailable && <Button size="sm" variant="outline" disabled={busy} onClick={() => void confirmDeleteAudio()}>{t("meetingResults.deleteAudio")}</Button>}
          {currentRecording.recording.audioState === "deleting" && <Button size="sm" variant="outline" disabled={busy} onClick={() => void confirmDeleteAudio()}>{t("meetingResults.retryDelete")}</Button>}
        </div>
      </div>

      {recordings.length > 1 && (
        <label className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span>{t("meetingResults.recording")}</span>
          <select
            className="max-w-full rounded border bg-background px-2 py-1"
            aria-label={t("meetingResults.recording")}
            value={currentRecording.recording.id}
            onChange={(event) => void selectRecording(event.target.value)}
          >
            {sortedRecordings.map((recording, index) => (
              <option key={recording.recording.id} value={recording.recording.id}>
                {t("meetingResults.recording")} {index + 1} · {formatVersionDate(recording.recording.startedAt, locale)} · {t(`meetingResults.capture.${recording.recording.captureState}`)}
              </option>
            ))}
          </select>
        </label>
      )}

      {selectableRuns.length > 0 && (
        <label className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span>{t("meetingResults.version")}</span>
          <select className="max-w-full rounded border bg-background px-2 py-1" value={selectedRunId} onChange={(event) => void selectRun(event.target.value)}>
            {selectableRuns.map((result) => (
              <option key={result.run.id} value={result.run.id}>{versionLabel(result, locale)}</option>
            ))}
          </select>
        </label>
      )}

      {playbackUrl && audioAvailable && <audio ref={audioRef} controls preload="metadata" src={playbackUrl} className="mt-3 h-9 max-w-full" />}
      {audioAvailable && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {playbackUrl && run && <Button size="sm" variant="outline" disabled={busy} onClick={() => void exportAudio("mixed")}>{t("meetingResults.exportMixed")}</Button>}
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void exportAudio("mic")}>{t("meetingResults.exportMic")}</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void exportAudio("system")}>{t("meetingResults.exportSystem")}</Button>
        </div>
      )}
      {!audioAvailable && <p className="mt-2 text-xs text-muted-foreground">{t("meetingResults.audioUnavailable")}</p>}

      {speakers.length > 0 && run && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {speakers.map((speakerId) => (
            <label key={speakerId} className="flex items-center gap-2 text-xs">
              <span className="shrink-0">{speakerId}</span>
              <input dir="auto" className="min-w-0 flex-1 rounded border bg-background px-2 py-1" value={speakerNames[speakerId] ?? speakerId} onChange={(event) => {
                setSpeakerNames((current) => ({ ...current, [speakerId]: event.target.value }));
                setSpeakerProfileIds((current) => ({ ...current, [speakerId]: null }));
              }} />
              <select
                className="max-w-32 rounded border bg-background px-2 py-1"
                value={speakerProfileIds[speakerId] ?? ""}
                onChange={(event) => {
                  const profileId = event.target.value ? Number(event.target.value) : null;
                  setSpeakerProfileIds((current) => ({ ...current, [speakerId]: profileId }));
                  const profile = speakerProfiles.find((item) => item.id === profileId);
                  if (profile) setSpeakerNames((current) => ({ ...current, [speakerId]: profile.display_name }));
                }}
                aria-label={t("meetingResults.speakerProfile")}
              >
                <option value="">{t("meetingResults.noSpeakerProfile")}</option>
                {speakerProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.display_name}</option>)}
              </select>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void persistSpeaker(speakerId)}>{t("meetingResults.saveSpeaker")}</Button>
            </label>
          ))}
        </div>
      )}

      {run?.transcript?.segments && run.transcript.segments.length > 0 && (
        <div className="mt-3 border-t border-border/60 pt-2">
          {run.transcript.segments.map((segment, index) => (
            <button key={`${index}-${segment.start}`} type="button" className="block w-full py-1 text-left text-xs text-muted-foreground hover:text-foreground" disabled={(!audioRef.current && !previewRecordings) || !audioAvailable} onClick={() => {
              if (previewRecordings) setMessage(`Mock playback position: ${Math.floor(segment.start)}s`);
              else if (audioRef.current) audioRef.current.currentTime = segment.start;
            }}>
              <span className="me-2 tabular-nums">{Math.floor(segment.start / 60)}:{String(Math.floor(segment.start % 60)).padStart(2, "0")}</span>{segment.text}
            </button>
          ))}
        </div>
      )}
      {run?.transcript?.text && !run.transcript.segments?.length && (
        <p className="mt-3 border-t border-border/60 pt-2 text-xs whitespace-pre-wrap">{run.transcript.text}</p>
      )}
      {run?.transcript && !run.transcript.text.trim() && !run.transcript.segments?.length && (
        <p className="mt-3 border-t border-border/60 pt-2 text-xs text-muted-foreground">{t("notes.upload.noSpeechDetected")}</p>
      )}
      {message && <p role="status" className="mt-2 text-xs text-muted-foreground">{message}</p>}
      <ConfirmDialog open={confirmDialog.open} onOpenChange={(open) => !open && hideConfirmDialog()} title={confirmDialog.title} description={confirmDialog.description} confirmText={confirmDialog.confirmText} cancelText={confirmDialog.cancelText} onConfirm={confirmDialog.onConfirm} variant={confirmDialog.variant} />
    </section>
  );
}
