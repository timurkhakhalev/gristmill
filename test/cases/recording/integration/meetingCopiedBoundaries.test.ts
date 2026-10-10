import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { createDb } from "../../../helpers/harness/db.ts";
import { getUserDataDir } from "../../../helpers/harness/electronStub.ts";
import { MeetingRecordingStorage } from "../../../../src/helpers/meetingRecordingStorage.ts";
import { savePcmEpoch } from "../../../lib/meetingAudioFixture.ts";
import { productionBenchmark } from "../../../helpers/harness/meetingMixerBenchmark.ts";

test("copied raw transport publishes both generation and inter-epoch gap/overlap categories", async (t) => {
  const db = createDb(t);
  assert.ok(db);
  const profile = getUserDataDir(),
    storage = new MeetingRecordingStorage({ userDataPath: profile });
  const note = db.saveNote("Synthetic boundaries", "", "meeting").note!;
  const recording = db.createMeetingRecording(note.id, { config: null }, "2026-01-01T00:00:00Z");
  for (const source of ["mic", "system"] as const)
    for (const [index, start] of [0, 48000, 60000].entries()) {
      db.createMeetingRecordingEpoch(recording.id, source, index, index + 1, 0, start);
      const pcm = Buffer.alloc(48000);
      for (let i = 0; i < 24000; i++)
        pcm.writeInt16LE(Math.round(4000 * Math.sin((i * Math.PI * 317) / 12000)), i * 2);
      savePcmEpoch(storage, recording.id, source, index, pcm);
      db.updateMeetingRecordingEpochRecovery(
        recording.id,
        source,
        index,
        storage.recoverEpoch(recording.id, source, index)
      );
    }
  db.markMeetingRecordingFinalizing(recording.id);
  db.finalizeMeetingRecording(recording.id, {
    captureState: "ready",
    endedAt: "2026-01-01T00:00:04Z",
    sourceMetadata: { captureEndFrame: 96000 },
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meeting-copied-boundaries-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const copied = path.join(root, "copied"),
    report = path.join(root, "report");
  execFileSync("python3", [
    "test/benchmarks/copy-meeting-for-prototype.py",
    profile,
    String(note.id),
    copied,
  ]);
  await productionBenchmark(t, null, report, copied);
  const schema = z.array(z.object({ category: z.string(), frame: z.number() }).passthrough());
  const index = schema.parse(
    JSON.parse(fs.readFileSync(path.join(report, "excerpt-index-0.json"), "utf8"))
  );
  for (const category of ["generation", "gap", "overlap", "start", "end"])
    assert.ok(
      index.some((boundary) => boundary.category === category),
      category
    );
  const windows = schema.parse(
    JSON.parse(fs.readFileSync(path.join(report, "waveform-windows-0.json"), "utf8"))
  );
  for (const frame of [48000, 60000]) {
    assert.ok(windows.some((window) => window.category === "generation" && window.frame === frame));
    assert.ok(
      windows.some(
        (window) =>
          window.category === (frame === 48000 ? "gap" : "overlap") && window.frame === frame
      )
    );
  }
});
