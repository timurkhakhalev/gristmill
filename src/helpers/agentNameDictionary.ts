export interface DictionaryChanges {
  add: string[];
  remove: string[];
}

// The snapshot comes from settings/localStorage and can be stale or
// hand-edited; the guards keep the historical degradation to an empty delta.
function isString<T>(value: T): value is T & string {
  return typeof value === "string";
}

function findStoredWord(words: readonly string[], word: string): string | undefined {
  const needle = word.toLowerCase();

  return words.find((w) => isString(w) && w.trim().toLowerCase() === needle);
}

/**
 * Work out which dictionary changes an agent name requires: drop a
 * renamed-away name, add the current one.
 *
 * Returns a delta, not a whole list. A whole-list write replaces the SQLite
 * table, so a caller holding a stale snapshot deletes everything it omitted
 * (#1295); a delta can only touch the words it names.
 *
 * @param {string[]} dictionary current dictionary snapshot
 * @param {string} newName
 * @param {string} [oldName]
 * @returns {{ add: string[], remove: string[] }}
 */
export function agentNameDictionaryChanges(
  dictionary: string[] | null | undefined,
  newName: string | null | undefined,
  oldName?: string | null
): DictionaryChanges {
  const words = Array.isArray(dictionary) ? dictionary : [];
  const trimmedNew = isString(newName) ? newName.trim() : "";
  const trimmedOld = isString(oldName) ? oldName.trim() : "";
  const storedNew = trimmedNew ? findStoredWord(words, trimmedNew) : undefined;
  const storedOld = trimmedOld ? findStoredWord(words, trimmedOld) : undefined;

  return {
    add: trimmedNew && !storedNew ? [trimmedNew] : [],
    remove:
      storedOld && storedOld.trim().toLowerCase() !== trimmedNew.toLowerCase() ? [storedOld] : [],
  };
}
