#!/bin/sh
# Runs the tests with macOS JavaScriptCore (no Node needed).
cd "$(dirname "$0")/.." || exit 1
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
for t in tests/*.test.js; do
  echo "== $t"
  $JSC -m "$t"
done
