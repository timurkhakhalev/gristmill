import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  MEET_ACTIVITY_HOLD_MS,
  MeetSpeakingActivity,
} from "../../../../extension/src/meetSpeakingActivity.js";

const timeline: {
  durationMs: number;
  remoteVideoTile: number[];
  localAvatarTile: number[];
} = JSON.parse(fs.readFileSync("test/fixtures/meet/v1/activity-timeline.json", "utf8"));

function activeShare(times: number[], from = 1500): number {
  const activity = new MeetSpeakingActivity();
  let next = 0;
  let active = 0;
  let samples = 0;

  for (let at = from; at <= timeline.durationMs; at += 250) {
    while (next < times.length && times[next] <= at) activity.note("tile", times[next++]);
    samples++;
    if (activity.active(at).has("tile")) active++;
  }

  return active / samples;
}

test("recorded Meet indicator churn keeps heard tiles active", () => {
  assert.equal(activeShare(timeline.remoteVideoTile), 1);
  assert.ok(activeShare(timeline.localAvatarTile) >= 0.9);
});

test("sparse class changes, hover bursts and muted tiles stay inactive", () => {
  const activity = new MeetSpeakingActivity();

  for (let at = 0; at < 10_000; at += 1000) activity.note("idle", at);
  for (const at of [20_000, 20_050, 20_100]) activity.note("hover", at);

  for (let at = 0; at <= 21_000; at += 250) assert.deepEqual([...activity.active(at)], []);
});

test("activity ends one hold period after the last burst change", () => {
  const activity = new MeetSpeakingActivity();

  for (const at of [0, 100, 200, 300]) activity.note("speaker", at);

  assert.deepEqual([...activity.active(300)], ["speaker"]);
  assert.deepEqual([...activity.active(300 + MEET_ACTIVITY_HOLD_MS - 1)], ["speaker"]);
  assert.deepEqual([...activity.active(300 + MEET_ACTIVITY_HOLD_MS)], []);
});
