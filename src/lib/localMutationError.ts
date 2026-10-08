export type LocalMutationErrorKey =
  | "notes.mutationErrors.folderNameRequired"
  | "notes.mutationErrors.folderAlreadyExists"
  | "notes.mutationErrors.folderNotFound"
  | "notes.mutationErrors.defaultFolderImmutable"
  | "notes.mutationErrors.generic";

interface LocalMutationErrorKeyTable {
  readonly [message: string]: LocalMutationErrorKey;
}

const ERROR_KEYS: LocalMutationErrorKeyTable = {
  "Folder name is required": "notes.mutationErrors.folderNameRequired",
  "A folder with that name already exists": "notes.mutationErrors.folderAlreadyExists",
  "Folder not found": "notes.mutationErrors.folderNotFound",
  "Cannot delete default folders": "notes.mutationErrors.defaultFolderImmutable",
  "Cannot rename default folders": "notes.mutationErrors.defaultFolderImmutable",
  "Cannot move default folders": "notes.mutationErrors.defaultFolderImmutable",
};

/**
 * Main-process/database messages are internal protocol details, not UI copy.
 * Known validation failures get a specific translation; network and unknown
 * errors deliberately collapse to a localized generic description.
 */
export function localMutationErrorKey(error: string | null | undefined): LocalMutationErrorKey {
  return (error && ERROR_KEYS[error]) || "notes.mutationErrors.generic";
}
