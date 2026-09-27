const test = require("node:test");
const assert = require("node:assert/strict");
test("embedded chat tool activity remains visible for its minimum duration", async () => {
  const { getAgentToolActivityRemainingMs } = await import("../../src/helpers/agentToolPresentation.ts");
  assert.equal(getAgentToolActivityRemainingMs(10000, 10500), 1900);
  assert.equal(getAgentToolActivityRemainingMs(10000, 12500), 0);
});
