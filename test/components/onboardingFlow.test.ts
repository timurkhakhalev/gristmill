const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const path: typeof import("node:path") = require("node:path");

const test: typeof import("node:test") = require("node:test");

const root = path.join(__dirname, "../..");

const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("onboarding flow contains only local setup persistence primitives", () => {
  const flow = read("src/components/onboarding/flow.ts");
  assert.match(flow, /export interface OnboardingByokDraft/);
  assert.match(flow, /export function resetOnboardingProgress/);
  assert.doesNotMatch(flow, /auth|dictation|assistant|required-models|screenContext/i);
});

test("prompt registry exposes only note-compatible prompt kinds", () => {
  const registry = read("src/config/prompts/registry.ts");
  assert.match(registry, /cleanup:/);
  assert.match(registry, /chatAgent:/);
  assert.doesNotMatch(registry, /dictationAgent|translate/);
});
