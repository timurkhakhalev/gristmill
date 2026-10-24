const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

// Requires Node's native TypeScript type-stripping (Node >= 22.6 with
// --experimental-strip-types, on by default in Node 23.6+/24). CI runs Node 24.

const {
  decideRetry,
  MeetingProcessingFailure,
}: typeof import("../../../../src/helpers/meetingProcessingRetry.ts") = require("../../../../src/helpers/meetingProcessingRetry.ts");

const NOW = Date.parse("2026-10-19T12:00:00.000Z");

const retryAt = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();

const decide = (
  error: unknown,
  retryCount = 0,
  isCapturing = false
): ReturnType<typeof decideRetry> =>
  decideRetry({ error, retryCount, isCapturing: () => isCapturing, now: () => NOW });

test("a cancelled stage pauses instead of failing", () => {
  assert.deepEqual(decide(new MeetingProcessingFailure("processing-cancelled", "cancelled")), {
    action: "pause",
  });

  const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
  assert.deepEqual(decide(aborted), { action: "pause" });
});

test("an AbortError-named failure pauses only while capture is active", () => {
  const abortish = new MeetingProcessingFailure("summary-task-interrupted", "failed");
  abortish.name = "AbortError";

  assert.deepEqual(decide(abortish, 0, true), { action: "pause" });
  assert.deepEqual(decide(abortish, 0, false), {
    action: "failed",
    code: "summary-task-interrupted",
  });
});

test("blocked codes stay blocked", () => {
  assert.deepEqual(decide(new MeetingProcessingFailure("api-key-missing", "blocked")), {
    action: "blocked",
    code: "api-key-missing",
  });

  const providerKey = Object.assign(new Error("key missing"), { code: "API_KEY_MISSING" });
  assert.deepEqual(decide(providerKey), { action: "blocked", code: "API_KEY_MISSING" });

  const projectMismatch = Object.assign(new Error("wrong project"), {
    code: "bb-project-mismatch",
  });
  assert.deepEqual(decide(projectMismatch), { action: "blocked", code: "bb-project-mismatch" });
});

test("transient failures retry with exponential backoff up to the limit", () => {
  const rateLimited = new MeetingProcessingFailure("PROVIDER_RATE_LIMITED", "failed");

  assert.deepEqual(decide(rateLimited, 0), {
    action: "retry",
    code: "PROVIDER_RATE_LIMITED",
    retryAt: retryAt(5),
    retryCount: 1,
  });
  assert.deepEqual(decide(rateLimited, 1), {
    action: "retry",
    code: "PROVIDER_RATE_LIMITED",
    retryAt: retryAt(10),
    retryCount: 2,
  });
  assert.deepEqual(decide(rateLimited, 2), {
    action: "retry",
    code: "PROVIDER_RATE_LIMITED",
    retryAt: retryAt(20),
    retryCount: 3,
  });
  assert.deepEqual(decide(rateLimited, 3), {
    action: "failed",
    code: "PROVIDER_RATE_LIMITED",
  });
});

test("HTTP 429, 5xx and TypeError classify as transient", () => {
  const tooMany = Object.assign(new Error("slow down"), { status: 429 });
  assert.deepEqual(decide(tooMany), {
    action: "retry",
    code: "PROVIDER_RATE_LIMITED",
    retryAt: retryAt(5),
    retryCount: 1,
  });

  const unavailable = Object.assign(new Error("unavailable"), { statusCode: 503 });
  assert.deepEqual(decide(unavailable), {
    action: "retry",
    code: "TRANSIENT_NETWORK_ERROR",
    retryAt: retryAt(5),
    retryCount: 1,
  });

  assert.deepEqual(decide(new TypeError("fetch failed")), {
    action: "retry",
    code: "TRANSIENT_NETWORK_ERROR",
    retryAt: retryAt(5),
    retryCount: 1,
  });
});

test("a Gemini 5xx message is transient even without a code", () => {
  assert.deepEqual(decide(new Error("Gemini API error 500: upstream")), {
    action: "retry",
    code: "processing-error",
    retryAt: retryAt(5),
    retryCount: 1,
  });
});

test("non-transient failures fail without a retry", () => {
  assert.deepEqual(decide(new Error("boom")), { action: "failed", code: "processing-error" });

  assert.deepEqual(decide(new MeetingProcessingFailure("transcript-timing-invalid", "failed")), {
    action: "failed",
    code: "transcript-timing-invalid",
  });

  const permanent = Object.assign(new Error("bad request"), { status: 400 });
  assert.deepEqual(decide(permanent), { action: "failed", code: "processing-error" });
});

test("a non-Error rejection becomes a failed processing-error", () => {
  assert.deepEqual(decide("boom"), { action: "failed", code: "processing-error" });
  assert.deepEqual(decide(null), { action: "failed", code: "processing-error" });
});

test("the clock and capture probe are read only when a retry is scheduled", () => {
  let probes = 0;
  const decision = decideRetry({
    error: new MeetingProcessingFailure("api-key-missing", "blocked"),
    retryCount: 0,
    isCapturing: () => {
      probes += 1;
      return true;
    },
    now: () => {
      probes += 1;
      return NOW;
    },
  });

  assert.deepEqual(decision, { action: "blocked", code: "api-key-missing" });
  assert.equal(probes, 0);
});
