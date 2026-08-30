#!/usr/bin/env bash
# Bump the version everywhere, commit, and tag. Then: git push --follow-tags  → CI builds & publishes.
#   scripts/release.sh 0.2.0
set -euo pipefail
VERSION="${1:-}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || { echo "usage: scripts/release.sh <semver e.g. 0.2.0>"; exit 1; }
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
[ -z "$(git status --porcelain)" ] || { echo "working tree not clean — commit or stash first"; exit 1; }
git rev-parse "v$VERSION" >/dev/null 2>&1 && { echo "tag v$VERSION already exists"; exit 1; }

node - "$VERSION" <<'JS'
const fs = require('node:fs');
const version = process.argv[2];
for (const file of ['package.json', 'apps/desktop/package.json', 'apps/cli/package.json']) {
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
}
const cfg = 'apps/desktop/electrobun.config.ts';
fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace(/version: '[^']+'/, `version: '${version}'`));
const main = 'apps/desktop/src/main/index.ts';
fs.writeFileSync(main, fs.readFileSync(main, 'utf8').replace(/const VERSION = '[^']+'/, `const VERSION = '${version}'`));
JS

git add -A
git commit -q -m "chore(release): v$VERSION"
git tag -a "v$VERSION" -m "Neon Video Studio v$VERSION"
echo "Tagged v$VERSION. Publish with:  git push --follow-tags"
