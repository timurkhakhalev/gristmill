#!/bin/sh
set -eu

if [ "${1:-}" = "--" ]; then
  shift
fi

if [ "$#" -eq 0 ]; then
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

# macOS schedules this process and all test children as background work.
if [ "$(uname -s)" = Darwin ] && [ "${OPENHERCULES_TEST_BACKGROUND:-}" != 1 ]; then
  export OPENHERCULES_TEST_BACKGROUND=1
  exec taskpolicy -b nice -n 15 sh "$0" "$@"
fi

pnpm run build:main
exec node --import tsx --test --test-concurrency=1 --test-timeout=30000 "$@"
