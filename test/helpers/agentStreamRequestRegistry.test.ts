// The sender-scoped AgentStreamRequestRegistry after the TS cutover:
// identity is (senderId, requestId) — one renderer can never abort, replace
// or complete another's request; a repeated id of the same sender aborts the
// previous controller; completion is identity-guarded so a late finish never
// removes a replacement; isActive is the replacement-protection probe the
// enterprise stream handler uses before sending terminal events.
const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const { AgentStreamRequestRegistry }: typeof import("../../src/helpers/agentStreamRequestRegistry") = require("../../src/helpers/agentStreamRequestRegistry");

test("a repeated id of the same sender aborts the previous controller", () => {
  const registry = new AgentStreamRequestRegistry();
  const first = registry.begin(1, "stream-a");
  const second = registry.begin(1, "stream-a");

  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, false);
});

test("the same id in another sender is fully independent", () => {
  const registry = new AgentStreamRequestRegistry();
  const mine = registry.begin(1, "stream-a");
  const theirs = registry.begin(2, "stream-a");

  registry.cancel(2, "stream-a");

  assert.equal(mine.signal.aborted, false);
  assert.equal(theirs.signal.aborted, true);
  // The other sender's cancel removed only its own entry.
  assert.equal(registry.isActive(1, "stream-a", mine), true);
});

test("cancel aborts and removes; a later cancel is a no-op", () => {
  const registry = new AgentStreamRequestRegistry();
  const controller = registry.begin(7, "req-1");

  assert.equal(registry.cancel(7, "req-1"), true);
  assert.equal(controller.signal.aborted, true);
  assert.equal(registry.cancel(7, "req-1"), false);
  assert.equal(registry.cancel(99, "req-1"), false);
});

test("complete of a replaced controller never removes the replacement", () => {
  const registry = new AgentStreamRequestRegistry();
  const first = registry.begin(1, "stream-a");
  const second = registry.begin(1, "stream-a");

  // The replaced stream finishes late: identity guard must ignore it.
  registry.complete(1, "stream-a", first);
  assert.equal(registry.isActive(1, "stream-a", second), true);
  assert.equal(second.signal.aborted, false);

  registry.complete(1, "stream-a", second);
  assert.equal(registry.isActive(1, "stream-a", second), false);
  assert.equal(registry.cancel(1, "stream-a"), false);
});

test("isActive distinguishes the live controller from a stale one", () => {
  const registry = new AgentStreamRequestRegistry();
  const first = registry.begin(1, "s");
  registry.begin(1, "s");

  assert.equal(registry.isActive(1, "s", first), false);
  assert.equal(registry.isActive(2, "s", first), false);
});

test("cancelSender aborts every request of one sender only", () => {
  const registry = new AgentStreamRequestRegistry();
  const a1 = registry.begin(1, "r1");
  const a2 = registry.begin(1, "r2");
  const b1 = registry.begin(2, "r1");

  assert.equal(registry.cancelSender(1), 2);
  assert.equal(a1.signal.aborted, true);
  assert.equal(a2.signal.aborted, true);
  assert.equal(b1.signal.aborted, false);
  assert.equal(registry.cancelSender(1), 0);
});

test("begin rejects invalid identities", () => {
  const registry = new AgentStreamRequestRegistry();
  assert.throws(() => Reflect.apply(registry.begin, registry, ["1", "s"]), TypeError);
  assert.throws(() => registry.begin(1, ""), TypeError);
  assert.throws(() => Reflect.apply(registry.begin, registry, [1, undefined]), TypeError);
});
