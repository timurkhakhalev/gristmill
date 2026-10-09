import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createDb } from "../../../helpers/harness/db.ts";
import { getUserDataDir } from "../../../helpers/harness/electronStub.ts";
import { MeetingRecordingStorage } from "../../../../src/helpers/meetingRecordingStorage.ts";
import { prepareMeetingAudio } from "../../../../src/helpers/meetingAudioMixer.ts";
import { alignedAudioRanges } from "../../../../src/helpers/meetingAudioAlignment.ts";
import { convertMeetingPcm } from "../../../../src/helpers/meetingOpus.ts";
import { getFFmpegPath } from "../../../../src/helpers/ffmpegUtils.ts";
import type { MeetingFrameAlignmentSegment } from "../../../../src/contracts/meetingRecording.ts";

const sampleRate = 24_000;
const variants = ["current", "resample-once", "segment", "concat", "segment-concat"] as const;
type Variant = typeof variants[number];

function setting(name: string, fallback: number, maximum: number, minimum = 1): number {
  const value = Number(process.env[name] ?? fallback);
  assert.ok(Number.isInteger(value) && value >= minimum && value <= maximum, `${name}: invalid value`);
  return value;
}

// Experimental graph edits are confined to this stand, never shipped to the app.
function experiment(graph: string, variant: Variant): string {
  if (variant === "current") return graph;
  const filters = graph.split(";").map((filter) =>
    filter.replace(/^(\[\d+:a\])asplit=/, "$1aresample=24000,asplit=")
      .replace(/^(\[src\d+\])aresample=24000,/, "$1")
  );
  if (variant === "segment" || variant === "segment-concat") {
    const bounds = new Map<string, { start: number; end: number }>();
    for (const filter of filters) {
      const match = /^\[(src\d+)\]atrim=start_sample=(\d+):end_sample=(\d+),/.exec(filter);
      if (match) bounds.set(match[1], { start: Number(match[2]), end: Number(match[3]) });
    }
    for (let i = 0; i < filters.length; i++) {
      const split = /asplit=(\d+)((?:\[src\d+\])+)$/.exec(filters[i]);
      if (split) {
        const labels = [...split[2].matchAll(/\[(src\d+)\]/g)].map((match) => match[1]);
        assert.equal(labels.length, Number(split[1]));
        let cursor = 0;
        const ends = labels.map((label) => {
          const bound = bounds.get(label);
          assert.ok(bound);
          assert.equal(bound.start, cursor, "asegment requires consecutive source coverage");
          cursor = bound.end;
          return cursor;
        });
        filters[i] = filters[i].replace(split[0], `asegment=samples=${ends.slice(0, -1).join("|")}${split[2]}`);
      } else {
        filters[i] = filters[i].replace(/^(\[src\d+\])atrim=start_sample=\d+:end_sample=\d+,/, "$1");
      }
    }
  }
  if (variant === "resample-once" || variant === "segment") return filters.join(";");

  const ranges = new Map<string, { start: number; frames: number }>();
  const pieces = filters.map((original) => {
    const filter = original.replace(/aresample=24000,/g, "aresample=24000,aformat=sample_fmts=flt,");
    const match = /,atrim=end_sample=(\d+),adelay=(\d+)S:all=1\[(a\d+)\]$/.exec(filter);
    if (!match) return filter;
    ranges.set(match[3], { start: Number(match[2]), frames: Number(match[1]) });
    return filter.replace(/,adelay=\d+S:all=1/, ",asetpts=N/SR/TB");
  });
  assert.ok(ranges.size > 0, "mixer graph changed: prototype must be updated explicitly");
  return pieces.flatMap((filter) => {
    const match = /^((?:\[a\d+\])+)amix=inputs=(\d+):duration=longest:dropout_transition=0:normalize=0,(.*)$/.exec(filter);
    if (!match) return [filter];
    const labels = [...match[1].matchAll(/\[(a\d+)\]/g)].map((item) => item[1]);
    assert.equal(labels.length, Number(match[2]));
    let cursor = 0;
    const prefix: string[] = [];
    const sequence: string[] = [];
    for (const label of labels) {
      const range = ranges.get(label);
      assert.ok(range);
      assert.ok(range.start >= cursor, "concat prototype does not support overlapping ranges");
      if (range.start > cursor) {
        const gap = `gap${label}`;
        prefix.push(`anullsrc=r=24000:cl=mono,aformat=sample_fmts=flt,atrim=end_sample=${range.start - cursor},asetpts=PTS-STARTPTS[${gap}]`);
        sequence.push(`[${gap}]`);
      }
      sequence.push(`[${label}]`);
      cursor = range.start + range.frames;
    }
    return [...prefix, `${sequence.join("")}concat=n=${sequence.length}:v=0:a=1,${match[3]}`];
  }).join(";");
}

