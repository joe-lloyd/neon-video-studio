#!/usr/bin/env bash
# Does the preview keep its picture while you scrub? Opens the renderer in headless Chrome, drags
# the playhead for ~6 s (scripts/scrub-drag.js), screenshots the page about every 400 ms, and
# prints the mean brightness (luma 0-255) of the preview area in each shot. Black frames read near
# the background level; a picture reads clearly higher. Compare runs, e.g. before and after a change.
#
#   scripts/scrub-check.sh "http://localhost:5173/?port=<port>&token=<token>" [shots]
#
# Needs: the renderer dev server (pnpm dev:renderer), an app with a video project open, ffmpeg.
set -euo pipefail
URL="${1:?usage: scripts/scrub-check.sh <renderer-url> [shots]}"
SHOTS="${2:-30}"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
FFMPEG="${NEON_FFMPEG:-$(command -v ffmpeg || echo "${NEON_HOME:-$HOME/.neon-video}/tools/ffmpeg")}"
DIR=$(mktemp -d)
trap 'rm -rf "$DIR"' EXIT
steps=(--step "new Promise((r) => setTimeout(r, 6000))" --step "$(cat "$ROOT/scripts/scrub-drag.js")")
for _ in $(seq 1 "$SHOTS"); do steps+=(--step 1); done
out=$(node "$ROOT/scripts/ui-shot.ts" "$URL" "$DIR/s.png" --wait 200 --shot-after-each "${steps[@]}")
read -r X Y W H < <(echo "$out" | grep '^step 2:' | sed 's/^step 2: //' | tr -d '[]' | tr ',' ' ')
for i in $(seq 3 $((SHOTS + 2))); do
  luma=$("$FFMPEG" -hide_banner -i "$DIR/s-$i.png" -vf "crop=$((W - 20)):$((H - 20)):$((X + 10)):$((Y + 10)),signalstats,metadata=print:key=lavfi.signalstats.YAVG" -f null - 2>&1 | grep -o 'YAVG=[0-9.]*' | cut -d= -f2)
  printf '%s ' "${luma%.*}"
done
echo
