#!/bin/sh
# Runs the iPhone Use test suite; usable locally and in CI.
set -eu
cd "$(dirname "$0")/.."
PYTHON="${PYTHON:-python3}"
"$PYTHON" -c 'import sys; assert sys.version_info >= (3, 9), sys.version'
PYTHONDONTWRITEBYTECODE=1 "$PYTHON" -m unittest discover -s tests
if [ -n "${PYTHON39:-}" ]; then PYTHONDONTWRITEBYTECODE=1 "$PYTHON39" -m unittest discover -s tests; fi
if command -v node >/dev/null 2>&1; then node --check viewer/app.js; fi
echo "iphone-use checks passed"
