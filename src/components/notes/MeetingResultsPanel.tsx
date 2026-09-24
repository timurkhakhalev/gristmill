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

export default function MeetingResultsPanel({ noteId, locale }: { noteId: number; locale: string }) {
  const { t } = useTranslation();
  const [recordings, setRecordings] = useState<MeetingProcessingRecordingResult[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>("");
  const [playbackUrl, setPlaybackUrl] = useState<string>("");
  const [message, setMessage] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
  const [speakerProfileIds, setSpeakerProfileIds] = useState<Record<string, number | null>>({});
  const [speakerProfiles, setSpeakerProfiles] = useState<Array<{ id: number; display_name: string }>>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const autoSelectRunId = useRef<string | null>(null);
  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();

  const refresh = useCallback(async () => {
    const result = await window.electronAPI.meetingProcessingListForNote(noteId);
    if (!result.success) {
      setMessage(result.error || t("meetingResults.loadError"));
      return;
    }
    const next = result.recordings ?? [];
    setRecordings(next);
    const runs = next.flatMap((recording) => recording.runs);
    const pendingAutoSelect = autoSelectRunId.current;
    if (pendingAutoSelect && runs.some((item) => item.run.id === pendingAutoSelect && item.transcript)) {
      autoSelectRunId.current = null;
      setSelectedRunId(pendingAutoSelect);
      return;
    }
    setSelectedRunId((selected) => {
      return runs.some((item) => item.run.id === selected && item.transcript)
        ? selected
        : runs.find((item) => item.run.id === next.find((recording) => recording.recording.currentRunId)?.recording.currentRunId && item.transcript)?.run.id
          ?? runs.find((item) => item.transcript)?.run.id
          ?? "";
    });
  }, [noteId, t]);

  useEffect(() => {
    void refresh();
    const unsubscribe = window.electronAPI.onMeetingProcessingUpdated(() => void refresh());
    return unsubscribe;
  }, [refresh]);

  useEffect(() => {
    void window.electronAPI.getSpeakerProfiles?.().then((profiles) => {
      setSpeakerProfiles((profiles ?? []).map((profile) => ({ id: profile.id, display_name: profile.display_name })));
    });
  }, []);

  const selected = useMemo(() => {
    for (const recording of recordings) {
      const result = recording.runs.find((item) => item.run.id === selectedRunId);
      if (result?.transcript) return { recording, result };
    }
    for (const recording of recordings) {
      const result = recording.runs.find((item) => item.run.id === recording.recording.currentRunId && item.transcript);
      if (result) return { recording, result };
    }
    return recordings.flatMap((recording) => recording.runs
      .filter((item) => item.transcript)
      .map((result) => ({ recording, result })))
      .sort((a, b) => b.result.run.createdAt.localeCompare(a.result.run.createdAt))[0] ?? null;
  }, [recordings, selectedRunId]);

  useEffect(() => {
    let cancelled = false;
    setPlaybackUrl("");
    if (!selected || selected.recording.recording.audioState !== "available" || !selected.result.run.hasTranscript) return;
    void window.electronAPI.meetingRecordingGetPlaybackPath(selected.recording.recording.id, selected.result.run.id)
      .then((result) => {
        if (!cancelled && result.success && result.path) {
          setPlaybackUrl(new URL(result.path, "file://").href);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : String(error));
      });
    return () => { cancelled = true; };
  }, [selected]);

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

  const currentRecording = selected?.recording ?? recordings[0];
  const run = selected?.result;
  const audioAvailable = currentRecording.recording.audioState === "available";
  const selectableRuns = recordings.flatMap((recording) => recording.runs.filter((result) => result.transcript));
  const latestRun = [...currentRecording.runs].sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt))[0];
  const speakers = [...new Set(run?.transcript?.segments?.flatMap((segment) => segment.speaker ? [segment.speaker] : []) ?? [])];

  const selectRun = async (runId: string) => {
    const found = recordings.flatMap((item) => item.runs.map((result) => ({ item, result }))).find(({ result }) => result.run.id === runId);
    if (!found) return;
    setSelectedRunId(runId);
    setMessage("");
    const result = await window.electronAPI.meetingProcessingSelectRun(found.item.recording.id, runId);
    if (!result.success) setMessage(result.error || t("meetingResults.selectError"));
    else void refresh();
  };

  const makeRun = async (kind: "reprocess" | "summary") => {
    if (!selected) return;
    setBusy(true);
    setMessage("");
    try {
      const snapshot = snapshotMeetingRecordingConfig();
      const created = await window.electronAPI.meetingProcessingCreateRun({
        recordingId: selected.recording.recording.id,
        kind,
        config: snapshot.config,
        configError: snapshot.configError,
        ...(kind === "summary" ? {
          sourceRunId: selected.result.run.kind === "summary"
            ? selected.result.run.sourceRunId ?? selected.result.run.id
            : selected.result.run.id,
        } : {}),
      });
      if (!created.success || !created.result) throw new Error(created.error || t("meetingResults.createError"));
      autoSelectRunId.current = created.result.run.id;
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const retryRun = async () => {
    if (!latestRun) return;
    setBusy(true);
    setMessage("");
    try {
      autoSelectRunId.current = latestRun.run.id;
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
    if (!selected) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await window.electronAPI.meetingRecordingExportAudio({
        recordingId: selected.recording.recording.id,
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

  const persistSpeaker = async (speakerId: string) => {
    if (!run) return;
    const sourceRunId = run.run.kind === "summary" ? run.run.sourceRunId : run.run.id;
    const displayName = speakerNames[speakerId]?.trim();
    if (!sourceRunId || !displayName) return;
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
    if (!selected) return;
    showConfirmDialog({
      title: t("meetingResults.deleteAudioTitle"),
      description: t("meetingResults.deleteAudioDescription"),
      confirmText: t("meetingResults.deleteAudioConfirm"),
      variant: "destructive",
      onConfirm: async () => {
        if (!selected) return;
        if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current.removeAttribute("src");
          audioRef.current.load();
        }
        setPlaybackUrl("");
        setBusy(true);
        const result = currentRecording.recording.audioState === "deleting"
          ? await window.electronAPI.meetingRecordingRetryAudioDeletion(selected.recording.recording.id)
          : await window.electronAPI.meetingRecordingDeleteAudio(selected.recording.recording.id);
        setBusy(false);
        setMessage(result.success ? "" : result.error || t("meetingResults.deleteError"));
        await refresh();
      },
    });
  };

  const status = latestRun
    ? `${t(`meetingResults.stage.${latestRun.run.stage}`)} · ${t(`meetingResults.status.${latestRun.run.status}`)}`
    : currentRecording.recording.captureState === "incomplete"
      ? t("meetingResults.captureIncomplete")
      : t(`meetingResults.capture.${currentRecording.recording.captureState}`);

  return (
    <section className="m-4 rounded-xl border border-border bg-surface-2/70 p-4 dark:border-white/10" aria-label={t("meetingResults.title")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{t("meetingResults.title")}</h3>
          <p className="text-xs text-muted-foreground">{status}{latestRun?.run.errorCode ? ` · ${latestRun.run.errorCode}` : currentRecording.recording.captureErrorCode ? ` · ${currentRecording.recording.captureErrorCode}` : currentRecording.recording.audioErrorCode ? ` · ${currentRecording.recording.audioErrorCode}` : ""}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {audioAvailable && <Button size="sm" variant="outline" disabled={busy} onClick={() => void makeRun("reprocess")}>{t("meetingResults.newAsr")}</Button>}
          {run?.transcript && <Button size="sm" variant="outline" disabled={busy} onClick={() => void makeRun("summary")}>{t("meetingResults.newSummary")}</Button>}
          {latestRun && ["failed", "blocked", "cancelled"].includes(latestRun.run.status) && (
            <Button size="sm" variant="outline" disabled={busy || (!audioAvailable && !latestRun.run.hasRawProviderResponse && !latestRun.transcript)} onClick={() => void retryRun()}>{t("meetingResults.retry")}</Button>
          )}
          {audioAvailable && <Button size="sm" variant="outline" disabled={busy} onClick={() => void confirmDeleteAudio()}>{t("meetingResults.deleteAudio")}</Button>}
          {currentRecording.recording.audioState === "deleting" && <Button size="sm" variant="outline" disabled={busy} onClick={() => void confirmDeleteAudio()}>{t("meetingResults.retryDelete")}</Button>}
        </div>
      </div>

      {selectableRuns.length > 0 && (
        <label className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span>{t("meetingResults.version")}</span>
          <select className="max-w-full rounded border bg-background px-2 py-1" value={selectedRunId} onChange={(event) => void selectRun(event.target.value)}>
            {recordings.flatMap((recording) => recording.runs.filter((result) => result.transcript).map((result) => (
              <option key={result.run.id} value={result.run.id}>{versionLabel(result, locale)}</option>
            )))}
          </select>
        </label>
      )}

      {playbackUrl && audioAvailable && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <audio ref={audioRef} controls preload="metadata" src={playbackUrl} className="h-9 max-w-full" />
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void exportAudio("mixed")}>{t("meetingResults.exportMixed")}</Button>
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
              <input className="min-w-0 flex-1 rounded border bg-background px-2 py-1" value={speakerNames[speakerId] ?? speakerId} onChange={(event) => {
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
        <div className="mt-3 max-h-32 overflow-y-auto border-t border-border/60 pt-2">
          {run.transcript.segments.map((segment, index) => (
            <button key={`${index}-${segment.start}`} type="button" className="block w-full py-1 text-left text-xs text-muted-foreground hover:text-foreground" disabled={!audioRef.current || !audioAvailable} onClick={() => { if (audioRef.current) audioRef.current.currentTime = segment.start; }}>
              <span className="me-2 tabular-nums">{Math.floor(segment.start / 60)}:{String(Math.floor(segment.start % 60)).padStart(2, "0")}</span>{segment.text}
            </button>
          ))}
        </div>
      )}
      {run?.transcript?.text && !run.transcript.segments?.length && (
        <p className="mt-3 max-h-32 overflow-y-auto border-t border-border/60 pt-2 text-xs whitespace-pre-wrap">{run.transcript.text}</p>
      )}
      {message && <p role="status" className="mt-2 text-xs text-muted-foreground">{message}</p>}
      <ConfirmDialog open={confirmDialog.open} onOpenChange={(open) => !open && hideConfirmDialog()} title={confirmDialog.title} description={confirmDialog.description} confirmText={confirmDialog.confirmText} cancelText={confirmDialog.cancelText} onConfirm={confirmDialog.onConfirm} variant={confirmDialog.variant} />
    </section>
  );
}
