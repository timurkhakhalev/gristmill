import { i18nMain } from "./i18nMain.js";

// The export formats read whatever the note/segment producers actually store:
// speaker fields are optional (uploads have none), timestamps may be missing,
// and SQLite dates arrive as UTC-without-suffix strings.
export interface TranscriptExportSegment {
  text: string;
  timestamp?: number | null;
  endTimestamp?: number | null;
  speaker?: string | null;
  speakerName?: string | null;
  speakerIsPlaceholder?: boolean | null;
  source?: string | null;
}

export interface TranscriptExportNote {
  title?: string | null;
  created_at?: string | number | null;
  participants?: string | null;
}

export type SpeakerMappings = Record<string, string>;

function resolveSpeaker(seg: TranscriptExportSegment, speakerMappings: SpeakerMappings): string {
  if (!seg.speaker && seg.speakerName && speakerMappings[seg.speakerName]) {
    return speakerMappings[seg.speakerName];
  }

  if (seg.speakerName && !seg.speakerIsPlaceholder) return seg.speakerName;

  if (seg.speaker && speakerMappings[seg.speaker]) return speakerMappings[seg.speaker];

  if (seg.speaker === "you") return i18nMain.t("transcript.speaker.you");

  if (seg.speaker) {
    const num = parseInt(seg.speaker.replace("speaker_", ""), 10);

    if (!isNaN(num)) return i18nMain.t("notes.speaker.label", { n: num + 1 });
  }

  if (seg.source === "mic") return i18nMain.t("transcript.speaker.you");

  if (seg.source === "system") return i18nMain.t("transcript.speaker.others");

  return i18nMain.t("notes.speaker.unknown");
}

// Segments merge only when they resolve to the same display name, so the key has
// to cover every field resolveSpeaker reads — a manually named segment would
// otherwise absorb the un-named one beside it.
function speakerKey(seg: TranscriptExportSegment): string {
  const named = seg.speakerName && !seg.speakerIsPlaceholder ? seg.speakerName : "";

  return [seg.speaker || "", named, seg.speaker ? "" : seg.source || ""].join("\u0000");
}

export function parseNoteDate(createdAt: string | number | null | undefined): Date {
  if (createdAt == null || createdAt === "") {
    return new Date(NaN);
  }

  if (typeof createdAt === "number") {
    return new Date(createdAt);
  }

  const value = String(createdAt).trim();

  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(value)) {
    return new Date(value);
  }

  // SQLite CURRENT_TIMESTAMP is UTC without a timezone suffix.
  return new Date(value.includes("T") ? `${value}Z` : `${value.replace(" ", "T")}Z`);
}

export function normalizeSegmentTimestamps(
  segments: TranscriptExportSegment[],
  note: TranscriptExportNote | null | undefined
): TranscriptExportSegment[] {
  const segmentTimestamps = segments
    .map((seg) => seg.timestamp)
    .filter((ts): ts is number => typeof ts === "number" && Number.isFinite(ts));

  let startMs: number | null = null;

  if (segmentTimestamps.length > 0) {
    startMs = Math.min(...segmentTimestamps);
  } else {
    const noteDate = parseNoteDate(note?.created_at);
    startMs = Number.isNaN(noteDate.getTime()) ? null : noteDate.getTime();
  }

  if (startMs == null || startMs <= 1e9) {
    return segments;
  }

  return segments.map((seg) => {
    const normalized = { ...seg };

    if (typeof seg.timestamp === "number" && Number.isFinite(seg.timestamp)) {
      normalized.timestamp = (seg.timestamp - startMs) / 1000;
    }

    if (typeof seg.endTimestamp === "number" && Number.isFinite(seg.endTimestamp)) {
      normalized.endTimestamp = (seg.endTimestamp - startMs) / 1000;
    }

    return normalized;
  });
}

interface MergedSegment {
  text: string;
  timestamp: number;
  endTimestamp: number;
  hasExplicitEndTimestamp: boolean;
  speaker?: string | null;
  speakerName?: string | null;
  speakerIsPlaceholder?: boolean | null;
  source?: string | null;
}

function mergeSegments(segments: TranscriptExportSegment[]): MergedSegment[] {
  const merged: MergedSegment[] = [];
  let lastTimestamp: number | null = null;

  for (const seg of segments) {
    if (!seg.text?.trim()) continue;
    const ts = seg.timestamp || 0;
    const last = merged[merged.length - 1];

    if (last && speakerKey(last) === speakerKey(seg) && ts - (lastTimestamp as number) < 2) {
      last.text = last.text + " " + seg.text.trim();
      last.endTimestamp = typeof seg.endTimestamp === "number" ? seg.endTimestamp : ts;
      last.hasExplicitEndTimestamp = typeof seg.endTimestamp === "number";
    } else {
      merged.push({
        ...seg,
        timestamp: ts,
        endTimestamp: typeof seg.endTimestamp === "number" ? seg.endTimestamp : ts,
        hasExplicitEndTimestamp: typeof seg.endTimestamp === "number",
        text: seg.text.trim(),
      });
    }

    lastTimestamp = ts;
  }

  return merged;
}

