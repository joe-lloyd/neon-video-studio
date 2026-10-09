#!/usr/bin/env bash
# Install a CI build (any branch, unpublished) on a Windows machine over SSH and start it.
#
#   scripts/install-windows-build.sh <ssh-host> [release-workflow-run-id]
#
# Without a run id it takes the newest successful Release run of the current branch. It copies
# the installer and the matching render runtime over, closes the running app, runs the installer
# in the signed-in desktop session, points settings.json at the new render runtime (installed apps
# otherwise download the runtime of the last published release) and relaunches through the tunnel.
# Needs: gh (authenticated), key-based ssh to the host, someone signed in at its desktop.
set -euo pipefail
HOST="${1:?usage: scripts/install-windows-build.sh <ssh-host> [run-id]}"
RUN="${2:-}"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BRANCH=$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)
if [ -z "$RUN" ]; then
  RUN=$(gh run list --workflow release.yml --branch "$BRANCH" --status success --limit 1 --json databaseId -q '.[0].databaseId')
  [ -n "$RUN" ] || { echo "no successful Release run on $BRANCH; dispatch one: gh workflow run release.yml --ref $BRANCH"; exit 1; }
fi
SHA=$(gh run view "$RUN" --json headSha -q '.headSha[0:7]')
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
echo "== downloading the windows-x64 build of run $RUN ($SHA)"
gh run download "$RUN" -n windows-x64 -D "$WORK"

echo "== copying to $HOST"
ssh "$HOST" 'if not exist "%USERPROFILE%\neon-branch" mkdir "%USERPROFILE%\neon-branch"' >/dev/null 2>&1 || true
scp -q "$WORK/win-x64-NeonVideoStudio-Setup.zip" "$WORK/render-runtime-windows-x64.tar.gz" "$HOST:neon-branch/"
cat > "$WORK/install.ps1" <<PS1
\$ErrorActionPreference = 'Stop'
\$ProgressPreference = 'SilentlyContinue'
\$src = Join-Path \$env:USERPROFILE 'neon-branch'
Get-Process bun, launcher -ErrorAction SilentlyContinue | Where-Object { \$_.Path -like '*com.hypersolid.neon-video-studio*' } | Stop-Process -Force
# A previous installer still open would block this one.
Get-Process 'Neon Video Studio-Setup' -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item -Recurse -Force (Join-Path \$src 'setup') -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path \$src 'setup') | Out-Null
tar -xf (Join-Path \$src 'win-x64-NeonVideoStudio-Setup.zip') -C (Join-Path \$src 'setup')
\$setup = Join-Path \$src 'setup\Neon Video Studio-Setup.exe'
# An interactive-logon task runs in the signed-in desktop session (SSH sessions have no desktop).
# The cmdlets keep the spaced path intact; PowerShell 5 strips embedded quotes from schtasks /tr.
\$task = Register-ScheduledTask -TaskName NeonVideoStudioSetup -Force -Action (New-ScheduledTaskAction -Execute \$setup) -Principal (New-ScheduledTaskPrincipal -UserId \$env:USERNAME -LogonType Interactive)
\$before = (Get-Content (Join-Path \$env:LOCALAPPDATA 'com.hypersolid.neon-video-studio\stable\app\Resources\version.json') -Raw | ConvertFrom-Json).hash
Start-ScheduledTask -TaskName NeonVideoStudioSetup
for (\$i = 0; \$i -lt 60; \$i++) {
  Start-Sleep 2
  \$now = (Get-Content (Join-Path \$env:LOCALAPPDATA 'com.hypersolid.neon-video-studio\stable\app\Resources\version.json') -Raw | ConvertFrom-Json).hash
  if (\$now -ne \$before) { break }
}
if (\$now -eq \$before) { throw "the installer did not replace the app (bundle still \$before); is someone signed in at the desktop?" }
"installed bundle \$now (was \$before)"
Get-Process 'Neon Video Studio-Setup' -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process bun, launcher -ErrorAction SilentlyContinue | Where-Object { \$_.Path -like '*com.hypersolid.neon-video-studio*' } | Stop-Process -Force
Unregister-ScheduledTask -TaskName NeonVideoStudioSetup -Confirm:\$false
\$rt = Join-Path \$env:USERPROFILE '.neon-video\render-runtime\branch-$SHA'
New-Item -ItemType Directory -Force \$rt | Out-Null
tar -xzf (Join-Path \$src 'render-runtime-windows-x64.tar.gz') -C \$rt
\$f = Join-Path \$env:USERPROFILE '.neon-video\settings.json'
\$s = [IO.File]::ReadAllText(\$f).TrimStart([char]0xFEFF) | ConvertFrom-Json
\$s | Add-Member -NotePropertyName renderRuntimeDir -NotePropertyValue \$rt -Force
[IO.File]::WriteAllText(\$f, (\$s | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding \$false))
"render runtime \$rt"
PS1
scp -q "$WORK/install.ps1" "$HOST:neon-branch/install.ps1"
echo "== installing on $HOST"
ssh "$HOST" 'powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\neon-branch\install.ps1"' 2>&1 | grep -v 'cannot find the path'
[ "${PIPESTATUS[0]}" = 0 ] || { echo "install failed on $HOST"; exit 1; }

echo "== starting the app"
node "$ROOT/apps/cli/src/main.ts" --on "$HOST" disconnect >/dev/null 2>&1 || true
node "$ROOT/apps/cli/src/main.ts" --on "$HOST" launch
node "$ROOT/apps/cli/src/main.ts" --on "$HOST" status
