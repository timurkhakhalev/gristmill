// Startup reconcile for custom dictionary localStorage <-> SQLite (#1295).
//
// SQLite is the durable store. The renderer also caches words in localStorage.
// setDictionary() is a full replace: any SQLite row missing from the incoming
// list is hard-deleted (or tombstoned). If startup treats a stale cache as
// authoritative, newer DB state is overwritten and those words disappear.

export type DictionaryStartupAction = {
  action: "push-local-to-db" | "pull-db-to-local" | "noop";
  words: string[];
};

/**
 * Decide how to reconcile the renderer cache with SQLite on app launch.
 *
 * Policy (mirrors snippets startup):
 * - Empty DB + non-empty cache → migrate cache into SQLite (legacy / first write).
 * - Non-empty DB → SQLite wins; refresh the cache from the DB.
 * - Both empty → nothing to do.
 */
// The DB read and the renderer cache both cross a trust boundary; a
// non-string-array value is treated as empty rather than trusted.
function isStringArray<T>(value: T): value is T & string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string");
}

export function chooseDictionaryStartupAction<TDb, TLocal>(
  dbWords: TDb,
  localWords: TLocal
): DictionaryStartupAction {
  const db = isStringArray(dbWords) ? dbWords : [];
  const local = isStringArray(localWords) ? localWords : [];

  if (db.length === 0 && local.length > 0) {
    return { action: "push-local-to-db", words: local };
  }

  if (db.length > 0) {
    return { action: "pull-db-to-local", words: db };
  }

  return { action: "noop", words: local };
}
