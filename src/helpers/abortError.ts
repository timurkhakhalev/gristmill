// Mirrors the DOMException `net.fetch` throws on abort, so transports that
// abort by hand (the ffmpeg child, a queued upload slot) reject with the same
// shape and callers can branch uniformly on `error.name === "AbortError"`.
export function createAbortError(message = "Aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";

  return error;
}
