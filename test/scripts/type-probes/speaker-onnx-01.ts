// @probe-name "an unknown method string cannot ride the typed request union"
// @probe-codes [2345]
// @probe-origin test/scripts/speakerOnnxTypeProbe.test.js
import { OnnxWorkerClient } from "./src/helpers/onnxWorkerClient.ts";

declare const client: OnnxWorkerClient;
async function main() {
  await client.request("speaker.embed", {});
}
void main;
