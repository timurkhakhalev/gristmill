// A promise with its resolver exposed, for tests that must hold an async seam
// open (a bounds settle, a display lookup, a provider stop) until the
// assertion point.
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;

  const promise = new Promise<T>((next) => {
    resolve = next;
  });

  return { promise, resolve };
}
