import type { MeetingSpeakerCorrection, MeetingTranscriptArtifact } from "../contracts/meetingRecording.js";
import type { SpeakerProfileRow } from "./database.js";

export interface MeetingSpeakerEmbeddings {
  isAvailable(): boolean;
  extractEmbedding(wavPath: string, startSeconds: number, endSeconds: number): Promise<Float32Array | null>;
  computeCentroid(embeddings: Float32Array[]): Float32Array;
  cosineSimilarity(left: Float32Array, right: Float32Array): number;
}

export interface MeetingSpeakerRecognitionDeps {
  speakerEmbeddings: MeetingSpeakerEmbeddings;
  getProfiles: () => SpeakerProfileRow[];
  convertToWav: (inputPath: string, outputPath: string, options: { sampleRate: number; channels: number; signal: AbortSignal }) => Promise<void>;
  createTempPath: () => string;
  removeFile: (filePath: string) => void;
  logSkipped?: (error: unknown) => void;
}

export async function recognizeMeetingSpeakers(
  transcript: MeetingTranscriptArtifact,
  audioPath: string,
  signal: AbortSignal,
  deps: MeetingSpeakerRecognitionDeps
): Promise<MeetingSpeakerCorrection[]> {
  if (!transcript.segments?.length || !deps.speakerEmbeddings.isAvailable()) return [];
  const tempPath = deps.createTempPath();
  try {
    await deps.convertToWav(audioPath, tempPath, { sampleRate: 16_000, channels: 1, signal });
    const bySpeaker = new Map<string, Array<{ start: number; end: number }>>();
    for (const segment of transcript.segments) {
      if (!segment.speaker) continue;
      const segments = bySpeaker.get(segment.speaker) ?? [];
      segments.push({ start: segment.start, end: segment.end });
      bySpeaker.set(segment.speaker, segments);
    }

    const profiles = deps.getProfiles().filter(
      (profile): profile is SpeakerProfileRow & { embedding: Buffer } => Buffer.isBuffer(profile.embedding)
    );
    const matches: Array<{ speakerId: string; profile: SpeakerProfileRow; similarity: number }> = [];
    for (const [speakerId, segments] of bySpeaker) {
      signal.throwIfAborted();
      const embeddings: Float32Array[] = [];
      const longest = segments
        .filter((segment) => segment.end > segment.start)
        .sort((a, b) => (b.end - b.start) - (a.end - a.start))
        .slice(0, 3);
      for (const segment of longest) {
        signal.throwIfAborted();
        const embedding = await deps.speakerEmbeddings.extractEmbedding(tempPath, segment.start, segment.end);
        if (embedding) embeddings.push(embedding);
      }
      if (!embeddings.length) continue;
      const centroid = deps.speakerEmbeddings.computeCentroid(embeddings);
      let best: { profile: SpeakerProfileRow; similarity: number } | null = null;
      for (const profile of profiles) {
        const profileEmbedding = new Float32Array(
          profile.embedding.buffer,
          profile.embedding.byteOffset,
          Math.floor(profile.embedding.byteLength / Float32Array.BYTES_PER_ELEMENT)
        );
        if (profileEmbedding.length !== centroid.length) continue;
        const similarity = deps.speakerEmbeddings.cosineSimilarity(centroid, profileEmbedding);
        if (!best || similarity > best.similarity) best = { profile, similarity };
      }
      if (best && best.similarity > 0.6) matches.push({ speakerId, profile: best.profile, similarity: best.similarity });
    }

    const usedProfiles = new Set<number>();
    return matches
      .sort((a, b) => b.similarity - a.similarity)
      .filter(({ profile }) => {
        if (usedProfiles.has(profile.id)) return false;
        usedProfiles.add(profile.id);
        return true;
      })
      .map(({ speakerId, profile }) => ({
        speakerId,
        profileId: profile.id,
        displayName: profile.display_name,
      }));
  } catch (error) {
    if (signal.aborted) throw error;
    deps.logSkipped?.(error);
    return [];
  } finally {
    try { deps.removeFile(tempPath); } catch {}
  }
}