function segment(start: number, end: number, timeline: number, rate: number): MeetingFrameAlignmentSegment {
  const ns = (frame: number) => String(1e9 + Math.round(frame / sampleRate * 1e9));
  return {
    sourceGeneration: 1, sourceStartFrame: start, sourceEndFrame: end,
    timelineStartFrame: timeline, rate, uncertaintyStartFrames: 2, uncertaintyEndFrames: 2,
    helperGeneration: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sourceStartNs: ns(start), sourceEndNs: ns(end), helperStartNs: ns(start), helperEndNs: ns(end),
    sampledSourceStartNs: ns(start), sampledSourceEndNs: ns(end), freshnessSourceNs: ns(end),
  };
}

test("mixer prototypes reject unsupported coverage instead of changing its meaning", () => {
  const graph = "[0:a]asplit=2[src0][src1];" +
    "[src0]aresample=24000,atrim=start_sample=0:end_sample=100,asetpts=PTS-STARTPTS,apad=whole_len=100,atrim=end_sample=100,adelay=0S:all=1[a0];" +
    "[src1]aresample=24000,atrim=start_sample=100:end_sample=200,asetpts=PTS-STARTPTS,apad=whole_len=100,atrim=end_sample=100,adelay=90S:all=1[a1];" +
    "[a0][a1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,apad=whole_len=200,atrim=end_sample=200[out]";
  assert.throws(() => experiment(graph, "concat"), /overlapping ranges/);
  assert.throws(() => experiment(graph, "segment-concat"), /overlapping ranges/);
  assert.throws(() => experiment(graph.replace("start_sample=100", "start_sample=101"), "segment"), /consecutive source coverage/);
  assert.match(experiment(graph, "segment"), /adelay=90S/);
});

function pcmData(file: string): { start: number; bytes: number } {
  const fd = fs.openSync(file, "r");
  const header = Buffer.alloc(4096);
  let offset = 12;
  try {
    fs.readSync(fd, header, 0, header.length, 0);
    assert.equal(header.toString("ascii", 0, 4), "RIFF");
    while (header.toString("ascii", offset, offset + 4) !== "data") {
      const size = header.readUInt32LE(offset + 4);
      offset += 8 + size + (size % 2);
      assert.ok(offset + 8 <= header.length);
    }
  } finally { fs.closeSync(fd); }
  const bytes = header.readUInt32LE(offset + 4);
  return { start: offset + 8, bytes };
}

async function pcmHash(file: string): Promise<string> {
  const { start, bytes } = pcmData(file);
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file, { start, end: start + bytes - 1 })) hash.update(chunk);
  return hash.digest("hex");
}

