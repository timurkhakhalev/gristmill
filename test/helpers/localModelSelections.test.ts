const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const load = () => import("../../src/helpers/localModelSelections.ts");

import type { LocalScopeEntry } from "../../src/helpers/localModelSelections.ts";

const SCOPES: LocalScopeEntry[] = [
  { storeKeys: { mode: "cleanupMode", model: "cleanupModel" } },
  { storeKeys: { mode: "chatAgentMode", model: "chatAgentModel" } },
];

const installed = (...ids: string[]) => {
  const set = new Set(ids);

  return (id: string) => set.has(id);
};

test("flags a local scope whose model is gone", async () => {
  const { findStaleLocalModelKeys } = await load();

  const settings = {
    cleanupMode: "local",
    cleanupModel: "qwen2.5-3b",
    chatAgentMode: "local",
    chatAgentModel: "llama-3.2-3b",
  } as const;

  assert.deepEqual(findStaleLocalModelKeys(SCOPES, settings, installed("llama-3.2-3b")), [
    "cleanupModel",
  ]);
});

test("leaves installed models alone", async () => {
  const { findStaleLocalModelKeys } = await load();
  const settings = { cleanupMode: "local", cleanupModel: "qwen2.5-3b" } as const;
  assert.deepEqual(findStaleLocalModelKeys(SCOPES, settings, installed("qwen2.5-3b")), []);
});

test("ignores scopes that are not on local mode", async () => {
  const { findStaleLocalModelKeys } = await load();
  const settings = { cleanupMode: "providers", cleanupModel: "gpt-5.5" } as const;
  assert.deepEqual(findStaleLocalModelKeys(SCOPES, settings, installed()), []);
});

test("ignores a scope with nothing selected", async () => {
  const { findStaleLocalModelKeys } = await load();
  const settings = { cleanupMode: "local", cleanupModel: "" } as const;
  assert.deepEqual(findStaleLocalModelKeys(SCOPES, settings, installed()), []);
});

test("flags every local scope sharing the removed model", async () => {
  const { findStaleLocalModelKeys } = await load();

  const settings = {
    cleanupMode: "local",
    cleanupModel: "qwen2.5-3b",
    chatAgentMode: "local",
    chatAgentModel: "qwen2.5-3b",
  } as const;

  assert.deepEqual(findStaleLocalModelKeys(SCOPES, settings, installed()), [
    "cleanupModel",
    "chatAgentModel",
  ]);
});
