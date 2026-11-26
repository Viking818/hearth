#!/bin/bash
# Double-click to start Hearth on a Mac. Keep this window open while you use Hearth; close it to stop.
cd "$(dirname "$0")" || exit 1

NODE=""
for c in node /opt/homebrew/bin/node /usr/local/bin/node "$HOME/tools/node/bin/node" "$HOME/.volta/bin/node" "$HOME"/.nvm/versions/node/*/bin/node; do
  if command -v "$c" >/dev/null 2>&1; then
    NODE="$(command -v "$c")"
    break
  fi
done

if [ -z "$NODE" ]; then
  echo "Hearth needs Node.js 20 or newer."
  echo "Opening nodejs.org: install the LTS version, then double-click this file again."
  open "https://nodejs.org/en/download"
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi

exec "$NODE" server/index.mjs --open
