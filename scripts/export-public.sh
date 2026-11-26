#!/bin/bash
# Copies the public part of Hearth into a clean folder (a git checkout that is published). Only what is listed here
# goes out; the author's private notes and the built packages never do. Files that left the project are removed
# from the copy too, except its own .git and dist folders.
# Usage: scripts/export-public.sh <folder>
set -euo pipefail
cd "$(dirname "$0")/.."
DEST="${1:?Give the folder to copy into}"
mkdir -p "$DEST"
rsync -a --delete --delete-excluded \
  --exclude '.DS_Store' \
  --filter 'P /.git/' --filter 'P /dist/' \
  --include '/LICENSE' --include '/THIRD-PARTY-NOTICES.md' --include '/README.md' --include '/README.ru.md' \
  --include '/.gitignore' --include '/package.json' \
  --include '/Start Hearth.bat' --include '/Start Hearth.command' --include '/start-hearth.sh' \
  --include '/docs/***' --include '/server/***' --include '/public/***' --include '/bin/***' \
  --include '/mac/***' --include '/windows/***' --include '/scripts/***' --include '/tests/***' \
  --exclude '*' \
  ./ "$DEST/"
echo "Copied to $DEST"
