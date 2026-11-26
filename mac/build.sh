#!/bin/bash
# Builds Hearth.app: the Swift launcher, the icon, Node.js and the app files, signed for this Mac.
# Node.js is the official build named in scripts/node-version.txt (checked against nodejs.org's SHA-256 list), not
# whatever Node this Mac happens to have: that one was months behind on security fixes.
# Usage: mac/build.sh [--install]   (--install copies it to /Applications)
# It builds in a temporary folder: iCloud-synced folders (like the Desktop) add Finder details that signing refuses.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
VERSION=$(node -p "require('./package.json').version")
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
APP="$TMP/Hearth.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/hearth"

echo "• Compiling the app"
swiftc -O -target "$(uname -m)-apple-macos13.0" mac/HearthApp.swift -o "$APP/Contents/MacOS/Hearth" \
  -framework Cocoa -framework WebKit -framework ServiceManagement

echo "• Drawing the icon"
swift mac/make-icon.swift public/logo.svg "$TMP/AppIcon.iconset"
iconutil -c icns "$TMP/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"

NODE_VERSION="${NODE_VERSION:-$(tr -d '[:space:]' < scripts/node-version.txt)}"
case "$(uname -m)" in arm64) NODE_ARCH=arm64 ;; *) NODE_ARCH=x64 ;; esac
NODE_TGZ="node-$NODE_VERSION-darwin-$NODE_ARCH.tar.gz"
CACHE="$ROOT/dist/.mac-build"
mkdir -p "$CACHE"
echo "• Getting Node.js $NODE_VERSION and copying the app files"
curl -sfL -o "$TMP/SHASUMS256.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
# The download is kept between builds; it is used only while it still matches nodejs.org's checksum.
if ! (cd "$CACHE" && grep " $NODE_TGZ\$" "$TMP/SHASUMS256.txt" | shasum -a 256 -c - >/dev/null 2>&1); then
  curl -sfL -o "$CACHE/$NODE_TGZ" "https://nodejs.org/dist/$NODE_VERSION/$NODE_TGZ"
  (cd "$CACHE" && grep " $NODE_TGZ\$" "$TMP/SHASUMS256.txt" | shasum -a 256 -c -)
fi
tar -xzf "$CACHE/$NODE_TGZ" -C "$TMP" "node-$NODE_VERSION-darwin-$NODE_ARCH/bin/node"
cp "$TMP/node-$NODE_VERSION-darwin-$NODE_ARCH/bin/node" "$APP/Contents/Resources/node"
chmod 755 "$APP/Contents/Resources/node"
ditto --norsrc --noextattr server "$APP/Contents/Resources/hearth/server"
ditto --norsrc --noextattr public "$APP/Contents/Resources/hearth/public"
cp package.json "$APP/Contents/Resources/hearth/"
sed "s/__VERSION__/$VERSION/g" mac/Info.plist > "$APP/Contents/Info.plist"

echo "• Signing for this Mac"
xattr -cr "$APP"
codesign --force --sign - "$APP/Contents/Resources/node"
codesign --force --sign - "$APP"
codesign --verify --deep "$APP"

mkdir -p "$ROOT/dist"
# The copy in dist is updated in place too, never deleted first (see the note about uninstall helpers below).
mkdir -p "$ROOT/dist/Hearth.app"
rsync -a --delete "$APP/" "$ROOT/dist/Hearth.app/"
echo "Built dist/Hearth.app ($(du -sh "$APP" | cut -f1))"

if [ "${1:-}" = "--install" ]; then
  # Update the app in place, never delete it first: uninstall helpers such as AppCleaner's SmartDelete treat a
  # deleted app as uninstalled and offer to remove its data folder (models, chats, settings) as well.
  mkdir -p /Applications/Hearth.app
  rsync -a --delete "$APP/" /Applications/Hearth.app/
  echo "Installed /Applications/Hearth.app"
fi
