#!/usr/bin/env bash
# Generate all platform icons from one SVG candidate (macOS only: uses qlmanage + iconutil + sips).
#   scripts/build-icons.sh 01        # apps/desktop/icons/candidates/01-*.svg → icon.iconset, icon.icns, icon.png, docs/icons/*
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PICK="${1:-01}"
SRC=$(ls "$ROOT"/apps/desktop/icons/candidates/${PICK}-*.svg | head -1)
[ -f "$SRC" ] || { echo "no candidate matching $PICK"; exit 1; }
OUT="$ROOT/apps/desktop/icons"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

echo "→ rasterising $(basename "$SRC")"
qlmanage -t -s 1024 -o "$TMP" "$SRC" >/dev/null 2>&1
MASTER="$TMP/$(basename "$SRC").png"
[ -f "$MASTER" ] || { echo "qlmanage failed to render the SVG"; exit 1; }

rm -rf "$OUT/icon.iconset"; mkdir -p "$OUT/icon.iconset"
for size in 16 32 128 256 512; do
  sips -z $size $size "$MASTER" --out "$OUT/icon.iconset/icon_${size}x${size}.png" >/dev/null
  dbl=$((size * 2))
  sips -z $dbl $dbl "$MASTER" --out "$OUT/icon.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$OUT/icon.iconset" -o "$OUT/icon.icns"
sips -z 512 512 "$MASTER" --out "$OUT/icon.png" >/dev/null           # Linux
sips -z 256 256 "$MASTER" --out "$OUT/icon-win.png" >/dev/null       # Windows (ICO conversion rejects >256px)
mkdir -p "$ROOT/docs/icons"
sips -z 256 256 "$MASTER" --out "$ROOT/docs/icons/app-icon.png" >/dev/null
for svg in "$ROOT"/apps/desktop/icons/candidates/*.svg; do
  qlmanage -t -s 256 -o "$TMP" "$svg" >/dev/null 2>&1
  mv "$TMP/$(basename "$svg").png" "$ROOT/docs/icons/$(basename "${svg%.svg}").png"
done
echo "✓ icons written to $OUT (iconset, icns, png) and docs/icons/"
