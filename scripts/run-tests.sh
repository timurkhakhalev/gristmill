#!/bin/sh
set -eu

# macOS schedules this process and all test children as background work.
if [ "$(uname -s)" = Darwin ] && [ "${OPENHERCULES_TEST_BACKGROUND:-}" != 1 ]; then
  export OPENHERCULES_TEST_BACKGROUND=1
  exec taskpolicy -b nice -n 15 sh "$0" "$@"
fi

exec node scripts/run-tests.js "$@"
