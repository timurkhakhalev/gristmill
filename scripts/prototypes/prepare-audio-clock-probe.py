"""Instrument a temporary copy of the audio tap.

Usage: python3 scripts/prototypes/prepare-audio-clock-probe.py /tmp/probe.swift
Compile the result with swiftc. It stops after 15 seconds and emits JSONL to stderr.
With --capture-log PATH, retain normal PCM output and lifetime; log timing to PATH.
That mode is for a temporary Dev-only helper, restored after the experiment.
The replacements deliberately fail if the original helper changes.
"""

from pathlib import Path
import argparse
import json

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("output", type=Path)
parser.add_argument("--capture-log", type=Path)
args = parser.parse_args()

source = (Path(__file__).resolve().parents[2] / "resources/macos-audio-tap.swift").read_text()


def replace(old: str, new: str) -> None:
    global source
    if source.count(old) != 1:
        raise RuntimeError(f"Expected one instrumentation site: {old[:80]!r}")
    source = source.replace(old, new, 1)


clock_body = """        let sampleCount = Int(audioBuffer.mDataByteSize) / 2
        let samples = data.assumingMemoryBound(to: Int16.self)
        var energy = 0.0
        for index in 0..<sampleCount {
            let value = Double(samples[index]) / 32768.0
            energy += value * value
        }
        CLOCK_EMIT(event: [
            "type": "clock",
            "callbackHostTicks": String(mach_absolute_time()),
            "inputHostTicks": String(timestamp.mHostTime),
            "inputSampleTime": timestamp.mSampleTime,
            "inputFlags": timestamp.mFlags.rawValue,
            "nowHostTicks": String(now.mHostTime),
            "nowFlags": now.mFlags.rawValue,
            "sourceRate": sourceFormat.sampleRate,
            "sourceFrames": sourceBuffer.frameLength,
            "targetRate": targetFormat.sampleRate,
            "converterLeadingFrames": converter.primeInfo.leadingFrames,
            "converterTrailingFrames": converter.primeInfo.trailingFrames,
            "convertedFrameOffset": String(probeFrames),
            "outputFrames": outputBuffer.frameLength,
            "rms": sqrt(energy / Double(max(1, sampleCount))),
        ])
        probeFrames += UInt64(outputBuffer.frameLength)
"""
pcm_write = "        pendingPCM.append(data.assumingMemoryBound(to: UInt8.self), count: Int(audioBuffer.mDataByteSize))\n        flushFullChunks()"
replace(
    "    private var pendingPCM = Data()",
    "    private var pendingPCM = Data()\n    private var probeFrames: UInt64 = 0",
)
replace(
    "{ [weak self] _, inputData, _, _, _ in",
    "{ [weak self] now, inputData, inputTime, _, _ in",
)
replace(
    "self.processInput(inputData, sourceFormat: sourceFormat, converter: converter)",
    "self.processInput(inputData, timestamp: inputTime.pointee, now: now.pointee, "
    "sourceFormat: sourceFormat, converter: converter)",
)
replace(
    "        _ inputData: UnsafePointer<AudioBufferList>,\n        sourceFormat:",
    "        _ inputData: UnsafePointer<AudioBufferList>,\n"
    "        timestamp: AudioTimeStamp,\n        now: AudioTimeStamp,\n        sourceFormat:",
)
clock_start = """        var timebase = mach_timebase_info_data_t()
        mach_timebase_info(&timebase)
        CLOCK_EMIT(event: ["type": "probe-clock", "numer": timebase.numer, "denom": timebase.denom,
                           "pid": ProcessInfo.processInfo.processIdentifier])
"""
if args.capture_log:
    if not args.capture_log.is_absolute():
        parser.error("--capture-log must be an absolute temporary path")
    args.capture_log.touch(exist_ok=False)
    path_literal = json.dumps(str(args.capture_log), ensure_ascii=False)
    replace("import Foundation", "import Foundation\n" + f"""
// Research instrumentation. A log failure must not stop audio capture.
let probeLogPath = {path_literal} + "." + String(ProcessInfo.processInfo.processIdentifier) + ".jsonl"
let probeLogCreated = FileManager.default.createFile(atPath: probeLogPath, contents: nil,
                                                     attributes: [.posixPermissions: 0o600])
var probeLog = probeLogCreated ? try? FileHandle(forWritingTo: URL(fileURLWithPath: probeLogPath)) : nil
if probeLog == nil {{ emit(event: ["type": "warning", "code": "probe-clock-log-unavailable"]) }}
func writeProbeClock(event: [String: Any]) {{
    guard let log = probeLog else {{ return }}
    do {{
        let bytes = try JSONSerialization.data(withJSONObject: event)
        try log.write(contentsOf: bytes + Data([10]))
    }} catch {{
        probeLog = nil
        emit(event: ["type": "warning", "code": "probe-clock-log-unavailable"])
    }}
}}
""")
    replace(pcm_write, clock_body.replace("CLOCK_EMIT", "writeProbeClock") + pcm_write)
    replace("        try capture.start()\n        dispatchMain()",
            clock_start.replace("CLOCK_EMIT", "writeProbeClock") + "        try capture.start()\n        dispatchMain()")
else:
    replace(pcm_write, clock_body.replace("CLOCK_EMIT", "emit") +
            "        // This diagnostic mode discards PCM.")
    replace("        try capture.start()\n        dispatchMain()",
            clock_start.replace("CLOCK_EMIT", "emit") + "        try capture.start()\n"
            "        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { stopAndExit(0) }\n        dispatchMain()")
args.output.write_text(source)
