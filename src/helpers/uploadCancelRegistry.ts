// In-flight audio-upload work keyed by requestId, so one cancel aborts every
// operation the upload spawned (transcription and diarization run in parallel
// under the same id). Pure seam: no Electron imports, unit-tested in
// test/helpers/uploadCancelRegistry.test.js.

export interface UploadCancelRegistration {
  signal: AbortSignal | undefined;
  release: () => void;
}

export interface UploadCancelRegistry {
  register<T>(requestId: T): UploadCancelRegistration;
  cancel<T>(requestId: T): number;
}

function isNonEmptyString<T>(value: T): value is T & string {
  return typeof value === "string" && value !== "";
}

export function createUploadCancelRegistry(): UploadCancelRegistry {
  // requestId -> Set<AbortController>, one controller per in-flight operation.
  const controllers = new Map<string, Set<AbortController>>();

  return {
    // Registers one operation. Missing/invalid ids are inert — flows without a
    // requestId (dictation, voice drafts, warm-ups) get no signal and a no-op
    // release, so their behavior is untouched.
    register<T>(requestId: T): UploadCancelRegistration {
      if (!isNonEmptyString(requestId)) {
        return { signal: undefined, release: () => {} };
      }

      let set = controllers.get(requestId);

      if (!set) {
        set = new Set();
        controllers.set(requestId, set);
      }

      const controller = new AbortController();
      set.add(controller);

      return {
        signal: controller.signal,
        release: () => {
          set.delete(controller);

          // Guard against deleting a successor set registered after a cancel.
          if (set.size === 0 && controllers.get(requestId) === set) {
            controllers.delete(requestId);
          }
        },
      };
    },

    // Aborts every operation registered under the id and returns how many were
    // aborted. Unknown or already-finished ids are a safe no-op — the renderer
    // fires a cancel for every provider, including ones that never register.
    cancel<T>(requestId: T): number {
      if (!isNonEmptyString(requestId)) return 0;

      const set = controllers.get(requestId);

      if (!set) return 0;
      controllers.delete(requestId);

      for (const controller of set) controller.abort();

      return set.size;
    },
  };
}
