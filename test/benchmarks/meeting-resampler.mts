// Experimental only. Run: node test/benchmarks/meeting-resampler.mts [seconds ...]
// Requires the already-installed clang/pkg-config/libswresample development files.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const ffmpeg: string = require("ffmpeg-static");
const compareDecode = process.argv.includes("--compare-decode");
const durations = process.argv.slice(2).filter((arg) => arg !== "--compare-decode").map(Number);
if (!durations.length) durations.push(60);
assert.ok(durations.every((n) => Number.isInteger(n) && n >= 8 && n <= 7200));
assert.equal(process.platform, "darwin", "RSS accounting in this prototype is macOS-specific");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-resampler-"));
const executable = path.join(root, "resampler");
const sampleRate = 24000;
const owned = new Set<ReturnType<typeof spawn>>();
let interrupted = false;
const cancel = () => {
  interrupted = true;
  for (const child of owned) if (child.pid) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already closed. */ }
  }
};
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

async function run(command: string, args: string[], timeout = 120_000) {
  assert.equal(interrupted, false, "benchmark interrupted");
  const start = performance.now();
  const measured = command === ffmpeg;
  // macOS time reports bytes directly; FFmpeg 6.0 mislabels ru_maxrss on macOS.
  const child = spawn(measured ? "/usr/bin/time" : command,
    measured ? ["-l", command, ...args] : args,
    { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C" } });
  owned.add(child);
  let stdout = "", stderr = "", timedOut = false;
  child.stdout.on("data", (data: Buffer) => { stdout = (stdout + data).slice(-16000); });
  child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data).slice(-8000); });
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already closed. */ }
  }, timeout);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${command}: exit ${code}, timeout=${timedOut}: ${stderr}`)));
    });
    const cpu = /([\d.]+) user\s+([\d.]+) sys/.exec(stderr);
    const rss = /(\d+)\s+maximum resident set size/.exec(stderr);
    return { wallMs: performance.now() - start, stdout,
      cpuSeconds: cpu ? Number(cpu[1]) + Number(cpu[2]) : null,
      maxRssBytes: rss ? Number(rss[1]) : null };
  } finally {
    clearTimeout(timer);
    if (child.pid) {
      // A killed time wrapper can exit just before macOS reaps its FFmpeg child.
      for (let attempt = 0; attempt < 40; attempt++) {
        try { process.kill(-child.pid, 0); }
        catch { break; }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.throws(() => process.kill(-child.pid!, 0), { code: "ESRCH" }, "owned process group must be gone");
    }
    owned.delete(child);
  }
}

type Range = { first: number; last: number; start: number; end: number };
type Fixture = { raw: string; opus: string; decoded: string; corrected: string; mapping: string; ranges: Range[]; markers: number[]; extent: number };

function fixture(seconds: number, source: number, directory: string): Fixture {
  const raw = path.join(directory, `${source}.f32`);
  const ranges: Range[] = [], markers: number[] = [];
  const frames = seconds * sampleRate;
  let cursor = source === 0 ? 1200 : 0;
  let fractional = 0;
  const fd = fs.openSync(raw, "wx");
  const chunk = Buffer.alloc(4096 * 4);
  const count = Math.ceil(seconds / 4);
  try {
    for (let index = 0; index < count; index++) {
      const first = Math.floor(index * frames / count), last = Math.floor((index + 1) * frames / count);
      // Real discontinuities: a mute gap and a later source restart.
      if (index === Math.floor(count / 3) || index === Math.floor(count * 2 / 3)) cursor += source === 0 ? 6000 : 12000;
      const rate = 1 + (source === 0 ? 200 : -120) * Math.sin(index / 11 + 0.7) / 1e6;
      const exact = (last - first) * rate + fractional;
      const length = Math.round(exact);
      fractional = exact - length;
      const start = cursor, end = start + length;
      ranges.push({ first, last, start, end });
      const center = Math.floor((first + last) / 2);
      markers.push(start + Math.round((center - first) * length / (last - first)));
      for (let offset = first; offset < last; offset += 4096) {
        const size = Math.min(4096, last - offset);
        for (let i = 0; i < size; i++) {
          const position = offset + i;
          const pulse = 0.65 * Math.exp(-0.5 * ((position - center) / 48) ** 2) * Math.cos(2 * Math.PI * 1700 * (position - center) / sampleRate);
          const tone = 0.015 * Math.sin(2 * Math.PI * (source ? 811 : 317) * position / sampleRate);
          chunk.writeFloatLE(pulse + tone, i * 4);
        }
        assert.equal(fs.writeSync(fd, chunk, 0, size * 4), size * 4);
      }
      cursor = end;
    }
  } finally { fs.closeSync(fd); }
  const mapping = path.join(directory, `${source}.txt`);
  fs.writeFileSync(mapping, ranges.map((r) => `${r.first} ${r.last} ${r.start} ${r.end}`).join("\n") + "\n");
  return { raw, mapping, ranges, markers, extent: cursor + 2400,
    opus: path.join(directory, `${source}.opus`), decoded: path.join(directory, `${source}.decoded.f32`), corrected: path.join(directory, `${source}.corrected.f32`) };
}

function validate(file: string, dataStart: number, stride: number, channel: number, f: Fixture, extent: number) {
  const fd = fs.openSync(file, "r");
  const value = (buffer: Buffer, at: number) => stride === 4 && dataStart === 0 ? buffer.readFloatLE(at) : buffer.readInt16LE(at) / 32768;
  let maxMarkerErrorFrames = 0;
  let maxBoundaryStep = 0;
  try {
    for (const center of f.markers) {
      const radius = 480, samples = radius * 2 + 1;
      const window = Buffer.alloc(samples * stride);
      assert.equal(fs.readSync(fd, window, 0, window.length, dataStart + (center - radius) * stride), window.length);
      let best = 0, bestEnergy = -1;
      for (let i = 24; i < samples - 24; i++) {
        let energy = 0;
        for (let j = i - 24; j <= i + 24; j++) energy += value(window, j * stride + channel * 2) ** 2;
        if (energy > bestEnergy) { bestEnergy = energy; best = i; }
      }
      assert.ok(bestEnergy > 1, "marker missing or wrong channel");
      maxMarkerErrorFrames = Math.max(maxMarkerErrorFrames, Math.abs(best - radius));
    }
    // Independent temporal oracle: marker positions come from fixture coordinates.
    assert.ok(maxMarkerErrorFrames <= 96, `marker drift ${maxMarkerErrorFrames} frames exceeds 4ms`);
    for (let i = 1; i < f.ranges.length; i++) {
      if (f.ranges[i].start !== f.ranges[i - 1].end) continue;
      const window = Buffer.alloc(256 * stride);
      assert.equal(fs.readSync(fd, window, 0, window.length, dataStart + (f.ranges[i].start - 128) * stride), window.length);
      let energy = 0;
      for (let j = 1; j < 256; j++) {
        const current = value(window, j * stride + channel * 2);
        const previous = value(window, (j - 1) * stride + channel * 2);
        maxBoundaryStep = Math.max(maxBoundaryStep, Math.abs(current - previous));
        energy += current * current;
      }
      assert.ok(energy / 255 > 0.00002 && energy / 255 < 0.0004, "tone continuity lost at calibration boundary");
    }
    assert.ok(maxBoundaryStep < 0.02, "unexpected signal step at calibration boundary");
    const gaps = [{ start: 0, end: f.ranges[0].start },
      ...f.ranges.slice(1).map((r, i) => ({ start: f.ranges[i].end, end: r.start })),
      { start: f.ranges.at(-1)!.end, end: extent }];
    for (const gap of gaps.filter((g) => g.end - g.start > 100)) {
      const position = Math.floor((gap.start + gap.end) / 2);
      const sample = Buffer.alloc(stride);
      assert.equal(fs.readSync(fd, sample, 0, stride, dataStart + position * stride), stride);
      assert.equal(value(sample, channel * 2), 0, "real gap must remain silent");
    }
  } finally { fs.closeSync(fd); }
  return { markers: f.markers.length, maxMarkerErrorFrames, maxMarkerErrorMs: maxMarkerErrorFrames / 24, maxBoundaryStep };
}

async function hash(file: string) {
  const result = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) result.update(chunk);
  return result.digest("hex");
}

try {
  const flags = execFileSync("pkg-config", ["--cflags", "--libs", "libswresample", "libavutil"], { encoding: "utf8" }).trim().split(/\s+/);
  await run("clang", ["-O2", "-Wall", "-Wextra", "-Werror", "test/benchmarks/meeting-resampler.c", ...flags, "-o", executable]);
  console.log("RESAMPLER_ENVIRONMENT", JSON.stringify({ platform: process.platform, arch: process.arch,
    runtime: process.version, libraries: execFileSync("pkg-config", ["--modversion", "libswresample", "libavutil"], { encoding: "utf8" }).trim(),
    decoder: execFileSync(ffmpeg, ["-version"], { encoding: "utf8" }).split("\n")[0] }));
  const invalidInput = path.join(root, "invalid.f32"), invalidMap = path.join(root, "invalid.txt"), invalidOutput = path.join(root, "invalid-output.f32");
  fs.writeFileSync(invalidInput, Buffer.alloc(400));
  for (const mapping of ["0 50 0 50\n50 100 49 99\n", "0 50 0 50\n51 100 50 99\n"]) {
    fs.writeFileSync(invalidMap, mapping);
    await assert.rejects(run(executable, [invalidInput, invalidMap, invalidOutput, "100"]), /unsupported source gap or output overlap/);
    assert.equal(fs.existsSync(invalidOutput), false);
  }
  fs.writeFileSync(invalidMap, "0 101 0 101\n");
  await assert.rejects(run(executable, [invalidInput, invalidMap, invalidOutput, "101"]), /input length mismatch/);
  assert.equal(fs.existsSync(invalidOutput), false);
  await assert.rejects(run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-f", "null", "-"], 120), /timeout=true/);
  console.log("RESAMPLER_GUARDS", JSON.stringify({ overlapRejected: true, sourceGapRejected: true, truncatedInputRejected: true, cancellationChildExited: true }));
  if (compareDecode) {
    const jitterInput = path.join(root, "jitter.f32");
    fs.writeFileSync(jitterInput, Buffer.alloc(2000 * 4));
    const jitterResults = [];
    for (const delta of [-50, -1, 1, 50]) {
      const mapping = path.join(root, `jitter-${delta}.txt`);
      const output = path.join(root, `jitter-${delta}.out`);
      fs.writeFileSync(mapping, `0 1000 0 1000\n1000 2000 ${1000 + delta} ${2000 + delta}\n`);
      try {
        const result = await run(executable, [jitterInput, mapping, output, "2100"]);
        const stats = JSON.parse(result.stdout) as { continuousRuns: number };
        jitterResults.push({ delta, result: "accepted", continuousRuns: stats.continuousRuns });
      } catch (error) {
        assert.match(String(error), /unsupported source gap or output overlap/);
        jitterResults.push({ delta, result: "rejected-overlap" });
      }
    }
    console.log("JITTER_DIAGNOSTIC", JSON.stringify(jitterResults));
  }
  if (compareDecode) {
    const results = await Promise.allSettled([120, 120_000].map((timeout) =>
      run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-f", "null", "-"], timeout)
        .catch((error) => { cancel(); throw error; })));
    assert.ok(results.every((result) => result.status === "rejected"));
    assert.equal(owned.size, 0);
    interrupted = false;
    console.log("PARALLEL_DECODE_GUARD", JSON.stringify({ failureStopsPeer: true, bothGroupsExited: true }));
  }
  for (const seconds of durations) {
    const directory = path.join(root, String(seconds));
    fs.mkdirSync(directory);
    const sources = [fixture(seconds, 0, directory), fixture(seconds, 1, directory)];
    const extent = Math.max(...sources.map((f) => f.extent));
    for (const f of sources) {
      await run(ffmpeg, ["-v", "error", "-f", "f32le", "-ar", "24000", "-ac", "1", "-i", f.raw,
        "-c:a", "libopus", "-b:a", "32k", "-application", "voip", "-compression_level", "0", f.opus]);
      fs.rmSync(f.raw);
    }
    const originals = await Promise.all(sources.map((f) => hash(f.opus)));
    for (const mode of compareDecode ? ["sequential", "parallel", "parallel", "sequential"] : ["sequential"]) {
    const started = performance.now();
    let decodeMs = 0, resampleMs = 0, childCpuSeconds = 0, maxChildRssBytes = 0;
    const resourceUsage: Array<{ cpuSeconds: number; maxRssBytes: number }> = [];
    let decodeRssUpperBoundBytes = 0;
    const decode = async (f: Fixture) => {
      const decoded = await run(ffmpeg, ["-v", "error", "-i", f.opus, "-ar", "24000", "-ac", "1", "-f", "f32le", f.decoded]);
      assert.notEqual(decoded.cpuSeconds, null); assert.notEqual(decoded.maxRssBytes, null);
      childCpuSeconds += decoded.cpuSeconds!;
      maxChildRssBytes = Math.max(maxChildRssBytes, decoded.maxRssBytes!);
      decodeRssUpperBoundBytes = mode === "parallel" ? decodeRssUpperBoundBytes + decoded.maxRssBytes! : Math.max(decodeRssUpperBoundBytes, decoded.maxRssBytes!);
    };
    const decodingStarted = performance.now();
    if (mode === "parallel") {
      const results = await Promise.allSettled(sources.map((f) => decode(f).catch((error) => { cancel(); throw error; })));
      for (const result of results) if (result.status === "rejected") throw result.reason;
    } else {
      for (const f of sources) await decode(f);
    }
    decodeMs = performance.now() - decodingStarted;
    for (const f of sources) {
      const rendered = await run(executable, [f.decoded, f.mapping, f.corrected, String(extent)]);
      resampleMs += rendered.wallMs;
      const usage = JSON.parse(rendered.stdout) as { cpuSeconds: number; maxRssBytes: number };
      assert.ok(Number.isFinite(usage.cpuSeconds) && usage.maxRssBytes > 0);
      resourceUsage.push(usage);
      childCpuSeconds += usage.cpuSeconds;
      maxChildRssBytes = Math.max(maxChildRssBytes, usage.maxRssBytes);
      fs.rmSync(f.decoded);
    }
    const output = path.join(directory, "stereo.wav");
    const join = await run(ffmpeg, ["-v", "error", ...sources.flatMap((f) => ["-f", "f32le", "-ar", "24000", "-ac", "1", "-i", f.corrected]),
      "-filter_complex", "[0:a][1:a]join=inputs=2:channel_layout=stereo:map=0.0-FL|1.0-FR[out]", "-map", "[out]", "-c:a", "pcm_s16le", output]);
    const wallMs = performance.now() - started;
    assert.notEqual(join.cpuSeconds, null); assert.notEqual(join.maxRssBytes, null);
    childCpuSeconds += join.cpuSeconds!;
    maxChildRssBytes = Math.max(maxChildRssBytes, join.maxRssBytes!);
    const header = Buffer.alloc(4096);
    const fd = fs.openSync(output, "r");
    try { fs.readSync(fd, header); } finally { fs.closeSync(fd); }
    let offset = 12;
    assert.equal(header.toString("ascii", 0, 4), "RIFF");
    while (header.toString("ascii", offset, offset + 4) !== "data") {
      const size = header.readUInt32LE(offset + 4);
      offset += size + 8 + (size % 2);
      assert.ok(offset + 8 <= header.length);
    }
    assert.equal(header.readUInt32LE(offset + 4), extent * 4);
    const alignment = sources.map((f, channel) => validate(output, offset + 8, 4, channel, f, extent));
    assert.deepEqual(await Promise.all(sources.map((f) => hash(f.opus))), originals);
    console.log("RESAMPLER_RESULT", JSON.stringify({ mode, decodeRssUpperBoundBytes, seconds, rangesPerSource: sources[0].ranges.length,
      wallMs, childCpuSeconds, maxChildRssBytes, decodeMs, resampleMs, joinMs: join.wallMs, frameCount: extent, alignment, resourceUsage }));
    fs.rmSync(output);
    for (const f of sources) fs.rmSync(f.corrected);
    }
    fs.rmSync(directory, { recursive: true });
  }
} finally {
  cancel();
  fs.rmSync(root, { recursive: true, force: true });
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
  assert.equal(owned.size, 0);
  assert.equal(fs.existsSync(root), false);
  console.log("RESAMPLER_CLEANUP", JSON.stringify({ ownedGroupsExited: true, temporaryDirectoryRemoved: true }));
}
