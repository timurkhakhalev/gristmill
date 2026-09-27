// @probe-name "contract parse guards return the discriminated unions, not any"
// @probe-codes [2322]
// @probe-origin test/scripts/speakerOnnxTypeProbe.test.js
import { parseOnnxWorkerRequest } from "./src/contracts/onnxWorker.ts";

const request = parseOnnxWorkerRequest({ id: 1, method: "ping" });
if (request === null) throw new Error("null");
// method is the literal union; a bogus method literal must not compile.
const bad: "speaker.embed" = request.method;
void bad;
