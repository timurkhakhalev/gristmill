// @probe-name "llamaServer options keep numeric/context fields narrowed"
// @probe-codes [2322]
// @probe-origin test/scripts/localLlmModelsTypeProbe.test.js
import { LlamaServerManager } from "./src/helpers/llamaServer.ts";

const manager = new LlamaServerManager();
// draftModelPath is string | null | undefined, not an arbitrary object.
const bad: { path: string } = manager.draftModelPath;
void bad;
