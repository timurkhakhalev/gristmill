import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { meetingResamplerManifest, meetingResamplerMappingText } from "../../../../src/helpers/meetingResamplerMapping.ts";
import { calibratedEpoch } from "../../../helpers/harness/meetingResampler.ts";

const binary = path.resolve("resources/bin/meeting-resampler");
function fixture(t: import("node:test").TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-resampler-native-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.ok(fs.existsSync(binary), "compile:native must produce the real bundled helper");
  return { dir, output: path.join(dir, "output.f32") };
}
function input(file: string, count: number, sample: (index: number) => number) {
  const values = new Float32Array(count);
  for (let i = 0; i < count; i++) values[i] = sample(i);
  fs.writeFileSync(file, Buffer.from(values.buffer));
}
function run(file: string, mapping: string, output: string, extent: number, frames: number, mode = "create") {
  const result = spawnSync(binary, [file, mapping, output, String(extent), String(frames), mode], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const metrics = JSON.parse(result.stdout) as { continuousRuns: number; maxEndpointRoundingFrames: number };
  assert.ok(metrics.maxEndpointRoundingFrames <= 2);
  assert.equal(fs.statSync(output).size, extent * 4);
  return metrics;
}
function samples(file: string) {
  const buffer = fs.readFileSync(file);
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}
for (const jitter of [-50, -1, 1, 50]) test(`native continuous tone and markers retain ${jitter}-frame reconciliation`, t => {
  const { dir, output } = fixture(t);
  const epoch = calibratedEpoch([{ frames: 96000, start: 2000, rate: 1.0002 }, { frames: 96000, start: 98019 + jitter, rate: 0.9998 }, { frames: 96000, start: 194000 + jitter, rate: 1.0001 }]);
  const extent = 300000;
  const source = path.join(dir, "input.f32"), mapping = path.join(dir, "mapping");
  const manifest = meetingResamplerManifest("mic", [epoch], () => source, extent);
  assert.ok(manifest.epochs[0].rows.slice(1).every(row => !row.reset));
  fs.writeFileSync(mapping, meetingResamplerMappingText(manifest.epochs[0].rows));
  input(source, epoch.frameCount, i => 0.2 * Math.sin(2 * Math.PI * 220 * i / 24000));
  const original = fs.readFileSync(source);
  const rounding = run(source, mapping, output, extent, epoch.frameCount);
  assert.equal(rounding.continuousRuns, 1);
  assert.deepEqual(fs.readFileSync(source), original);
  const tone = samples(output);
  let maximumStep = 0;
  for (const row of manifest.epochs[0].rows.slice(1)) {
    let step = 0;
    for (let i = row.timelineStart - 100; i < row.timelineStart + 100; i++) step = Math.max(step, Math.abs(tone[i + 1] - tone[i]));
    maximumStep = Math.max(maximumStep, step);
    assert.ok(step < 0.02, `accepted join step ${step}`);
  }
  assert.ok(tone.slice(0, 2000).every(value => value === 0));
  assert.ok(tone.slice(manifest.epochs[0].rows.at(-1)!.timelineEnd).every(value => value === 0));
  const markers = [24000, 120000, 216000];
  input(source, epoch.frameCount, i => markers.reduce((sum, marker) => sum + Math.exp(-Math.pow((i - marker) / 8, 2)), 0));
  fs.rmSync(output);
  run(source, mapping, output, extent, epoch.frameCount);
  const pulse = samples(output);
  let maximumMarkerError = 0;
  for (let k = 0; k < markers.length; k++) {
    const row = manifest.epochs[0].rows[k];
    const expected = row.timelineStart + (markers[k] - row.inputStart) * (row.timelineEnd - row.timelineStart) / (row.inputEnd - row.inputStart);
    let peak = Math.round(expected);
    for (let i = Math.round(expected) - 96; i <= Math.round(expected) + 96; i++) if (pulse[i] > pulse[peak]) peak = i;
    maximumMarkerError = Math.max(maximumMarkerError, Math.abs(peak - expected));
    assert.ok(Math.abs(peak - expected) <= 96, `marker error exceeds 4ms: ${peak - expected}`);
    assert.ok(pulse[peak] > 0.9);
  }
  console.log("RESAMPLER_SYNTHETIC", JSON.stringify({ jitter, maximumStep, maximumMarkerError, maxEndpointRoundingFrames: rounding.maxEndpointRoundingFrames }));
});
for (const gap of [500, -500, 50, -50]) test(`rejected ${gap > 0 ? "gap" : "overlap"} preserves placement and independent sum`, t => {
  const { dir, output } = fixture(t);
  const uncertainty = Math.abs(gap) === 50 ? 10 : 600;
  const epoch = calibratedEpoch([{ frames: 96000, start: 1000, uncertainty }, { frames: 96000, start: 97000 + gap, uncertainty }]);
  const source = path.join(dir, "input.f32"), mapping = path.join(dir, "mapping");
  const manifest = meetingResamplerManifest("mic", [epoch], () => source, 200000);
  assert.equal(manifest.decisions[0].reason, Math.abs(gap) === 50 ? "uncertainty" : "effective-rate");
  fs.writeFileSync(mapping, meetingResamplerMappingText(manifest.epochs[0].rows));
  input(source, epoch.frameCount, i => i < 96000 ? 0.1 : 0.2);
  assert.equal(run(source, mapping, output, 200000, epoch.frameCount).continuousRuns, 2);
  const mixed = samples(output);
  if (gap > 0) assert.ok(mixed.slice(97000, 97000 + gap).every(value => value === 0));
  else for (let i = 97000 + gap + 20; i < 96980; i++) assert.ok(Math.abs(mixed[i] - 0.3) < 0.00001, `independent overlap sum ${mixed[i]}`);
});
for (const gap of [0, 2]) test(`actual epoch and generation boundaries reset with ${gap}-sample gap`, t => {
  const { dir, output } = fixture(t);
  const epochs = [calibratedEpoch([{ frames: 24000, start: 1000 }]), calibratedEpoch([{ frames: 24000, start: 25000 + gap }], 1, 2)];
  const manifest = meetingResamplerManifest("mic", epochs, epoch => path.join(dir, `epoch-${epoch.epochIndex}.f32`), 50000);
  assert.equal(manifest.boundaryResets, 1); assert.equal(manifest.decisions.length, 0);
  for (const [i, epoch] of manifest.epochs.entries()) {
    const mapping = path.join(dir, `mapping-${i}`);
    fs.writeFileSync(mapping, meetingResamplerMappingText(epoch.rows));
    input(epoch.inputPath, epoch.inputFrames, () => i ? 0.2 : 0.1);
    assert.equal(run(epoch.inputPath, mapping, output, 50000, epoch.inputFrames, i ? "add" : "create").continuousRuns, 1);
  }
  const audio = samples(output);
  assert.ok(audio.slice(25000, 25000 + gap).every(value => value === 0));
  assert.ok(Math.abs(audio[10000] - 0.1) < 0.00001);
  assert.ok(Math.abs(audio[35000] - 0.2) < 0.00001);
});
test("sequential epochs add distinct signals into overlapping timelines", t => {
  const { dir, output } = fixture(t);
  const epochs = [calibratedEpoch([{ frames: 24000, start: 1000 }]), calibratedEpoch([{ frames: 24000, start: 12000 }], 1)];
  const manifest = meetingResamplerManifest("mic", epochs, epoch => path.join(dir, `epoch-${epoch.epochIndex}.f32`), 40000);
  for (const [i, epoch] of manifest.epochs.entries()) {
    const mapping = path.join(dir, `mapping-${i}`);
    fs.writeFileSync(mapping, meetingResamplerMappingText(epoch.rows));
    input(epoch.inputPath, epoch.inputFrames, frame => i ? 0.2 * Math.sin(2 * Math.PI * 100 * (frame + 12000) / 24000) : 0.1);
    run(epoch.inputPath, mapping, output, 40000, epoch.inputFrames, i ? "add" : "create");
  }
  const audio = samples(output);
  for (let i = 13000; i < 24000; i++) assert.ok(Math.abs(audio[i] - (0.1 + 0.2 * Math.sin(2 * Math.PI * 100 * i / 24000))) < 0.0001);
});
test("more than 4096 calibration rows and ranges longer than 60 seconds have bounded processing", t => {
  const { dir, output } = fixture(t);
  const frames = 4100 * 2400;
  const source = path.join(dir, "input.f32"), mapping = path.join(dir, "mapping");
  const fd = fs.openSync(source, "w"); fs.ftruncateSync(fd, frames * 4); fs.closeSync(fd);
  fs.writeFileSync(mapping, Array.from({ length: 4100 }, (_, i) => `${i * 2400} ${(i + 1) * 2400} ${i * 2400} ${(i + 1) * 2400} ${i === 0 ? 1 : 0}\n`).join(""));
  assert.equal(run(source, mapping, output, frames + 3, frames).continuousRuns, 1);
  fs.rmSync(output);
  fs.writeFileSync(mapping, `0 ${frames} 0 ${frames} 1\n`);
  run(source, mapping, output, frames + 3, frames);
  fs.rmSync(output);
  const starts = Array.from({ length: 4101 }, (_, i) => i * 2400 + i % 3);
  fs.writeFileSync(mapping, starts.slice(0, -1).map((start, i) => `${i * 2400} ${(i + 1) * 2400} ${start} ${starts[i + 1]} ${i === 0 ? 1 : 0}\n`).join(""));
  assert.equal(run(source, mapping, output, frames + 3, frames).continuousRuns, 1);
});
test("extent and input duration exceed the prototype 8000-second cap", t => {
  const { dir, output } = fixture(t);
  const frames = 24000 * 8001;
  const source = path.join(dir, "input.f32"), mapping = path.join(dir, "mapping");
  const fd = fs.openSync(source, "w"); fs.ftruncateSync(fd, frames * 4); fs.closeSync(fd);
  fs.writeFileSync(mapping, `0 ${frames} 2 ${frames + 2} 1\n`);
  run(source, mapping, output, frames + 5, frames);
});
for (const rate of [0.999, 1.001, 1.0002, 0.9998]) test(`run-end rounding remains at most two samples at rate ${rate}`, t => {
  const { dir, output } = fixture(t);
  const epoch = calibratedEpoch(Array.from({ length: 30 }, (_, i) => ({ frames: 96000, start: Math.round(i * 96000 * rate) + 1000, rate, uncertainty: 100 })));
  const source = path.join(dir, "input.f32"), mapping = path.join(dir, "mapping");
  const manifest = meetingResamplerManifest("mic", [epoch], () => source, 3000000);
  input(source, epoch.frameCount, i => 0.2 * Math.sin(2 * Math.PI * 100 * i / 24000));
  fs.writeFileSync(mapping, meetingResamplerMappingText(manifest.epochs[0].rows));
  run(source, mapping, output, 3000000, epoch.frameCount);
});
test("malformed, overflow, extra, truncated and incomplete mapping cannot create output", t => {
  const { dir, output } = fixture(t);
  const source = path.join(dir, "input.f32"), mapping = path.join(dir, "mapping");
  input(source, 2400, () => 0);
  for (const text of ["0 2400 0 2400 1 extra\n", "0 2400 0 2400 1", "0 2400 0 2400 2\n", "0 2400 0 99999999999999999999 1\n", "0 1200 0 1200 1\n", "1 2400 0 2400 1\n", "0 2400 0 2400 0\n", "0 2400 0 2500 1\n", "0 2400 0 2400 1\n\n", "0 2400 0 NaN 1\n", "0 2400 0 2400 1\n0 2400 0 2400 1\n", "0 2400 0 2400 " + "1".repeat(300) + "\n", ""]) {
    fs.writeFileSync(mapping, text);
    const result = spawnSync(binary, [source, mapping, output, "3000", "2400", "create"], { encoding: "utf8" });
    assert.equal(result.status, 2, result.stderr); assert.ok(result.stderr.length < 256); assert.ok(!fs.existsSync(output));
  }
  fs.writeFileSync(mapping, "0 2400 0 2400 1\n");
  fs.truncateSync(source, 2399 * 4);
  assert.equal(spawnSync(binary, [source, mapping, output, "3000", "2400", "create"]).status, 3);
  assert.ok(!fs.existsSync(output));
  fs.truncateSync(source, 2401 * 4);
  assert.equal(spawnSync(binary, [source, mapping, output, "3000", "2400", "create"]).status, 3);
  assert.ok(!fs.existsSync(output));
});
test("nonfinite input and I/O errors have distinct fixed failures", t => {
  const { dir, output } = fixture(t);
  const source = path.join(dir, "input.f32"), mapping = path.join(dir, "mapping");
  fs.writeFileSync(mapping, "0 2400 0 2400 1\n");
  input(source, 2400, () => NaN);
  assert.equal(spawnSync(binary, [source, mapping, output, "3000", "2400", "create"]).status, 3);
  assert.equal(spawnSync(binary, [source, mapping, path.join(dir, "absent", "out"), "3000", "2400", "create"]).status, 4);
});

test("clipped asymmetric uncertainty admits only the conservative fixed-anchor join", t => {
  const { dir, output } = fixture(t);
  const epoch = calibratedEpoch([{ frames: 96000, start: 0, uncertainty: 2, endUncertainty: 100 }, { frames: 96000, start: 96050, uncertainty: 2, endUncertainty: 100 }]);
  epoch.sourceStartFrame = 12000; epoch.frameCount = 168000;
  const source = path.join(dir, "input.f32"), mapping = path.join(dir, "mapping");
  const manifest = meetingResamplerManifest("mic", [epoch], () => source, 200000);
  assert.equal(manifest.decisions[0].reason, "accepted");
  assert.equal(manifest.epochs[0].rows[0].timelineStart, 12000);
  assert.equal(manifest.epochs[0].rows.at(-1)!.timelineEnd, 180050);
  input(source, epoch.frameCount, i => 0.2 * Math.sin(2 * Math.PI * 220 * i / 24000));
  fs.writeFileSync(mapping, meetingResamplerMappingText(manifest.epochs[0].rows));
  assert.equal(run(source, mapping, output, 200000, epoch.frameCount).continuousRuns, 1);
  const audio = samples(output);
  for (let i = 95950; i < 96150; i++) assert.ok(Math.abs(audio[i + 1] - audio[i]) < 0.02);
  assert.ok(audio.slice(0, 12000).every(value => value === 0));
  assert.ok(audio.slice(180050).every(value => value === 0));
});

test("independent native source timelines retain mic-left/system-right identity", t => {
  const { dir } = fixture(t);
  const sources = ["mic", "system"] as const;
  const outputs: string[] = [];
  for (const [i, source] of sources.entries()) {
    const epoch = { ...calibratedEpoch([{ frames: 24000, start: 1000 }]), source };
    const decoded = path.join(dir, `${source}.f32`), mapping = path.join(dir, `${source}.mapping`), output = path.join(dir, `${source}.timeline.f32`);
    const manifest = meetingResamplerManifest(source, [epoch], () => decoded, 30000);
    assert.equal(manifest.source, source);
    input(decoded, epoch.frameCount, () => i ? -0.25 : 0.125);
    fs.writeFileSync(mapping, meetingResamplerMappingText(manifest.epochs[0].rows));
    run(decoded, mapping, output, 30000, epoch.frameCount);
    outputs.push(output);
  }
  const ffmpeg: string = require("ffmpeg-static");
  const stereo = path.join(dir, "stereo.f32");
  const args = ["-hide_banner", "-loglevel", "error", ...outputs.flatMap(file => ["-f", "f32le", "-ar", "24000", "-ac", "1", "-i", file]), "-filter_complex", "[0:a][1:a]join=inputs=2:channel_layout=stereo:map=0.0-FL|1.0-FR[out]", "-map", "[out]", "-f", "f32le", stereo];
  const result = spawnSync(ffmpeg, args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const audio = samples(stereo);
  assert.equal(audio.length, 30000 * 2);
  for (let i = 2000; i < 24000; i++) {
    assert.ok(Math.abs(audio[i * 2] - 0.125) < 0.00001);
    assert.ok(Math.abs(audio[i * 2 + 1] + 0.25) < 0.00001);
  }
  assert.ok(audio.slice(0, 2000).every(value => value === 0));
  assert.ok(audio.slice(25000 * 2).every(value => value === 0));
});
