#!/bin/zsh
# End-to-end smoke test against a running Neon Video Studio instance.
# Usage: scripts/smoke.sh [media-dir]   (defaults to synthetic media generated with ffmpeg in /tmp/neon-smoke)
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cli() { node "$ROOT/apps/cli/src/main.ts" "$@"; }
MEDIA=${1:-/tmp/neon-smoke}
if [ ! -f "$MEDIA/clip.mp4" ]; then
  mkdir -p "$MEDIA"
  ffmpeg -y -loglevel error -f lavfi -i "testsrc2=duration=4:size=1280x720:rate=30" -f lavfi -i "sine=frequency=440:duration=4" -c:v libx264 -pix_fmt yuv420p -preset veryfast -c:a aac -shortest "$MEDIA/clip.mp4"
fi
echo "== status";            cli status
echo "== new project";       cli project new --name "Smoke $(date +%H%M%S)" --fps 30 --width 1280 --height 720
echo "== import";            cli assets import "$MEDIA/clip.mp4" --at 0
echo "== templates";         cli timeline insert --component TextOverlay --props '{"text":"Smoke test"}' --at 1s --duration 2s
echo "== list";              cli list clips
echo "== state (json)";      cli state dump --json | head -c 400; echo
echo "== render";            cli render --output "$MEDIA/smoke.mp4" --preset draft
ffprobe -v error -show_entries format=duration -of default=nw=1 "$MEDIA/smoke.mp4"
echo "SMOKE OK"
