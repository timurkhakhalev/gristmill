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
export function chooseDictionaryStartupAction(
  dbWords: unknown,
  localWords: unknown
): DictionaryStartupAction {
  const db = Array.isArray(dbWords) ? (dbWords as string[]) : [];
  const local = Array.isArray(localWords) ? (localWords as string[]) : [];

  if (db.length === 0 && local.length > 0) {
    return { action: "push-local-to-db", words: local };
  }

  if (db.length > 0) {
    return { action: "pull-db-to-local", words: db };
  }

  return { action: "noop", words: local };
}
