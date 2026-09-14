const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/components/onboarding/setupEligibility.ts");

test("Notes setup always exposes local capture and self-hosted options", async () => {
  const { getOnboardingSetupAvailability } = await load();
  assert.deepEqual(
    getOnboardingSetupAvailability({ transcriptionProviders: [] }),
    { cloud: false, local: true, byok: false, selfHosted: true }
  );
});

test("hosted provider availability follows the local registry", async () => {
  const { getOnboardingSetupAvailability } = await load();
  assert.deepEqual(
    getOnboardingSetupAvailability({ transcriptionProviders: [{ id: "openai" }] }),
    { cloud: false, local: true, byok: true, selfHosted: true }
  );
});

test("at least one local setup remains available", async () => {
  const { hasAvailableOnboardingSetup } = await load();
  assert.equal(hasAvailableOnboardingSetup({ cloud: false, local: true, byok: false, selfHosted: true }), true);
});
