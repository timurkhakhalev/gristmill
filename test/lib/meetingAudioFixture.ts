import fs from "node:fs";
import type { MeetingRecordingStorage } from "../../src/helpers/meetingRecordingStorage.js";
import type { MeetingSource } from "../../src/contracts/meetingRecording.js";

// Saved-audio fixtures may contain hours of audio; capture's five-second queue
// belongs to the live writer tests rather than these downstream consumers.
export function savePcmEpoch(
  storage: MeetingRecordingStorage,
  recordingId: string,
  source: MeetingSource,
  index: number,
  pcm: Buffer
): void {
  const { convertMeetingPcm } =
    require("../../src/helpers/meetingOpus.ts") as typeof import("../../src/helpers/meetingOpus.js");

  const destination = storage.createEpochFile(recordingId, source, index);
  const temporary = `${destination}.fixture-pcm`;

  try {
    fs.writeFileSync(temporary, pcm);
    convertMeetingPcm(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
