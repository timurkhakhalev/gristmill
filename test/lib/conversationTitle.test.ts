import assert from "node:assert/strict";
import test from "node:test";

import { deriveConversationTitle } from "../../src/lib/conversationTitle.ts";

// The canonical runner loads these files through tsx in CJS mode, so top-level
// await is unavailable; node:test awaits every root registration itself, and
// this wrapper only keeps the registration promise observed.
const it = (name: string, fn: () => void | Promise<void>): void => {
  test(name, fn).catch((error: Error) => {
    throw error;
  });
};

it("short messages become the title verbatim", () => {
  assert.equal(deriveConversationTitle("Catch me up", "Growth"), "Catch me up");
});

it("long messages truncate to 40 chars with an ellipsis", () => {
  const text = "What were the key decisions from the sales sync last Thursday?";
  const title = deriveConversationTitle(text, "Growth");
  assert.equal(title.endsWith("…"), true);
  assert.equal(title.length <= 41, true);
  assert.equal(title, "What were the key decisions from the sal…");
});

it("whitespace-only input falls back to the container name", () => {
  assert.equal(deriveConversationTitle("   \n\t ", "Growth"), "Growth");
  assert.equal(deriveConversationTitle("", "Growth"), "Growth");
});

it("internal newlines and runs of spaces collapse to single spaces", () => {
  assert.equal(deriveConversationTitle("catch\nme   up\t please", "Growth"), "catch me up please");
});

it("a message landing exactly on the limit is not truncated", () => {
  const text = "x".repeat(40);
  assert.equal(deriveConversationTitle(text, "Growth"), text);
});
