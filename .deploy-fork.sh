#!/bin/sh
# Copy the app from the feat branch checkout into the fork's Pages root and stamp the build,
# so the service worker's cache name changes and browsers pick up new CSS/JS.
set -e
SRC=/home/claude/fairshare; DST=/home/claude/ghpages
SHA=$(git -C "$SRC" rev-parse --short HEAD); VER=$(node -e "console.log(require('$SRC/package.json').version||'0.0.0')")
cp "$SRC"/index.html "$SRC"/styles.css "$SRC"/sw.js "$SRC"/manifest.json "$DST"/ && cp "$SRC"/js/*.js "$DST"/js/
sed -i "s/__BUILD_HASH__/$SHA/g; s/__BUILD_VERSION__/$VER/g" "$DST"/index.html "$DST"/sw.js
echo "stamped $SHA"
