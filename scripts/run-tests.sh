#!/bin/sh
set -eu

if [ "${1:-}" = "--" ]; then
  shift
fi

full_suite=0
if [ "$#" -eq 0 ]; then
  full_suite=1
  set -- 'test/**/*.test.js'
else
  for file do
    case "$file" in
      test/*.test.js|test/*/*.test.js) ;;
      *) echo "Expected a test file under test/: $file" >&2; exit 2 ;;
    esac
    if [ ! -f "$file" ]; then
      echo "Test file does not exist: $file" >&2
      exit 2
    fi
  done
fi

# The full suite must include DB tests; do not report green with an Electron ABI.
if [ "$full_suite" -eq 1 ] && ! node -e 'const db = require("better-sqlite3") (":memory:"); db.close()' 2>/dev/null; then
  echo 'better-sqlite3 is not built for Node. Run: pnpm --dir node_modules/better-sqlite3 exec prebuild-install' >&2
  exit 1
fi
export REQUIRE_DB_TESTS=1

# macOS schedules this process and all test children as background work.
if [ "$(uname -s)" = Darwin ] && [ "${OPENHERCULES_TEST_BACKGROUND:-}" != 1 ]; then
  export OPENHERCULES_TEST_BACKGROUND=1
  exec taskpolicy -b nice -n 15 sh "$0" "$@"
fi

pnpm run build:main
exec node --import tsx --test --test-concurrency=1 --test-timeout=30000 "$@"
