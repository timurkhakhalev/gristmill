"""Compare AX instants with a normalized transcript using the same tap's clock.

This reports temporal coincidences, never accepted speaker identities.
The Zoom indicator delay and converter startup offset remain uncalibrated.
"""

import argparse
import bisect
from collections import Counter
import json
from pathlib import Path
import subprocess
import sys
import tempfile


def read_jsonl(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line]


def position_at(host_ns, clocks, times, epoch_start):
    index = bisect.bisect_right(times, host_ns) - 1
    if index < 0:
        return None
    clock = clocks[index]
    # Do not extrapolate beyond the input buffer actually observed.
    duration_ns = clock["sourceFrames"] / clock["sourceRate"] * 1e9
    if host_ns - times[index] > duration_ns:
        return None
    return epoch_start + int(clock["convertedFrameOffset"]) + (host_ns - times[index]) / 1e9 * clock["targetRate"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ax", type=Path)
    parser.add_argument("clock", type=Path)
    parser.add_argument("transcript", type=Path)
    parser.add_argument("--epoch-start-frame", type=int, required=True)
    args = parser.parse_args()
    if args.epoch_start_frame < 0:
        parser.error("epoch start must be nonnegative")
    journal = read_jsonl(args.clock)
    scale = next(row for row in journal if row["type"] == "probe-clock")
    clocks = [row for row in journal if row["type"] == "clock"]
    if not clocks or any(row["inputFlags"] & 3 != 3 for row in clocks):
        raise ValueError("Capture clock is missing valid sample/host timestamps")
    if any(row["targetRate"] != 24000 for row in clocks):
        raise ValueError("Expected the canonical 24 kHz audio timeline")
    times = [int(row["inputHostTicks"]) * scale["numer"] // scale["denom"] for row in clocks]
    if any(after <= before for before, after in zip(times, times[1:])):
        raise ValueError("Capture host clock must increase")
    if any(int(after["convertedFrameOffset"]) != int(before["convertedFrameOffset"]) + before["outputFrames"]
           for before, after in zip(clocks, clocks[1:])):
        raise ValueError("Converted audio frame offsets are discontinuous")
    segments = json.loads(args.transcript.read_text())["segments"]
    system = [(index, segment) for index, segment in enumerate(segments)
              if segment.get("speaker", "").startswith("system:")]
    reads = [row for row in read_jsonl(args.ax) if row["type"] == "read"]
    result = {"reads": len(reads), "mappedReads": 0, "explicitMappedReads": 0,
              "clockOutputFrames": sum(row["outputFrames"] for row in clocks),
              "systemSegmentCount": len(system), "systemSpeakerCount": len({s["speaker"] for _, s in system})}
    sweeps = {}
    # Sensitivity analysis, not a measured or chosen Zoom delay.
    for offset in [-1.0, -0.5, -0.25, 0.0, 0.25, 0.5, 1.0]:
        matches = Counter()
        outside_speech = 0
        ambiguous = 0
        matched_segments = set()
        for row in reads:
            before = position_at(int(row["beforeHostNS"]), clocks, times, args.epoch_start_frame)
            after = position_at(int(row["afterHostNS"]), clocks, times, args.epoch_start_frame)
            if before is None or after is None:
                continue
            if offset == 0:
                result["mappedReads"] += 1
            if not row["usableExplicit"]:
                continue
            if offset == 0:
                result["explicitMappedReads"] += 1
            active = [tile for window in row["windows"] for tile in window["tiles"] if tile.get("active")]
            if len(active) != 1:
                continue
            tile = active[0]
            if tile.get("muted") is not False:
                continue
            low, high = before / 24000 + offset, after / 24000 + offset
            overlapping = [(i, s) for i, s in system if s["start"] <= high and s["end"] >= low]
            speakers = {s["speaker"] for _, s in overlapping}
            if not speakers:
                outside_speech += 1
            elif len(speakers) > 1:
                ambiguous += 1
            else:
                matches[f"{tile['key']} / {next(iter(speakers))}"] += 1
                matched_segments.update(i for i, _ in overlapping)
        sweeps[str(offset)] = {"coincidencesByAXInstanceAndCluster": dict(matches),
                              "outsideSystemSpeech": outside_speech, "ambiguousSpeech": ambiguous,
                              "matchedSystemSegments": len(matched_segments)}
    result["offsetSensitivitySeconds"] = sweeps
    print(json.dumps(result, indent=2, sort_keys=True))


def self_test():
    clock = {"sourceFrames": 24000, "sourceRate": 24000, "targetRate": 24000,
             "convertedFrameOffset": "0", "outputFrames": 24000,
             "inputFlags": 3, "inputHostTicks": "1000000000"}
    assert position_at(1500000000, [clock], [1000000000], 24000) == 36000
    assert position_at(500000000, [clock], [1000000000], 24000) is None
    assert position_at(2500000000, [clock], [1000000000], 24000) is None
    with tempfile.TemporaryDirectory(prefix="gristmill-122-analysis-") as directory:
        root = Path(directory)
        journal = [{"type": "probe-clock", "numer": 1, "denom": 1}, {"type": "clock", **clock}]
        read = {"type": "read", "beforeHostNS": "1499999000", "afterHostNS": "1500001000",
                "usableExplicit": True, "windows": [{"tiles": [{"key": "tile-1", "active": True, "muted": False}]}]}
        (root / "clock.jsonl").write_text("\n".join(map(json.dumps, journal)))
        (root / "ax.jsonl").write_text(json.dumps(read))
        segments = [{"speaker": speaker, "start": 1, "end": 2} for speaker in ["mic", "system:A", "system:B"]]
        (root / "transcript.json").write_text(json.dumps({"segments": segments}))
        command = [sys.executable, __file__, str(root / "ax.jsonl"), str(root / "clock.jsonl"),
                   str(root / "transcript.json"), "--epoch-start-frame", "24000"]
        result = json.loads(subprocess.run(command, check=True, capture_output=True, text=True).stdout)
        at_zero = result["offsetSensitivitySeconds"]["0.0"]
        assert at_zero["ambiguousSpeech"] == 1
        assert at_zero["coincidencesByAXInstanceAndCluster"] == {}
        assert result["systemSpeakerCount"] == 2
        # Replay several speakers and failure states without a live group call.
        # This verifies temporal matching, not Zoom's real indicator latency.
        journal = [{"type": "probe-clock", "numer": 1, "denom": 1}]
        for index, second in enumerate([0, 1, 2, 4, 5, 6, 7]):
            journal.append({"type": "clock", **clock,
                            "inputHostTicks": str(1000000000 + second * 1000000000),
                            "convertedFrameOffset": str(index * 24000)})

        def observation(second, key, *, usable=True, muted=False):
            instant = int(1000000000 + second * 1000000000)
            return {"type": "read", "beforeHostNS": str(instant - 1000),
                    "afterHostNS": str(instant + 1000), "usableExplicit": usable,
                    "windows": [{"tiles": [{"key": key, "active": True, "muted": muted}]}]}

        reads = [observation(0.5, "tile-1"), observation(1.5, "tile-2"),
                 observation(2.5, "tile-3"), observation(3.5, "tile-1"),
                 observation(4.5, "tile-2"), observation(5.25, "tile-1", usable=False),
                 observation(5.5, "tile-4"), observation(6.25, "tile-2", muted=True),
                 observation(6.5, "tile-2", muted=None), observation(7.1, "tile-3"),
                 observation(7.5, "tile-5"), observation(7.7, "tile-5")]
        reads[-1]["windows"][0]["tiles"].append({"key": "tile-6", "active": True, "muted": False})
        segments = [{"speaker": speaker, "start": start, "end": end}
                    for speaker, start, end in [
                        ("system:A", 1, 2), ("system:B", 2, 3), ("system:C", 3, 4),
                        ("system:B", 4, 5), ("system:C", 4.4, 4.8),
                        ("system:A", 5, 6), ("system:B", 6, 7),
                        ("mic", 7, 8), ("system:D", 7.4, 7.8)]]
        (root / "clock.jsonl").write_text("\n".join(map(json.dumps, journal)))
        (root / "ax.jsonl").write_text("\n".join(map(json.dumps, reads)))
        (root / "transcript.json").write_text(json.dumps({"segments": segments}))
        result = json.loads(subprocess.run(command, check=True, capture_output=True, text=True).stdout)
        at_zero = result["offsetSensitivitySeconds"]["0.0"]
        assert result["mappedReads"] == 11  # Missing host interval is not extrapolated.
        assert result["explicitMappedReads"] == 10  # Unknown activity is not carried forward.
        assert result["systemSpeakerCount"] == 4
        assert at_zero["ambiguousSpeech"] == 1
        assert at_zero["outsideSystemSpeech"] == 1  # Mic alone is not remote speech.
        assert at_zero["matchedSystemSegments"] == 5
        assert at_zero["coincidencesByAXInstanceAndCluster"] == {
            "tile-1 / system:A": 1, "tile-2 / system:B": 1, "tile-3 / system:C": 1,
            "tile-4 / system:A": 1, "tile-5 / system:D": 1,
        }  # Recreated tiles remain separate; muted/disconnected/multiple active tiles abstain.
    print("13 analysis checks passed (including synthetic multi-speaker replay)")


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        self_test()
    else:
        main()
