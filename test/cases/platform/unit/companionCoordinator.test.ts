import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CompanionCoordinator, COMPANION_REMINDER_MS } from "../../../../src/helpers/companionCoordinator.ts";
import type { CompanionCandidateKey, CompanionContext, CompanionRecordingScope } from "../../../../src/contracts/companion.ts";

const candidate = (): CompanionCandidateKey => ({ connectionId: randomUUID(), ref: { platform: "google-meet",
  installationId: randomUUID(), sessionId: randomUUID(), tabId: 1, documentId: randomUUID(), callId: "abc-defg-hij" } });
let sourceTime = 1000;
const context = (patch: Partial<CompanionContext> = {}): CompanionContext => ({ sourceNs: String(sourceTime++), presence: "in-call",
  health: "recognized", reason: null, micMuted: false, mode: "standard", participants: [], activeParticipantIds: [],
  rosterComplete: false, confirmedLeave: false, ...patch });
function setup() {
  let now = 0;
  let scope: CompanionRecordingScope | null = { recordingId: randomUUID(), sessionId: randomUUID() };
  let draining = false;
  const effects: string[] = [];
  const coordinator = new CompanionCoordinator({ now: () => now, currentScope: () => scope, canBind: () => !draining,
    suppressAutoEnd: () => effects.push("suppress"), setPlatformMuted: (_, muted) => effects.push(`mute:${muted}`),
    leave: () => effects.push("leave"), remind: () => effects.push("remind"), changed: () => {} });
  return { coordinator, effects, scope: scope!, time: (value: number) => { now = value; },
    replace: () => { scope = { recordingId: randomUUID(), sessionId: randomUUID() }; }, drain: () => { draining = true; } };
}

test("only one fresh candidate at Start binds automatically; later contexts require scoped confirmation", () => {
  const s = setup(); const key = candidate();
  s.coordinator.start(s.scope);
  s.coordinator.receive(key, context({ micMuted: true }));
  assert.deepEqual(s.effects, []);
  assert.equal(s.coordinator.confirm(s.scope, key), true);
  assert.deepEqual(s.effects, ["suppress", "mute:true"]);
  s.coordinator.receive(candidate(), context({ confirmedLeave: true, presence: "not-in-call" }));
  assert.equal(s.effects.some((effect) => effect === "leave"), false);
});

test("stale selection, draining and replacement cannot bind or stop another recording", () => {
  for (const invalidate of ["stale", "drain", "replace"] as const) {
    const s = setup(); const key = candidate(); s.coordinator.receive(key, context());
    if (invalidate === "stale") s.time(5001);
    if (invalidate === "drain") s.drain();
    if (invalidate === "replace") s.replace();
    assert.equal(s.coordinator.confirm(s.scope, key), false);
    assert.deepEqual(s.effects, []);
  }
  const s = setup(); const key = candidate(); s.coordinator.receive(key, context()); s.coordinator.start(s.scope);
  s.effects.length = 0; s.replace();
  s.coordinator.receive(key, context({ confirmedLeave: true, presence: "not-in-call" }));
  assert.deepEqual(s.effects, []);
});

test("disconnect keeps mute and suppression; one reminder at five minutes, no implicit Stop", () => {
  const s = setup(); const key = candidate(); s.coordinator.receive(key, context({ micMuted: true })); s.coordinator.start(s.scope);
  s.effects.length = 0; s.coordinator.disconnect(key.connectionId);
  s.time(COMPANION_REMINDER_MS - 1); s.coordinator.tick(); assert.deepEqual(s.effects, []);
  s.time(COMPANION_REMINDER_MS); s.coordinator.tick(); s.coordinator.tick(); assert.deepEqual(s.effects, ["remind"]);
  s.coordinator.receive(key, context({ health: "unrecognized", micMuted: false }));
  assert.deepEqual(s.effects, ["remind"]);
  s.coordinator.receive(key, context({ micMuted: false }));
  assert.deepEqual(s.effects, ["remind", "mute:false"]);
  assert.equal(s.coordinator.status().contextUnavailableSince, null);
  assert.equal(s.coordinator.status().binding?.generation, 1);
});

test("only recognized positive leave stops once; disable clears platform gate without restoring heuristics", () => {
  const s = setup(); const key = candidate(); s.coordinator.receive(key, context()); s.coordinator.start(s.scope); s.effects.length = 0;
  s.coordinator.receive(key, context({ presence: "unknown" }));
  s.coordinator.receive(key, context({ presence: "not-in-call" }));
  assert.deepEqual(s.effects, []);
  s.coordinator.receive(key, context({ presence: "not-in-call", confirmedLeave: true }));
  s.coordinator.receive(key, context({ presence: "not-in-call", confirmedLeave: true }));
  assert.deepEqual(s.effects, ["leave"]);
  s.coordinator.setEnabled(false); s.time(COMPANION_REMINDER_MS); s.coordinator.tick();
  assert.deepEqual(s.effects, ["leave", "mute:false"]);
});

test("multiple Chrome profiles and Meet Companion tabs are separate; Restart cannot select unrelated call", () => {
  const s = setup(); const first = candidate(); const second = candidate();
  s.coordinator.receive(first, context()); s.coordinator.receive(second, context({ mode: "companion", micMuted: null }));
  s.coordinator.start(s.scope); assert.equal(s.coordinator.status().binding, null);
  assert.equal(s.coordinator.confirm(s.scope, second), true); assert.deepEqual(s.effects, ["suppress"]);
  s.coordinator.stop(s.scope); s.effects.length = 0;
  s.coordinator.start(s.scope, null); assert.equal(s.coordinator.status().binding, null);
  s.coordinator.start(s.scope, first); assert.equal(s.coordinator.status().binding?.connectionId, first.connectionId);
});

test("reload accepts fresh same-call document once; retired document and other room cannot act", () => {
  const s = setup(); const key = candidate(); s.coordinator.receive(key, context()); s.coordinator.start(s.scope);
  const reload = { ...key, ref: { ...key.ref, documentId: randomUUID() } };
  s.coordinator.receive(reload, context({ micMuted: true }));
  assert.equal(s.coordinator.status().binding?.ref.documentId, reload.ref.documentId);
  s.effects.length = 0;
  s.coordinator.receive(key, context({ presence: "not-in-call", confirmedLeave: true }));
  assert.deepEqual(s.effects, []);
  const room = { ...reload, ref: { ...reload.ref, callId: "xyz-abcd-efg" } };
  s.coordinator.receive(room, context({ micMuted: false }));
  assert.deepEqual(s.effects, []);
  assert.equal(s.coordinator.confirm(s.scope, room), true);
  assert.equal(s.coordinator.status().binding?.ref.callId, room.ref.callId);
});
