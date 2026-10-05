const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

require("../../../helpers/harness/electronStub.ts");

const {
  register,
  shutdownAll,
}: typeof import("../../../../src/helpers/sidecarRegistry.ts") = require("../../../../src/helpers/sidecarRegistry.ts");

let stopEngine: () => void | Promise<void> = () => {};

register("test-engine", () => stopEngine());

test("engines stop only after the work barrier settles", async () => {
  let release!: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const order: string[] = [];
  stopEngine = () => {
    order.push("engine-stopped");
  };

  const shutdown = shutdownAll(async () => {
    order.push("work-aborted");
    await gate;
    order.push("work-settled");
  });

  assert.deepEqual(order, ["work-aborted"]);
  release();
  assert.equal(await shutdown, true);
  assert.deepEqual(order, ["work-aborted", "work-settled", "engine-stopped"]);
});

test("a failed work barrier leaves engines owned and reports incomplete shutdown", async () => {
  let stopped = false;
  stopEngine = () => {
    stopped = true;
  };

  assert.equal(
    await shutdownAll(async () => {
      throw new Error("capture finalization failed");
    }),
    false
  );
  assert.equal(stopped, false);
});

test("the eight-second deadline reports incomplete shutdown without later engine teardown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release!: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  let stopped = false;
  stopEngine = () => {
    stopped = true;
  };

  const shutdown = shutdownAll(() => gate);
  t.mock.timers.tick(7999);
  let settled = false;
  void shutdown.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  assert.equal(await shutdown, false);
  release();
  await Promise.resolve();
  assert.equal(stopped, false);
});

test("engine teardown errors are not reported as successful shutdown", async () => {
  stopEngine = () => {
    throw new Error("engine stop failed");
  };

  assert.equal(await shutdownAll(async () => {}), false);
});