function pcmDifference(reference: string, candidate: string) {
  const a = pcmData(reference), b = pcmData(candidate);
  assert.equal(a.bytes, b.bytes);
  const left = fs.openSync(reference, "r");
  try {
    const right = fs.openSync(candidate, "r");
    try {
      const expected = Buffer.alloc(65536), actual = Buffer.alloc(65536);
      let differentSamples = 0, firstSample: number | null = null, maxDelta = 0;
      for (let offset = 0; offset < a.bytes; offset += expected.length) {
        const length = Math.min(expected.length, a.bytes - offset);
        assert.equal(fs.readSync(left, expected, 0, length, a.start + offset), length);
        assert.equal(fs.readSync(right, actual, 0, length, b.start + offset), length);
        for (let i = 0; i < length; i += 2) {
          const delta = Math.abs(expected.readInt16LE(i) - actual.readInt16LE(i));
          if (delta) {
            differentSamples++;
            firstSample ??= (offset + i) / 2;
            maxDelta = Math.max(maxDelta, delta);
          }
        }
      }
      return { differentSamples, firstSample, maxDelta };
    } finally { fs.closeSync(right); }
  } finally { fs.closeSync(left); }
}

test("real mixer benchmark: calibration fan-out, resampling and sequential composition", { timeout: setting("GRISTMILL_MIXER_TIMEOUT", 60, 600) * variants.length * 1000 + 120_000 }, async (t) => {
  const seconds = setting("GRISTMILL_MIXER_SECONDS", 8, 3600);
  const count = setting("GRISTMILL_MIXER_RANGES", 8, 1000);
  const limitSeconds = setting("GRISTMILL_MIXER_TIMEOUT", 60, 600);
  const driftPpm = setting("GRISTMILL_MIXER_DRIFT_PPM", 200, 5000, 0);
  const frames = seconds * sampleRate;
  assert.ok(count <= frames);
  const db = createDb(t);
  if (!db) return;
  const ffmpeg = getFFmpegPath();
  assert.ok(ffmpeg, "benchmark requires bundled FFmpeg");
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const note = db.saveNote("Synthetic mixer benchmark", "", "meeting").note!;
  const recording = db.createMeetingRecording(note.id, { config: null }, "2026-01-01T00:00:00Z");
  let extent = 0;
  for (const source of ["mic", "system"] as const) {
    const destination = storage.createEpochFile(recording.id, source, 0);
    const raw = `${destination}.pcm`;
    const fd = fs.openSync(raw, "wx");
    try {
      const block = Buffer.alloc(sampleRate * 2);
      for (let second = 0; second < seconds; second++) {
        for (let i = 0; i < sampleRate; i++) {
          const frequency = (source === "mic" ? 317 : 811) + second % 13;
          block.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * i / sampleRate) * 5000), i * 2);
        }
        fs.writeFileSync(fd, block);
      }
    } finally { fs.closeSync(fd); }
    try { assert.equal(convertMeetingPcm(raw, destination), frames); }
    finally { fs.rmSync(raw, { force: true }); }
    db.createMeetingRecordingEpoch(recording.id, source, 0, 1, 0, null);
    db.updateMeetingRecordingEpochRecovery(recording.id, source, 0, storage.recoverEpoch(recording.id, source, 0));
    let cursor = source === "mic" ? 1200 : 0;
    const ranges = source === "mic" ? count : 1;
    for (let i = 0; i < ranges; i++) {
      const start = Math.floor(i * frames / ranges);
      const end = Math.floor((i + 1) * frames / ranges);
      const rate = source === "mic" ? (1 + (i % 2 ? driftPpm : -driftPpm) / 1e6) : 1;
      if (i > 0 && i % 7 === 0) cursor += 2400;
      db.addMeetingRecordingEpochAlignment(recording.id, source, 0, segment(start, end, cursor, rate));
      cursor += Math.round((end - start) * rate);
    }
    extent = Math.max(extent, cursor + 2400);
  }
  db.markMeetingRecordingFinalizing(recording.id);
  const finalized = db.finalizeMeetingRecording(recording.id, {
    captureState: "ready", endedAt: "2026-01-01T01:00:00Z", sourceMetadata: { captureEndFrame: extent },
  }).recording;
  const epochs = db.listMeetingRecordingEpochs(recording.id);
  assert.equal(epochs.flatMap(alignedAudioRanges).length, count + 1);
  const originals = epochs.map((epoch) => storage.getEpochFilePath(epoch.recordingId, epoch.source, epoch.epochIndex));
  const originalHashes = originals.map((file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
  console.log("MIXER_ENVIRONMENT", JSON.stringify({ platform: process.platform, arch: process.arch, runtime: process.version, ffmpeg: execFileSync(ffmpeg, ["-version"], { encoding: "utf8" }).split("\n")[0], revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() }));
  let reference: string | undefined;
  let referencePath: string | undefined;
  const failures: unknown[] = [];
  for (const variant of variants) {
    if (t.signal.aborted) break;
    const controller = new AbortController();
    const abort = () => controller.abort();
    t.signal.addEventListener("abort", abort, { once: true });
    const deadline = setTimeout(() => controller.abort(), limitSeconds * 1000);
    let maxRssKiB: number | null = null;
    let filters = 0;
    let outputBytes = 0;
    let childPid: number | undefined;
    let polling: ReturnType<typeof setInterval> | undefined;
    const start = performance.now();
    try {
      const result = await prepareMeetingAudio(storage, finalized, randomUUID(), epochs, {
        layout: "stereo", signal: controller.signal,
        deps: { ffmpegPath: () => ffmpeg, spawn(command, args, options) {
          const index = args.indexOf("-filter_complex") + 1;
          assert.ok(index > 0);
          args[index] = experiment(args[index], variant);
          filters = args[index].split(";").length;
          const child = spawn(command, args, options);
          childPid = child.pid;
          polling = setInterval(() => {
            if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
            try {
              const output = args.at(-1)!;
              if (fs.existsSync(output)) outputBytes = fs.statSync(output).size;
              const rss = Number(execFileSync("ps", ["-o", "rss=", "-p", String(child.pid)], { encoding: "utf8", timeout: 1000 }));
              if (Number.isFinite(rss)) maxRssKiB = Math.max(maxRssKiB ?? 0, rss);
            } catch { /* The owned child can exit between the check and ps. */ }
          }, 250);
          return child;
        } },
      });
      const wallMs = performance.now() - start;
      assert.equal(result.frameCount, extent);
      const hash = await pcmHash(result.path);
      console.log("MIXER_BENCHMARK", JSON.stringify({ seconds, ranges: count, driftPpm, variant, filterChains: filters, wallMs, maxRssKiB, pcmHash: hash, frameCount: extent }));
      if (reference && hash !== reference) console.log("MIXER_PCM_DIFFERENCE", JSON.stringify({ variant, ...pcmDifference(referencePath!, result.path) }));
      if ((variant === "resample-once" || variant === "segment") && reference) assert.equal(hash, reference, `${variant} must preserve PCM`);
      if (variant !== "current") console.log("MIXER_PROTOTYPE_VALIDATION", JSON.stringify({ variant, bitExact: reference ? hash === reference : null, productionReady: false }));
      if (variant === "current") { reference = hash; referencePath = result.path; }
      else fs.rmSync(result.path);
    } catch (error) {
      console.log("MIXER_BENCHMARK_FAILURE", JSON.stringify({ seconds, ranges: count, driftPpm, variant, filterChains: filters, wallMs: performance.now() - start, maxRssKiB, outputBytes, timedOut: controller.signal.aborted }));
      failures.push(error);
    } finally {
      t.signal.removeEventListener("abort", abort);
      clearTimeout(deadline);
      if (polling) clearInterval(polling);
      controller.abort();
      if (childPid) assert.throws(() => process.kill(childPid!, 0), { code: "ESRCH" }, "owned FFmpeg must have exited");
    }
  }
  assert.deepEqual(originals.map((file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex")), originalHashes);
  assert.equal(failures.length, 0, `benchmark variants failed: ${failures.map(String).join("; ")}`);
});