function formatTimestamp(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;

  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function formatSrtTimestamp(seconds: number): string {
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const s = Math.floor(totalMs / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;

  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function extractMetadata(note: TranscriptExportNote): {
  title: string;
  dateStr: string;
  participants: string[];
} {
  const title = note.title || "Untitled";
  const noteDate = parseNoteDate(note.created_at);

  const dateStr =
    noteDate.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) +
    " " +
    noteDate.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  let participants: string[] = [];

  try {
    const parsed = JSON.parse(note.participants || "[]") as Array<{
      displayName?: string | null;
      email?: string | null;
    }>;

    participants = parsed.map((p) => p.displayName || p.email || "").filter(Boolean);
  } catch {
    // Malformed participants stay out of the export header.
  }

  return { title, dateStr, participants };
}

export function formatTxt(
  note: TranscriptExportNote,
  segments: TranscriptExportSegment[],
  speakerMappings: SpeakerMappings
): string {
  const merged = mergeSegments(normalizeSegmentTimestamps(segments, note));
  const { title, dateStr, participants } = extractMetadata(note);

  const lines = [title, dateStr];

  if (participants.length)
    lines.push(`${i18nMain.t("notes.editor.participants")}: ${participants.join(", ")}`);
  lines.push("", "──────────────────────────────────", "");

  for (const seg of merged) {
    lines.push(`[${formatTimestamp(seg.timestamp)}] ${resolveSpeaker(seg, speakerMappings)}:`);
    lines.push(seg.text);
    lines.push("");
  }

  return lines.join("\n");
}

export function formatSrt(
  segments: TranscriptExportSegment[],
  speakerMappings: SpeakerMappings,
  note: TranscriptExportNote = {}
): string {
  const merged = mergeSegments(normalizeSegmentTimestamps(segments, note));
  // Upload transcripts carry no speaker identity at all; prefixing every cue
  // with "Unknown Speaker:" would defeat the subtitle use case. Meeting
  // segments always serialize a source, so they keep their labels.
  const hasSpeakerIdentity = merged.some((seg) => seg.speaker || seg.speakerName || seg.source);
  const entries: string[] = [];

  for (let i = 0; i < merged.length; i++) {
    const seg = merged[i];

    const nextTs =
      seg.hasExplicitEndTimestamp && seg.endTimestamp > seg.timestamp
        ? seg.endTimestamp
        : i + 1 < merged.length
          ? merged[i + 1].timestamp
          : seg.endTimestamp + 3;

    entries.push(`${i + 1}`);
    entries.push(`${formatSrtTimestamp(seg.timestamp)} --> ${formatSrtTimestamp(nextTs)}`);
    entries.push(
      hasSpeakerIdentity ? `${resolveSpeaker(seg, speakerMappings)}: ${seg.text}` : seg.text
    );
    entries.push("");
  }

  return entries.join("\n");
}

export function formatJson(
  note: TranscriptExportNote,
  segments: TranscriptExportSegment[],
  speakerMappings: SpeakerMappings
): string {
  const merged = mergeSegments(normalizeSegmentTimestamps(segments, note));
  const { title, dateStr } = extractMetadata(note);

  const speakersSet = new Set<string>();

  for (const seg of merged) speakersSet.add(resolveSpeaker(seg, speakerMappings));
  const lastSeg = merged[merged.length - 1];

  return JSON.stringify(
    {
      metadata: {
        title,
        date: dateStr,
        duration_seconds: lastSeg ? Math.round(lastSeg.endTimestamp) : 0,
        speaker_count: speakersSet.size,
        segment_count: merged.length,
      },
      speakers: [...speakersSet],
      segments: merged.map((seg) => ({
        speaker: resolveSpeaker(seg, speakerMappings),
        timestamp: seg.timestamp,
        end_timestamp: seg.endTimestamp,
        text: seg.text,
      })),
    },
    null,
    2
  );
}

export function formatMd(
  note: TranscriptExportNote,
  segments: TranscriptExportSegment[],
  speakerMappings: SpeakerMappings
): string {
  const merged = mergeSegments(normalizeSegmentTimestamps(segments, note));
  const { title, dateStr, participants } = extractMetadata(note);

  const lines = [`# ${title}`, "", `**Date:** ${dateStr}`];

  if (participants.length)
    lines.push(`**${i18nMain.t("notes.editor.participants")}:** ${participants.join(", ")}`);
  lines.push("", "---", "");

  for (const seg of merged) {
    lines.push(`**${resolveSpeaker(seg, speakerMappings)}** \`${formatTimestamp(seg.timestamp)}\``);
    lines.push(`${seg.text}`, "");
  }

  return lines.join("\n");
}
