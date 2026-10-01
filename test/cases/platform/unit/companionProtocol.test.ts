import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { companionBrowserMessageSchema, companionDesktopMessageSchema } from "../../../../src/contracts/companion.ts";
import { CompanionFrameDecoder } from "../../../../src/helpers/companionFrames.ts";

test("native frames reject oversized lengths before allocation and incomplete or malformed payloads", () => {
  const decoder = new CompanionFrameDecoder(() => assert.fail("must not decode oversized frame"));
  const oversized = Buffer.alloc(4); oversized.writeUInt32LE(65537);
  assert.throws(() => decoder.push(oversized), /length/);
  const partial = new CompanionFrameDecoder(() => {});
  partial.push(Buffer.from([1, 0]));
  assert.throws(() => partial.finish(), /Incomplete/);
  const utf8 = new CompanionFrameDecoder(() => {});
  assert.throws(() => utf8.push(Buffer.from([1, 0, 0, 0, 255])));
});

test("protocol accepts only the current bounded metadata shape", () => {
  const hello = { version: 1, type: "hello", installationId: randomUUID(), sessionId: randomUUID() };
  assert.equal(companionBrowserMessageSchema.safeParse(hello).success, true);
  for (const extra of [{ version: 2 }, { audio: "pcm" }, { transcript: "private" }, { credential: "secret" }]) {
    assert.equal(companionBrowserMessageSchema.safeParse({ ...hello, ...extra }).success, false);
  }
  const snapshot = { version: 1, type: "snapshot", connectionId: randomUUID(), recordingState: "idle", recordingId: null,
    binding: null, contextState: "unbound", manualMuted: false, platformMuted: false };
  assert.equal(companionDesktopMessageSchema.safeParse(snapshot).success, true);
  assert.equal(companionDesktopMessageSchema.safeParse({ ...snapshot, noteTitle: "Private" }).success, false);
});
