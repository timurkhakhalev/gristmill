// @probe-name "wrong download/ffmpeg/sidecar usage fails compilation"
// @probe-codes [2322,2322,2322,2322,2345,2345,2353,2741]
// @probe-origin test/scripts/downloadsTypeProbe.test.js
import { convertToWav, mergeAudioSegments, splitAudioFile } from "./src/helpers/ffmpegUtils.js";
import { createDownloadSignal, downloadFile } from "./src/helpers/downloadUtils.js";
import { write as writePid } from "./src/helpers/sidecarPidFile.js";
import { register as registerSidecar } from "./src/helpers/sidecarRegistry.js";
import { reapStaleSidecars } from "./src/helpers/sidecarReaper.js";

// Conversion options are typed: a string sample rate is rejected.
convertToWav("/tmp/a.wav", "/tmp/a.out.wav", { sampleRate: "16000" });

// Segment buffers carry audio data, not arbitrary objects.
mergeAudioSegments([{ buffer: { notAudio: true } }]);

// Split options need numbers/AbortSignal.
splitAudioFile("/tmp/a.wav", "/tmp/out", { segmentDuration: "10", signal: "none" });

// A DOM AbortSignal is not the download signal the model managers share.
downloadFile("https://x", "/tmp/x", { signal: new AbortController().signal });

// The pid file takes an integer pid.
writePid("whisper", "1234");

// Sidecar stop callbacks are functions.
registerSidecar("whisper", "stop");

// Reaper options are numbers.
reapStaleSidecars({ sigtermGraceMs: "5" });
