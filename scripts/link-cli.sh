#!/usr/bin/env sh
# Put `neon-cli` on PATH (macOS/Linux): writes a shim that runs this checkout's CLI with Node.
#   scripts/link-cli.sh [bin-dir]     (default ~/.local/bin)
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
bin=${1:-"$HOME/.local/bin"}
mkdir -p "$bin"
printf '#!/usr/bin/env sh\nexec node "%s/apps/cli/src/main.ts" "$@"\n' "$repo" > "$bin/neon-cli"
chmod +x "$bin/neon-cli"
echo "Wrote $bin/neon-cli -> $repo/apps/cli/src/main.ts"
case ":$PATH:" in
  *":$bin:"*) ;;
  *) echo "Add it to PATH: export PATH=\"$bin:\$PATH\"" ;;
esac
