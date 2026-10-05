export interface MeetingAudioTimelineOptions {
  originFrame?: number;
}

export type MeetingAudioTimelineEmitter = (buffer: Buffer, frameStart: number) => void;

export interface MeetingAudioTimeline {
  lastFrame: number;
  markRestart(frame: number): number;
  write(buffer: Buffer, frameStart: number, emit: MeetingAudioTimelineEmitter): void;
}

/** Tracks actual frame anchors; callers must provide the source clock mapping. */
export const createMeetingAudioTimeline = ({
  originFrame = 0,
}: MeetingAudioTimelineOptions = {}): MeetingAudioTimeline => {
  if (!Number.isSafeInteger(originFrame) || originFrame < 0)
    throw new RangeError("Invalid meeting audio origin frame");
  let lastFrame = originFrame;

  return {
    get lastFrame() {
      return lastFrame;
    },
    markRestart(frame) {
      if (!Number.isSafeInteger(frame) || frame < lastFrame)
        throw new RangeError("Invalid meeting audio restart frame");
      lastFrame = frame;

      return lastFrame;
    },
    write(buffer, frameStart, emit) {
      if (
        buffer.length === 0 ||
        buffer.length % 2 !== 0 ||
        !Number.isSafeInteger(frameStart) ||
        frameStart < lastFrame
      ) {
        throw new Error("Invalid meeting audio frame range");
      }

      emit(buffer, frameStart);
      lastFrame = frameStart + buffer.length / 2;
    },
  };
};

module.exports = createMeetingAudioTimeline;

module.exports.createMeetingAudioTimeline = createMeetingAudioTimeline;
