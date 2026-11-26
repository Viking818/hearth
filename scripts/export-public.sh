#!/bin/bash
# Copies the public part of Hearth into a clean folder (a git checkout that is published). Only what is listed here
# goes out; the author's private notes and the built packages never do. Files that left the listed folders are
# removed from the copy too; its own .git and dist folders are never touched.
# Usage: scripts/export-public.sh <folder>
set -euo pipefail
cd "$(dirname "$0")/.."
DEST="${1:?Give the folder to copy into}"
mkdir -p "$DEST"
# The copy's own .git and dist are excluded first, which also keeps them from being deleted there (the rsync that
# comes with macOS does not honour "protect" rules, and --delete-excluded once wiped the copy's .git).
rsync -a --delete \
  --exclude '/.git' --exclude '/dist' --exclude '.DS_Store' \
  --include '/LICENSE' --include '/THIRD-PARTY-NOTICES.md' --include '/README.md' --include '/README.ru.md' \
  --include '/.gitignore' --include '/package.json' \
  --include '/Start Hearth.bat' --include '/Start Hearth.command' --include '/start-hearth.sh' \
  --include '/docs/***' --include '/server/***' --include '/public/***' --include '/bin/***' \
  --include '/mac/***' --include '/windows/***' --include '/scripts/***' --include '/tests/***' \
  --exclude '*' \
  ./ "$DEST/"
echo "Copied to $DEST"
