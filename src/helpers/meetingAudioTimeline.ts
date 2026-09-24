const SAMPLE_RATE = 24_000;

export interface MeetingAudioTimelineOptions {
  originAt?: number;
  wallNow?: () => number;
}

export type MeetingAudioTimelineEmitter = (
  buffer: Buffer,
  sampleOffset: number,
  capturedAt: number
) => void;

export interface MeetingAudioTimeline {
  frameAt(at?: number): number;
  markRestart(at?: number): number;
  write(buffer: Buffer, emit: MeetingAudioTimelineEmitter): void;
}

export const frameOffsetFromSessionOrigin = (originAt: number, sourceStartedAt: number): number =>
  Math.max(0, Math.round(((sourceStartedAt - originAt) * SAMPLE_RATE) / 1000));

/** Tracks source frame positions; delivery jitter never inserts synthetic PCM. */
export const createMeetingAudioTimeline = ({
  originAt = Date.now(),
  wallNow = Date.now,
}: MeetingAudioTimelineOptions = {}): MeetingAudioTimeline => {
  let lastPosition = 0;

  const frameAt = (at = wallNow()) => frameOffsetFromSessionOrigin(originAt, at);

  return {
    frameAt,
    markRestart(at = wallNow()) {
      lastPosition = Math.max(lastPosition, frameAt(at));
      return lastPosition;
    },
    write(buffer, emit) {
      const capturedAt = originAt + (lastPosition * 1000) / SAMPLE_RATE;
      emit(buffer, lastPosition, capturedAt);
      lastPosition += buffer.length / 2;
    },
  };
};

module.exports = createMeetingAudioTimeline;
module.exports.createMeetingAudioTimeline = createMeetingAudioTimeline;
module.exports.frameOffsetFromSessionOrigin = frameOffsetFromSessionOrigin;
