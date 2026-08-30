#!/usr/bin/env bash
# Install Neon Video Studio on macOS from a GitHub release (or a local build) and clear the
# Gatekeeper hurdles that unsigned downloads hit ("app is damaged" / "cannot be opened").
#
#   curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/scripts/install-mac.sh | REPO=<owner>/<repo> bash
#   scripts/install-mac.sh                # latest release from $REPO (default below)
#   scripts/install-mac.sh v0.2.0         # specific tag
#   scripts/install-mac.sh --local        # copy apps/desktop/build/stable-*/ from this checkout
set -euo pipefail
REPO="${REPO:-joe-lloyd/neon-video-studio}"
APP_NAME="Neon Video Studio"
DEST="${DEST:-/Applications}"
ARCH=$(uname -m); [ "$ARCH" = "arm64" ] && LABEL="macos-arm64" || LABEL="macos-x64"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

if [ "${1:-}" = "--local" ]; then
  ROOT=$(cd "$(dirname "$0")/.." && pwd)
  SRC=$(ls -d "$ROOT"/apps/desktop/build/stable-* 2>/dev/null | head -1)
  [ -n "$SRC" ] || { echo "no stable build found — run: pnpm --filter @neon/desktop build:app"; exit 1; }
  cp -R "$SRC"/. "$TMP/"
else
  TAG="${1:-latest}"
  if [ "$TAG" = "latest" ]; then API="https://api.github.com/repos/$REPO/releases/latest"; else API="https://api.github.com/repos/$REPO/releases/tags/$TAG"; fi
  echo "→ resolving $API"
  URL=$(curl -fsSL "$API" | grep -o "https://[^\"]*${LABEL}\.zip" | head -1)
  [ -n "$URL" ] || { echo "no ${LABEL}.zip asset found in release $TAG of $REPO"; exit 1; }
  echo "→ downloading $URL"
  curl -fL --progress-bar "$URL" -o "$TMP/app.zip"
  (cd "$TMP" && unzip -q app.zip && rm app.zip)
fi

APP=$(find "$TMP" -maxdepth 2 -name "*.app" | head -1)
[ -n "$APP" ] || { echo "no .app bundle found in the archive"; exit 1; }
TARGET="$DEST/$(basename "$APP")"

echo "→ removing quarantine flag (unsigned download)"
xattr -cr "$APP" 2>/dev/null || true
echo "→ ad-hoc code signing so Gatekeeper does not report the bundle as damaged"
codesign --force --deep --sign - "$APP" 2>/dev/null || echo "   (codesign unavailable — continuing)"

if [ -d "$TARGET" ]; then
  echo "→ replacing existing $TARGET"
  rm -rf "$TARGET"
fi
mv "$APP" "$TARGET"
echo "✓ installed $TARGET"
echo "  First launch: if macOS still blocks it, right-click → Open, or run:  xattr -cr \"$TARGET\""
open "$TARGET" || true
