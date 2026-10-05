import assert from "node:assert/strict";
import test from "node:test";

import { localMutationErrorKey } from "../../src/lib/localMutationError.ts";

// The canonical runner loads these files through tsx in CJS mode, so top-level
// await is unavailable; node:test awaits every root registration itself, and
// this wrapper only keeps the registration promise observed.
const it = (name: string, fn: () => void | Promise<void>): void => {
  test(name, fn).catch((error: Error) => {
    throw error;
  });
};

it("maps database validation messages to translation keys", () => {
  assert.equal(
    localMutationErrorKey("A folder with that name already exists"),
    "notes.mutationErrors.folderAlreadyExists"
  );
  assert.equal(
    localMutationErrorKey("Cannot move default folders"),
    "notes.mutationErrors.defaultFolderImmutable"
  );
  assert.equal(
    localMutationErrorKey("Cannot purge the private space"),
    "notes.mutationErrors.privateSpaceImmutable"
  );
});

it("does not expose arbitrary main-process or cloud error text", () => {
  assert.equal(
    localMutationErrorKey("connect ECONNREFUSED api.example.test"),
    "notes.mutationErrors.generic"
  );
  assert.equal(localMutationErrorKey(undefined), "notes.mutationErrors.generic");
});
