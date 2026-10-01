const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { installElectronStub }: typeof import("../../../helpers/harness/electronStub.ts") = require("../../../helpers/harness/electronStub.ts");
installElectronStub();
const { AudioTapManager }: typeof import("../../../../src/helpers/audioTapManager.js") = require("../../../../src/helpers/audioTapManager.ts");

test("native audio tap answers bounded clock probes while stdout remains PCM", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("requires the macOS system-audio tap and its live host clock");
    return;
  }
  const manager = new AudioTapManager();
  if (!manager.isAvailable()) throw new Error("Compile the macOS audio tap before this native verification");
  const chunks: Array<{ bytes: number; frameStart: number }> = [];
  const starts: import("../../../../src/helpers/audioTapManager.js").AudioTapStartMessage[] = [];
  let failure: Error | null = null;
  t.after(async () => manager.stop());

  await manager.start({
    onStart: (message) => { starts.push(message); },
    onChunk: (chunk, frameStart) => chunks.push({ bytes: chunk.length, frameStart }),
    onError: (error) => { failure = error; },
  });
  assert.ok(starts[0]?.generation);
  assert.match(starts[0]?.monotonicOriginNs ?? "", /^\d{1,20}$/);
  const origin = manager.getClockOrigin();
  assert.ok(origin);

  const reply = await manager.probeClock(randomUUID());
  assert.equal(reply.helperGeneration, origin.helperGeneration);
  assert.match(reply.helperReceiveNs, /^\d{1,20}$/);
  assert.match(reply.helperSendNs, /^\d{1,20}$/);
  assert.ok(reply.helperFrame >= 0);

  const child = manager.process;
  assert.ok(child);
  child.stdin.end();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(child.exitCode, null, "stdin EOF must end probe input without stopping capture");
  assert.equal(failure, null);
  assert.ok(chunks.length > 0, "stdout PCM should continue independently of stderr probe metadata");
  assert.ok(chunks.every((chunk) => chunk.bytes > 0 && chunk.bytes % 2 === 0 && chunk.bytes <= 4_800));
  assert.ok(chunks.every((chunk, index) => index === 0 || chunk.frameStart >= chunks[index - 1].frameStart));
});
