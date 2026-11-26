#!/bin/sh
# Start Hearth on Linux (or a Mac terminal). Keep this terminal open while you use Hearth; Ctrl+C stops it.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Hearth needs Node.js 20 or newer: https://nodejs.org/en/download (or your package manager)."
  exit 1
fi
exec node server/index.mjs --open "$@"
