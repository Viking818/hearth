#!/bin/bash
# Builds dist/Hearth-Windows-<version>.zip: Hearth with its own Node.js for 64-bit Windows, so nothing has to be
# installed, and, when NSIS is installed (brew install makensis), dist/Hearth-Setup-<version>.exe: the same files as a
# setup program. dist keeps this version and the one before it, so going back is one click away.
# Runs on a Mac or Linux. Usage: windows/package.sh [--with-extensions [folder]]
#   --with-extensions  also pack the skills and plugins installed in Hearth on this Mac (or from the given
#                      extensions folder). Hearth on Windows copies them in on its first start. Keys typed for
#                      connectors and sign-ins to services are never included.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
EXT=""
if [ "${1:-}" = "--with-extensions" ]; then
  EXT="${2:-$HOME/Library/Application Support/Hearth/extensions}"
  [ -f "$EXT/state.json" ] || { echo "No Hearth extensions found in: $EXT"; exit 1; }
fi
# The Node.js that goes inside both packages is named in one place: scripts/node-version.txt.
NODE_VERSION="${NODE_VERSION:-$(tr -d '[:space:]' < scripts/node-version.txt)}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
OUT="$TMP/Hearth"
mkdir -p "$OUT/node" "$OUT/app" "$TMP/dl"

echo "• Downloading Node.js $NODE_VERSION for Windows"
ZIP="node-$NODE_VERSION-win-x64.zip"
curl -sfL -o "$TMP/dl/$ZIP" "https://nodejs.org/dist/$NODE_VERSION/$ZIP"
curl -sfL -o "$TMP/dl/SHASUMS256.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
(cd "$TMP/dl" && grep " $ZIP\$" SHASUMS256.txt | shasum -a 256 -c -)
unzip -q -j "$TMP/dl/$ZIP" "node-$NODE_VERSION-win-x64/node.exe" "node-$NODE_VERSION-win-x64/LICENSE" -d "$OUT/node"

echo "• Copying Hearth"
cp -R server public package.json "$OUT/app/"
cp windows/Hearth.vbs windows/Stop-Hearth.vbs windows/Make-Desktop-Shortcut.vbs "$OUT/"
cp "windows/Hearth (with console).bat" "$OUT/"
cp windows/README.txt "$OUT/README.txt"

if [ -n "$EXT" ]; then
  echo "• Adding the extensions from $EXT"
  SEED="$OUT/app/seed/extensions"
  mkdir -p "$SEED"
  # Not the hidden half-installed folders at the top, nor Finder's .DS_Store files.
  for d in plugins skills; do [ -d "$EXT/$d" ] && rsync -a --exclude '/.*' --exclude '.DS_Store' "$EXT/$d/" "$SEED/$d/"; done
  # The list of what is switched on, without values typed for connectors (keys, tokens).
  python3 -I - "$EXT/state.json" "$SEED/state.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1], encoding='utf-8'))
for p in (s.get('plugins') or {}).values():
    p.pop('values', None)
json.dump(s, open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
PY
  echo "  $(ls "$SEED/plugins" 2>/dev/null | wc -l | tr -d ' ') plugins, $(ls "$SEED/skills" 2>/dev/null | wc -l | tr -d ' ') skills of your own"
fi

echo "• Drawing the icon"
if command -v swift >/dev/null; then
  swift mac/make-icon.swift public/logo.svg "$TMP/icons" >/dev/null
  python3 -I windows/make-ico.py "$TMP/icons" "$OUT/hearth.ico"
fi

# Windows wants CRLF line ends in scripts.
for f in "$OUT"/*.vbs "$OUT"/*.bat "$OUT/README.txt" "$OUT"/app/server/*.ps1; do perl -pi -e 's/\r?\n/\r\n/' "$f"; done

mkdir -p "$ROOT/dist"
VERSION="$(sed -n 's/.*"version": *"\([0-9.]*\)".*/\1/p' package.json | head -1)"
VERSION="${VERSION:-0.0.0}"
ZIPNAME="Hearth-Windows-$VERSION.zip"
SETUPNAME="Hearth-Setup-$VERSION.exe"
rm -f "$ROOT/dist/$ZIPNAME"
(cd "$TMP" && zip -qr -X "$ROOT/dist/$ZIPNAME" Hearth)
echo "Built dist/$ZIPNAME ($(du -h "$ROOT/dist/$ZIPNAME" | cut -f1))"

if command -v makensis >/dev/null; then
  echo "• Building the setup program"
  rm -f "$ROOT/dist/$SETUPNAME"
  # makensis crashes (bad_alloc) under some system locales, e.g. on a Mac set to Russian; its texts are UTF-8 anyway.
  LC_ALL=en_US.UTF-8 makensis -V2 -INPUTCHARSET UTF8 -DSRC="$OUT" -DVERSION="$VERSION" -DOUTFILE="$ROOT/dist/$SETUPNAME" windows/installer.nsi
  echo "Built dist/$SETUPNAME ($(du -h "$ROOT/dist/$SETUPNAME" | cut -f1))"
else
  echo "(For $SETUPNAME too, install NSIS: brew install makensis)"
fi

# Keep this version and the one before it; older ones, and the files from before they had numbers, go.
python3 -I - "$ROOT/dist" <<'PY'
import os, re, sys
d = sys.argv[1]
for prefix, ext in (('Hearth-Setup', 'exe'), ('Hearth-Windows', 'zip')):
    found = []
    for f in os.listdir(d):
        m = re.fullmatch(re.escape(prefix) + r'-(\d+(?:\.\d+)*)\.' + ext, f)
        if m:
            found.append((tuple(int(x) for x in m.group(1).split('.')), f))
    for _, f in sorted(found)[:-2]:
        os.remove(os.path.join(d, f))
        print(f'Removed old dist/{f}')
    if os.path.exists(os.path.join(d, f'{prefix}.{ext}')):
        os.remove(os.path.join(d, f'{prefix}.{ext}'))
PY
