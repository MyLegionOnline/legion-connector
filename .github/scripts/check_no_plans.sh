#!/bin/sh
# Fails if a tracked path looks like a planning document.
set -eu

PATTERN='(^|/)plans?(/|$)|plan[^/]*\.md$|PLAN[^/]*\.md$'
found=$(git ls-files | grep -E "$PATTERN" || true)

if [ -n "$found" ]; then
    echo "ERROR: plan files must not be in this repository:" >&2
    echo "$found" >&2
    exit 1
fi
echo "ok: no plan paths"
