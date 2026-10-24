import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  MeetingCaptureWriteQueue,
  MAX_UNACKNOWLEDGED_CAPTURE_FRAMES,
  MAX_UNACKNOWLEDGED_CAPTURE_MS,
} from "../../src/helpers/meetingCaptureWriteQueue.ts";

// Class-level observation of MeetingCaptureWriteQueue (follow-up #415, owner
// approved): the worklet-replay suite models ACK latency but never drives the
// queue itself. These cases observe the queue directly with injected
// writers/boundaries - behavior contracts, not score targets.

interface QueueOverrides {
  write?: (packet: string) => Promise<void>;
  maxFrames?: number;
  maxAgeMs?: number;
}

function makeQueue(overrides: QueueOverrides = {}) {
  const written: string[] = [];
  const failures: Error[] = [];
  const queue = new MeetingCaptureWriteQueue<string>({
    write: async (packet) => {
      written.push(packet);
    },
    onFailure: (error) => failures.push(error),
    ...overrides,
  });
  return { queue, written, failures };
}

const backlogPattern = new RegExp(
  `Meeting capture exceeded the ${MAX_UNACKNOWLEDGED_CAPTURE_MS} ms write backlog`
);

test("accepted writes resolve serially and unacknowledgedFrames tracks pending then zero (B2, B3 accounting, B4 resolve, B6)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const written: string[] = [];
  const failures: Error[] = [];
  const queue = new MeetingCaptureWriteQueue<string>({
    write: async (packet) => {
      written.push(packet);
      await gate;
    },
    onFailure: (error) => failures.push(error),
  });

  const first = queue.write("p1", 480);
  assert.equal(queue.unacknowledgedFrames, 480);
  const second = queue.write("p2", 120);
  assert.equal(queue.unacknowledgedFrames, 600);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(written, ["p1", "p2"]);
  assert.equal(queue.unacknowledgedFrames, 0);
  assert.deepEqual(failures, []);
});

test("default limits accept frames up to the derived cap, then overflow rejects with the backlog message (B1 defaults, B3 gates)", async () => {
  const failures: Error[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queue = new MeetingCaptureWriteQueue<string>({
    write: async () => {
      await gate;
    },
    onFailure: (error) => failures.push(error),
  });

  assert.equal(MAX_UNACKNOWLEDGED_CAPTURE_FRAMES, 120_000);
  const atCap = queue.write("at-cap", MAX_UNACKNOWLEDGED_CAPTURE_FRAMES);
  atCap.catch(() => {});
  await assert.rejects(queue.write("over", 1), (error: Error) => {
    assert.match(error.message, backlogPattern);
    return true;
  });
  release();
  await assert.rejects(atCap, backlogPattern);
  assert.equal(failures.length, 1);
});

test("invalid frame counts reject per shape without writing (B3 gates)", async () => {
  const { queue, written } = makeQueue({ maxFrames: 1000 });
  for (const frames of [0, -5, Number.NaN, 1.5]) {
    await assert.rejects(
      queue.write("packet", frames),
      (error: Error) => {
        assert.match(error.message, /write backlog/);
        return true;
      }
    );
  }
  assert.deepEqual(written, []);
  assert.equal(queue.unacknowledgedFrames, 0);
});

test("drained queue rejects new writes with the closed message (B3 closed gate)", async () => {
  const { queue, written } = makeQueue();
  await queue.write("last", 10);
  await queue.drain();
  await assert.rejects(
    queue.write("after", 10),
    /Meeting capture write queue is closed/
  );
  assert.deepEqual(written, ["last"]);
});

test("a writer throw fails the packet, fires onFailure once, and later writes reject immediately (B3 failure short-circuit, B4 catch, B7 idempotence)", async () => {
  const written: string[] = [];
  const failures: Error[] = [];
  const queue = new MeetingCaptureWriteQueue<string>({
    write: async (packet) => {
      written.push(packet);
      throw new Error("writer exploded");
    },
    onFailure: (error) => failures.push(error),
  });

  await assert.rejects(queue.write("p1", 10), /writer exploded/);
  assert.deepEqual(written, ["p1"]);
  await assert.rejects(queue.write("p2", 10), /writer exploded/);
  assert.deepEqual(written, ["p1"], "post-failure writes never reach the writer");
  assert.equal(failures.length, 1, "onFailure is not re-fired");
});

test("ack-age timer fails pending writes with the exact message; timers are cleared on settle (B4 timer rows, B7 fan-out)", async () => {
  const failures: Error[] = [];
  const queue = new MeetingCaptureWriteQueue<string>({
    write: async () => {
      await delay(50);
    },
    onFailure: (error) => failures.push(error),
    maxAgeMs: 5,
  });

  const first = queue.write("p1", 100);
  const second = queue.write("p2", 200);
  await assert.rejects(first, /Meeting capture write acknowledgement exceeded 5 ms/);
  await assert.rejects(second, (error: Error) => {
    assert.match(error.message, /acknowledgement exceeded 5 ms/);
    return true;
  });
  assert.equal(queue.unacknowledgedFrames, 0);
  assert.equal(failures.length, 1);
  await delay(30);
  assert.equal(failures.length, 1, "no late duplicate failure after settle");
});

test("a writer throw wraps non-Error rejections into Errors (B4 catch-site contract)", async () => {
  const failures: Error[] = [];
  const queue = new MeetingCaptureWriteQueue<string>({
    // SAFETY: intentionally rejecting the documented contract to observe the
    // catch-site wrap (error instanceof Error check).
    write: (async () => Promise.reject("boom")) as never,
    onFailure: (error) => failures.push(error),
  });
  await assert.rejects(queue.write("p1", 10), (error: Error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "boom");
    return true;
  });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].message, "boom");
});

