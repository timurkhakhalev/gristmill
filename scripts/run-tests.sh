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

if [ "$#" -eq 0 ]; then
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

# On macOS, tests use Electron as Node so a running dev app and tests use the
# same SQLite ABI. Linux CI keeps its normal Node runtime.
test_runtime=node
if [ "$(uname -s)" = Darwin ]; then
  test_runtime=electron
fi
node scripts/ensure-sqlite-runtime.js "$test_runtime"
export REQUIRE_DB_TESTS=1

pnpm run build:main
if [ "$test_runtime" = electron ]; then
  electron_bin="$(node -p 'require("electron")')"
  export ELECTRON_RUN_AS_NODE=1
  exec "$electron_bin" --import tsx --test --test-concurrency=1 --test-timeout=30000 "$@"
fi
exec node --import tsx --test --test-concurrency=1 --test-timeout=30000 "$@"
