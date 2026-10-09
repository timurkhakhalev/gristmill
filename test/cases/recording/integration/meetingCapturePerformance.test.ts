import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import type { MeetingFrameAlignmentSegment } from "../../../../src/contracts/meetingRecording.js";
import type { MeetingCaptureEpochStorage } from "../../../../src/helpers/meetingCaptureSession.js";
import { createDb } from "../../../helpers/harness/db.ts";

const { MeetingCaptureSession }: typeof import("../../../../src/helpers/meetingCaptureSession.js") =
  require("../../../../src/helpers/meetingCaptureSession.ts");

const FRAME_COUNT = 2400;
const SAMPLES = 100;
const HELPER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function segment(sequence: number): MeetingFrameAlignmentSegment {
  const start = Math.max(0, sequence * FRAME_COUNT - 96000);
  const end = (sequence + 1) * FRAME_COUNT;
  const ns = (frame: number) => String(1_000_000_000 + Math.round(frame / 24000 * 1e9));
  return {
    sourceGeneration: 1, sourceStartFrame: start, sourceEndFrame: end,
    timelineStartFrame: start, rate: 1, uncertaintyStartFrames: 2, uncertaintyEndFrames: 2,
    helperGeneration: HELPER, sourceStartNs: ns(start), sourceEndNs: ns(end),
    helperStartNs: ns(start), helperEndNs: ns(end), sampledSourceStartNs: ns(start),
    sampledSourceEndNs: ns(end), freshnessSourceNs: ns(end),
  };
}

// Seed the historical metadata in one transaction; advance the real session's
// packet counters separately. The measured path uses the real database adapter.
// Encoding is excluded here: the fixture counts PCM frames instead of encoding them.
test("capture packet cost stays below the 100ms arrival interval after two hours", async (t) => {
  const db = createDb(t);
  if (!db) return;
  const ref = process.env.GRISTMILL_CAPTURE_BENCH_REF;
  if (ref) {
    // Load the historical methods against the same isolated fixture and dependencies.
    // The source path keeps relative imports on the canonical test loader's graph.
    const filename = path.resolve("src/helpers/database.ts");
    const source = execFileSync("git", ["show", `${ref}:src/helpers/database.ts`], { encoding: "utf8" });
    const ts: typeof import("typescript") = require("typescript");
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const loaded = { exports: {} as { DatabaseManager: { prototype: typeof db } } };
    vm.runInThisContext(`(function(exports, require, module, __filename, __dirname) {${js}\n})`, { filename })(loaded.exports, createRequire(filename), loaded, filename, path.dirname(filename));
    db.addMeetingRecordingEpochAlignment = loaded.exports.DatabaseManager.prototype.addMeetingRecordingEpochAlignment;
    db.getMeetingRecordingEpoch = loaded.exports.DatabaseManager.prototype.getMeetingRecordingEpoch;
    db.db!.exec("DROP INDEX IF EXISTS idx_meeting_alignment_coverage");
  }
  const reports: Array<{ minutes: number; segments: number; wallMs: number[]; cpuMs: number; frames: number }> = [];
  for (const minutes of [0, 5, 53, 120]) {
    const note = db.saveNote("Synthetic capture performance", "", "meeting").note!;
    const counts = new Map<string, number>();
    const storage: MeetingCaptureEpochStorage = {
      openEpochWriter: (_id, source, index) => { counts.set(`${source}:${index}`, 0); },
      appendEpochSamples: (_id, source, index, data) => {
        const key = `${source}:${index}`;
        counts.set(key, (counts.get(key) ?? 0) + data.length / 2);
      },
      closeEpochWriter: () => {},
      recoverEpoch: (_id, source, index) => ({ frameCount: counts.get(`${source}:${index}`) ?? 0, ignoredTrailingBytes: 0, errorCode: null }),
    };
    const adapter = Object.create(db) as typeof db;
    adapter.addMeetingRecordingEpochAlignment = (id, source, index) => db.getMeetingRecordingEpoch(id, source, index)!;
    const capture = MeetingCaptureSession.create(adapter, storage, note.id, null);
    const pcm = Buffer.alloc(FRAME_COUNT * 2);
    const append = (sequence: number) => capture.appendRendererSamples("mic", {
      epochIndex: 0, epochSourceStartFrame: 0, sourceFrameStart: sequence * FRAME_COUNT,
      sourceGeneration: 1, sequence, sampleOffset: sequence * FRAME_COUNT,
      alignment: segment(sequence), alignmentErrorCode: "clock-unavailable",
    }, pcm);
    const packets = minutes * 60 * 10;
    for (let sequence = 0; sequence < packets; sequence++) append(sequence);
    if (packets) {
      const insert = db.db!.prepare(`INSERT INTO meeting_recording_epoch_alignments
        (recording_id,source,epoch_index,segment_index,source_generation,source_start_frame,source_end_frame,
         timeline_start_frame,rate,uncertainty_start_frames,uncertainty_end_frames,helper_generation,
         source_start_ns,source_end_ns,helper_start_ns,helper_end_ns,sampled_source_start_ns,sampled_source_end_ns,freshness_source_ns)
        VALUES (?,'mic',0,?,1,?,?,?,1,2,2,?,?,?,?,?,?,?,?)`);
      db.db!.transaction(() => {
        for (let sequence = 0; sequence < packets; sequence++) {
          const s = segment(sequence);
          insert.run(capture.recordingId, sequence, s.sourceStartFrame, s.sourceEndFrame, s.timelineStartFrame,
            HELPER, s.sourceStartNs, s.sourceEndNs, s.helperStartNs, s.helperEndNs,
            s.sampledSourceStartNs, s.sampledSourceEndNs, s.freshnessSourceNs);
        }
      })();
    }
    adapter.addMeetingRecordingEpochAlignment = db.addMeetingRecordingEpochAlignment.bind(db);
    const wallMs: number[] = [];
    const cpuStart = process.cpuUsage();
    for (let sequence = packets; sequence < packets + SAMPLES; sequence++) {
      const start = performance.now();
      append(sequence);
      wallMs.push(Number((performance.now() - start).toFixed(3)));
    }
    const cpu = process.cpuUsage(cpuStart);
    const frames = counts.get("mic:0")!;
    assert.equal(frames, (packets + SAMPLES) * FRAME_COUNT);
    reports.push({ minutes, segments: packets, wallMs, cpuMs: (cpu.user + cpu.system) / 1000, frames });
    const result = await capture.stop({ lastSequence: { mic: packets + SAMPLES - 1 } });
    assert.equal(result.errorCode, "source-unavailable", "the synthetic workload deliberately has no system source");
  }
  const summaries = reports.map(({ wallMs, ...report }) => {
    const sorted = [...wallMs].sort((a, b) => a - b);
    return { ...report, samples: sorted.length, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], maxMs: sorted.at(-1)! };
  });
  console.log("CAPTURE_PERFORMANCE", JSON.stringify(summaries));
  if (process.env.GRISTMILL_CAPTURE_BENCH_REPORT)
    fs.writeFileSync(process.env.GRISTMILL_CAPTURE_BENCH_REPORT, JSON.stringify(reports, null, 2));
  for (const report of summaries) {
    assert.ok(report.p95Ms < 100,
      `${report.minutes} minutes: p95 packet processing must keep up with 100ms packets: ${JSON.stringify(report)}`);
  }
  assert.ok(summaries[3].medianMs <= Math.max(2, summaries[1].medianMs * 4), "Two-hour capture must retain the five-minute processing budget");
});