test("a failure in the tail chain rejects still-queued packets with the same failure (B4 tail, B7 fan-out)", async () => {
  const attempts: string[] = [];
  const queue = new MeetingCaptureWriteQueue<string>({
    write: async (packet) => {
      attempts.push(packet);
      if (packet === "bad") throw new Error("writer exploded");
      await delay(10);
    },
    onFailure: () => {},
  });

  const bad = queue.write("bad", 10);
  const after = queue.write("after", 10);
  await assert.rejects(bad, /writer exploded/);
  await assert.rejects(after, /writer exploded/);
  assert.deepEqual(attempts, ["bad"], "post-failure tail entries abort before writing");
});

test("waitForWrites resolves when healthy and throws the recorded failure afterwards (B5)", async () => {
  const healthy = makeQueue();
  healthy.queue.write("ok", 10);
  await healthy.queue.waitForWrites();
  assert.deepEqual(healthy.written, ["ok"]);

  const broken = makeQueue({
    write: async () => {
      throw new Error("write failed");
    },
  });
  await assert.rejects(broken.queue.write("nope", 10), /write failed/);
  await assert.rejects(broken.queue.waitForWrites(), /write failed/);
});

test("drain resolves after in-flight writes; drain with a failing in-flight write rejects (B5, B7)", async () => {
  const sequential = makeQueue({ maxAgeMs: 5000 });
  sequential.queue.write("a", 10);
  sequential.queue.write("b", 10);
  await sequential.queue.drain();
  assert.deepEqual(sequential.written, ["a", "b"]);

  const written: string[] = [];
  const failures: Error[] = [];
  let failFirst = true;
  const failing = new MeetingCaptureWriteQueue<string>({
    write: async (packet) => {
      written.push(packet);
      if (failFirst) {
        failFirst = false;
        throw new Error("drain failure");
      }
      await new Promise<void>(() => {});
    },
    onFailure: (error) => failures.push(error),
  });
  const queue = failing;
  const doomed = queue.write("doomed", 10);
  doomed.catch(() => {});
  const drained = queue.drain().then(
    () => "resolved",
    (error: Error) => `rejected: ${error.message}`
  );
  assert.equal(await drained, "rejected: drain failure");
  assert.deepEqual(written, ["doomed"]);
});

test("settle clears the ack timer: an acked packet never fails the queue late (B6)", async () => {
  const failures: Error[] = [];
  const queue = new MeetingCaptureWriteQueue<string>({
    write: async () => {
      await delay(1);
    },
    onFailure: (error) => failures.push(error),
    maxAgeMs: 10,
  });

  await queue.write("quick", 10);
  await delay(30);
  assert.equal(failures.length, 0, "settled packet's timer was cleared");
  assert.equal(queue.unacknowledgedFrames, 0);
  await queue.write("again", 10);
  assert.equal(failures.length, 0, "queue still healthy after a settled late-timer window");
});
