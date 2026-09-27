// @probe-name "wrong-shaped arguments and results fail compilation"
// @probe-codes [2339]
// @probe-origin test/scripts/urlDownloadTypeProbe.test.js
import {
  downloadUrlAudioArgsSchema,
  urlDownloadResultSchema,
  type UrlDownloadResult,
} from "./src/contracts/urlDownload.js";

// Wrong argument type at the boundary.
downloadUrlAudioArgsSchema.parse([42, "dl-1"]);
downloadUrlAudioArgsSchema.parse(["https://example.com/a.mp3", 7]);
// Overlong URL fails the schema.
downloadUrlAudioArgsSchema.parse([["x".repeat(2049)]]);
// Unknown stage is not a progress payload the bridge may forward.
import { urlDownloadProgressSchema } from "./src/contracts/urlDownload.js";
urlDownloadProgressSchema.parse({ stage: "sideways", percent: 1 });

// A failure result cannot be narrowed to success by a bare assertion.
const bad: UrlDownloadResult = urlDownloadResultSchema.parse({ success: false, error: "e" });
if (bad.success) {
  const p: string = bad.error;
  console.log(p);
}
console.log(bad);
