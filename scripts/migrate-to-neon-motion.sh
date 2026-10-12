#!/bin/zsh
# Point code written against Remotion's API at @neon/motion. Idempotent — safe to re-run.
# Use after merging feat/own-render-engine into a branch that still has `remotion` imports
# (e.g. new example packs), then run `pnpm install --ignore-scripts && pnpm typecheck`.
#
#   scripts/migrate-to-neon-motion.sh            # whole repo (apps, packages, examples)
#   scripts/migrate-to-neon-motion.sh path/...   # only these directories
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
if (( $# )); then TARGETS=("$@"); else TARGETS=(apps packages examples); fi

# 1. Source imports: 'remotion' → '@neon/motion', '@remotion/player' → '@neon/motion/player'.
grep -rlE "from ['\"](remotion|@remotion/player)['\"]" --include='*.ts' --include='*.tsx' --exclude-dir=node_modules $TARGETS 2>/dev/null | while read -r f; do
  sed -i '' -E "s/from (['\"])remotion(['\"])/from \1@neon\/motion\2/; s/from (['\"])@remotion\/player(['\"])/from \1@neon\/motion\/player\2/" "$f"
  echo "imports  $f"
done

# 2. package.json: drop remotion / @remotion/* entries, depend on @neon/motion instead.
find $TARGETS -name package.json -not -path '*/node_modules/*' | while read -r f; do
  grep -qE '"(remotion|@remotion/[a-z-]+)":' "$f" || continue
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      const deps = pkg[field];
      if (!deps) continue;
      let had = false;
      for (const name of Object.keys(deps)) if (name === "remotion" || name.startsWith("@remotion/")) { delete deps[name]; had = true; }
      if (had && field !== "peerDependencies") deps["@neon/motion"] = "workspace:*";
    }
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  ' "$f"
  echo "package  $f"
done

# 3. Player props that only existed for the old library.
grep -rlE "acknowledgeRemotionLicense|numberOfSharedAudioTags|showVolumeControls" --include='*.tsx' --exclude-dir=node_modules $TARGETS 2>/dev/null | while read -r f; do
  sed -i '' -E 's/ acknowledgeRemotionLicense//; s/ numberOfSharedAudioTags=\{[0-9]+\}//; s/ showVolumeControls=\{false\}//; s/ controls=\{false\}//' "$f"
  echo "player   $f (check multi-line Player props by hand)"
done

echo "done — now: pnpm install --ignore-scripts && pnpm typecheck"
