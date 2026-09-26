#!/bin/sh
set -eu

if [ "${1:-}" = "--" ]; then
  shift
fi

# macOS schedules this process and all test children as background work.
if [ "$(uname -s)" = Darwin ] && [ "${OPENHERCULES_TEST_BACKGROUND:-}" != 1 ]; then
  export OPENHERCULES_TEST_BACKGROUND=1
  exec taskpolicy -b nice -n 15 sh "$0" "$@"
fi

full_suite=0
if [ "$#" -eq 0 ]; then
  full_suite=1
  set -- 'test/**/*.test.js' 'test/**/*.test.ts'
else
  for file do
    case "$file" in
      test/*.test.js|test/*/*.test.js|test/*.test.ts|test/*/*.test.ts) ;;
      *) echo "Expected a test file under test/: $file" >&2; exit 2 ;;
    esac
    if [ ! -f "$file" ]; then
      echo "Test file does not exist: $file" >&2
      exit 2
    fi
  done
fi

# Focused and full tests both require the Node ABI. This is a no-op when the
# installed binding already loads under Node.
node scripts/ensure-sqlite-runtime.js node
export REQUIRE_DB_TESTS=1

pnpm run build:main
exec node --import tsx --test --test-concurrency=1 --test-timeout=30000 "$@"
