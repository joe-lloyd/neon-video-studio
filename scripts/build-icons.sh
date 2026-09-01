#!/usr/bin/env bash
# Generate all platform icons from one SVG candidate (macOS only: AppKit SVG rasteriser + iconutil + sips).
#   scripts/build-icons.sh 01        # apps/desktop/icons/candidates/01-*.svg → icon.iconset, icon.icns, icon.png, docs/icons/*
# Rasterising goes through scripts/svg2png.swift (compiled on demand) because qlmanage composites
# SVG thumbnails onto an opaque white background — the corners must stay transparent.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PICK="${1:-01}"
SRC=$(ls "$ROOT"/apps/desktop/icons/candidates/${PICK}-*.svg | head -1)
[ -f "$SRC" ] || { echo "no candidate matching $PICK"; exit 1; }
OUT="$ROOT/apps/desktop/icons"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

SVG2PNG="$TMP/svg2png"
swiftc -O -o "$SVG2PNG" "$ROOT/scripts/svg2png.swift" 2>/dev/null || { echo "swiftc failed (xcode-select --install)"; exit 1; }

echo "→ rasterising $(basename "$SRC")"
MASTER="$TMP/master.png"
"$SVG2PNG" "$SRC" "$MASTER" 1024 2>/dev/null
[ -f "$MASTER" ] || { echo "svg2png failed to render the SVG"; exit 1; }

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
  "$SVG2PNG" "$svg" "$ROOT/docs/icons/$(basename "${svg%.svg}").png" 256 2>/dev/null
done
echo "✓ icons written to $OUT (iconset, icns, png) and docs/icons/"
