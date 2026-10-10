import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import type { TestContext } from "node:test";
import { createDb } from "./db.ts";
import { getUserDataDir } from "./electronStub.ts";
import { MeetingRecordingStorage } from "../../../src/helpers/meetingRecordingStorage.ts";
import {
  prepareMeetingAudio,
  meetingSourceIntentionallyEmpty,
} from "../../../src/helpers/meetingAudioMixer.ts";
import { convertMeetingPcm } from "../../../src/helpers/meetingOpus.ts";
import {
  meetingResamplerDecisionSummary,
  type MeetingResamplerManifest,
} from "../../../src/helpers/meetingResamplerMapping.ts";
import type {
  MeetingFrameAlignmentSegment,
  MeetingSource,
} from "../../../src/contracts/meetingRecording.ts";
import { compareWaveforms } from "../../benchmarks/meeting-waveform-oracle.mts";
import { replayMeetingFixture, meetingAudioFileHash } from "./meetingPrivateFixture.ts";

type SignalEpoch = { source: MeetingSource; start: number; frames: number; rate: number };
const sr = 24000;
function signal(source: MeetingSource, frame: number) {
  const carrier = source === "mic" ? 317 : 811;
  const center = Math.round(frame / (sr * 4) - 0.5) * sr * 4 + sr * 2;
  return (
    0.08 * Math.sin((2 * Math.PI * carrier * frame) / sr) +
    0.15 *
      Math.exp(-(((frame - center) / 160) ** 2)) *
      Math.cos((2 * Math.PI * 1700 * (frame - center)) / sr)
  );
}
function alignment(
  start: number,
  end: number,
  timeline: number,
  rate: number,
  generation: number
): MeetingFrameAlignmentSegment {
  const ns = (frame: number) => String(1000000000n + (BigInt(frame) * 1000000000n) / 24000n);
  return {
    sourceGeneration: generation,
    sourceStartFrame: start,
    sourceEndFrame: end,
    timelineStartFrame: timeline,
    rate,
    uncertaintyStartFrames: 2,
    uncertaintyEndFrames: 5,
    helperGeneration: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sourceStartNs: ns(start),
    sourceEndNs: ns(end),
    helperStartNs: ns(start),
    helperEndNs: ns(end),
    sampledSourceStartNs: ns(start),
    sampledSourceEndNs: ns(end),
    freshnessSourceNs: ns(end),
  };
}
export async function productionBenchmark(
  t: TestContext,
  seconds: number | null,
  reportDirectory: string,
  copiedFixture?: string,
  allLayouts = false,
  binaries?: { ffmpeg: string; resampler: string }
) {
  const db = createDb(t);
  assert.ok(db);
  const storage = new MeetingRecordingStorage({ userDataPath: getUserDataDir() });
  const analytical: SignalEpoch[] = [],
    boundaries: Array<{ category: string; frame: number }> = [];
  let inputs: ReturnType<typeof replayMeetingFixture>;
  if (copiedFixture) inputs = replayMeetingFixture(copiedFixture, db, storage);
  else {
    assert.ok(seconds && Number.isSafeInteger(seconds) && seconds >= 12);
    const note = db.saveNote("Synthetic production benchmark", "", "meeting").note!;
    const recording = db.createMeetingRecording(note.id, { config: null }, "2026-01-01T00:00:00Z");
    let extent = 0;
    for (const source of ["mic", "system"] as const) {
      let cursor = source === "mic" ? 1200 : 0;
      for (let index = 0; index < 3; index++) {
        const frames = Math.floor((seconds * sr) / 3),
          rate = source === "mic" ? 1.0002 : 0.9998;
        if (index === 1) {
          boundaries.push({ category: "gap", frame: cursor });
          cursor += source === "mic" ? 6000 : 12000;
        }
        if (index === 2) {
          cursor -= 4800;
          boundaries.push({ category: "overlap", frame: cursor });
        }
        boundaries.push({ category: "generation", frame: cursor });
        analytical.push({ source, start: cursor, frames, rate });
        const destination = storage.createEpochFile(recording.id, source, index),
          raw = destination + ".fixture-pcm";
        const fd = fs.openSync(raw, "wx"),
          block = Buffer.alloc(sr * 2);
        try {
          for (let first = 0; first < frames; first += sr) {
            const length = Math.min(sr, frames - first);
            for (let j = 0; j < length; j++)
              block.writeInt16LE(Math.round(signal(source, first + j) * 32767), j * 2);
            fs.writeSync(fd, block, 0, length * 2);
          }
        } finally {
          fs.closeSync(fd);
        }
        try {
          assert.equal(convertMeetingPcm(raw, destination), frames);
        } finally {
          fs.rmSync(raw);
        }
        db.createMeetingRecordingEpoch(recording.id, source, index, index + 1, 0, null);
        db.updateMeetingRecordingEpochRecovery(
          recording.id,
          source,
          index,
          storage.recoverEpoch(recording.id, source, index)
        );
        for (let first = 0; first < frames; first += sr * 4) {
          const anchor = cursor + Math.round(first * rate);
          db.addMeetingRecordingEpochAlignment(
            recording.id,
            source,
            index,
            alignment(first, Math.min(frames, first + sr * 4), anchor, rate, index + 1)
          );
          if (
            first &&
            boundaries.filter((boundary) => boundary.category === "calibration").length < 12
          )
            boundaries.push({ category: "calibration", frame: anchor });
        }
        cursor += Math.round(frames * rate);
        extent = Math.max(extent, cursor);
      }
    }
    db.markMeetingRecordingFinalizing(recording.id);
    const finalized = db.finalizeMeetingRecording(recording.id, {
      captureState: "ready",
      endedAt: "2026-01-01T03:00:00Z",
      sourceMetadata: { captureEndFrame: extent },
    }).recording;
    inputs = [
      { recording: finalized, epochs: db.listMeetingRecordingEpochs(recording.id), intervals: [] },
    ];
  }
  fs.mkdirSync(reportDirectory, { recursive: true, mode: 0o700 });
  const reports = [];
  for (const [inputIndex, input] of inputs.entries()) {
    const originals = input.epochs
      .filter((epoch) => epoch.frameCount)
      .map((epoch) => storage.getEpochFilePath(epoch.recordingId, epoch.source, epoch.epochIndex));
    const hashes = originals.map(meetingAudioFileHash);
    const manifests: MeetingResamplerManifest[] = [];
    let cpuSeconds = 0,
      maxChildRssBytes = 0,
      peakTemporaryBytes = 0;
    const temporaryRoot = path.dirname(
      storage.getDerivedAudioPath(input.recording.id, randomUUID(), "stereo")
    );
    const disk = () => {
      const visit = (directory: string): number => {
        try {
          return fs.readdirSync(directory, { withFileTypes: true }).reduce((sum, entry) => {
            const file = path.join(directory, entry.name);
            try {
              return sum + (entry.isDirectory() ? visit(file) : fs.statSync(file).blocks * 512);
            } catch {
              return sum;
            }
          }, 0);
        } catch {
          return 0;
        }
      };
      peakTemporaryBytes = Math.max(peakTemporaryBytes, visit(temporaryRoot));
    };
    const measured = (command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
      const child = spawn("/usr/bin/time", ["-l", command, ...args], options);
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.once("close", () => {
        const cpu = /([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys/.exec(stderr);
        if (cpu) cpuSeconds += Number(cpu[2]) + Number(cpu[3]);
        const rss = /(\d+)\s+maximum resident set size/.exec(stderr);
        if (rss) maxChildRssBytes = Math.max(maxChildRssBytes, Number(rss[1]));
        disk();
      });
      return child;
    };
    const timer = setInterval(disk, 25),
      start = performance.now();
    const layouts =
      allLayouts || copiedFixture
        ? (["stereo", "mono", "mic", "system"] as const)
        : (["stereo"] as const);
    let stereo: Awaited<ReturnType<typeof prepareMeetingAudio>> | undefined;
    const prepared = [];
    try {
      for (const layout of layouts) {
        const result = await prepareMeetingAudio(
          storage,
          input.recording,
          randomUUID(),
          input.epochs,
          {
            layout,
            signal: t.signal,
            intentionalEmptySources: (["mic", "system"] as const).filter(
              (source) =>
                !input.epochs.some((epoch) => epoch.source === source && epoch.frameCount > 0) &&
                meetingSourceIntentionallyEmpty(
                  input.recording,
                  input.epochs,
                  input.intervals,
                  source
                )
            ),
            deps: {
              ...(binaries
                ? { ffmpegPath: () => binaries.ffmpeg, resamplerPath: () => binaries.resampler }
                : {}),
              spawn: measured,
              onMapping: (manifest) => {
                manifests.push(manifest);
              },
            },
          }
        );
        prepared.push({ layout, frameCount: result.frameCount });
        if (layout === "stereo") stereo = result;
      }
    } finally {
      clearInterval(timer);
    }
    const wallSeconds = (performance.now() - start) / 1000;
    assert.ok(stereo);
    assert.ok(prepared.every((result) => result.frameCount === stereo.frameCount));
    assert.deepEqual(originals.map(meetingAudioFileHash), hashes, "original source files changed");
    fs.copyFileSync(stereo.path, path.join(reportDirectory, `prepared-${inputIndex}.wav`));
    fs.chmodSync(path.join(reportDirectory, `prepared-${inputIndex}.wav`), 0o600);
    fs.writeFileSync(
      path.join(reportDirectory, `mapping-${inputIndex}.json`),
      JSON.stringify(manifests),
      { mode: 0o600 }
    );
    const wav = Buffer.alloc(4096),
      wavFd = fs.openSync(stereo.path, "r");
    t.after(() => fs.closeSync(wavFd));
    fs.readSync(wavFd, wav, 0, wav.length, 0);
    let data = 12;
    while (wav.toString("ascii", data, data + 4) !== "data")
      data += 8 + wav.readUInt32LE(data + 4) + (wav.readUInt32LE(data + 4) % 2);
    data += 8;
    const valueBuffer = Buffer.alloc(2);
    const sample = (frame: number, channel: number) => {
      if (frame < 0 || frame >= stereo.frameCount) return 0;
      assert.equal(fs.readSync(wavFd, valueBuffer, 0, 2, data + frame * 4 + channel * 2), 2);
      return valueBuffer.readInt16LE(0) / 32768;
    };
    const windows = [];
    if (!copiedFixture) {
      for (const source of ["mic", "system"] as const) {
        const sourceEpochs = analytical.filter((epoch) => epoch.source === source),
          first = sourceEpochs[0]!,
          next = sourceEpochs[1]!;
        const gapMiddle = Math.floor(
          (first.start + Math.round(first.frames * first.rate) + next.start) / 2
        );
        for (let i = -32; i <= 32; i++)
          assert.ok(
            Math.abs(sample(gapMiddle + i, source === "mic" ? 0 : 1)) <= 1 / 32768,
            "source gap must remain silent"
          );
      }
      boundaries.push(
        { category: "start", frame: 1200 },
        { category: "end", frame: stereo.frameCount - 1200 }
      );
      for (const boundary of boundaries)
        for (const [channel, source] of ["mic", "system"].entries()) {
          const expected = Float32Array.from({ length: 1024 }, (_, i) =>
            analytical
              .filter((epoch) => epoch.source === source)
              .reduce((sum, epoch) => {
                const position = (boundary.frame + i - 512 - epoch.start) / epoch.rate;
                return (
                  sum +
                  (position >= 0 && position < epoch.frames ? signal(epoch.source, position) : 0)
                );
              }, 0)
          );
          if (expected.reduce((sum, value) => sum + value * value, 0) < 1e-5) continue;
          const actual = Float32Array.from({ length: 2048 }, (_, i) =>
            sample(boundary.frame + i - 1024, channel)
          );
          const comparison = compareWaveforms(expected, actual, 1);
          assert.ok(
            comparison.fractional > 0.8,
            `${boundary.category} waveform: ${comparison.fractional}`
          );
          windows.push({ ...boundary, source, ...comparison });
        }
      // A narrow pulse envelope has an independent known timeline coordinate.
      for (const epoch of analytical) {
        const center = epoch.start + Math.round(sr * 2 * epoch.rate),
          channel = epoch.source === "mic" ? 0 : 1;
        let best = -Infinity,
          bestLag = 0;
        for (let lag = -160; lag <= 160; lag++) {
          let score = 0;
          for (let i = -160; i <= 160; i += 2)
            score +=
              sample(center + i + lag, channel) * signal(epoch.source, sr * 2 + i / epoch.rate);
          if (score > best) {
            best = score;
            bestLag = lag;
          }
        }
        assert.ok(Math.abs(bestLag) <= 96, "marker timing must stay within four milliseconds");
      }
    } else {
      const ffmpeg: string = require("ffmpeg-static");
      const selected = manifests
        .filter((manifest) => manifest.source === "mic" || manifest.source === "system")
        .slice(0, 2);
      const references: Array<{
        manifest: MeetingResamplerManifest;
        epoch: MeetingResamplerManifest["epochs"][number];
        fd: number;
      }> = [];
      for (const manifest of selected)
        for (const epoch of manifest.epochs) {
          const original = storage.getEpochFilePath(
            epoch.recordingId,
            manifest.source,
            epoch.epochIndex
          );
          const raw = path.join(reportDirectory, `reference-${references.length}.f32`);
          execFileSync(ffmpeg, [
            "-v",
            "error",
            "-xerror",
            "-y",
            "-i",
            original,
            "-ar",
            "48000",
            "-ac",
            "1",
            "-f",
            "f32le",
            raw,
          ]);
          fs.chmodSync(raw, 0o600);
          assert.equal(fs.statSync(raw).size, epoch.inputFrames * 8);
          const fd = fs.openSync(raw, "r");
          t.after(() => fs.closeSync(fd));
          references.push({ manifest, epoch, fd });
          for (const [index, row] of epoch.rows.entries()) {
            if (index === 0) boundaries.push({ category: "generation", frame: row.timelineStart });
            else {
              const previous = epoch.rows[index - 1]!;
              const delta = row.timelineStart - previous.timelineEnd;
              const hasDecision = manifest.decisions.some(
                (decision) =>
                  decision.epochPosition === manifest.epochs.indexOf(epoch) &&
                  decision.rangeIndex === index
              );
              boundaries.push({
                category:
                  delta > 0
                    ? "gap"
                    : delta < 0
                      ? "overlap"
                      : row.reset && !hasDecision
                        ? "generation"
                        : "calibration",
                frame: row.timelineStart,
              });
            }
          }
        }
      boundaries.push(
        { category: "start", frame: 1200 },
        { category: "end", frame: stereo.frameCount - 1200 }
      );
      const sourceBuffer = Buffer.alloc(8);
      for (const boundary of boundaries)
        for (const [channel, source] of ["mic", "system"].entries()) {
          const contributions = references
            .filter((reference) => reference.manifest.source === source)
            .flatMap((reference) =>
              reference.epoch.rows
                .filter(
                  (row) =>
                    row.timelineStart < boundary.frame + 512 &&
                    row.timelineEnd > boundary.frame - 512
                )
                .map((row) => ({ reference, row }))
            );
          // Independent affine sample interpolation sums every mapped contribution.
          const expected = Float32Array.from({ length: 1024 }, (_, i) => {
            const timeline = boundary.frame + i - 512;
            let sum = 0;
            for (const { reference, row } of contributions) {
              if (timeline < row.timelineStart || timeline >= row.timelineEnd) continue;
              const position =
                2 *
                (row.inputStart +
                  ((timeline - row.timelineStart) * (row.inputEnd - row.inputStart)) /
                    (row.timelineEnd - row.timelineStart));
              const first = Math.floor(position),
                fraction = position - first;
              if (first + 1 >= reference.epoch.inputFrames * 2) continue;
              assert.equal(fs.readSync(reference.fd, sourceBuffer, 0, 8, first * 4), 8);
              sum +=
                sourceBuffer.readFloatLE(0) * (1 - fraction) +
                sourceBuffer.readFloatLE(4) * fraction;
            }
            return Math.max(-1, Math.min(32767 / 32768, sum));
          });
          if (expected.reduce((sum, value) => sum + value * value, 0) < 1e-5) continue;
          const actual = Float32Array.from({ length: 2048 }, (_, i) =>
            sample(boundary.frame + i - 1024, channel)
          );
          const comparison = compareWaveforms(expected, actual, 1);
          windows.push({ ...boundary, source, ...comparison });
        }
      assert.ok(windows.length > 0, "private speech fixture must have audible comparison windows");
      fs.writeFileSync(
        path.join(reportDirectory, "waveform-windows.json"),
        JSON.stringify(windows),
        { mode: 0o600 }
      );
      assert.ok(
        windows.every((window) => window.fractional > 0.8),
        "private waveform comparison failed; detailed evidence remains private"
      );
    }
    const decisions = manifests.map(meetingResamplerDecisionSummary);
    if (!copiedFixture)
      for (const decision of decisions) {
        assert.equal(
          decision.candidates,
          3 * (Math.ceil(Math.floor((seconds! * sr) / 3) / (sr * 4)) - 1)
        );
        assert.equal(decision.accepted, decision.candidates);
        assert.equal(decision.rejected, 0);
        assert.equal(decision.boundaryResets, 2);
        assert.ok(decision.corrections.every((correction) => correction <= 1));
      }
    reports.push({
      prepared,
      wallSeconds,
      cpuSeconds,
      maxChildRssBytes,
      peakTemporaryBytes,
      decisions,
      manifests,
      windows,
      originalHashes: hashes,
    });
    const excerptBoundaries = [
      ...new Map(boundaries.map((boundary) => [boundary.category, boundary])).values(),
    ];
    const excerptFrames = excerptBoundaries.map((boundary) =>
      boundary.category === "start"
        ? 0
        : boundary.category === "end"
          ? Math.max(0, stereo.frameCount - sr * 5)
          : Math.max(0, boundary.frame - sr * 2.5)
    );
    fs.writeFileSync(
      path.join(reportDirectory, `excerpt-index-${inputIndex}.json`),
      JSON.stringify(excerptBoundaries),
      { mode: 0o600 }
    );
    for (const [index, first] of excerptFrames.entries()) {
      const ffmpeg: string = require("ffmpeg-static");
      execFileSync(ffmpeg, [
        "-v",
        "error",
        "-y",
        "-i",
        stereo.path,
        "-af",
        `atrim=start_sample=${Math.round(first)}:end_sample=${Math.min(stereo.frameCount, Math.round(first) + sr * 5)},asetpts=PTS-STARTPTS`,
        "-c:a",
        "pcm_s16le",
        path.join(reportDirectory, `excerpt-${inputIndex}-${index}.wav`),
      ]);
      fs.chmodSync(path.join(reportDirectory, `excerpt-${inputIndex}-${index}.wav`), 0o600);
    }
  }
  fs.writeFileSync(path.join(reportDirectory, "report.json"), JSON.stringify(reports, null, 2), {
    mode: 0o600,
  });
  return reports.map(
    ({ wallSeconds, cpuSeconds, maxChildRssBytes, peakTemporaryBytes, windows, decisions }) => ({
      wallSeconds,
      cpuSeconds,
      maxChildRssBytes,
      peakTemporaryBytes,
      windows: windows.length,
      decisions,
    })
  );
}
